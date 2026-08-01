#!/usr/bin/env node
/**
 * seed-sweep.mjs — canonical licensed MoFlux demo.
 *
 * Runs the existing, end-to-end-verified presenter once per seed. Every seed
 * produces a fresh no-control/MoFlux pair with the same configured workload
 * and provider seed. Raw evidence is copied into a dedicated directory before
 * the next seed starts, then the paired observations are summarized as medians
 * with min/max spread.
 *
 * Usage:
 *   npm run demo                         # automatic seeds 1-5 comparison
 *   npm run demo:auto                    # seeds 1-5, timed transitions
 *   node demo/seed-sweep.mjs --seeds=3,7,11 --step
 *   node demo/seed-sweep.mjs --seed=7    # backward-compatible single seed
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildSweepSummary, parseSeedSpec } from "./seed-sweep-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS = process.env.MOFLUX_BENCH_RESULTS_DIR
  ? path.resolve(process.env.MOFLUX_BENCH_RESULTS_DIR)
  : path.join(ROOT, "results");
const PRESENTER = process.env.MOFLUX_BENCH_PRESENTER
  ? path.resolve(process.env.MOFLUX_BENCH_PRESENTER)
  : path.join(ROOT, "demo", "present.mjs");
mkdirSync(RESULTS, { recursive: true });

const rawArgs = new Map();
const originalArgs = process.argv.slice(2);
for (const arg of originalArgs) {
  const match = /^--([^=]+)=(.*)$/.exec(arg);
  if (match) rawArgs.set(match[1], match[2]);
  else if (arg.startsWith("--")) rawArgs.set(arg.slice(2), "true");
}
const flag = (name) => rawArgs.get(name) === "true";
const num = (name, fallback) => (rawArgs.has(name) ? Number(rawArgs.get(name)) : fallback);
const str = (name, fallback) => rawArgs.get(name) ?? fallback;

if (rawArgs.has("seed") && rawArgs.has("seeds")) {
  throw new Error("use either --seed or --seeds, not both");
}

const mode = str("mode", "compare");
if (!new Set(["compare", "baseline", "moflux"]).has(mode)) {
  throw new Error(`unsupported --mode=${mode}; expected compare, baseline, or moflux`);
}
const seedSpec = rawArgs.has("seed") ? rawArgs.get("seed") : str("seeds", "1-5");
const seeds = parseSeedSpec(seedSpec);
const fault = flag("fault");
const step = flag("step");
const pauseMs = num("pause-ms", 2500);
const keepStack = !flag("cleanup");
const openGrafana = !flag("no-open");

if (!Number.isFinite(pauseMs) || pauseMs < 0) throw new Error("--pause-ms must be non-negative");
if (fault && mode === "baseline") throw new Error("--fault is not meaningful with --mode=baseline");

const BOLD = "\u001b[1m";
const DIM = "\u001b[2m";
const CYAN = "\u001b[36m";
const YELLOW = "\u001b[33m";
const GREEN = "\u001b[32m";
const RED = "\u001b[31m";
const OFF = "\u001b[0m";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rl = createInterface({ input: process.stdin, output: process.stdout });

function say(...lines) {
  for (const line of lines) console.log(`${DIM}   ${line}${OFF}`);
}

async function cue(text) {
  if (step) {
    await new Promise((resolve) => rl.question(`\n${YELLOW}   [enter] ${text}${OFF}`, resolve));
  } else if (pauseMs > 0) {
    await sleep(pauseMs);
  }
}

function scratchPaths() {
  return {
    baseline: path.join(RESULTS, "baseline.json"),
    moflux: path.join(RESULTS, fault ? "moflux-enforce-fault.json" : "moflux-enforce.json"),
    comparison: path.join(RESULTS, fault ? "video-comparison-fault.json" : "video-comparison.json"),
    trace: path.join(RESULTS, "scenario-trace.json"),
  };
}

function outputNames(seed) {
  return {
    baseline: `baseline-seed-${seed}.json`,
    moflux: `${fault ? "moflux-enforce-fault" : "moflux-enforce"}-seed-${seed}.json`,
    comparison: `${fault ? "comparison-fault" : "comparison"}-seed-${seed}.json`,
    trace: `trace-seed-${seed}.json`,
  };
}

function sweepName() {
  if (mode === "baseline") return "baseline-seed-sweep";
  if (mode === "moflux") return fault ? "moflux-fault-seed-sweep" : "moflux-seed-sweep";
  return fault ? "video-seed-sweep-fault" : "video-seed-sweep";
}

const sweepDir = path.join(RESULTS, sweepName());
const summaryFile = path.join(RESULTS, `${sweepName()}.json`);
const relativePath = (file) => path.relative(ROOT, file).split(path.sep).join("/");

function childArgs(seed, index) {
  const wrapperOnly = new Set([
    "seed",
    "seeds",
    "step",
    "pause-ms",
    "mode",
    "cleanup",
    "no-open",
  ]);
  const forwarded = originalArgs.filter((arg) => {
    const match = /^--([^=]+)(?:=.*)?$/.exec(arg);
    return !match || !wrapperOnly.has(match[1]);
  });

  forwarded.push(`--mode=${mode}`, `--seed=${seed}`, "--pause-ms=0");
  if (!openGrafana || index > 0) forwarded.push("--no-open");
  if (!keepStack && index === seeds.length - 1) forwarded.push("--cleanup");
  return forwarded;
}

let activePresenter = null;

async function runPresenter(seed, index) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PRESENTER, ...childArgs(seed, index)], {
      cwd: ROOT,
      stdio: "inherit",
    });
    activePresenter = child;
    child.once("error", (error) => {
      activePresenter = null;
      reject(error);
    });
    child.once("exit", (code, signal) => {
      activePresenter = null;
      if (code === 0) resolve();
      else reject(new Error(`seed ${seed} presenter failed (${signal ? `signal ${signal}` : `exit code ${code}`})`));
    });
  });
}

function readRequired(file, label) {
  if (!existsSync(file)) throw new Error(`${label} did not write ${path.relative(ROOT, file)}`);
  return JSON.parse(readFileSync(file, "utf8"));
}

function validateSeed(summary, seed, label) {
  const workloadSeed = Number(summary?.scenario?.workload?.seed);
  const providerSeed = Number(summary?.scenario?.provider?.seed);
  if (workloadSeed !== seed || providerSeed !== seed) {
    throw new Error(
      `${label} seed mismatch: expected ${seed}, got workload=${workloadSeed}, provider=${providerSeed}`,
    );
  }
  if (Number(summary?.generatorSaturated ?? 0) !== 0) {
    throw new Error(`${label} seed ${seed} saturated the load generator`);
  }
  const trace = summary?.scenario?.trace;
  if (!trace?.hash || summary?.trace?.hash !== trace.hash) {
    throw new Error(`${label} seed ${seed} did not replay its recorded trace`);
  }
  for (const cls of ["interactive", "batch"]) {
    if (Number(summary?.classes?.[cls]?.logical) !== Number(trace?.planned?.[cls])) {
      throw new Error(`${label} seed ${seed} ${cls} request count differs from its trace`);
    }
  }
}

function preserveSeed(seed) {
  const scratch = scratchPaths();
  const names = outputNames(seed);
  const record = { seed, baseline: null, moflux: null, comparison: null, scenario: null, arms: {} };

  if (mode === "compare" || mode === "baseline") {
    record.baseline = readRequired(scratch.baseline, "baseline");
    validateSeed(record.baseline, seed, "baseline");
    const target = path.join(sweepDir, names.baseline);
    copyFileSync(scratch.baseline, target);
    record.arms.baseline = relativePath(target);
    record.scenario = record.baseline.scenario;
  }

  if (mode === "compare" || mode === "moflux") {
    record.moflux = readRequired(scratch.moflux, "MoFlux");
    validateSeed(record.moflux, seed, "MoFlux");
    const target = path.join(sweepDir, names.moflux);
    copyFileSync(scratch.moflux, target);
    record.arms.moflux = relativePath(target);
    record.scenario ??= record.moflux.scenario;
  }

  const trace = readRequired(scratch.trace, "request trace");
  if (trace.hash !== record.scenario?.trace?.hash) {
    throw new Error(`seed ${seed} trace evidence does not match the arm scenario`);
  }
  const traceTarget = path.join(sweepDir, names.trace);
  copyFileSync(scratch.trace, traceTarget);
  record.arms.trace = relativePath(traceTarget);

  if (mode === "compare") {
    record.comparison = readRequired(scratch.comparison, "comparison");
    if (record.baseline.scenario?.id !== record.moflux.scenario?.id) {
      throw new Error(`seed ${seed} is invalid: baseline and MoFlux scenario fingerprints differ`);
    }
    if (record.comparison.scenario?.id !== record.baseline.scenario?.id) {
      throw new Error(`seed ${seed} comparison scenario fingerprint differs from its arm results`);
    }
    const target = path.join(sweepDir, names.comparison);
    copyFileSync(scratch.comparison, target);
    record.arms.comparison = relativePath(target);
  }

  return record;
}

function stat(aggregate, key) {
  return aggregate?.[key] ?? null;
}

function range(value, formatter = (number) => number.toFixed(2)) {
  if (!value) return "n/a";
  return `${formatter(value.median)} [${formatter(value.min)}–${formatter(value.max)}]`;
}

const pct = (value) => `${(value * 100).toFixed(1)}%`;
const signedPct = (value) => `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
const signedPoints = (value) => `${value >= 0 ? "+" : ""}${value.toFixed(1)} pp`;
const seconds = (value) => `${(value / 1000).toFixed(2)}s`;
const count = (value) => Math.round(value).toString();

function printAggregate(summary) {
  const baseline = summary.aggregate.arms.baseline;
  const moflux = summary.aggregate.arms.moflux;
  const rows = [];
  if (baseline) {
    rows.push({
      arm: "No control",
      "int success": range(stat(baseline, "interactiveSuccessRate"), pct),
      "int goodput": range(stat(baseline, "interactiveGoodputRps"), (value) => `${value.toFixed(2)} r/s`),
      "int p95": range(stat(baseline, "interactiveP95Ms"), seconds),
      "TTFT p95": range(stat(baseline, "interactiveTtftP95Ms"), seconds),
      "upstream 429": range(stat(baseline, "upstream429s"), count),
      "batch success": range(stat(baseline, "batchSuccessRate"), pct),
    });
  }
  if (moflux) {
    rows.push({
      arm: fault ? "MoFlux + fault" : "MoFlux",
      "int success": range(stat(moflux, "interactiveSuccessRate"), pct),
      "int goodput": range(stat(moflux, "interactiveGoodputRps"), (value) => `${value.toFixed(2)} r/s`),
      "int p95": range(stat(moflux, "interactiveP95Ms"), seconds),
      "TTFT p95": range(stat(moflux, "interactiveTtftP95Ms"), seconds),
      "upstream 429": range(stat(moflux, "upstream429s"), count),
      "batch success": range(stat(moflux, "batchSuccessRate"), pct),
    });
  }

  console.log(`\n${GREEN}${BOLD}── AGGREGATE: median [min–max] across ${summary.seeds.length} seed${summary.seeds.length === 1 ? "" : "s"}${OFF}`);
  console.table(rows);

  const paired = summary.aggregate.paired;
  if (paired) {
    console.log(`${BOLD}   Paired MoFlux change versus its same-seed baseline${OFF}`);
    console.table([
      {
        "success Δ": range(stat(paired, "interactiveSuccessPercentagePointChange"), signedPoints),
        "goodput Δ": range(stat(paired, "interactiveGoodputChangePercent"), signedPct),
        "p95 Δ": range(stat(paired, "interactiveP95LatencyChangePercent"), signedPct),
        "tail-ratio Δ": range(stat(paired, "interactiveTailInflationChangePercent"), signedPct),
        "baseline 429": range(stat(paired, "upstream429Baseline"), count),
        "MoFlux 429": range(stat(paired, "upstream429Moflux"), count),
      },
    ]);
  }

  const token = summary.aggregate.tokenAccounting;
  if (token?.grossRecoveryRate) {
    console.log(`${BOLD}   Token reservation reconciliation${OFF}`);
    console.table([
      {
        reserved: range(stat(token, "totalReserved"), count),
        refunded: range(stat(token, "totalRefunded"), count),
        "gross recovery": range(stat(token, "grossRecoveryRate"), pct),
        "net recovery": range(stat(token, "netRecoveryRate"), pct),
      },
    ]);
  }
}

let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    interrupted = true;
    try {
      activePresenter?.kill("SIGTERM");
    } catch {
      // already stopped
    }
    console.error(`\n${RED}Seed sweep interrupted. Existing per-seed evidence was left in place.${OFF}`);
    process.exit(1);
  });
}

try {
  rmSync(sweepDir, { recursive: true, force: true });
  rmSync(summaryFile, { force: true });
  mkdirSync(sweepDir, { recursive: true });

  console.log(`${BOLD}MoFlux licensed demo — ${mode === "compare" ? "paired " : ""}seed sweep${OFF}`);
  say(
    `seeds: ${seeds.join(", ")}`,
    `mode: ${mode}${fault ? " with replica fault" : ""}`,
    mode === "compare"
      ? "Each seed generates one immutable request trace and replays that exact logical arrival schedule through both arms."
      : "Each seed is a fresh configured scenario; raw evidence is preserved before the next run.",
    "The final claim uses medians with min/max spread, while every raw run remains inspectable.",
  );

  const records = [];
  for (let index = 0; index < seeds.length; index += 1) {
    const seed = seeds[index];
    await cue(`run seed ${seed} (${index + 1}/${seeds.length})`);
    console.log(`\n${CYAN}${BOLD}════════ SEED ${seed} (${index + 1}/${seeds.length}) ════════${OFF}`);

    for (const file of Object.values(scratchPaths())) rmSync(file, { force: true });
    await runPresenter(seed, index);
    const record = preserveSeed(seed);
    records.push(record);
    console.log(`${GREEN}   ✓ preserved seed ${seed} evidence in ${relativePath(sweepDir)}${OFF}`);
  }

  const summary = buildSweepSummary({ mode, fault, seeds, records });
  writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
  printAggregate(summary);

  console.log(`\n${GREEN}${BOLD}   Seed sweep complete.${OFF}`);
  console.log(`   summary: ${relativePath(summaryFile)}`);
  console.log(`   raw runs: ${relativePath(sweepDir)}/`);
  say(
    "Report the aggregate, not the last seed's scratch files.",
    keepStack ? "Stop the demo later with: npm run demo:down" : "The demo stack was stopped after the final seed.",
  );

  // The single-pair presenter uses these names as scratch space. Remove them so
  // the last seed cannot be mistaken for the sweep result.
  for (const file of Object.values(scratchPaths())) rmSync(file, { force: true });
} catch (error) {
  if (!interrupted) {
    console.error(`\n${RED}${BOLD}Seed sweep failed:${OFF} ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = 1;
} finally {
  rl.close();
}
