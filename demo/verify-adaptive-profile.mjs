#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(path.join(tmpdir(), "moflux-adaptive-profile-"));

function run(...args) {
  return spawnSync(process.execPath, [path.join(ROOT, "demo", "present.mjs"), ...args], {
    cwd: ROOT,
    env: { ...process.env, MOFLUX_BENCH_RESULTS_DIR: temp },
    encoding: "utf8",
  });
}

try {
  const unknown = run("--capacity-profile=unknown");
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /--capacity-profile must be historical-31-1 or adaptive-28-4/);

  const conflict = run(
    "--capacity-profile=adaptive-28-4",
    "--batch-concurrency-slots=3",
  );
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /fixes the protected 28\/4, 24k\/40k policy/);
  assert.match(conflict.stderr, /--batch-concurrency-slots \(must be 4\)/);

  const shortLease = run(
    "--capacity-profile=adaptive-28-4",
    "--grant-ttl-ms=11000",
  );
  assert.notEqual(shortLease.status, 0);
  assert.match(shortLease.stderr, /--grant-ttl-ms must be at least 60000 for a 45000ms MoFlux phase/);

  const accepted = run(
    "--capacity-profile=adaptive-28-4",
    "--mode=baseline",
  );
  assert.notEqual(accepted.status, 0);
  assert.match(accepted.stderr, /--lending requires --mode=compare/);
  assert.doesNotMatch(accepted.stderr, /capacity-profile must be/);

  console.log("PASS  adaptive 28/4 profile validation");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
