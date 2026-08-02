#!/usr/bin/env node
/** Proves the public npm run demo entry point completes all five seeds without prompts. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(path.join(tmpdir(), "moflux-demo-command-"));
const results = path.join(temp, "results");
const envFile = path.join(temp, "demo.env");
const fake = path.join(temp, "fake-presenter.mjs");

writeFileSync(
  fake,
  String.raw`import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const args = new Map();
for (const arg of process.argv.slice(2)) {
  const match = /^--([^=]+)=(.*)$/.exec(arg);
  if (match) args.set(match[1], match[2]);
}
const seed = Number(args.get("seed"));
if (args.get("provider-api") !== "anthropic") {
  throw new Error("canonical demo did not explicitly select Anthropic streaming");
}
const results = process.env.MOFLUX_BENCH_RESULTS_DIR;
mkdirSync(results, { recursive: true });
const trace = { version: 1, hash: "trace-" + seed, planned: { interactive: 2, batch: 1, total: 3 }, entries: [] };
const scenario = {
  id: "scenario-" + seed,
  workload: { durationMs: 10000, seed, interactiveRps: 1 },
  provider: { api: "anthropic", envelope: 32, seed, sigma: 0.25 },
  trace: { version: 1, hash: trace.hash, planned: trace.planned, evidence: "results/scenario-trace.json" },
  routing: { interactiveReplicas: ["r1", "r2", "r3", "r4"], batchReplicas: ["r4"] },
};
function arm(name, managed) {
  return {
    arm: name,
    seed,
    config: { durationMs: 10000 },
    generatorSaturated: 0,
    trace: { version: 1, hash: trace.hash, planned: trace.planned, source: "scenario-trace.json" },
    classes: {
      interactive: { logical: 2, successRate: managed ? 1 : 0.5, success: managed ? 2 : 1, retryAmplification: 1, localReject: 0, upstreamReject: managed ? 0 : 1, latencyMs: { p50: 10, p95: 20, p99: 20 }, ttftMs: { p50: 1, p95: 2, p99: 2 } },
      batch: { logical: 1, successRate: 1, success: 1, retryAmplification: 1, localReject: 0, upstreamReject: 0, latencyMs: { p50: 10, p95: 20, p99: 20 }, ttftMs: { p50: 1, p95: 2, p99: 2 } },
    },
    simCounters: { peakActive: managed ? 32 : 32 },
    scenario,
    ...(managed ? {
      tokenAccounting: { totalReserved: 100, totalConsumed: 80, totalRefunded: 20, totalOverrun: 0, grossRecoveryRate: 0.2, netRecovered: 20, netRecoveryRate: 0.2 },
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
const baseline = arm("baseline-no-control", false);
const moflux = arm("moflux-enforce", true);
const comparison = {
  scenario,
  metrics: {
    interactiveSuccessPercentagePointChange: 50,
    interactiveGoodputChangePercent: 100,
    interactiveP95LatencyChangePercent: 0,
    interactiveTailRatioBaseline: 2,
    interactiveTailRatioMoflux: 2,
    interactiveTailInflationChangePercent: 0,
    upstream429Baseline: 1,
    upstream429Moflux: 0,
  },
};
writeFileSync(path.join(results, "baseline.json"), JSON.stringify(baseline));
writeFileSync(path.join(results, "moflux-enforce.json"), JSON.stringify(moflux));
writeFileSync(path.join(results, "video-comparison.json"), JSON.stringify(comparison));
writeFileSync(path.join(results, "scenario-trace.json"), JSON.stringify(trace));
`,
);

try {
  const run = await new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", "demo"], {
      cwd: ROOT,
      env: {
        ...process.env,
        MOFLUX_BENCH_PRESENTER: fake,
        MOFLUX_BENCH_RESULTS_DIR: results,
        MOFLUX_BENCH_ENV_FILE: envFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
  assert.doesNotMatch(run.stdout, /\[enter\]/);
  const pointerFile = path.join(results, "runs", "video-seed-sweep", "latest.json");
  assert.equal(existsSync(pointerFile), true);
  const pointer = JSON.parse(readFileSync(pointerFile, "utf8"));
  const summaryFile = path.join(results, "runs", "video-seed-sweep", pointer.runId, "summary.json");
  assert.equal(existsSync(summaryFile), true);
  // npm run demo must not touch reviewed evidence.
  assert.equal(existsSync(path.join(results, "video-seed-sweep.json")), false);
  const summary = JSON.parse(readFileSync(summaryFile, "utf8"));
  assert.deepEqual(summary.seeds, [1, 2, 3, 4, 5]);
  assert.equal(summary.capacityPolicy.interactiveConcurrencySlots, 31);
  assert.equal(summary.capacityPolicy.batchConcurrencySlots, 1);
  assert.equal(summary.scenarioTemplate.provider.api, "anthropic");
  console.log("PASS  npm run demo executes the complete automatic five-seed Anthropic path");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
