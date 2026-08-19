#!/usr/bin/env node
/** End-to-end seed-sweep orchestration regression using a fake single-pair presenter. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { publishRun } from "./publish-evidence-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(path.join(tmpdir(), "moflux-seed-sweep-"));
const results = path.join(temp, "results");
const fake = path.join(temp, "fake-presenter.mjs");
const pointerFile = path.join(results, "runs", "video-seed-sweep", "latest.json");
// Reviewed evidence paths. A run must leave these untouched; the whole point
// of the run directory is that nothing writes them by accident.
const reviewedSummary = path.join(results, "video-seed-sweep.json");
const reviewedDir = path.join(results, "video-seed-sweep");

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
const seed = Number(args.get("seed"));
const results = process.env.MOFLUX_BENCH_RESULTS_DIR;
mkdirSync(results, { recursive: true });
const trace = {
  version: 1,
  hash: "trace-" + seed,
  planned: { interactive: 10, batch: 5, total: 15 },
  workload: { durationMs: 10000, seed, interactiveRps: 6 },
  entries: [],
};
const scenario = {
  id: "scenario-" + seed,
  workload: { durationMs: 10000, seed, interactiveRps: 6 },
  provider: { api: "anthropic", envelope: 32, seed, sigma: 0.25 },
  trace: { version: 1, hash: trace.hash, planned: trace.planned, evidence: "results/scenario-trace.json" },
};
function rejectionSnapshots(count) {
  return Array.from({ length: count }, (_, index) => ({
    requestId: "interactive-reject-" + index,
    requestClass: "interactive",
    attempt: 1,
    rejectedAtMs: 100 + index,
    target: "http://127.0.0.1:8100",
    type: "admission_rejected",
    pool: "sim-interactive",
    reason: "concurrency_limit",
    admissionClass: null,
    admissionRevision: 1,
    retryAfterMs: null,
    grant: null,
    detail: { limitRevision: 1, constraint: "global", inFlight: 1, maxConcurrent: 1, pending: 0, maxQueue: 0 },
  }));
}
function arm(name, successRate, success, p95, upstream, tokenAccounting) {
  const localReject = name === "baseline" ? 0 : 4;
  return {
    arm: name,
    seed,
    config: { durationMs: 10000 },
    generatorSaturated: 0,
    trace: { version: 1, hash: trace.hash, planned: trace.planned, source: "scenario-trace.json" },
    classes: {
      interactive: {
        logical: 10, successRate, success, retryAmplification: 1.2, localReject,
        localRejectConstraints: localReject > 0 ? { global: localReject } : {},
        localRejectSnapshots: rejectionSnapshots(localReject),
        upstreamReject: upstream, latencyMs: { p50: 1000, p95, p99: p95 },
        ttftMs: { p50: 100, p95: 200, p99: 200 },
      },
      batch: {
        logical: 5, successRate: 0.5, success: 5, retryAmplification: 1.5, localReject: 0,
        localRejectConstraints: {}, localRejectSnapshots: [],
        upstreamReject: 0, latencyMs: { p50: 2000, p95: 3000, p99: 3000 },
        ttftMs: { p50: 300, p95: 400, p99: 400 },
      },
    },
    simCounters: { peakActive: 32 },
    scenario,
    ...(tokenAccounting ? {
      tokenAccounting,
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
    } : {}),
  };
}
const baseline = arm("baseline", 0.6 + seed / 100, 6 + seed, 2000, 10 + seed, null);
const tokenAccounting = {
  totalReserved: 1000 + seed,
  totalConsumed: 750,
  totalRefunded: 250 + seed,
  totalOverrun: 0,
  grossRecoveryRate: (250 + seed) / (1000 + seed),
  netRecovered: 250 + seed,
  netRecoveryRate: (250 + seed) / (1000 + seed),
  progressiveReports: 8,
  progressiveUpdates: 4,
  progressiveCoalesced: 4,
  progressiveEarlyReleasedTokens: 125 + seed,
  progressiveEarlyReleaseRate: (125 + seed) / (250 + seed),
  progressiveConfiguration: {
    enabled: true,
    updateStepTokens: 256,
    outputSafetyMarginTokens: 256,
  },
};
const moflux = arm("moflux", 0.8 + seed / 100, 8 + seed, 1200, 0, tokenAccounting);
const comparison = {
  generatedAt: new Date().toISOString(),
  scenario,
  metrics: {
    interactiveSuccessPercentagePointChange: 20,
    interactiveGoodputChangePercent: 25,
    interactiveP95LatencyChangePercent: -40,
    interactiveTailRatioBaseline: 2,
    interactiveTailRatioMoflux: 1.2,
    interactiveTailInflationChangePercent: -40,
    upstream429Baseline: 10 + seed,
    upstream429Moflux: 0,
  },
};
writeFileSync(path.join(results, "baseline.json"), JSON.stringify(baseline));
writeFileSync(path.join(results, "moflux-enforce.json"), JSON.stringify(moflux));
writeFileSync(path.join(results, "video-comparison.json"), JSON.stringify(comparison));
writeFileSync(path.join(results, "scenario-trace.json"), JSON.stringify(trace));
`,
);

async function run() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(ROOT, "demo", "seed-sweep.mjs"), "--seeds=2,4", "--pause-ms=0", "--no-open", "--cleanup"],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          MOFLUX_BENCH_PRESENTER: fake,
          MOFLUX_BENCH_RESULTS_DIR: results,
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
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

try {
  const result = await run();
  if (result.code !== 0) {
    throw new Error(`seed sweep exited ${result.code ?? result.signal}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }

  assert.equal(existsSync(pointerFile), true, "the sweep must record its latest run");
  const pointer = JSON.parse(readFileSync(pointerFile, "utf8"));
  const sweepDir = path.join(results, "runs", "video-seed-sweep", pointer.runId);
  const summaryFile = path.join(sweepDir, "summary.json");
  assert.ok(existsSync(summaryFile));
  const summary = JSON.parse(readFileSync(summaryFile, "utf8"));
  assert.deepEqual(summary.seeds, [2, 4]);
  assert.equal(summary.runs.length, 2);
  assert.equal(summary.aggregate.arms.baseline.interactiveSuccessRate.n, 2);
  assert.equal(summary.aggregate.paired.upstream429Baseline.min, 12);
  assert.equal(summary.aggregate.paired.upstream429Baseline.max, 14);
  assert.equal(summary.capacityPolicy.policy, "interactive-first-static");
  assert.equal(summary.capacityPolicy.interactiveConcurrencySlots, 31);
  assert.equal(summary.capacityPolicy.batchConcurrencySlots, 1);
  assert.equal(summary.capacityPolicy.batchTokenPercent, 25);
  assert.equal(summary.capacityPolicy.pools[1].agentCount, 1);
  assert.equal(summary.scenarioTemplate.provider.api, "anthropic");
  assert.deepEqual(summary.aggregate.tokenAccounting.progressiveConfiguration, {
    enabled: true,
    updateStepTokens: 256,
    outputSafetyMarginTokens: 256,
  });
  assert.equal(summary.aggregate.tokenAccounting.progressiveReports.median, 8);
  assert.ok(existsSync(path.join(sweepDir, "baseline-seed-2.json")));
  assert.ok(existsSync(path.join(sweepDir, "moflux-enforce-seed-4.json")));
  assert.ok(existsSync(path.join(sweepDir, "comparison-seed-4.json")));
  assert.ok(existsSync(path.join(sweepDir, "trace-seed-4.json")));
  for (const file of ["baseline.json", "moflux-enforce.json", "video-comparison.json", "scenario-trace.json"]) {
    assert.equal(existsSync(path.join(results, file)), false, `${file} leaked into the results root`);
    assert.equal(existsSync(path.join(sweepDir, "scratch", file)), false, `${file} survived in scratch`);
  }

  // The regression this file exists to prevent: a sweep silently replacing
  // reviewed evidence that had already been published under another runtime.
  assert.equal(existsSync(reviewedSummary), false, "the sweep wrote reviewed evidence");
  assert.equal(existsSync(reviewedDir), false, "the sweep wrote the reviewed evidence directory");
  for (const value of Object.values(summary.runs[0].arms)) {
    assert.ok(
      value.startsWith(`${path.basename(results)}/runs/video-seed-sweep/`)
        || value.includes("/runs/video-seed-sweep/"),
      `arm pointer escaped the run directory: ${value}`,
    );
  }

  // Promotion is the only path to reviewed evidence, and it refuses to replace
  // an existing copy without --force.
  // `root` is what both sides express paths relative to; the sweep used the
  // repo root, so promotion must too.
  const published = publishRun({
    root: ROOT,
    resultsRoot: results,
    runDir: sweepDir,
    name: "video-seed-sweep",
  });
  assert.equal(published.replaced, false);
  assert.equal(existsSync(reviewedSummary), true);
  assert.equal(existsSync(path.join(reviewedDir, "baseline-seed-2.json")), true);
  const promoted = JSON.parse(readFileSync(reviewedSummary, "utf8"));
  const expectedBaseline = path
    .relative(ROOT, path.join(reviewedDir, "baseline-seed-2.json"))
    .split(path.sep)
    .join("/");
  assert.equal(promoted.runs[0].arms.baseline, expectedBaseline);
  assert.equal(
    promoted.runs[0].scenario.trace.evidence,
    promoted.runs[0].arms.trace,
    "the published trace pointer must name a file that was published",
  );
  assert.throws(
    () => publishRun({ root: ROOT, resultsRoot: results, runDir: sweepDir, name: "video-seed-sweep" }),
    /already exists/,
    "publishing over existing evidence must require --force",
  );
  const forced = publishRun({
    root: ROOT,
    resultsRoot: results,
    runDir: sweepDir,
    name: "video-seed-sweep",
    force: true,
  });
  assert.equal(forced.replaced, true);

  console.log("PASS  seed sweep orchestration and evidence preservation");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
