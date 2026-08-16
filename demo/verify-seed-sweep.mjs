#!/usr/bin/env node
import assert from "node:assert/strict";
import { adaptiveProofFailureMessage, armMetrics, buildSweepSummary, median, parseSeedSpec, summarize } from "./seed-sweep-lib.mjs";

assert.deepEqual(parseSeedSpec("1-3,7,3"), [1, 2, 3, 7]);
assert.deepEqual(parseSeedSpec("0"), [0]);
assert.throws(() => parseSeedSpec("3-1"), /descending/);
assert.throws(() => parseSeedSpec("a"), /invalid seed/);
assert.equal(median([5, 1, 3]), 3);
assert.equal(median([4, 1, 2, 3]), 2.5);
assert.deepEqual(summarize([3, 1, 2]), { n: 3, median: 2, min: 1, max: 3 });

function summary(seed, successRate, success, p50, p95, upstream429s, refunded) {
  return {
    seed,
    config: { durationMs: 10000 },
    generatorSaturated: 0,
    classes: {
      interactive: {
        successRate,
        success,
        retryAmplification: 1.2,
        localReject: 2,
        upstreamReject: upstream429s,
        latencyMs: { p50, p95, p99: p95 },
        ttftMs: { p50: 100, p95: 200, p99: 200 },
      },
      batch: {
        successRate: 0.5,
        success: 5,
        retryAmplification: 1.5,
        localReject: 3,
        upstreamReject: 0,
        latencyMs: { p50: 1000, p95: 2000, p99: 2000 },
        ttftMs: { p50: 300, p95: 400, p99: 400 },
      },
    },
    simCounters: { peakActive: 32 },
    scenario: {
      id: `scenario-${seed}`,
      workload: { durationMs: 10000, seed, interactiveRps: 6 },
      provider: { api: "anthropic", envelope: 32, seed, sigma: 0.25 },
    },
    capacity: {
      policy: "interactive-first-static",
      batchFloorPercent: null,
      batchConcurrencySlots: 1,
      interactiveConcurrencySlots: 31,
      batchConcurrencyPercent: 3.125,
      batchTokenPercent: 25,
      envelope: 32,
      tokenBudget: 40000,
      pools: [
        { name: "sim-interactive", maxConcurrent: 31, tokenBudget: 30000, agentCount: 4, tokenFundedConcurrency: 31, strandedConcurrency: 0 },
        { name: "sim-batch", maxConcurrent: 1, tokenBudget: 10000, agentCount: 1, tokenFundedConcurrency: 1, strandedConcurrency: 0 },
      ],
    },
    tokenAccounting: {
      totalReserved: 1000,
      totalConsumed: 1000 - refunded,
      totalRefunded: refunded,
      totalOverrun: 0,
      grossRecoveryRate: refunded / 1000,
      netRecovered: refunded,
      netRecoveryRate: refunded / 1000,
      progressiveReports: 8,
      progressiveUpdates: 4,
      progressiveCoalesced: 4,
      progressiveEarlyReleasedTokens: refunded / 2,
      progressiveEarlyReleaseRate: 0.5,
      progressiveConfiguration: {
        enabled: true,
        updateStepTokens: 256,
        outputSafetyMarginTokens: 256,
      },
    },
  };
}

const baseline1 = summary(1, 0.6, 6, 1000, 2000, 10, 0);
const moflux1 = summary(1, 0.8, 8, 800, 1200, 0, 200);
const baseline2 = summary(2, 0.7, 7, 1100, 2200, 12, 0);
const moflux2 = summary(2, 0.9, 9, 900, 1350, 0, 300);

const metrics1 = {
  interactiveSuccessPercentagePointChange: 20,
  interactiveGoodputChangePercent: 33.33,
  interactiveP95LatencyChangePercent: -40,
  interactiveTailRatioBaseline: 2,
  interactiveTailRatioMoflux: 1.5,
  interactiveTailInflationChangePercent: -25,
  upstream429Baseline: 10,
  upstream429Moflux: 0,
};
const metrics2 = { ...metrics1, interactiveGoodputChangePercent: 28.57, upstream429Baseline: 12 };

const records = [
  {
    seed: 1,
    baseline: baseline1,
    moflux: moflux1,
    comparison: { metrics: metrics1 },
    scenario: baseline1.scenario,
    arms: { baseline: "results/a.json", moflux: "results/b.json" },
  },
  {
    seed: 2,
    baseline: baseline2,
    moflux: moflux2,
    comparison: { metrics: metrics2 },
    scenario: baseline2.scenario,
    arms: { baseline: "results/c.json", moflux: "results/d.json" },
  },
];

const aggregate = buildSweepSummary({ mode: "compare", fault: false, seeds: [1, 2], records });
assert.equal(aggregate.kind, "paired-seed-sweep");
assert.deepEqual(aggregate.seeds, [1, 2]);
assert.equal(aggregate.scenarioTemplate.workload.seed, undefined);
assert.equal(aggregate.scenarioTemplate.provider.seed, undefined);
assert.ok(Math.abs(aggregate.aggregate.arms.baseline.interactiveSuccessRate.median - 0.65) < 1e-12);
assert.ok(Math.abs(aggregate.aggregate.arms.moflux.interactiveGoodputRps.median - 0.85) < 1e-12);
assert.equal(aggregate.aggregate.paired.upstream429Baseline.min, 10);
assert.equal(aggregate.aggregate.paired.upstream429Baseline.max, 12);
assert.equal(aggregate.aggregate.tokenAccounting.grossRecoveryRate.median, 0.25);
assert.equal(aggregate.aggregate.tokenAccounting.progressiveEarlyReleaseRate.median, 0.5);
assert.deepEqual(aggregate.aggregate.tokenAccounting.progressiveConfiguration, {
  enabled: true,
  updateStepTokens: 256,
  outputSafetyMarginTokens: 256,
});
assert.throws(
  () => buildSweepSummary({
    mode: "compare",
    fault: false,
    seeds: [1, 2],
    records: [
      { seed: 1, baseline: baseline1, moflux: moflux1, comparison: { metrics: metrics1 }, scenario: baseline1.scenario, arms: {} },
      {
        seed: 2,
        baseline: baseline2,
        moflux: {
          ...moflux2,
          tokenAccounting: {
            ...moflux2.tokenAccounting,
            progressiveConfiguration: undefined,
          },
        },
        comparison: { metrics: metrics2 },
        scenario: baseline2.scenario,
        arms: {},
      },
    ],
  }),
  /omitted the progressive reconciliation policy/,
);
assert.equal(armMetrics(baseline1).interactiveTailRatio, 2);
assert.equal(aggregate.capacityPolicy.policy, "interactive-first-static");
assert.equal(aggregate.capacityPolicy.interactiveConcurrencySlots, 31);
assert.equal(aggregate.capacityPolicy.batchConcurrencySlots, 1);
assert.equal(aggregate.capacityPolicy.batchConcurrencyPercent, 3.125);
assert.equal(aggregate.capacityPolicy.pools[1].agentCount, 1);
const adaptiveRecords = records.map((record) => {
  const moflux = structuredClone(record.moflux);
  moflux.capacity = {
    profile: "adaptive-28-4",
    policy: "interactive-first-demand-aware",
    batchFloorPercent: null,
    batchConcurrencySlots: 4,
    interactiveConcurrencySlots: 28,
    batchConcurrencyPercent: 12.5,
    batchTokenPercent: 62.5,
    envelope: 32,
    tokenBudget: 64000,
    capacityGroup: "sim-workloads",
    demandPolicy: {
      enabled: true,
      reportStaleAfterMs: 6000,
      idleAfterMs: 3000,
      maxStarvationMs: 5000,
    },
    pools: [
      { name: "sim-interactive", maxConcurrent: 32, tokenBudget: 64000, guaranteedMaxConcurrent: 28, guaranteedTokenBudget: 24000, ceilingMaxConcurrent: 32, ceilingTokenBudget: 64000, agentCount: 4 },
      { name: "sim-batch", maxConcurrent: 32, tokenBudget: 64000, guaranteedMaxConcurrent: 4, guaranteedTokenBudget: 40000, ceilingMaxConcurrent: 32, ceilingTokenBudget: 64000, agentCount: 1 },
    ],
  };
  moflux.classes.interactive.upstreamReject = 0;
  moflux.classes.interactive.successRate = 0.95;
  moflux.classes.batch.upstreamReject = 0;
  moflux.classes.batch.successRate = 0.12;
  moflux.classes.batch.success = 4;
  moflux.lending = {
    idleWindow: { borrowed: true, borrowedSlots: 4 },
    floorReassertion: {
      admissionGapMinMs: 50,
      admissionGapMaxMs: 150,
      responseHeadersGapMs: 750,
    },
    controlPlane: {
      lendingObserved: true,
      floorRestored: true,
      controllerFloorRestored: true,
      dataPlaneFloorRestored: true,
      restorationDurationMs: 500,
      handoff: {
        observed: true,
        committedAt: "2026-08-08T20:00:27.900Z",
        firstBatchAdmissionWindow: {
          notBeforeAt: "2026-08-08T20:00:27.950Z",
          notAfterAt: "2026-08-08T20:00:28.050Z",
          widthMs: 100,
        },
        fallbackDeadline: "2026-08-08T20:01:27.200Z",
        safetyDeadline: "2026-08-08T20:01:27.200Z",
        safetyDeadlineSource: "prepared_successor_grants",
        predecessorLeaseDeadline: "2026-08-08T20:00:27.700Z",
        successorGrantDeadline: "2026-08-08T20:01:27.200Z",
        everyDrainApplied: true,
        aborted: false,
        abortReason: null,
        safeEventOrder: true,
        commitBeforeBatchAdmission: true,
        admissionOrderingStatus: "proven_after_commit",
        committedBeforeSafetyDeadline: true,
        committedBeforeLeaseExpiry: false,
        handoffDurationMs: 450,
        demandToDrainStartMs: 100,
        drainStartToAcknowledgedMs: 150,
        acknowledgedToCommitMs: 200,
        commitToFirstBatchAdmissionMinMs: 50,
        commitToFirstBatchAdmissionMaxMs: 150,
        demandToFirstBatchAdmissionMinMs: 500,
        demandToFirstBatchAdmissionMaxMs: 600,
        commitToFirstBatchResponseHeadersMs: 250,
        demandToFirstBatchResponseHeadersMs: 700,
        leaseTimeAvoidedMs: 0,
        predecessorLeaseLeadMs: -200,
        safetyTimeRemainingMs: 59300,
        appliedCapacity: { noAppliedOverallocation: true },
      },
    },
  };
  return { ...record, moflux };
});
const adaptive = buildSweepSummary({
  mode: "compare",
  fault: false,
  seeds: [1, 2],
  records: adaptiveRecords,
});
assert.equal(adaptive.capacityPolicy.profile, "adaptive-28-4");
assert.equal(adaptive.adaptiveProof.passed, true);
assert.equal(adaptive.adaptiveProof.passedSeeds, 2);
assert.equal(adaptive.adaptiveProof.zeroUpstream429Seeds, 2);
assert.equal(adaptive.adaptiveProof.interactiveTargetSeeds, 2);
assert.equal(adaptive.adaptiveProof.batchTargetSeeds, 2);
assert.equal(adaptive.adaptiveProof.occupancyObservedSeeds, 2);
assert.equal(adaptive.adaptiveProof.controllerObservedSeeds, 2);
assert.equal(adaptive.adaptiveProof.floorRestoredSeeds, 2);
assert.equal(adaptive.adaptiveProof.controllerFloorRestoredSeeds, 2);
assert.equal(adaptive.adaptiveProof.dataPlaneFloorRestoredSeeds, 2);
assert.equal(adaptive.adaptiveProof.handoffObservedSeeds, 2);
assert.equal(adaptive.adaptiveProof.handoffCommittedSeeds, 2);
assert.equal(adaptive.adaptiveProof.safeHandoffSeeds, 2);
assert.equal(adaptive.adaptiveProof.commitBeforeAdmissionSeeds, 2);
assert.equal(adaptive.adaptiveProof.admissionOrderViolationSeeds, 0);
assert.equal(adaptive.aggregate.lending.batchFloorAdmissionGapMaxMs.median, 150);
assert.equal(adaptive.aggregate.lending.batchFloorResponseHeadersGapMs.median, 750);
assert.equal(adaptive.aggregate.lending.commitToFirstBatchAdmissionMaxMs.median, 150);
assert.equal(adaptive.aggregate.lending.commitToFirstBatchResponseHeadersMs.median, 250);
assert.equal(adaptive.adaptiveProof.handoffWithinSafetyDeadlineSeeds, 2);
assert.equal(adaptive.adaptiveProof.handoffBeatLeaseExpirySeeds, 0);
assert.equal(adaptive.adaptiveProof.noAppliedOverallocationSeeds, 2);
assert.equal(adaptive.adaptiveProof.batchServedSeeds, 2);
assert.equal(adaptiveProofFailureMessage(adaptive.adaptiveProof), null);

const inconclusiveAdmissionRecords = structuredClone(adaptiveRecords);
inconclusiveAdmissionRecords[1].moflux.lending.controlPlane.handoff.commitBeforeBatchAdmission = null;
inconclusiveAdmissionRecords[1].moflux.lending.controlPlane.handoff.admissionOrderingStatus = "inconclusive";
const inconclusiveAdmission = buildSweepSummary({
  mode: "compare",
  fault: false,
  seeds: [1, 2],
  records: inconclusiveAdmissionRecords,
});
assert.equal(inconclusiveAdmission.adaptiveProof.passed, false);
assert.equal(inconclusiveAdmission.adaptiveProof.commitBeforeAdmissionSeeds, 1);
assert.equal(inconclusiveAdmission.adaptiveProof.admissionOrderInconclusiveSeeds, 1);
assert.equal(inconclusiveAdmission.adaptiveProof.admissionOrderViolationSeeds, 0);
assert.match(
  adaptiveProofFailureMessage(inconclusiveAdmission.adaptiveProof),
  /commit-before-batch-admission ordering inconclusive/,
);

const violatedAdmissionRecords = structuredClone(adaptiveRecords);
violatedAdmissionRecords[1].moflux.lending.controlPlane.handoff.commitBeforeBatchAdmission = false;
violatedAdmissionRecords[1].moflux.lending.controlPlane.handoff.admissionOrderingStatus = "proven_before_commit";
const violatedAdmission = buildSweepSummary({
  mode: "compare",
  fault: false,
  seeds: [1, 2],
  records: violatedAdmissionRecords,
});
assert.equal(violatedAdmission.adaptiveProof.passed, false);
assert.equal(violatedAdmission.adaptiveProof.admissionOrderViolationSeeds, 1);
assert.match(adaptiveProofFailureMessage(violatedAdmission.adaptiveProof), /batch admission proven before handoff commit/);

const partialOccupancyRecords = structuredClone(adaptiveRecords);
partialOccupancyRecords[1].moflux.lending.idleWindow.borrowed = false;
const partialOccupancy = buildSweepSummary({
  mode: "compare",
  fault: false,
  seeds: [1, 2],
  records: partialOccupancyRecords,
});
assert.equal(partialOccupancy.adaptiveProof.passed, true);
assert.equal(partialOccupancy.adaptiveProof.occupancyObservedSeeds, 1);

const failedAdaptiveRecords = structuredClone(adaptiveRecords);
failedAdaptiveRecords[1].moflux.lending.controlPlane.floorRestored = false;
const failedAdaptive = buildSweepSummary({
  mode: "compare",
  fault: false,
  seeds: [1, 2],
  records: failedAdaptiveRecords,
});
assert.equal(failedAdaptive.adaptiveProof.passed, false);
assert.match(adaptiveProofFailureMessage(failedAdaptive.adaptiveProof), /seed 2: batch floor not restored/);
const lowBatchRecords = structuredClone(adaptiveRecords);
lowBatchRecords[0].moflux.classes.batch.successRate = 0.05;
lowBatchRecords[0].moflux.classes.batch.success = 3;
const lowBatch = buildSweepSummary({
  mode: "compare",
  fault: false,
  seeds: [1, 2],
  records: lowBatchRecords,
});
assert.equal(lowBatch.adaptiveProof.passed, false);
assert.match(adaptiveProofFailureMessage(lowBatch.adaptiveProof), /batch completions 3 < protected floor 4/);
const noOccupancyRecords = structuredClone(adaptiveRecords);
for (const record of noOccupancyRecords) record.moflux.lending.idleWindow.borrowed = false;
const noOccupancy = buildSweepSummary({
  mode: "compare",
  fault: false,
  seeds: [1, 2],
  records: noOccupancyRecords,
});
assert.equal(noOccupancy.adaptiveProof.passed, false);
assert.match(
  adaptiveProofFailureMessage(noOccupancy.adaptiveProof),
  /no seed showed idle occupancy above the static 28-slot floor/,
);
assert.equal(adaptiveProofFailureMessage(null), "the run did not use --capacity-profile=adaptive-28-4");

const mismatchedRecords = structuredClone(records);
mismatchedRecords[1].moflux.capacity.batchTokenPercent = 30;
assert.throws(
  () => buildSweepSummary({ mode: "compare", fault: false, seeds: [1, 2], records: mismatchedRecords }),
  /changed the MoFlux capacity policy/,
);

console.log("PASS  seed sweep parsing and aggregation");
