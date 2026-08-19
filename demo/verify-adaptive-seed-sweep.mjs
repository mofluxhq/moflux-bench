#!/usr/bin/env node
/** End-to-end acceptance-gate regression using a deterministic fake presenter. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(path.join(tmpdir(), "moflux-adaptive-sweep-"));
const fake = path.join(temp, "fake-adaptive-presenter.mjs");

writeFileSync(
  fake,
  String.raw`import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const args = new Map();
for (const arg of process.argv.slice(2)) {
  const match = /^--([^=]+)=(.*)$/.exec(arg);
  if (match) args.set(match[1], match[2]);
  else if (arg.startsWith("--")) args.set(arg.slice(2), "true");
}
if (args.get("capacity-profile") !== "adaptive-28-4") {
  throw new Error("adaptive capacity profile was not forwarded");
}
const seed = Number(args.get("seed"));
const fail = process.env.FAIL_ADAPTIVE_SEED === String(seed);
const results = process.env.MOFLUX_BENCH_RESULTS_DIR;
mkdirSync(results, { recursive: true });
const trace = {
  version: 2,
  hash: "adaptive-trace-" + seed,
  planned: { interactive: 10, batch: 10, total: 20 },
  workload: { durationMs: 10000, seed, interactiveRps: 6, sizeDistribution: "lognormal" },
  entries: [],
};
const scenario = {
  id: "adaptive-scenario-" + seed,
  workload: { durationMs: 10000, seed, interactiveRps: 6, sizeDistribution: "lognormal" },
  provider: { api: "anthropic", envelope: 32, seed, sigma: 0.25 },
  trace: { version: 2, hash: trace.hash, planned: trace.planned, evidence: "results/scenario-trace.json" },
};
function rejectionSnapshots(count, cls) {
  return Array.from({ length: count }, (_, index) => ({
    requestId: cls + "-reject-" + index,
    requestClass: cls,
    attempt: 1,
    rejectedAtMs: 100 + index,
    target: "http://127.0.0.1:8100",
    type: "admission_rejected",
    pool: "sim-" + cls,
    reason: "concurrency_limit",
    admissionClass: null,
    admissionRevision: 1,
    retryAfterMs: null,
    grant: null,
    detail: { limitRevision: 1, constraint: "global", inFlight: 1, maxConcurrent: 1, pending: 0, maxQueue: 0 },
  }));
}
function classes(managed) {
  const interactiveRejects = managed ? 1 : 0;
  const batchRejects = managed ? 8 : 0;
  return {
    interactive: {
      logical: 10,
      successRate: managed ? 0.95 : 0.65,
      success: managed ? 9 : 6,
      retryAmplification: managed ? 1.2 : 2.2,
      localReject: interactiveRejects,
      localRejectConstraints: interactiveRejects > 0 ? { global: interactiveRejects } : {},
      localRejectSnapshots: rejectionSnapshots(interactiveRejects, "interactive"),
      upstreamReject: managed ? 0 : 12,
      latencyMs: { p50: managed ? 600 : 1000, p95: managed ? 1200 : 2000, p99: managed ? 1200 : 2000 },
      ttftMs: { p50: 100, p95: 200, p99: 200 },
    },
    batch: {
      logical: 10,
      successRate: managed ? (fail ? 0.05 : 0.2) : 0.5,
      success: managed ? (fail ? 0 : 4) : 5,
      retryAmplification: 1.5,
      localReject: batchRejects,
      localRejectConstraints: batchRejects > 0 ? { global: batchRejects } : {},
      localRejectSnapshots: rejectionSnapshots(batchRejects, "batch"),
      upstreamReject: 0,
      latencyMs: { p50: 2000, p95: 3000, p99: 3000 },
      ttftMs: { p50: 300, p95: 400, p99: 400 },
    },
  };
}
const baseline = {
  arm: "baseline-no-control",
  config: { durationMs: 10000 },
  classes: classes(false),
  simCounters: { peakActive: 32 },
  scenario,
  trace: { hash: trace.hash },
};
const moflux = {
  arm: "moflux-enforce",
  config: { durationMs: 10000 },
  classes: classes(true),
  simCounters: { peakActive: 32 },
  scenario,
  trace: { hash: trace.hash },
  capacity: {
    profile: "adaptive-28-4",
    policy: "interactive-first-demand-aware",
    batchFloorPercent: null,
    batchConcurrencySlots: 4,
    interactiveConcurrencySlots: 28,
    batchConcurrencyPercent: 12.5,
    batchTokenPercent: 62.5,
    envelope: 32,
    tokenBudget: 64000,
    capacityGroup: { name: "sim-workloads" },
    demandPolicy: { enabled: true, reportStaleAfterMs: 6000, idleAfterMs: 3000, maxStarvationMs: 5000 },
    pools: [
      { name: "sim-interactive", guaranteedMaxConcurrent: 28, guaranteedTokenBudget: 24000, ceilingMaxConcurrent: 32, ceilingTokenBudget: 64000, agentCount: 4 },
      { name: "sim-batch", guaranteedMaxConcurrent: 4, guaranteedTokenBudget: 40000, ceilingMaxConcurrent: 32, ceilingTokenBudget: 64000, agentCount: 1 },
    ],
  },
  lending: {
    idleWindow: { borrowed: true, borrowedSlots: 4 },
    floorReassertion: {
      admissionGapMinMs: fail ? null : 50,
      admissionGapMaxMs: fail ? null : 150,
      responseHeadersGapMs: fail ? null : 800,
    },
    controlPlane: {
      lendingObserved: true,
      floorRestored: !fail,
      restorationDurationMs: fail ? null : 500,
      handoff: {
        observed: true,
        committedAt: fail ? null : "2026-08-08T20:00:27.900Z",
        firstBatchAdmissionWindow: fail ? null : {
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
        aborted: fail,
        abortReason: fail ? "prepared_grant_expired" : null,
        safeEventOrder: !fail,
        commitBeforeBatchAdmission: fail ? null : true,
        admissionOrderingStatus: fail ? "unobserved" : "proven_after_commit",
        committedBeforeSafetyDeadline: !fail,
        committedBeforeLeaseExpiry: false,
        handoffDurationMs: fail ? null : 450,
        demandToDrainStartMs: fail ? null : 100,
        drainStartToAcknowledgedMs: fail ? null : 150,
        acknowledgedToCommitMs: fail ? null : 200,
        commitToFirstBatchAdmissionMinMs: fail ? null : 50,
        commitToFirstBatchAdmissionMaxMs: fail ? null : 150,
        demandToFirstBatchAdmissionMinMs: fail ? null : 500,
        demandToFirstBatchAdmissionMaxMs: fail ? null : 600,
        commitToFirstBatchResponseHeadersMs: fail ? null : 250,
        demandToFirstBatchResponseHeadersMs: fail ? null : 700,
        leaseTimeAvoidedMs: fail ? null : 0,
        predecessorLeaseLeadMs: fail ? null : -200,
        safetyTimeRemainingMs: fail ? null : 59300,
        appliedCapacity: { noAppliedOverallocation: !fail },
      },
    },
  },
  tokenAccounting: {
    totalReserved: 1000,
    totalConsumed: 800,
    totalRefunded: 200,
    totalOverrun: 0,
    grossRecoveryRate: 0.2,
    netRecovered: 200,
    netRecoveryRate: 0.2,
    progressiveReports: 8,
    progressiveUpdates: 4,
    progressiveCoalesced: 4,
    progressiveEarlyReleasedTokens: 150,
    progressiveEarlyReleaseRate: 0.75,
    progressiveConfiguration: { enabled: true, updateStepTokens: 256, outputSafetyMarginTokens: 256 },
  },
};
const comparison = {
  scenario,
  metrics: {
    interactiveSuccessPercentagePointChange: 30,
    interactiveGoodputChangePercent: 50,
    interactiveP95LatencyChangePercent: -40,
    interactiveTailRatioBaseline: 2,
    interactiveTailRatioMoflux: 2,
    interactiveTailInflationChangePercent: 0,
    upstream429Baseline: 12,
    upstream429Moflux: 0,
  },
};
writeFileSync(path.join(results, "baseline.json"), JSON.stringify(baseline));
writeFileSync(path.join(results, "moflux-enforce.json"), JSON.stringify(moflux));
writeFileSync(path.join(results, "video-comparison.json"), JSON.stringify(comparison));
writeFileSync(path.join(results, "scenario-trace.json"), JSON.stringify(trace));
`,
);

async function run(results, failSeed = null) {
  mkdirSync(results, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join(ROOT, "demo", "seed-sweep.mjs"),
        "--seeds=1-2",
        "--pause-ms=0",
        "--no-open",
        "--cleanup",
        "--capacity-profile=adaptive-28-4",
        "--require-adaptive-proof",
      ],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          MOFLUX_BENCH_PRESENTER: fake,
          MOFLUX_BENCH_RESULTS_DIR: results,
          ...(failSeed === null ? {} : { FAIL_ADAPTIVE_SEED: String(failSeed) }),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}


try {
  const passingResults = path.join(temp, "passing");
  const passing = await run(passingResults);
  assert.equal(passing.code, 0, passing.stderr || passing.stdout);
  const pointer = JSON.parse(
    readFileSync(path.join(passingResults, "runs", "video-seed-sweep", "latest.json"), "utf8"),
  );
  const passingSummary = JSON.parse(
    readFileSync(path.join(passingResults, "runs", "video-seed-sweep", pointer.runId, "summary.json"), "utf8"),
  );
  assert.equal(passingSummary.adaptiveProof.passed, true);
  assert.equal(passingSummary.adaptiveProof.passedSeeds, 2);
  assert.equal(passingSummary.adaptiveProof.batchTargetSeeds, 2);

  const failingResults = path.join(temp, "failing");
  const failing = await run(failingResults, 2);
  assert.notEqual(failing.code, 0);
  assert.match(failing.stderr, /adaptive 28\/4 acceptance gate failed/);
  assert.match(failing.stderr, /seed 2: batch completions 0 < protected floor 4, batch floor not restored, handoff aborted \(prepared_grant_expired\), applied capacity safety not proven, no batch success/);
  assert.equal(
    existsSync(path.join(failingResults, "runs", "video-seed-sweep", "latest.json")),
    false,
    "a failed adaptive run must not become the latest successful run",
  );
  const runRoot = path.join(failingResults, "runs", "video-seed-sweep");
  const runDir = readdirSync(runRoot, { withFileTypes: true })
    .find((entry) => entry.isDirectory());
  assert.ok(runDir);
  const failedSummary = JSON.parse(
    readFileSync(path.join(runRoot, runDir.name, "summary.json"), "utf8"),
  );
  assert.equal(failedSummary.adaptiveProof.passed, false);
  assert.equal(failedSummary.adaptiveProof.passedSeeds, 1);

  console.log("PASS  adaptive seed-sweep acceptance gate and evidence preservation");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
