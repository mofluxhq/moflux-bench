#!/usr/bin/env node
/**
 * Sequential multi-seed wrapper for the live OpenAI overload comparison.
 *
 * Each seed is executed by openai-overload.mjs as an independent runs=1
 * invocation so the existing <=2,000-request guard, per-seed spend guard,
 * provider-headroom recovery gates, trace matching, and Tyr proof remain the
 * source of truth. Only fully completed, conclusive, configuration-identical
 * seed summaries are pooled into the top-level summary.json.
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSafeOutputFile,
  assertSafeResultsDir,
  assertSafeRunDir,
  latestPointerFile,
  repoRelative,
  runDir as runDirFor,
  runId as newRunId,
} from "./evidence-paths-lib.mjs";
import {
  aggregateOpenAiOverloadCompareSummaries,
  counterbalancedArmOrderForSeed,
  OPENAI_OVERLOAD_DEFAULT_MAX_USD,
  OPENAI_OVERLOAD_MAX_RUN_CAP_USD,
  OPENAI_OVERLOAD_MULTI_SWEEP_DEFAULT_MAX_USD,
  OPENAI_OVERLOAD_MULTI_SWEEP_MAX_SEEDS,
  OPENAI_OVERLOAD_MULTI_SWEEP_MAX_USD,
  OPENAI_OVERLOAD_MULTI_SWEEP_NAME,
} from "./openai-overload-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS = process.env.MOFLUX_BENCH_RESULTS_DIR
  ? path.resolve(process.env.MOFLUX_BENCH_RESULTS_DIR)
  : path.join(ROOT, "results");
const CHILD = path.join(ROOT, "demo", "openai-overload.mjs");

const rawArgs = process.argv.slice(2);
const args = new Map();
for (const arg of rawArgs) {
  const match = /^--([^=]+)=(.*)$/.exec(arg);
  if (match) args.set(match[1], match[2]);
  else if (arg.startsWith("--")) args.set(arg.slice(2), "true");
}
const num = (name, fallback) => (args.has(name) ? Number(args.get(name)) : fallback);
const str = (name, fallback) => args.get(name) ?? fallback;
const bool = (name, fallback) => (args.has(name) ? args.get(name) === "true" : fallback);

function parseSeeds(value) {
  const seeds = [];
  for (const token of String(value).split(",").map((entry) => entry.trim()).filter(Boolean)) {
    const range = /^(\d+)-(\d+)$/.exec(token);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
        throw new Error(`invalid seed range: ${token}`);
      }
      for (let seed = start; seed <= end; seed += 1) seeds.push(seed);
      continue;
    }
    const seed = Number(token);
    if (!Number.isSafeInteger(seed) || seed < 1) throw new Error(`invalid seed: ${token}`);
    seeds.push(seed);
  }
  if (seeds.length === 0) throw new Error("--seeds must contain at least one positive integer seed");
  if (new Set(seeds).size !== seeds.length) throw new Error("--seeds must not contain duplicates");
  if (seeds.length > OPENAI_OVERLOAD_MULTI_SWEEP_MAX_SEEDS) {
    throw new Error(
      `--seeds may contain at most ${OPENAI_OVERLOAD_MULTI_SWEEP_MAX_SEEDS} seeds per sweep`,
    );
  }
  return seeds;
}

const seeds = parseSeeds(str("seeds", "1-8"));
const maxUsdPerSeed = num("max-usd-per-seed", OPENAI_OVERLOAD_DEFAULT_MAX_USD);
const maxSweepUsd = num("max-sweep-usd", OPENAI_OVERLOAD_MULTI_SWEEP_DEFAULT_MAX_USD);
const dryRun = bool("dry-run", false);
const runId = str("run-id", newRunId());
const explicitOut = args.has("out") ? path.resolve(str("out", "")) : null;

if (!Number.isFinite(maxUsdPerSeed) || maxUsdPerSeed <= 0 || maxUsdPerSeed > OPENAI_OVERLOAD_MAX_RUN_CAP_USD) {
  throw new Error(
    `--max-usd-per-seed must be greater than 0 and no more than ${OPENAI_OVERLOAD_MAX_RUN_CAP_USD}`,
  );
}
if (!Number.isFinite(maxSweepUsd) || maxSweepUsd <= 0 || maxSweepUsd > OPENAI_OVERLOAD_MULTI_SWEEP_MAX_USD) {
  throw new Error(
    `--max-sweep-usd must be greater than 0 and no more than ${OPENAI_OVERLOAD_MULTI_SWEEP_MAX_USD}`,
  );
}
const reservedSweepCapUsd = +(maxUsdPerSeed * seeds.length).toFixed(6);
if (reservedSweepCapUsd > maxSweepUsd) {
  throw new Error(
    `Refusing sweep: ${seeds.length} seeds × $${maxUsdPerSeed.toFixed(4)} per-seed cap = ` +
      `$${reservedSweepCapUsd.toFixed(4)}, above --max-sweep-usd=$${maxSweepUsd.toFixed(4)}.`,
  );
}

const wrapperOnly = new Set([
  "seeds",
  "max-usd-per-seed",
  "max-sweep-usd",
  "run-id",
  "out",
  "dry-run",
  "mode",
  "runs",
  "seed",
  "arms",
  "max-usd",
]);
const forwardedArgs = rawArgs.filter((arg) => {
  const match = /^--([^=]+)(?:=.*)?$/.exec(arg);
  return !match || !wrapperOnly.has(match[1]);
});

let sweepDir = null;
let out = null;
let pointerFile = null;
if (!dryRun) {
  assertSafeResultsDir(RESULTS, ROOT, "OpenAI overload sweep results root");
  if (explicitOut) {
    out = assertSafeOutputFile(explicitOut, ROOT, "OpenAI overload sweep output file");
    const stem = path.basename(out, path.extname(out));
    sweepDir = assertSafeRunDir(
      path.join(path.dirname(out), `${stem}-seed-runs`),
      ROOT,
      "OpenAI overload sweep seed directory",
    );
  } else {
    sweepDir = assertSafeRunDir(
      runDirFor(RESULTS, OPENAI_OVERLOAD_MULTI_SWEEP_NAME, runId),
      ROOT,
      "OpenAI overload sweep run directory",
    );
    out = path.join(sweepDir, "summary.json");
    pointerFile = latestPointerFile(RESULTS, OPENAI_OVERLOAD_MULTI_SWEEP_NAME);
  }
  if (existsSync(sweepDir) && readdirSync(sweepDir).length > 0) {
    throw new Error(`refusing to reuse non-empty sweep directory: ${repoRelative(sweepDir, ROOT)}`);
  }
  mkdirSync(sweepDir, { recursive: true });
}

function runChild(childArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, ...childArgs], {
      cwd: ROOT,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`OpenAI overload seed child exited ${code ?? `via signal ${signal}`}`));
    });
  });
}

console.log("OpenAI overload multi-seed sweep guard:");
console.table([{
  seeds: seeds.join(","),
  seedCount: seeds.length,
  maxUsdPerSeed,
  reservedSweepCapUsd,
  maxSweepUsd,
  dryRun,
}]);

const summaries = [];
const sourceFiles = [];
for (let index = 0; index < seeds.length; index += 1) {
  const seed = seeds[index];
  const armOrder = counterbalancedArmOrderForSeed(seed);
  console.log(`\n=== OpenAI overload sweep seed ${seed} (${index + 1}/${seeds.length}) order=${armOrder.join(" -> ")} ===`);
  const childArgs = [
    "--mode=compare",
    `--arms=${armOrder.join(",")}`,
    "--runs=1",
    `--seed=${seed}`,
    `--max-usd=${maxUsdPerSeed}`,
    ...forwardedArgs,
  ];
  let seedSummary = null;
  if (dryRun) {
    childArgs.push("--dry-run");
  } else {
    const seedDir = path.join(sweepDir, `seed-${seed}`);
    mkdirSync(seedDir, { recursive: true });
    seedSummary = path.join(seedDir, "summary.json");
    childArgs.push(`--out=${seedSummary}`);
  }

  await runChild(childArgs);

  if (!dryRun) {
    const summary = JSON.parse(readFileSync(seedSummary, "utf8"));
    if (summary.interpretation?.conclusiveProviderOverloadComparison !== true) {
      const reasons = summary.interpretation?.inconclusiveReasons ?? [];
      throw new Error(
        `seed ${seed} was not a conclusive provider-overload comparison; aborting remaining seeds` +
          (reasons.length > 0 ? `: ${reasons.join("; ")}` : ""),
      );
    }
    summaries.push(summary);
    sourceFiles.push(path.relative(path.dirname(out), seedSummary).split(path.sep).join("/"));
  }
}

if (dryRun) {
  console.log(`\nPASS sweep dry-run: ${seeds.length} independently guarded seed plans validated; no API request was sent.`);
  process.exit(0);
}

const unified = aggregateOpenAiOverloadCompareSummaries(summaries, { sourceFiles });
unified.runId = runId;
unified.budget.maxSweepUsd = maxSweepUsd;
unified.budget.reservedSweepCapUsd = reservedSweepCapUsd;
unified.outputs = {
  summary: repoRelative(out, ROOT),
  seedRunsDirectory: repoRelative(sweepDir, ROOT),
};

mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(unified, null, 2)}\n`, "utf8");
if (pointerFile) {
  mkdirSync(path.dirname(pointerFile), { recursive: true });
  writeFileSync(
    pointerFile,
    `${JSON.stringify({ runId, summary: repoRelative(out, ROOT) }, null, 2)}\n`,
    "utf8",
  );
}

console.log("\nOpenAI overload sweep aggregate:");
console.table(Object.fromEntries(
  Object.entries(unified.aggregate).map(([arm, summary]) => [arm, {
    success: `${summary.success}/${summary.offered}`,
    successRate: `${(summary.successRate * 100).toFixed(2)}%`,
    interactive: `${summary.classes.interactive.success}/${summary.classes.interactive.offered}`,
    interactiveRate: `${(summary.classes.interactive.successRate * 100).toFixed(2)}%`,
    batch: `${summary.classes.batch.success}/${summary.classes.batch.offered}`,
    batchRate: `${(summary.classes.batch.successRate * 100).toFixed(2)}%`,
    provider429s: summary.provider429s,
  }]),
));
console.log("Validation:", unified.validation);
console.log(`Unified summary: ${repoRelative(out, ROOT)}`);
