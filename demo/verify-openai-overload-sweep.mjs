#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateOpenAiOverloadCompareSummaries,
  counterbalancedArmOrderForSeed,
  summarizeArm,
} from "./openai-overload-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SWEEP = path.join(ROOT, "demo", "openai-overload-sweep.mjs");

function successRecord(workloadClass, requestId, ttftMs, latencyMs) {
  return {
    workloadClass,
    requestId,
    ok: true,
    status: 200,
    providerAttempted: true,
    rejectionOrigin: null,
    failureOrigin: null,
    ttftMs,
    latencyMs,
    promptTokens: 20,
    completionTokens: 4,
    actualCostUsd: 0.00001,
  };
}

function localReject(workloadClass, requestId, origin) {
  return {
    workloadClass,
    requestId,
    ok: false,
    status: 429,
    providerAttempted: false,
    rejectionOrigin: origin,
    failureOrigin: null,
    ttftMs: null,
    latencyMs: 1,
    promptTokens: 0,
    completionTokens: 0,
    actualCostUsd: 0,
  };
}

function provider429(workloadClass, requestId) {
  return {
    workloadClass,
    requestId,
    ok: false,
    status: 429,
    providerAttempted: true,
    rejectionOrigin: "provider_429",
    failureOrigin: "provider",
    ttftMs: null,
    latencyMs: 5,
    promptTokens: 0,
    completionTokens: 0,
    actualCostUsd: 0,
  };
}

function makeSummary(seed, { staticInteractiveSuccesses, mofluxInteractiveSuccesses }) {
  const armOrder = counterbalancedArmOrderForSeed(seed);
  const directRecords = [
    successRecord("interactive", `s${seed}-i-1`, 100 + seed, 150 + seed),
    successRecord("interactive", `s${seed}-i-2`, 110 + seed, 160 + seed),
    provider429("interactive", `s${seed}-i-3`),
    successRecord("batch", `s${seed}-b-1`, 120 + seed, 170 + seed),
    provider429("batch", `s${seed}-b-2`),
  ];

  const staticInteractive = [
    successRecord("interactive", `s${seed}-i-1`, 130 + seed, 180 + seed),
    successRecord("interactive", `s${seed}-i-2`, 140 + seed, 190 + seed),
    successRecord("interactive", `s${seed}-i-3`, 150 + seed, 200 + seed),
  ];
  while (staticInteractive.filter((record) => record.ok).length > staticInteractiveSuccesses) {
    const index = staticInteractive.findLastIndex((record) => record.ok);
    staticInteractive[index] = localReject("interactive", staticInteractive[index].requestId, "static_local");
  }
  const staticRecords = [
    ...staticInteractive,
    successRecord("batch", `s${seed}-b-1`, 160 + seed, 210 + seed),
    localReject("batch", `s${seed}-b-2`, "static_local"),
  ];

  const mofluxInteractive = [
    successRecord("interactive", `s${seed}-i-1`, 105 + seed, 155 + seed),
    successRecord("interactive", `s${seed}-i-2`, 115 + seed, 165 + seed),
    successRecord("interactive", `s${seed}-i-3`, 125 + seed, 175 + seed),
  ];
  while (mofluxInteractive.filter((record) => record.ok).length > mofluxInteractiveSuccesses) {
    const index = mofluxInteractive.findLastIndex((record) => record.ok);
    mofluxInteractive[index] = localReject("interactive", mofluxInteractive[index].requestId, "moflux_local");
  }
  const mofluxRecords = [
    ...mofluxInteractive,
    localReject("batch", `s${seed}-b-1`, "moflux_local"),
    localReject("batch", `s${seed}-b-2`, "moflux_local"),
  ];

  const elapsedMs = 1000;
  const aggregateByArm = {
    direct: summarizeArm(directRecords, elapsedMs),
    static: summarizeArm(staticRecords, elapsedMs),
    moflux: summarizeArm(mofluxRecords, elapsedMs),
  };
  const aggregate = Object.fromEntries(armOrder.map((arm) => [arm, aggregateByArm[arm]]));
  const recordsByArm = { direct: directRecords, static: staticRecords, moflux: mofluxRecords };

  return {
    schemaVersion: 1,
    benchmark: "openai-live-overload",
    generatedAt: `2026-08-29T19:00:0${seed}.000Z`,
    mode: "compare",
    runtime: { tyr: "0.28.0", model: "gpt-5.6-luna" },
    workload: {
      runs: 1,
      seed,
      durationMs: 1000,
      interactiveRps: 3,
      batchRps: 2,
      batchStartMs: 0,
      batchDurationMs: 1000,
      jitterFraction: 0.05,
      interactiveInputChars: 64,
      batchInputChars: 64,
      interactiveMaxOutputTokens: 8,
      batchMaxOutputTokens: 8,
      retryPolicy: "none",
      traceFingerprints: [`trace-${seed}`],
    },
    policies: {
      static: { maxConcurrent: 2, maxQueue: 0 },
      moflux: {
        maxConcurrent: 2,
        maxQueue: 0,
        admissionClasses: {
          interactive: { protectedConcurrent: 1, maxConcurrent: 2 },
          batch: { protectedConcurrent: 1, maxConcurrent: 2 },
        },
      },
    },
    budget: {
      plannedRequests: 15,
      workloadRequests: 15,
      recoveryProbeBudget: 0,
      worstCaseUsd: 0.01,
      hardRunCapUsd: 0.10,
      measuredSuccessfulUsageCostUsd: 0.001,
      pricingUsdPerMillionTokens: { input: 0.2, output: 1.2 },
    },
    rateLimitIsolation: {
      targetRatio: 0.99,
      expectedGates: 3,
      passed: true,
      gates: [],
    },
    aggregate,
    interpretation: {
      directProviderPressureObserved: true,
      localAdmissionContentionObserved: true,
      mofluxAdmissionClassProof: true,
      rateLimitIsolationPassed: true,
      conclusiveProviderOverloadComparison: true,
      inconclusiveReasons: [],
    },
    acceptance: {
      executionCompleted: true,
      matchedTraceByRun: true,
      mofluxAdmissionClassProof: true,
      rateLimitIsolationPassed: true,
    },
    runs: [{
      run: 1,
      seed,
      fingerprint: `trace-${seed}`,
      armOrder,
      arms: Object.fromEntries(armOrder.map((arm) => [arm, { elapsedMs, records: recordsByArm[arm] }])),
    }],
  };
}

async function runSweep(args) {
  const child = spawn(process.execPath, [SWEEP, ...args], {
    cwd: ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, stdout, stderr };
}

const seed1 = makeSummary(1, { staticInteractiveSuccesses: 2, mofluxInteractiveSuccesses: 3 });
const seed2 = makeSummary(2, { staticInteractiveSuccesses: 1, mofluxInteractiveSuccesses: 3 });
const unified = aggregateOpenAiOverloadCompareSummaries(
  [seed1, seed2],
  { sourceFiles: ["seed-1/summary.json", "seed-2/summary.json"] },
);

assert.equal(unified.benchmark, "openai-live-overload-sweep");
assert.deepEqual(unified.workload.seeds, [1, 2]);
assert.equal(unified.validation.allConclusive, true);
assert.equal(unified.validation.allRateLimitIsolationPassed, true);
assert.equal(unified.validation.directPressureEverySeed, true);
assert.equal(unified.validation.controlledProvider429FreeEverySeed, true);
assert.equal(unified.validation.mofluxInteractiveAdvantageEverySeed, true);
assert.equal(unified.aggregate.direct.provider429s, 4);
assert.equal(unified.aggregate.static.classes.interactive.success, 3);
assert.equal(unified.aggregate.static.classes.interactive.offered, 6);
assert.equal(unified.aggregate.moflux.classes.interactive.success, 6);
assert.equal(unified.aggregate.moflux.classes.interactive.offered, 6);
assert.equal(unified.aggregate.moflux.classes.interactive.successRate, 1);
assert.equal(unified.aggregate.static.classes.interactive.successRate, 0.5);
assert.equal(unified.pairedSeedResults.length, 2);
assert.deepEqual(unified.pairedSeedResults[0].armOrder, ["direct", "static", "moflux"]);
assert.deepEqual(unified.pairedSeedResults[1].armOrder, ["static", "moflux", "direct"]);
assert.equal(unified.pairedSummary.interactiveSuccessAdvantagePp.median, 50);
assert.deepEqual(unified.sources, [
  { seed: 1, file: "seed-1/summary.json", traceFingerprint: "trace-1" },
  { seed: 2, file: "seed-2/summary.json", traceFingerprint: "trace-2" },
]);


const expectedOrders = [
  ["direct", "static", "moflux"],
  ["static", "moflux", "direct"],
  ["moflux", "direct", "static"],
  ["direct", "moflux", "static"],
  ["static", "direct", "moflux"],
  ["moflux", "static", "direct"],
];
for (let seed = 1; seed <= expectedOrders.length; seed += 1) {
  assert.deepEqual(counterbalancedArmOrderForSeed(seed), expectedOrders[seed - 1]);
}
const eightSeedUnified = aggregateOpenAiOverloadCompareSummaries(
  Array.from({ length: 8 }, (_, index) => makeSummary(index + 1, {
    staticInteractiveSuccesses: 2,
    mofluxInteractiveSuccesses: 3,
  })),
);
assert.equal(eightSeedUnified.validation.counterbalancedArmOrdering, true);
assert.equal(eightSeedUnified.interpretation.conclusiveProviderOverloadSweep, true);
assert.equal(unified.validation.counterbalancedArmOrdering, false);
assert.equal(unified.interpretation.conclusiveProviderOverloadSweep, false);
assert.deepEqual(eightSeedUnified.experimentalDesign.armOrdering.positionCounts, {
  direct: [3, 2, 3],
  static: [3, 3, 2],
  moflux: [2, 3, 3],
});
assert.equal(eightSeedUnified.experimentalDesign.armOrdering.allArmsSeenInEveryPosition, true);
assert.equal(eightSeedUnified.experimentalDesign.armOrdering.positionCountSpreadWithinOne, true);

assert.throws(
  () => aggregateOpenAiOverloadCompareSummaries([seed1, { ...seed1 }]),
  /duplicate seeds/,
);
const mismatched = structuredClone(seed2);
mismatched.policies.static.maxConcurrent = 3;
assert.throws(
  () => aggregateOpenAiOverloadCompareSummaries([seed1, mismatched]),
  /policies differ/,
);
const inconclusive = structuredClone(seed2);
inconclusive.interpretation.conclusiveProviderOverloadComparison = false;
assert.throws(
  () => aggregateOpenAiOverloadCompareSummaries([seed1, inconclusive]),
  /not a conclusive provider-overload comparison/,
);

const dry = await runSweep([
  "--dry-run",
  "--seeds=1-2",
  "--duration-ms=1000",
  "--interactive-rps=1",
  "--batch-rps=1",
  "--batch-start-ms=0",
  "--batch-duration-ms=1000",
  "--interactive-input-chars=64",
  "--batch-input-chars=64",
  "--interactive-max-output-tokens=8",
  "--batch-max-output-tokens=8",
  "--static-cap=2",
  "--moflux-max-concurrent=2",
  "--interactive-floor=1",
  "--batch-floor=1",
  "--max-usd-per-seed=0.10",
  "--max-sweep-usd=0.20",
]);
assert.equal(dry.code, 0, `${dry.stdout}\n${dry.stderr}`);
assert.match(dry.stdout, /seed 1 .*order=direct -> static -> moflux/);
assert.match(dry.stdout, /seed 2 .*order=static -> moflux -> direct/);
assert.match(dry.stdout, /PASS sweep dry-run: 2 independently guarded seed plans validated/);

const budgetRefusal = await runSweep([
  "--dry-run",
  "--seeds=1-8",
  "--max-usd-per-seed=0.20",
  "--max-sweep-usd=1.50",
]);
assert.notEqual(budgetRefusal.code, 0);
assert.match(`${budgetRefusal.stdout}\n${budgetRefusal.stderr}`, /above --max-sweep-usd/);

console.log("PASS OpenAI overload multi-seed sweep counterbalanced ordering, aggregation, mismatch guards, dry-run orchestration, and aggregate spend guard");
