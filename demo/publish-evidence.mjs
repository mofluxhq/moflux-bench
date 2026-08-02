#!/usr/bin/env node
/**
 * publish-evidence.mjs — promote one completed run to reviewed evidence.
 *
 * Sweeps write to `results/runs/<sweep>/<run-id>/` and never to the reviewed
 * paths. This is the deliberate step that moves a run into
 * `results/<name>.json` + `results/<name>/`, and it refuses to replace an
 * existing one without `--force`.
 *
 * Usage:
 *   node demo/publish-evidence.mjs --as=video-seed-sweep
 *   node demo/publish-evidence.mjs --as=video-seed-sweep --run=results/runs/video-seed-sweep/20260801T223625Z
 *   node demo/publish-evidence.mjs --as=video-seed-sweep --force
 *   node demo/publish-evidence.mjs --list
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  latestPointerFile,
  repoRelative,
  sweepRunsDir,
} from "./evidence-paths-lib.mjs";
import { publishRun } from "./publish-evidence-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS = process.env.MOFLUX_BENCH_RESULTS_DIR
  ? path.resolve(process.env.MOFLUX_BENCH_RESULTS_DIR)
  : path.join(ROOT, "results");

const args = new Map();
for (const arg of process.argv.slice(2)) {
  const match = /^--([^=]+)=(.*)$/.exec(arg);
  if (match) args.set(match[1], match[2]);
  else if (arg.startsWith("--")) args.set(arg.slice(2), "true");
}

const GREEN = "\u001b[32m";
const YELLOW = "\u001b[33m";
const DIM = "\u001b[2m";
const OFF = "\u001b[0m";

function listRuns() {
  const runsRoot = path.join(RESULTS, "runs");
  if (!existsSync(runsRoot)) {
    console.log("No runs yet. Produce one with: npm run demo");
    return;
  }
  for (const sweep of readdirSync(runsRoot, { withFileTypes: true })) {
    if (!sweep.isDirectory()) continue;
    console.log(`\n${sweep.name}`);
    const entries = readdirSync(path.join(runsRoot, sweep.name), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const entry of entries) console.log(`   ${entry}`);
  }
}

function resolveRun(name) {
  const explicit = args.get("run");
  if (explicit) return path.resolve(explicit);

  // Which sweep's runs to search. Defaults to the evidence name, but a run can
  // be published under a different one — `--from=video-seed-sweep --as=v0.11.0`.
  const sweep = (args.get("from") ?? name).trim();

  const pointer = latestPointerFile(RESULTS, sweep);
  if (existsSync(pointer)) {
    const { run } = JSON.parse(readFileSync(pointer, "utf8"));
    if (run) return path.resolve(ROOT, run);
  }

  const runsRoot = sweepRunsDir(RESULTS, sweep);
  if (!existsSync(runsRoot)) {
    throw new Error(
      `no runs found for "${sweep}". Produce one first, pass --run=<directory>, ` +
        "or name the source sweep with --from=<sweep>. Available: npm run evidence:list",
    );
  }
  const newest = readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .pop();
  if (!newest) throw new Error(`no runs found under ${repoRelative(runsRoot, ROOT)}`);
  return path.join(runsRoot, newest);
}

try {
  if (args.get("list") === "true") {
    listRuns();
    process.exit(0);
  }

  const name = (args.get("as") ?? "").trim();
  if (!name) {
    throw new Error("--as=<evidence-name> is required (for example --as=video-seed-sweep)");
  }

  const runDir = resolveRun(name);
  const report = publishRun({
    root: ROOT,
    resultsRoot: RESULTS,
    runDir,
    name,
    force: args.get("force") === "true",
  });

  console.log(
    `${GREEN}${report.replaced ? "Replaced" : "Published"} ${report.reviewed ? "reviewed " : ""}evidence "${report.name}"${OFF}`,
  );
  console.log(`${DIM}   from:      ${report.from}${OFF}`);
  console.log(`${DIM}   summary:   ${report.summary}${OFF}`);
  console.log(`${DIM}   per-seed:  ${report.directory}/ (${report.files} files)${OFF}`);
  if (report.replaced) {
    console.log(
      `${YELLOW}   Previous evidence was overwritten. Review the diff before committing:${OFF}`,
    );
    console.log(`${YELLOW}   git diff --stat -- ${report.summary} ${report.directory}${OFF}`);
  }
} catch (error) {
  console.error(`\npublish failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
