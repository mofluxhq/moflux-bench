/**
 * aggregate.mjs — collapses replicate runs into medians and spread.
 *
 * Single-run numbers are not publishable. This reports the median with min/max
 * across seeds so a reader can see how stable each result is.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const dir = process.argv[2] ?? "results/replicates";
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
if (files.length === 0) {
  console.error(`no replicate files in ${dir}`);
  process.exit(1);
}

const runs = files.map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")));
const armKeys = [...new Set(runs.flatMap((r) => Object.keys(r.results)))];

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const rows = [];
for (const arm of armKeys) {
  const present = runs.map((r) => r.results[arm]).filter(Boolean);
  if (present.length === 0) continue;
  const pick = (fn) => present.map(fn);
  const fmt = (xs) => `${median(xs).toFixed(1)} [${Math.min(...xs).toFixed(1)}–${Math.max(...xs).toFixed(1)}]`;
  rows.push({
    arm,
    seeds: present.length,
    "int success %": fmt(pick((s) => s.classes.interactive.successRate * 100)),
    "int p99 s": fmt(pick((s) => s.classes.interactive.latencyMs.p99 / 1000)),
    "ttft p99 s": fmt(pick((s) => s.classes.interactive.ttftMs.p99 / 1000)),
    "retries x": fmt(pick((s) => s.classes.interactive.retryAmplification)),
    "upstream 429": fmt(pick((s) => s.classes.interactive.upstreamReject + s.classes.batch.upstreamReject)),
  });
}
console.log(`\nmedian [min–max] across ${runs.length} seeds\n`);
console.table(rows);

const invalid = runs.filter((r) => Object.values(r.results).some((s) => s.generatorSaturated > 0));
if (invalid.length > 0) {
  console.error(`\nWARNING: ${invalid.length} run(s) had a saturated generator and must be excluded.`);
}
