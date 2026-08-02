#!/usr/bin/env node
import assert from "node:assert/strict";
import { armMetrics, buildSweepSummary, median, parseSeedSpec, summarize } from "./seed-sweep-lib.mjs";

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
      provider: { envelope: 32, seed, sigma: 0.25 },
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
assert.equal(armMetrics(baseline1).interactiveTailRatio, 2);
assert.equal(aggregate.capacityPolicy.policy, "interactive-first-static");
assert.equal(aggregate.capacityPolicy.interactiveConcurrencySlots, 31);
assert.equal(aggregate.capacityPolicy.batchConcurrencySlots, 1);
assert.equal(aggregate.capacityPolicy.batchConcurrencyPercent, 3.125);
assert.equal(aggregate.capacityPolicy.pools[1].agentCount, 1);
const mismatchedRecords = structuredClone(records);
mismatchedRecords[1].moflux.capacity.batchTokenPercent = 30;
assert.throws(
  () => buildSweepSummary({ mode: "compare", fault: false, seeds: [1, 2], records: mismatchedRecords }),
  /changed the MoFlux capacity policy/,
);

console.log("PASS  seed sweep parsing and aggregation");
