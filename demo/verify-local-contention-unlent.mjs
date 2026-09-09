#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadProfile(profile) {
  const script = `
    import {
      CONTENTION_POLICY,
      CONTENTION_PROFILE,
      LOCAL_CONTENTION_PROFILE,
      LOCAL_CONTENTION_SWEEP_NAME,
      contentionPoolDefinition,
      nominalClassGrant
    } from ${JSON.stringify(new URL("./local-contention-lib.mjs", import.meta.url).href)};
    const staticPool = contentionPoolDefinition("local-static", 15000, { lending: false });
    const mofluxPool = contentionPoolDefinition("local-moflux", 15000, { lending: true });
    console.log(JSON.stringify({
      profile: LOCAL_CONTENTION_PROFILE,
      descriptor: CONTENTION_PROFILE,
      sweep: LOCAL_CONTENTION_SWEEP_NAME,
      policy: CONTENTION_POLICY,
      nominal: nominalClassGrant(),
      staticBatchMax: staticPool.admissionClassLimits.batch.globalMaxConcurrent,
      mofluxBatchMax: mofluxPool.admissionClassLimits.batch.globalMaxConcurrent
    }));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: ROOT,
    env: { ...process.env, MOFLUX_LOCAL_CONTENTION_PROFILE: profile },
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout.trim());
}

const baseline = loadProfile("baseline");
assert.equal(baseline.sweep, "local-inference-contention");
assert.equal(baseline.policy.physical.maxConcurrent, 4);
assert.equal(baseline.policy.classes.interactive.globalProtectedConcurrent, 3);
assert.equal(baseline.policy.classes.batch.globalProtectedConcurrent, 1);
assert.equal(baseline.policy.classes.batch.globalMaxConcurrent, 4);
assert.equal(baseline.policy.unlentProtectedConcurrent.interactive, 0);

const experiment = loadProfile("unlent-concurrency-1");
assert.equal(experiment.sweep, "local-inference-contention-unlent-concurrency");
assert.equal(experiment.descriptor.implementation, "borrower-class-ceiling");
assert.equal(experiment.policy.physical.maxConcurrent, 4);
assert.equal(experiment.policy.classes.interactive.globalProtectedConcurrent, 3);
assert.equal(experiment.policy.classes.batch.globalProtectedConcurrent, 1);
assert.equal(experiment.policy.classes.interactive.globalMaxConcurrent, 4);
assert.equal(experiment.policy.classes.batch.globalMaxConcurrent, 3);
assert.equal(experiment.policy.unlentProtectedConcurrent.interactive, 1);
assert.equal(experiment.staticBatchMax, 3);
assert.equal(experiment.mofluxBatchMax, 3);
assert.deepEqual(
  Object.fromEntries(Object.entries(experiment.nominal).map(([k, v]) => [k, v.protectedConcurrent])),
  { interactive: 3, batch: 1 },
  "the follow-up must not change the protected 3/1 partition",
);

// The static arm never exceeds its protected floor of one, so max=3 is inert
// there. In the lending arm the same max is what prevents batch from consuming
// all four physical slots: own floor 1 + at most 2 borrowed = 3.
assert.equal(
  experiment.policy.classes.batch.globalMaxConcurrent -
    experiment.policy.classes.batch.globalProtectedConcurrent,
  2,
  "batch may borrow exactly two interactive slots in the new profile",
);


const runnerSource = readFileSync(path.join(ROOT, "demo", "local-contention.mjs"), "utf8");
assert.match(
  runnerSource,
  /--drain-timeout-mode=\$\{arm\.managed \? "fail" : "censor"\}/,
  "only the unmanaged direct arm may censor a progressing hard-drain tail",
);
assert.match(
  runnerSource,
  /resetOllamaAfterCensoredDrain/,
  "a censored direct tail must trigger an Ollama runtime reset before another arm",
);
assert.match(
  runnerSource,
  /--force-recreate", "--wait", "ollama"/,
  "the reset must recreate Ollama rather than assuming client abort reclaimed upstream work",
);

const invalid = spawnSync(
  process.execPath,
  ["--input-type=module", "--eval", `import ${JSON.stringify(new URL("./local-contention-lib.mjs", import.meta.url).href)}`],
  {
    cwd: ROOT,
    env: { ...process.env, MOFLUX_LOCAL_CONTENTION_PROFILE: "made-up" },
    encoding: "utf8",
  },
);
assert.notEqual(invalid.status, 0);
assert.match(invalid.stderr, /unknown MOFLUX_LOCAL_CONTENTION_PROFILE/);

const dry = spawnSync(process.execPath, ["demo/local-contention-unlent.mjs", "--dry-run"], {
  cwd: ROOT,
  encoding: "utf8",
});
assert.equal(dry.status, 0, dry.stderr);
assert.match(dry.stdout, /local-inference-contention-unlent-concurrency/);
assert.match(dry.stdout, /unlent-concurrency-1/);
assert.match(dry.stdout, /PASS dry-run/);

console.log("PASS local-contention unlent-concurrency profile");
