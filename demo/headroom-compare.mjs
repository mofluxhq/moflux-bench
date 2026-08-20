#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildHeadroomPolicyComparison, readCompletedSweepSummary } from "./headroom-compare-lib.mjs";
import { parseSeedSpec } from "./seed-sweep-lib.mjs";
import {
  assertSafeResultsDir,
  assertSafeRunDir,
  latestPointerFile,
  repoRelative,
  runDir,
  runId,
} from "./evidence-paths-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS = process.env.MOFLUX_BENCH_RESULTS_DIR
  ? path.resolve(process.env.MOFLUX_BENCH_RESULTS_DIR)
  : path.join(ROOT, "results");
assertSafeResultsDir(RESULTS, ROOT, "headroom comparison results root");

const raw = new Map();
for (const arg of process.argv.slice(2)) {
  const match = /^--([^=]+)=(.*)$/.exec(arg);
  if (match) raw.set(match[1], match[2]);
  else if (arg.startsWith("--")) raw.set(arg.slice(2), "true");
}
const seeds = parseSeedSpec(raw.get("seeds") ?? "1-5");
const baseId = raw.get("run-id") ?? runId();
const baselineId = `${baseId}-adaptive`;
const headroomId = `${baseId}-headroom`;
const SEED_SWEEP = path.join(ROOT, "demo", "seed-sweep.mjs");
const SWEEP_NAME = "moflux-seed-sweep";
// This paired test is about active-demand headroom, not heterogeneous sizing.
// Keep interactive traffic continuously active but comfortably below its 28-slot
// guarantee so Latchflo gets a deterministic >=3s demanding-with-headroom
// interval while batch is present. The ordinary hetero/adaptive demos retain
// the 6 RPS lognormal workload.
const HEADROOM_EXERCISE_INTERACTIVE_RPS = 3;
const HEADROOM_EXERCISE_SIZE_DISTRIBUTION = "uniform";

function runSweep(profile, id, cleanup = false) {
  const args = [
    SEED_SWEEP,
    "--mode=moflux",
    `--seeds=${seeds.join(",")}`,
    "--pause-ms=0",
    "--no-open",
    `--interactive-rps=${HEADROOM_EXERCISE_INTERACTIVE_RPS}`,
    `--size-distribution=${HEADROOM_EXERCISE_SIZE_DISTRIBUTION}`,
    `--capacity-profile=${profile}`,
    "--provider-api=anthropic",
    "--require-adaptive-proof",
    "--adaptive-proof-context=headroom-compare",
    `--run-id=${id}`,
  ];
  if (cleanup) args.push("--cleanup");
  return spawnSync(process.execPath, args, { cwd: ROOT, env: process.env, stdio: "inherit" });
}

const baselineFile = path.join(runDir(RESULTS, SWEEP_NAME, baselineId), "summary.json");
const headroomFile = path.join(runDir(RESULTS, SWEEP_NAME, headroomId), "summary.json");

console.log("\nMoFlux policy comparison — adaptive 28/4 vs headroom-aware 28/4");
console.log(`seeds: ${seeds.join(", ")}`);
console.log(
  `exercise workload: ${HEADROOM_EXERCISE_INTERACTIVE_RPS} interactive RPS, ` +
  `${HEADROOM_EXERCISE_SIZE_DISTRIBUTION} request sizes; batch begins at 60% of the phase`,
);
const baselineRun = runSweep("adaptive-28-4", baselineId, false);
const baselineResult = readCompletedSweepSummary(baselineFile, baselineRun, "adaptive-28-4");
if (baselineResult.nonZeroExit) {
  console.warn(
    `adaptive-28-4 sweep exited ${baselineRun.status} after preserving summary.json; ` +
    "continuing so the paired comparison can report the failed acceptance result.",
  );
}
const baseline = baselineResult.summary;
const headroomRun = runSweep("adaptive-headroom-28-4", headroomId, raw.get("cleanup") === "true");
const headroomResult = readCompletedSweepSummary(
  headroomFile,
  headroomRun,
  "adaptive-headroom-28-4",
);
if (headroomResult.nonZeroExit) {
  console.warn(
    `adaptive-headroom-28-4 sweep exited ${headroomRun.status} after preserving summary.json; ` +
    "continuing so the paired comparison can report the failed acceptance result.",
  );
}
const headroom = headroomResult.summary;

const acceptanceOverrides = Object.fromEntries(
  [
    ["minimumMedianBatchSuccesses", "min-median-batch-successes"],
    ["minimumMedianBatchSuccessDelta", "min-median-batch-success-delta"],
    ["maximumMedianInteractiveSuccessRegressionPp", "max-interactive-success-regression-pp"],
    ["maximumMedianInteractiveP95RegressionPercent", "max-interactive-p95-regression-percent"],
    ["minimumHeadroomEvidenceSeedFraction", "min-headroom-evidence-seed-fraction"],
  ]
    .filter(([, flag]) => raw.has(flag))
    .map(([key, flag]) => [key, raw.get(flag)]),
);
const comparison = buildHeadroomPolicyComparison(baseline, headroom, acceptanceOverrides);
comparison.inputs = {
  baseline: repoRelative(baselineFile, ROOT),
  headroom: repoRelative(headroomFile, ROOT),
};
const comparisonDir = assertSafeRunDir(
  runDir(RESULTS, "headroom-policy-comparison", baseId),
  ROOT,
  "headroom comparison run directory",
);
mkdirSync(comparisonDir, { recursive: true });
const comparisonFile = path.join(comparisonDir, "summary.json");
writeFileSync(comparisonFile, `${JSON.stringify(comparison, null, 2)}\n`);
const pointer = latestPointerFile(RESULTS, "headroom-policy-comparison");
mkdirSync(path.dirname(pointer), { recursive: true });
writeFileSync(
  pointer,
  `${JSON.stringify({
    runId: baseId,
    generatedAt: comparison.generatedAt,
    seeds,
    summary: repoRelative(comparisonFile, ROOT),
  }, null, 2)}\n`,
);

const med = (metric) => comparison.aggregate[metric]?.median;
console.table([{
  "all-seed batch success Δ": med("batchSuccessDelta"),
  "exercised batch success Δ": med("exercisedBatchSuccessDelta"),
  "batch success pp Δ": med("batchSuccessRatePercentagePointDelta"),
  "interactive success pp Δ": med("interactiveSuccessPercentagePointDelta"),
  "interactive p95 % Δ": med("interactiveP95LatencyChangePercent"),
  "TTFT p95 % Δ": med("interactiveTtftP95ChangePercent"),
  "local rejects Δ": med("localRejectDelta"),
  "upstream 429 Δ": med("upstream429Delta"),
}]);
console.log(`headroom controller evidence: ${comparison.headroomObservedSeeds}/${seeds.length} seeds`);
console.log(`headroom correlated data-plane evidence: ${comparison.dataPlaneHeadroomObservedSeeds}/${seeds.length} seeds`);
console.log(`headroom joint evidence: ${comparison.headroomEvidenceSeeds}/${seeds.length} seeds`);
console.log(`exact successor-grant proof: ${comparison.exactAdmissionProofSeeds}/${seeds.length} seeds`);
console.log(`zero upstream 429s: ${comparison.zeroUpstream429Seeds}/${seeds.length} seeds`);
console.log(
  `bounded demanding-state lend: ${comparison.headroomCapacityExpectation.effectiveFundedDemandingLend} ` +
  "additional batch reservation(s) funded",
);
console.log(
  `batch payoff gate on headroom-evidence seeds: median completions >= ` +
  `${comparison.acceptance.thresholds.minimumMedianBatchSuccesses}, median gain >= ` +
  `${comparison.acceptance.thresholds.minimumMedianBatchSuccessDelta}`,
);
console.log(`headroom outcome gate: ${comparison.acceptance.passed ? "PASS" : "FAIL"}`);
console.log(`summary: ${repoRelative(comparisonFile, ROOT)}`);

if (!comparison.acceptance.passed) {
  for (const failure of comparison.acceptance.failures) console.error(`- ${failure}`);
  console.error(
    "The paired comparison was preserved, but the headroom policy did not prove materially more batch work while preserving interactive protection.",
  );
  process.exitCode = 1;
}
