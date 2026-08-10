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
 * Output goes to `results/runs/<sweep-name>/<run-id>/` and nowhere else. That
 * directory is generated, git-ignored and safe to delete. Reviewed evidence in
 * `results/` is never touched by a run; promoting a run to reviewed evidence is
 * a separate, explicit step:
 *
 *   node demo/publish-evidence.mjs --as=video-seed-sweep
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
import { adaptiveProofFailureMessage, buildSweepSummary, parseSeedSpec } from "./seed-sweep-lib.mjs";
import {
  assertSafeResultsDir,
  assertSafeRunDir,
  latestPointerFile,
  repoRelative,
  runDir as runDirFor,
  runId as newRunId,
} from "./evidence-paths-lib.mjs";
import { publishRun } from "./publish-evidence-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS = process.env.MOFLUX_BENCH_RESULTS_DIR
  ? path.resolve(process.env.MOFLUX_BENCH_RESULTS_DIR)
  : path.join(ROOT, "results");
const PRESENTER = process.env.MOFLUX_BENCH_PRESENTER
  ? path.resolve(process.env.MOFLUX_BENCH_PRESENTER)
  : path.join(ROOT, "demo", "present.mjs");
/** Configuration errors are the user's problem to fix, not a stack trace to read. */
function refuse(error) {
  console.error(`\nRefusing to run: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

try {
  assertSafeResultsDir(RESULTS, ROOT, "sweep results root");
} catch (error) {
  refuse(error);
}
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
/**
 * Mirrors present.mjs. Declared here too so the wrapper knows which extra
 * result files to preserve and aggregate per seed.
 */
const CONTROL_ARM_FILES = {
  staticCap: "static-cap.json",
  staticPartition: "static-partition.json",
  redis: "redis-coordinated.json",
};
const controlArmsRaw = str("control-arms", "").trim();
const CONTROL_ARM_KEYS =
  controlArmsRaw === ""
    ? []
    : (controlArmsRaw === "all" ? ["static-cap", "redis"] : controlArmsRaw.split(",").map((n) => n.trim()))
        .filter(Boolean)
        .map((name) => {
          const key = name === "static-cap"
            ? "staticCap"
            : name === "static-partition"
              ? "staticPartition"
              : name;
          if (!CONTROL_ARM_FILES[key]) {
            throw new Error(`unsupported --control-arms entry "${name}"; expected static-cap, static-partition, redis, or all`);
          }
          return key;
        });
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
const requireAdaptiveProof = flag("require-adaptive-proof");

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
    baseline: path.join(SCRATCH, "baseline.json"),
    moflux: path.join(SCRATCH, fault ? "moflux-enforce-fault.json" : "moflux-enforce.json"),
    armComparisons: path.join(SCRATCH, "arm-comparisons.json"),
    ...Object.fromEntries(
      CONTROL_ARM_KEYS.map((key) => [key, path.join(SCRATCH, CONTROL_ARM_FILES[key])]),
    ),
    comparison: path.join(SCRATCH, fault ? "video-comparison-fault.json" : "video-comparison.json"),
    trace: path.join(SCRATCH, "scenario-trace.json"),
  };
}

function outputNames(seed) {
  return {
    baseline: `baseline-seed-${seed}.json`,
    moflux: `${fault ? "moflux-enforce-fault" : "moflux-enforce"}-seed-${seed}.json`,
    armComparisons: `arm-comparisons-seed-${seed}.json`,
    ...Object.fromEntries(
      CONTROL_ARM_KEYS.map((key) => [
        key,
        `${CONTROL_ARM_FILES[key].replace(/\.json$/, "")}-seed-${seed}.json`,
      ]),
    ),
    comparison: `${fault ? "comparison-fault" : "comparison"}-seed-${seed}.json`,
    trace: `trace-seed-${seed}.json`,
  };
}

function sweepName() {
  if (mode === "baseline") return "baseline-seed-sweep";
  if (mode === "moflux") return fault ? "moflux-fault-seed-sweep" : "moflux-seed-sweep";
  return fault ? "video-seed-sweep-fault" : "video-seed-sweep";
}

/**
 * Every artifact of this run lives under one generated directory.
 *
 * Nothing here is ever `results/<sweep-name>.json` or `results/<sweep-name>/`.
 * Those hold reviewed evidence and are written only by publish-evidence.mjs.
 */
const RUN_ID = str("run-id", newRunId());
const SWEEP_NAME = sweepName();
let sweepDir;
try {
  sweepDir = assertSafeRunDir(runDirFor(RESULTS, SWEEP_NAME, RUN_ID), ROOT, "sweep run directory");
} catch (error) {
  refuse(error);
}
const summaryFile = path.join(sweepDir, "summary.json");
const SCRATCH = path.join(sweepDir, "scratch");
const pointerFile = latestPointerFile(RESULTS, SWEEP_NAME);
const publishAs = str("publish-as", "").trim();
const relativePath = (file) => repoRelative(file, ROOT);

function childArgs(seed, index) {
  const wrapperOnly = new Set([
    "seed",
    "seeds",
    "step",
    "pause-ms",
    "mode",
    "cleanup",
    "no-open",
    "run-id",
    "publish-as",
    "force-publish",
    "require-adaptive-proof",
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
      // The presenter writes its scratch files into whatever results directory
      // it is given. Handing it this run's scratch directory is what keeps
      // per-seed output out of `results/` entirely.
      env: { ...process.env, MOFLUX_BENCH_RESULTS_DIR: SCRATCH },
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
  const record = {
    seed,
    baseline: null,
    moflux: null,
    comparison: null,
    scenario: null,
    arms: {},
    controlArms: {},
    armComparisons: null,
  };

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

  for (const key of CONTROL_ARM_KEYS) {
    const summary = readRequired(scratch[key], key);
    validateSeed(summary, seed, key);
    if (summary.scenario?.id !== record.scenario?.id) {
      throw new Error(`seed ${seed} ${key} scenario fingerprint differs from the baseline`);
    }
    const target = path.join(sweepDir, names[key]);
    copyFileSync(scratch[key], target);
    record.arms[key] = relativePath(target);
    record.controlArms[key] = summary;
  }

  if (CONTROL_ARM_KEYS.length > 0) {
    const target = path.join(sweepDir, names.armComparisons);
    copyFileSync(scratch.armComparisons, target);
    record.arms.armComparisons = relativePath(target);
    record.armComparisons = readRequired(target, "arm comparisons");
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

const ARM_TITLES = {
  baseline: "No control",
  staticCap: "Static cap (arm 2)",
  staticPartition: "Static protected partition",
  redis: "Redis coord (arm 4)",
  moflux: "MoFlux",
};

function armRow(title, arm) {
  return {
    arm: title,
    "int success": range(stat(arm, "interactiveSuccessRate"), pct),
    "int goodput": range(stat(arm, "interactiveGoodputRps"), (value) => `${value.toFixed(2)} r/s`),
    "int p95": range(stat(arm, "interactiveP95Ms"), seconds),
    "TTFT p95": range(stat(arm, "interactiveTtftP95Ms"), seconds),
    "upstream 429": range(stat(arm, "upstream429s"), count),
    "batch success": range(stat(arm, "batchSuccessRate"), pct),
  };
}

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
  for (const key of summary.controlArms ?? []) {
    const arm = summary.aggregate.arms[key];
    if (arm) rows.push(armRow(ARM_TITLES[key] ?? key, arm));
  }
  if (moflux) {
    rows.push(armRow(fault ? "MoFlux + fault" : "MoFlux", moflux));
  }

  console.log(`\n${GREEN}${BOLD}── AGGREGATE: median [min–max] across ${summary.seeds.length} seed${summary.seeds.length === 1 ? "" : "s"}${OFF}`);
  console.table(rows);

  // Printed before the head-to-head, because a comparison between a
  // token-aware arm and a concurrency-only one cannot be read until you know
  // whether the token budget refused anything.
  const awareness = summary.tokenAwareness;
  if (awareness && Object.values(awareness).some(Boolean)) {
    console.log(`${BOLD}   Did the token budget decide any admission?${OFF}`);
    console.table(
      Object.entries(awareness)
        .filter(([, value]) => value)
        .map(([arm, value]) => ({
          arm: ARM_TITLES[arm] ?? arm,
          "budget-limited rejects": value.totalBudgetLimitedRejects,
          "seeds exercised": `${value.seedsExercised}/${value.seeds}`,
          "token-aware": value.exercisedTokenAwareness ? "yes" : "NO",
        })),
    );
    const silent = Object.entries(awareness)
      .filter(([, value]) => value && !value.exercisedTokenAwareness)
      .map(([arm]) => ARM_TITLES[arm] ?? arm);
    if (silent.length > 0) {
      console.log(
        `${YELLOW}   ${silent.join(", ")} never had an admission refused by the token budget. ` +
          `Nothing in their comparison is attributable to token-aware admission.${OFF}`,
      );
    }
  }

  const mofluxVersus = summary.aggregate.mofluxVersus;
  if (mofluxVersus && Object.keys(mofluxVersus).length > 0) {
    console.log(`${BOLD}   MoFlux versus each alternative — paired per seed, then medianed${OFF}`);
    console.table(
      Object.entries(mofluxVersus).map(([key, delta]) => ({
        versus: ARM_TITLES[key] ?? key,
        "int success": range(stat(delta, "interactiveSuccessPercentagePointChange"), signedPoints),
        "int goodput": range(stat(delta, "interactiveGoodputChangePercent"), signedPct),
        "int p95": range(stat(delta, "interactiveP95LatencyChangePercent"), signedPct),
        "TTFT p95": range(stat(delta, "interactiveTtftP95ChangePercent"), signedPct),
        "batch success": range(stat(delta, "batchSuccessPercentagePointChange"), signedPoints),
      })),
    );
  }

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

  const adaptive = summary.adaptiveProof;
  if (adaptive) {
    console.log(`${BOLD}   Adaptive 28/4 acceptance gate${OFF}`);
    console.table([
      {
        "policy exact": adaptive.policyMatches ? "yes" : "NO",
        "passed seeds": `${adaptive.passedSeeds}/${adaptive.seeds}`,
        "zero upstream 429": `${adaptive.zeroUpstream429Seeds}/${adaptive.seeds}`,
        "interactive ≥90%": `${adaptive.interactiveTargetSeeds}/${adaptive.seeds}`,
        "batch ≥10%": `${adaptive.batchTargetSeeds}/${adaptive.seeds}`,
        "occupancy proof": `${adaptive.occupancyObservedSeeds}/${adaptive.seeds}`,
        "controller proof": `${adaptive.controllerObservedSeeds}/${adaptive.seeds}`,
        "floor restored": `${adaptive.floorRestoredSeeds}/${adaptive.seeds}`,
        "handoff": `${adaptive.handoffObservedSeeds}/${adaptive.seeds}`,
        "committed": `${adaptive.handoffCommittedSeeds}/${adaptive.seeds}`,
        "safe order": `${adaptive.safeHandoffSeeds}/${adaptive.seeds}`,
        "no double allocation": `${adaptive.noAppliedOverallocationSeeds}/${adaptive.seeds}`,
        "beat lease expiry": `${adaptive.handoffBeatLeaseExpirySeeds}/${adaptive.seeds}`,
        "batch served": `${adaptive.batchServedSeeds}/${adaptive.seeds}`,
      },
    ]);
    if (!adaptive.passed) {
      console.log(`${YELLOW}   Adaptive proof failed: ${adaptiveProofFailureMessage(adaptive)}${OFF}`);
    }
  }

  const lending = summary.aggregate.lending;
  if (lending) {
    console.log(`${BOLD}   Demand-aware lending proof${OFF}`);
    console.table([
      {
        "occupancy proof": `${lending.occupancyObservedSeeds}/${summary.seeds.length} seeds`,
        "controller proof": `${lending.controllerObservedSeeds}/${summary.seeds.length} seeds`,
        "floor restored": `${lending.floorRestoredSeeds}/${summary.seeds.length} seeds`,
        "borrowed slots": range(lending.borrowedSlots, count),
        "restore duration": range(lending.floorRestorationDurationMs, (value) => `${value.toFixed(0)}ms`),
        "batch admission gap": range(lending.batchFloorAdmissionGapMs, (value) => `${value.toFixed(0)}ms`),
        "batch completion gap": range(lending.batchFloorFirstSuccessGapMs, (value) => `${value.toFixed(0)}ms`),
        "demand → drain": range(lending.demandToDrainStartMs, (value) => `${value.toFixed(0)}ms`),
        "drain → ack": range(lending.drainStartToAcknowledgedMs, (value) => `${value.toFixed(0)}ms`),
        "ack → commit": range(lending.acknowledgedToCommitMs, (value) => `${value.toFixed(0)}ms`),
        "commit → batch": range(lending.commitToFirstBatchAdmissionMs, (value) => `${value.toFixed(0)}ms`),
        "demand → batch": range(lending.demandToFirstBatchAdmissionMs, (value) => `${value.toFixed(0)}ms`),
        "lease time avoided": range(lending.leaseTimeAvoidedMs, (value) => `${value.toFixed(0)}ms`),
      },
    ]);
  }
}

/**
 * Opt-in promotion. Absent `--publish-as`, a sweep leaves reviewed evidence
 * exactly as it found it — which is the whole point of the run directory.
 */
async function promote(name) {
  const report = publishRun({
    root: ROOT,
    resultsRoot: RESULTS,
    runDir: sweepDir,
    name,
    force: flag("force-publish"),
  });
  console.log(
    `\n${GREEN}${BOLD}   ${report.replaced ? "Replaced" : "Published"} evidence "${report.name}"${OFF}`,
  );
  console.log(`   summary:  ${report.summary}`);
  console.log(`   per-seed: ${report.directory}/ (${report.files} files)`);
  if (report.replaced) {
    console.log(
      `${YELLOW}   Previous evidence was overwritten. Review before committing:${OFF}`,
    );
    console.log(`${YELLOW}   git diff --stat -- ${report.summary} ${report.directory}${OFF}`);
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
  // A fresh run identifier means this directory should not exist. If it does,
  // an explicit --run-id was reused; clearing it is safe because
  // assertSafeRunDir has already proved it holds no reviewed evidence.
  rmSync(sweepDir, { recursive: true, force: true });
  mkdirSync(sweepDir, { recursive: true });
  mkdirSync(SCRATCH, { recursive: true });

  console.log(`${BOLD}MoFlux licensed demo — ${mode === "compare" ? "paired " : ""}seed sweep${OFF}`);
  say(
    `run: ${relativePath(sweepDir)}/`,
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
  if (requireAdaptiveProof) {
    const failure = adaptiveProofFailureMessage(summary.adaptiveProof);
    if (failure) {
      throw new Error(
        `adaptive 28/4 acceptance gate failed: ${failure}. ` +
          `The complete evidence remains at ${relativePath(summaryFile)}`,
      );
    }
  }

  // A stable path to the newest run, so tooling never has to guess a run id
  // and never has to fall back to reading reviewed evidence.
  writeFileSync(
    pointerFile,
    `${JSON.stringify(
      {
        sweep: SWEEP_NAME,
        runId: RUN_ID,
        generatedAt: summary.generatedAt,
        seeds: summary.seeds,
        run: relativePath(sweepDir),
        summary: relativePath(summaryFile),
      },
      null,
      2,
    )}\n`,
  );
  printAggregate(summary);

  console.log(`\n${GREEN}${BOLD}   Seed sweep complete.${OFF}`);
  console.log(`   summary: ${relativePath(summaryFile)}`);
  console.log(`   raw runs: ${relativePath(sweepDir)}/`);
  console.log(`   latest:  ${relativePath(pointerFile)}`);

  // The single-pair presenter uses these names as scratch space. Remove them so
  // the last seed cannot be mistaken for the sweep result.
  for (const file of Object.values(scratchPaths())) rmSync(file, { force: true });
  rmSync(SCRATCH, { recursive: true, force: true });

  if (publishAs) {
    await promote(publishAs);
  } else {
    say(
      "This run did not modify any reviewed evidence.",
      `Promote it deliberately with: node demo/publish-evidence.mjs --as=${SWEEP_NAME}`,
    );
  }
  say(
    "Report the aggregate, not the last seed's scratch files.",
    keepStack ? "Stop the demo later with: npm run demo:down" : "The demo stack was stopped after the final seed.",
  );
} catch (error) {
  if (!interrupted) {
    console.error(`\n${RED}${BOLD}Seed sweep failed:${OFF} ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = 1;
} finally {
  rl.close();
}
