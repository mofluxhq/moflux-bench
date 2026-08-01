/**
 * verify-trace-sizes.mjs — heterogeneous request sizes, without breaking v1.
 *
 * Why this change exists
 * ----------------------
 * Every request in a class used to be the same size: 1,200 chars and 400 max
 * tokens for interactive, on every request, on every seed. In that world
 * token-aware admission and a plain concurrency semaphore are not merely
 * similar, they are the same algorithm — N slots times one fixed size is a
 * fixed token ceiling, so there is no admission decision token accounting can
 * make that a counter cannot. Any result claimed for token awareness was
 * therefore unattributable, and a static cap was expected to match it.
 *
 * Real traffic within one class spans one to two orders of magnitude, because
 * context length, retrieved documents, and conversation history vary per call.
 * Version 2 draws a size per request so the two policies can diverge.
 *
 * What this file protects
 * -----------------------
 * 1. Version 1 still hashes exactly as before, so every result already
 *    recorded stays reproducible rather than merely archived.
 * 2. Version 2 is deterministic per seed and genuinely heavy-tailed.
 * 3. No drawn request is too large to admit, which would reproduce the
 *    stranded-capacity failure through the workload instead of the config.
 * 4. The two versions cannot be mixed within a paired run.
 *
 * Run: node load/verify-trace-sizes.mjs
 */
import { buildTrace, sizeBounds, validateTrace } from "./trace-lib.mjs";

const failures = [];
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`PASS  ${name}`);
  } else {
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
}

const BASE = {
  durationMs: 45000, seed: 3, interactiveRps: 6, interactiveInputChars: 1200,
  interactiveMaxTokens: 400, batchStartMs: 15750, batchDurationMs: 22500, batchRps: 3,
  batchInputChars: 24000, batchMaxTokens: 3000, maxAttempts: 4, backoffBaseMs: 250,
  inFlightCeiling: 3000, windowMs: 30000,
};
const HET = { ...BASE, sizeDistribution: "lognormal", interactiveSizeSigma: 0.75, batchSizeSigma: 0 };

/**
 * The hash committed alongside the published five-seed sweep. If adding
 * per-request sizes shifted any pre-existing draw by a single value, this
 * changes and every version-1 result becomes unreproducible.
 */
const KNOWN_V1 = "14745a767634923c7d42d626df4d541b98ff66372c5d84ebe1f33b33ebe9c02b";

// ── version 1 is untouched ───────────────────────────────────────────
{
  const implicit = buildTrace(BASE);
  const explicit = buildTrace({ ...BASE, sizeDistribution: "uniform" });
  check("an unconfigured trace is still version 1", implicit.version === 1);
  check("the published version-1 hash is unchanged", implicit.hash === KNOWN_V1, implicit.hash);
  check("an explicitly uniform trace hashes identically", explicit.hash === KNOWN_V1);
  check(
    "version-1 entries carry no size fields",
    implicit.entries.every((e) => e.inputChars === undefined && e.maxTokens === undefined),
  );
  check(
    "version-1 planned counts are unchanged",
    implicit.planned.interactive === 300 && implicit.planned.batch === 59,
    JSON.stringify(implicit.planned),
  );
}

// ── version 2 is deterministic and heavy-tailed ──────────────────────
{
  const het = buildTrace(HET);
  check("a heterogeneous trace is version 2", het.version === 2);
  check("it does not collide with the version-1 hash", het.hash !== KNOWN_V1);
  check("it is deterministic for a given seed", het.hash === buildTrace(HET).hash);
  check(
    "a different seed produces a different trace",
    het.hash !== buildTrace({ ...HET, seed: 4 }).hash,
  );
  check(
    "a different sigma produces a different trace",
    het.hash !== buildTrace({ ...HET, interactiveSizeSigma: 0.5 }).hash,
  );
  // Arrivals must not move: only sizes are new, so a v2 run offers the same
  // schedule as its v1 counterpart and the two remain comparable in shape.
  const v1 = buildTrace(BASE);
  check(
    "arrival times are identical to the version-1 trace",
    JSON.stringify(het.entries.map((e) => e.arrivalMs)) ===
      JSON.stringify(v1.entries.map((e) => e.arrivalMs)),
  );
  check(
    "retry jitter is identical to the version-1 trace",
    JSON.stringify(het.entries.map((e) => e.retryJitter)) ===
      JSON.stringify(v1.entries.map((e) => e.retryJitter)),
  );

  const sizes = het.entries.filter((e) => e.class === "interactive").map((e) => e.inputChars);
  const min = Math.min(...sizes);
  const max = Math.max(...sizes);
  const sorted = [...sizes].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  check("interactive sizes actually vary", min < max, `${min}..${max}`);
  check("the spread is at least 8x", max / min >= 8, `${(max / min).toFixed(1)}x`);
  check(
    "the median stays near the configured class size",
    median > BASE.interactiveInputChars * 0.7 && median < BASE.interactiveInputChars * 1.5,
    String(median),
  );
  // A lognormal has more mass below the median than above it; a symmetric
  // spread would not reproduce the long tail that makes sizing hard.
  check(
    "the distribution is right-skewed, not symmetric",
    max - median > median - min,
    `above ${max - median}, below ${median - min}`,
  );
  check("max tokens vary too", new Set(het.entries.map((e) => e.maxTokens)).size > 1);
}

// ── nothing drawn can be too large to admit ──────────────────────────
{
  const het = buildTrace(HET);
  const bounds = sizeBounds(HET, "interactive");
  const sizes = het.entries.filter((e) => e.class === "interactive");
  check(
    "every drawn size sits inside the admittable bound",
    sizes.every(
      (e) =>
        e.inputChars >= bounds.inputChars.min &&
        e.inputChars <= bounds.inputChars.max &&
        e.maxTokens >= bounds.maxTokens.min &&
        e.maxTokens <= bounds.maxTokens.max,
    ),
  );
  check(
    "the bound is a bounded multiple of the class median",
    bounds.inputChars.max / bounds.inputChars.median <= 4,
  );
  check("sigma 0 collapses a class to exactly its median",
    het.entries.filter((e) => e.class === "batch").every((e) => e.inputChars === BASE.batchInputChars));
}

// ── the two versions cannot be mixed ─────────────────────────────────
{
  const v1 = buildTrace(BASE);
  const het = buildTrace(HET);
  const rejects = (trace, config) => {
    try {
      validateTrace(trace, config);
      return false;
    } catch {
      return true;
    }
  };
  check("a version-1 trace cannot replay under a heterogeneous config", rejects(v1, HET));
  check("a version-2 trace cannot replay under a uniform config", rejects(het, BASE));
  check("a matching config accepts its own trace", !rejects(het, HET) && !rejects(v1, BASE));

  const tampered = {
    ...het,
    hash: undefined,
    entries: het.entries.map((e, idx) => (idx === 0 ? { ...e, inputChars: 999999 } : e)),
  };
  check("an unadmittable size is rejected by validation", rejects(tampered, HET));
}

console.log();
if (failures.length > 0) {
  console.log(`${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("All checks passed.");
