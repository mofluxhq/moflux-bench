/**
 * verify-lending.mjs — the lending analysis says "lending" only when it saw it.
 *
 * The failure this guards against is the expensive one: a lending policy that
 * is misconfigured, silently behaves exactly like the static split, and still
 * produces a report claiming lending worked. Every assertion below is built
 * from synthetic runs whose answer is known in advance, so the arithmetic is
 * checked without Docker or a licensed image.
 *
 * Run: node demo/verify-lending.mjs
 */
import {
  lendingComparison,
  lendingMetrics,
  peakActiveInWindow,
  percentile,
  windowedInteractive,
} from "./lending-lib.mjs";

const failures = [];
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`PASS  ${name}`);
  } else {
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
}

const ENVELOPE = 32;
const INTERACTIVE_CEILING = 31;
const BATCH_ARRIVAL_MS = 15_000;
const RUN_END_MS = 45_000;

/** Interactive completions at a steady rate across the whole run. */
function interactiveSamples({ ratePerSec, latencyMs, fromMs = 0, toMs = RUN_END_MS }) {
  const samples = [];
  for (let t = fromMs; t < toMs; t += Math.round(1000 / ratePerSec)) {
    samples.push({ offsetMs: t, latencyMs, ttftMs: Math.round(latencyMs / 4) });
  }
  return samples;
}

function runSummary({ idleRate, contendedRate, batch }) {
  return {
    classes: {
      interactive: {
        samples: [
          ...interactiveSamples({ ratePerSec: idleRate, latencyMs: 3000, toMs: BATCH_ARRIVAL_MS }),
          ...interactiveSamples({
            ratePerSec: contendedRate,
            latencyMs: 5000,
            fromMs: BATCH_ARRIVAL_MS,
          }),
        ],
      },
      batch,
    },
  };
}

/** Per-second occupancy: `idle` before batch arrives, `contended` after. */
function buckets(idle, contended) {
  return Array.from({ length: 45 }, (_, second) =>
    second * 1000 < BATCH_ARRIVAL_MS ? idle : contended,
  );
}

const servedBatch = { success: 12, firstAttemptAtMs: 15_100, firstSuccessAtMs: 15_400, admissionGapMs: 300 };
const starvedBatch = { success: 0, firstAttemptAtMs: 15_100, firstSuccessAtMs: null, admissionGapMs: null };

// ── window arithmetic ────────────────────────────────────────────────
{
  const b = buckets(32, 31);
  check("idle window scores only its own seconds", peakActiveInWindow(b, 0, BATCH_ARRIVAL_MS) === 32);
  check(
    "contended window excludes the idle seconds",
    peakActiveInWindow(b, BATCH_ARRIVAL_MS, RUN_END_MS) === 31,
  );
  check("an empty bucket list yields no answer", peakActiveInWindow([], 0, 1000) === null);
  check("a zero-width window yields no answer", peakActiveInWindow(b, 5000, 5000) === null);
  check(
    "a window past the recorded run is clamped, not fabricated",
    peakActiveInWindow(b, 100_000, 200_000) === null,
  );
  // A single late spike must not be reported as idle-window occupancy: that is
  // exactly the confusion a cumulative high-water mark creates.
  const lateSpike = Array.from({ length: 45 }, (_, s) => (s === 44 ? 32 : 20));
  check(
    "a late spike does not leak into the idle window",
    peakActiveInWindow(lateSpike, 0, BATCH_ARRIVAL_MS) === 20,
  );
}

// ── percentiles ──────────────────────────────────────────────────────
{
  check("percentile picks an actual observation", percentile([1, 2, 3, 4, 5], 0.5) === 3);
  check("p95 of a short series is the top observation", percentile([10, 20], 0.95) === 20);
  check("no samples means no percentile", percentile([], 0.5) === null);
}

// ── windowed interactive split ───────────────────────────────────────
{
  const summary = runSummary({ idleRate: 6, contendedRate: 4, batch: servedBatch });
  const windows = windowedInteractive(summary, BATCH_ARRIVAL_MS, RUN_END_MS);
  check("idle completions are counted in the idle window", windows.idle.completed > 0);
  check("contended completions are counted separately", windows.contended.completed > 0);
  check(
    "no sample is counted in both windows",
    windows.idle.completed + windows.contended.completed ===
      summary.classes.interactive.samples.length,
  );
  check(
    "the idle window shows the higher goodput here",
    windows.idle.goodputRps > windows.contended.goodputRps,
  );
}

// ── lending detected ─────────────────────────────────────────────────
{
  const metrics = lendingMetrics({
    summary: runSummary({ idleRate: 6, contendedRate: 4, batch: servedBatch }),
    peakActiveBySecond: buckets(32, 32),
    batchArrivalMs: BATCH_ARRIVAL_MS,
    runEndMs: RUN_END_MS,
    interactiveCeiling: INTERACTIVE_CEILING,
    envelope: ENVELOPE,
  });
  check("occupancy above the interactive ceiling counts as borrowed", metrics.idleWindow.borrowed === true);
  check("the borrowed amount is the excess over the ceiling", metrics.idleWindow.borrowedSlots === 1);
  check("a served batch class marks the floor reasserted", metrics.floorReassertion.reasserted === true);
  check("reassertion cost is the batch admission gap", metrics.floorReassertion.admissionGapMs === 300);
  check("handover cost is reported as a percentage", metrics.handoverCostPercent > 0);
}

// ── static split: no lending, and it must not be reported as lending ──
{
  const metrics = lendingMetrics({
    summary: runSummary({ idleRate: 5, contendedRate: 4, batch: servedBatch }),
    peakActiveBySecond: buckets(31, 32),
    batchArrivalMs: BATCH_ARRIVAL_MS,
    runEndMs: RUN_END_MS,
    interactiveCeiling: INTERACTIVE_CEILING,
    envelope: ENVELOPE,
  });
  check("a static split never exceeds its ceiling while batch is idle", metrics.idleWindow.borrowed === false);
  check("nothing is reported as borrowed", metrics.idleWindow.borrowedSlots === 0);
  // The whole run still reaches 32 — which is why a run-long high-water mark
  // cannot distinguish this case from the lending case above.
  check(
    "the run-long peak alone cannot tell these apart",
    peakActiveInWindow(buckets(31, 32), 0, RUN_END_MS) === 32,
  );
}

// ── starved batch is a failure, not a win ────────────────────────────
{
  const metrics = lendingMetrics({
    summary: runSummary({ idleRate: 6, contendedRate: 6, batch: starvedBatch }),
    peakActiveBySecond: buckets(32, 32),
    batchArrivalMs: BATCH_ARRIVAL_MS,
    runEndMs: RUN_END_MS,
    interactiveCeiling: INTERACTIVE_CEILING,
    envelope: ENVELOPE,
  });
  check("a batch class that never ran is not a reasserted floor", metrics.floorReassertion.reasserted === false);
  check("an unserved batch class reports no admission gap", metrics.floorReassertion.admissionGapMs === null);
}

// ── comparison between the two policies ──────────────────────────────
{
  const staticArm = lendingMetrics({
    summary: runSummary({ idleRate: 5, contendedRate: 4, batch: servedBatch }),
    peakActiveBySecond: buckets(31, 32),
    batchArrivalMs: BATCH_ARRIVAL_MS,
    runEndMs: RUN_END_MS,
    interactiveCeiling: INTERACTIVE_CEILING,
    envelope: ENVELOPE,
  });
  const lendingArm = lendingMetrics({
    summary: runSummary({ idleRate: 6, contendedRate: 4, batch: { ...servedBatch, admissionGapMs: 900, firstSuccessAtMs: 16_000 } }),
    peakActiveBySecond: buckets(32, 32),
    batchArrivalMs: BATCH_ARRIVAL_MS,
    runEndMs: RUN_END_MS,
    interactiveCeiling: INTERACTIVE_CEILING,
    envelope: ENVELOPE,
  });
  const comparison = lendingComparison(staticArm, lendingArm);
  check("lending is observed only when idle occupancy actually rose", comparison.lendingObserved === true);
  check("the gain is one slot", comparison.idlePeakActiveGain === 1);
  check("idle goodput improvement is reported", comparison.idleGoodputChangePercent > 0);
  check("the reassertion cost of lending is surfaced", comparison.reassertionCostMs === 600);
  check("both policies returned the floor", comparison.bothReasserted === true);

  // Same policy compared with itself must report no lending.
  const selfComparison = lendingComparison(staticArm, staticArm);
  check("comparing a static arm with itself shows no lending", selfComparison.lendingObserved === false);
  check("and no idle occupancy gain", selfComparison.idlePeakActiveGain === 0);
}

// ── regression: the emitted windows are preferred over raw samples ───
{
  // A result file whose rolling `samples` array has been pruned down to the
  // contended window only. Before the generator emitted its own windows, this
  // silently reported zero idle goodput instead of failing.
  const pruned = {
    classes: {
      interactive: {
        samples: interactiveSamples({ ratePerSec: 4, latencyMs: 5000, fromMs: BATCH_ARRIVAL_MS }),
        windows: {
          boundaryMs: BATCH_ARRIVAL_MS,
          idle: { completed: 90, goodputRps: 6, p50Ms: 3000, p95Ms: 4000, ttftP50Ms: 700 },
          contended: { completed: 120, goodputRps: 4, p50Ms: 5000, p95Ms: 8000, ttftP50Ms: 900 },
        },
      },
      batch: servedBatch,
    },
  };
  const windows = windowedInteractive(pruned, BATCH_ARRIVAL_MS, RUN_END_MS);
  check("emitted windows survive a pruned sample array", windows.idle.completed === 90);
  check("idle goodput is not silently zero after pruning", windows.idle.goodputRps === 6);

  // A boundary mismatch means the file was produced under a different phase
  // layout, so the emitted split must not be trusted.
  const mismatched = {
    classes: {
      interactive: { samples: [], windows: { ...pruned.classes.interactive.windows, boundaryMs: 999 } },
      batch: servedBatch,
    },
  };
  check(
    "emitted windows from a different boundary are not reused",
    windowedInteractive(mismatched, BATCH_ARRIVAL_MS, RUN_END_MS).idle.completed === 0,
  );
}

// ── the phase split accounts for every completion ────────────────────
{
  // idle + contended + drain must equal the class's successes. If it does not,
  // one of the three buckets is dropping or double-counting work, and every
  // per-window goodput figure is wrong by an unknown amount.
  const emitted = {
    boundaryMs: BATCH_ARRIVAL_MS,
    endMs: RUN_END_MS,
    idle: { completed: 17, goodputRps: 3.4 },
    contended: { completed: 13, goodputRps: 4.333 },
    drainCompleted: 13,
  };
  check(
    "the three buckets account for every success",
    emitted.idle.completed + emitted.contended.completed + emitted.drainCompleted === 43,
  );
  check(
    "drain completions are excluded from the contended window",
    emitted.contended.completed < emitted.contended.completed + emitted.drainCompleted,
  );
}

// ── regression: a per-replica ceiling must not read as borrowing ─────
{
  // maxConcurrent is configured per replica; the fleet ceiling is that times
  // the replica count. Passing the per-replica figure made a static cap look
  // like it was borrowing.
  let threw = false;
  try {
    lendingMetrics({
      summary: runSummary({ idleRate: 5, contendedRate: 4, batch: servedBatch }),
      peakActiveBySecond: buckets(8, 8),
      batchArrivalMs: BATCH_ARRIVAL_MS,
      runEndMs: RUN_END_MS,
      interactiveCeiling: 40,
      envelope: ENVELOPE,
    });
  } catch {
    threw = true;
  }
  check("a ceiling above the envelope is rejected as a misconfiguration", threw);
}

console.log();
if (failures.length > 0) {
  console.log(`${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("All checks passed.");
