#!/usr/bin/env node
/**
 * verify-evidence-paths.mjs — reviewed evidence is unreachable from a run.
 *
 * The incident this encodes: `npm run demo:hetero` wrote its summary to
 * `results/video-seed-sweep.json` and its per-seed files to
 * `results/video-seed-sweep/`, which is where reviewed, committed, already-cited
 * evidence lives. The replacement was silent — the JSON still parsed, the path
 * was still approved, and only the `runtime.tyr.version` recorded inside each
 * per-seed file showed that a different runtime had produced it.
 *
 * These checks assert the two properties that make that impossible: the guards
 * refuse reviewed paths, and the sweep computes its output somewhere else.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  REVIEWED_EVIDENCE,
  assertSafeOutputFile,
  assertSafeResultsDir,
  assertSafeRunDir,
  isReviewedEvidence,
  latestPointerFile,
  repoRelative,
  reviewedEvidenceInside,
  runDir,
  runId,
} from "./evidence-paths-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS = path.join(ROOT, "results");
const failures = [];

function check(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    console.log(`FAIL  ${name} — ${error instanceof Error ? error.message : String(error)}`);
    failures.push(name);
  }
}

check("the published sweep paths are declared reviewed", () => {
  assert.equal(isReviewedEvidence("results/video-seed-sweep.json"), true);
  assert.equal(isReviewedEvidence("results/video-seed-sweep/baseline-seed-1.json"), true);
  assert.equal(isReviewedEvidence("results/curated/negative-fragmented-batch-floor/aggregate.json"), true);
  assert.equal(isReviewedEvidence("results/openai-live-overload-8-seed.json"), true);
  assert.equal(isReviewedEvidence("results/openai-live-overload-8-seed/seed-1/summary.json"), true);
});

check("generated run output is not reviewed", () => {
  assert.equal(isReviewedEvidence("results/runs/video-seed-sweep/20260801T223625Z/summary.json"), false);
  assert.equal(isReviewedEvidence("results/video-seed-sweep-extra.json"), false);
});

check("a directory guard rejects a reviewed evidence directory", () => {
  assert.throws(
    () => assertSafeResultsDir(path.join(RESULTS, "video-seed-sweep"), ROOT),
    /reviewed evidence/,
  );
});

check("a run directory guard rejects a parent of reviewed evidence", () => {
  // `results/` itself: legal to write individual scratch files into, illegal to
  // clear recursively, which is what a run directory does on startup.
  assert.doesNotThrow(() => assertSafeResultsDir(RESULTS, ROOT));
  assert.throws(() => assertSafeRunDir(RESULTS, ROOT), /contains reviewed evidence/);
  assert.ok(reviewedEvidenceInside("results").length > 0);
});

check("a file guard rejects the published summary", () => {
  assert.throws(
    () => assertSafeOutputFile(path.join(RESULTS, "video-seed-sweep.json"), ROOT),
    /reviewed evidence/,
  );
  assert.doesNotThrow(() =>
    assertSafeOutputFile(path.join(RESULTS, "runs", "video-seed-sweep", "x", "summary.json"), ROOT),
  );
});

check("a run directory is accepted and sits under results/runs", () => {
  const dir = runDir(RESULTS, "video-seed-sweep", runId());
  assert.doesNotThrow(() => assertSafeRunDir(dir, ROOT));
  assert.match(repoRelative(dir, ROOT), /^results\/runs\/video-seed-sweep\/\d{8}T\d{6}Z$/);
  assert.equal(
    repoRelative(latestPointerFile(RESULTS, "video-seed-sweep"), ROOT),
    "results/runs/video-seed-sweep/latest.json",
  );
});

check("run ids sort chronologically as strings", () => {
  const earlier = runId(new Date("2026-08-01T22:36:25.269Z"));
  const later = runId(new Date("2026-08-01T23:01:00.000Z"));
  assert.equal(earlier, "20260801T223625Z");
  assert.ok(earlier < later);
});

const sweep = readFileSync(path.join(ROOT, "demo", "seed-sweep.mjs"), "utf8");

check("the sweep no longer derives its output from the results root", () => {
  assert.equal(
    /path\.join\(RESULTS, `\$\{sweepName\(\)\}\.json`\)/.test(sweep),
    false,
    "the summary is being written back into the reviewed evidence path",
  );
  assert.ok(sweep.includes("assertSafeRunDir("), "the sweep must guard its run directory");
  assert.ok(sweep.includes('path.join(sweepDir, "summary.json")'));
});

check("the sweep confines the presenter to its own scratch directory", () => {
  assert.ok(
    /MOFLUX_BENCH_RESULTS_DIR: SCRATCH/.test(sweep),
    "the presenter would otherwise write scratch into results/",
  );
});

check("the presenter guards the directory it was given", () => {
  const present = readFileSync(path.join(ROOT, "demo", "present.mjs"), "utf8");
  assert.ok(present.includes("assertSafeResultsDir(RESULTS, ROOT"));
});

check("every reviewed entry is under results/", () => {
  for (const entry of REVIEWED_EVIDENCE) {
    assert.ok(entry.startsWith("results/"), entry);
  }
});

console.log();
if (failures.length > 0) {
  console.log(`${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("All checks passed.");
