#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildHeadroomPolicyComparison,
  evaluateHeadroomAcceptance,
  readCompletedSweepSummary,
} from "./headroom-compare-lib.mjs";

function sweep(profile, headroom = false) {
  const seeds = [1, 2];
  return {
    seeds,
    scenarioTemplate: { workload: { durationMs: 45000 }, provider: { envelope: 32 }, routing: {} },
    capacityPolicy: {
      profile,
      capacityGroup: {
        members: [
          {
            pool: "sim-interactive",
            guaranteedMaxConcurrent: 28,
            guaranteedTokenBudget: 24000,
            ...(headroom
              ? {
                  headroomLending: {
                    demandingSustainMs: 3000,
                    maxDemandingConcurrentLend: 2,
                    maxDemandingTokenLend: 10000,
                  },
                }
              : {}),
          },
          { pool: "sim-batch", guaranteedMaxConcurrent: 4, guaranteedTokenBudget: 40000 },
        ],
      },
      pools: [
        { name: "sim-batch", reservation: { requiredLocalGrant: 9942 } },
      ],
    },
    adaptiveProof: {
      passed: true,
      perSeed: seeds.map((seed) => ({
        seed,
        passed: true,
        batchSuccess: headroom ? 7 + seed : 4,
        headroomLendingObserved: headroom,
        dataPlaneHeadroomObserved: headroom,
        handoffExactAdmissionProof: true,
      })),
    },
    runs: seeds.map((seed) => ({
      seed,
      scenario: { trace: { hash: `trace-${seed}` } },
      mofluxMetrics: {
        batchSuccessRate: headroom ? 0.16 : 0.09,
        interactiveSuccessRate: headroom ? 0.95 : 0.96,
        interactiveP95Ms: headroom ? 1100 : 1000,
        interactiveTtftP95Ms: headroom ? 525 : 500,
        localRejects: headroom ? 90 : 100,
        upstream429s: 0,
      },
    })),
  };
}


const sweepTemp = mkdtempSync(path.join(tmpdir(), "moflux-headroom-sweep-result-"));
try {
  const preserved = path.join(sweepTemp, "summary.json");
  writeFileSync(preserved, `${JSON.stringify({ kind: "seed-sweep", adaptiveProof: { passed: false } })}\n`);
  const failedGate = readCompletedSweepSummary(
    preserved,
    { status: 1, signal: null, error: undefined },
    "adaptive-headroom-28-4",
  );
  assert.equal(failedGate.nonZeroExit, true);
  assert.equal(failedGate.summary.adaptiveProof.passed, false);

  assert.throws(
    () => readCompletedSweepSummary(
      path.join(sweepTemp, "missing.json"),
      { status: 1, signal: null, error: undefined },
      "adaptive-headroom-28-4",
    ),
    /before preserving a readable summary/,
  );
  assert.throws(
    () => readCompletedSweepSummary(
      preserved,
      { status: null, signal: "SIGTERM", error: undefined },
      "adaptive-headroom-28-4",
    ),
    /terminated by SIGTERM/,
  );
} finally {
  rmSync(sweepTemp, { recursive: true, force: true });
}

const baseline = sweep("adaptive-28-4");
const headroom = sweep("adaptive-headroom-28-4", true);
const result = buildHeadroomPolicyComparison(baseline, headroom);
assert.equal(result.schemaVersion, 4);
assert.equal(
  result.headroomEvidenceDefinition,
  "in-window demanding controller event + bounded correlated Tyr transfer",
);
assert.equal(result.perSeed.length, 2);
assert.equal(result.headroomObservedSeeds, 2);
assert.equal(result.dataPlaneHeadroomObservedSeeds, 2);
assert.equal(result.headroomEvidenceSeeds, 2);
assert.equal(result.exactAdmissionProofSeeds, 2);
assert.equal(result.zeroUpstream429Seeds, 2);
assert.equal(result.perSeed[0].baselineBatchSuccess, 4);
assert.equal(result.perSeed[0].headroomBatchSuccess, 8);
assert.equal(result.perSeed[0].batchSuccessDelta, 4);
assert.equal(result.aggregate.headroomBatchSuccess.median, 8.5);
assert.equal(result.aggregate.batchSuccessDelta.median, 4.5);
assert.equal(result.aggregate.exercisedHeadroomBatchSuccess.median, 8.5);
assert.equal(result.aggregate.exercisedBatchSuccessDelta.median, 4.5);
assert.equal(result.headroomCapacityExpectation.effectiveFundedDemandingLend, 1);
assert.equal(result.acceptance.thresholds.minimumMedianBatchSuccesses, 5);
assert.equal(result.acceptance.thresholds.minimumMedianBatchSuccessDelta, 1);
assert.equal(result.acceptance.thresholds.batchThresholdBasis.mode, "bounded-headroom-capacity");
assert.equal(result.aggregate.batchSuccessRatePercentagePointDelta.median, 7.000000000000001);
assert.ok(Math.abs(result.aggregate.interactiveSuccessPercentagePointDelta.median + 1) < 1e-9);
assert.equal(result.aggregate.interactiveP95LatencyChangePercent.median, 10);
assert.equal(result.aggregate.upstream429Delta.median, 0);
assert.equal(result.acceptance.passed, true);
assert.equal(result.acceptance.checks.materiallyMoreBatchCompletions, true);
assert.equal(result.acceptance.checks.interactiveSuccessPreserved, true);
assert.equal(result.acceptance.checks.interactiveP95Preserved, true);

const weakBatch = structuredClone(result);
weakBatch.aggregate.exercisedHeadroomBatchSuccess.median = 4;
weakBatch.aggregate.exercisedBatchSuccessDelta.median = 0;
const weakBatchGate = evaluateHeadroomAcceptance(weakBatch);
assert.equal(weakBatchGate.passed, false);
assert.equal(weakBatchGate.checks.materiallyMoreBatchCompletions, false);
assert.match(weakBatchGate.failures.join("; "), /headroom batch completions 4/);

const interactiveRegression = structuredClone(result);
interactiveRegression.aggregate.interactiveSuccessPercentagePointDelta.median = -2.5;
const interactiveGate = evaluateHeadroomAcceptance(interactiveRegression);
assert.equal(interactiveGate.passed, false);
assert.equal(interactiveGate.checks.interactiveSuccessPreserved, false);

const sparseButUsefulHeadroom = structuredClone(result);
sparseButUsefulHeadroom.headroomObservedSeeds = 1;
sparseButUsefulHeadroom.dataPlaneHeadroomObservedSeeds = 1;
sparseButUsefulHeadroom.headroomEvidenceSeeds = 1;
sparseButUsefulHeadroom.aggregate.exercisedBaselineBatchSuccess = {
  n: 1, median: 4, min: 4, max: 4,
};
sparseButUsefulHeadroom.aggregate.exercisedHeadroomBatchSuccess = {
  n: 1, median: 5, min: 5, max: 5,
};
sparseButUsefulHeadroom.aggregate.exercisedBatchSuccessDelta = {
  n: 1, median: 1, min: 1, max: 1,
};
const sparseGate = evaluateHeadroomAcceptance(sparseButUsefulHeadroom);
assert.equal(sparseGate.checks.materiallyMoreBatchCompletions, true);
assert.equal(sparseGate.checks.enoughHeadroomEvidence, false);
assert.equal(sparseGate.passed, false);

const insufficientEvidence = structuredClone(result);
insufficientEvidence.headroomEvidenceSeeds = 1;
const evidenceGate = evaluateHeadroomAcceptance(insufficientEvidence, {
  minimumHeadroomEvidenceSeedFraction: 1,
});
assert.equal(evidenceGate.passed, false);
assert.equal(evidenceGate.thresholds.minimumHeadroomEvidenceSeeds, 2);
assert.equal(evidenceGate.checks.enoughHeadroomEvidence, false);

const missingBatchMetric = structuredClone(headroom);
missingBatchMetric.adaptiveProof.perSeed[0].batchSuccess = null;
const missingMetricResult = buildHeadroomPolicyComparison(baseline, missingBatchMetric);
assert.equal(missingMetricResult.perSeed[0].headroomBatchSuccess, null);
assert.equal(missingMetricResult.acceptance.passed, false);

assert.throws(
  () => evaluateHeadroomAcceptance(result, { minimumMedianBatchSuccessDelta: -1 }),
  /thresholds must be >= 0/,
);

const wrongTrace = structuredClone(headroom);
wrongTrace.runs[0].scenario.trace.hash = "different";
assert.throws(() => buildHeadroomPolicyComparison(baseline, wrongTrace), /same immutable request trace/);

const wrongProfile = structuredClone(headroom);
wrongProfile.capacityPolicy.profile = "adaptive-28-4";
assert.throws(() => buildHeadroomPolicyComparison(baseline, wrongProfile), /headroom sweep must use/);

const compareCli = readFileSync(new URL("./headroom-compare.mjs", import.meta.url), "utf8");
assert.match(compareCli, /HEADROOM_EXERCISE_INTERACTIVE_RPS = 3/);
assert.match(compareCli, /HEADROOM_EXERCISE_SIZE_DISTRIBUTION = "uniform"/);
assert.match(compareCli, /--interactive-rps=\$\{HEADROOM_EXERCISE_INTERACTIVE_RPS\}/);
assert.match(compareCli, /--size-distribution=\$\{HEADROOM_EXERCISE_SIZE_DISTRIBUTION\}/);
assert.match(compareCli, /--adaptive-proof-context=headroom-compare/);

console.log("PASS  paired adaptive-vs-headroom outcome gate");
