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
  assert.match(unknown.stderr, /--capacity-profile must be historical-31-1, adaptive-28-4, or adaptive-headroom-28-4/);

  const conflict = run(
    "--capacity-profile=adaptive-28-4",
    "--batch-concurrency-slots=3",
  );
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /fixes the protected 28\/4, 24k\/40k policy/);
  assert.match(conflict.stderr, /--batch-concurrency-slots \(must be 4\)/);

  const headroomConflict = run(
    "--capacity-profile=adaptive-headroom-28-4",
    "--headroom-min-concurrent=3",
  );
  assert.notEqual(headroomConflict.status, 0);
  assert.match(headroomConflict.stderr, /plus 4-slot\/4000-token retained interactive headroom/);
  assert.match(headroomConflict.stderr, /--headroom-min-concurrent \(must be 4\)/);

  const headroomFlagWithoutProfile = run(
    "--capacity-profile=adaptive-28-4",
    "--headroom-min-tokens=4000",
  );
  assert.notEqual(headroomFlagWithoutProfile.status, 0);
  assert.match(headroomFlagWithoutProfile.stderr, /headroom flags require --capacity-profile=adaptive-headroom-28-4/);

  const shortLease = run(
    "--capacity-profile=adaptive-28-4",
    "--grant-ttl-ms=11000",
  );
  assert.notEqual(shortLease.status, 0);
  assert.match(shortLease.stderr, /--grant-ttl-ms must be at least 60000 for a 45000ms MoFlux phase/);

  const baselineProfile = run(
    "--capacity-profile=adaptive-28-4",
    "--mode=baseline",
  );
  assert.notEqual(baselineProfile.status, 0);
  assert.match(baselineProfile.stderr, /requires a MoFlux arm; use --mode=moflux or --mode=compare/);
  assert.doesNotMatch(baselineProfile.stderr, /--lending requires --mode=compare/);

  // Regression for demo:headroom:compare: adaptive profiles are valid in a
  // MoFlux-only seed sweep. Use an intentionally short TTL so validation stops
  // before any Docker/runtime work while proving we got past the old mode guard.
  const mofluxAdaptive = run(
    "--capacity-profile=adaptive-28-4",
    "--mode=moflux",
    "--grant-ttl-ms=11000",
  );
  assert.notEqual(mofluxAdaptive.status, 0);
  assert.match(mofluxAdaptive.stderr, /--grant-ttl-ms must be at least 60000/);
  assert.doesNotMatch(mofluxAdaptive.stderr, /--lending requires --mode=compare/);

  const mofluxHeadroom = run(
    "--capacity-profile=adaptive-headroom-28-4",
    "--mode=moflux",
    "--grant-ttl-ms=11000",
  );
  assert.notEqual(mofluxHeadroom.status, 0);
  assert.match(mofluxHeadroom.stderr, /--grant-ttl-ms must be at least 60000/);
  assert.doesNotMatch(mofluxHeadroom.stderr, /--lending requires --mode=compare/);

  console.log("PASS  adaptive and headroom-aware 28/4 profile validation");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
