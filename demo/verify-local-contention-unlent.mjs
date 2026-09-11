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
      capacityInvariantViolations,
      contentionPoolDefinition,
      contentionRestorationClaim,
      nominalClassGrant
    } from ${JSON.stringify(new URL("./local-contention-lib.mjs", import.meta.url).href)};
    const staticPool = contentionPoolDefinition("local-static", 15000, { lending: false });
    const mofluxPool = contentionPoolDefinition("local-moflux", 15000, { lending: true });
    const nominal = nominalClassGrant();
    const sample = (interactiveProtectedConcurrent) => ({
      offsetMs: 0,
      pool: { maxConcurrent: 4, tokenBudget: 4000, inFlight: 0, sharedMaxConcurrent: 0 },
      classes: {
        interactive: {
          limits: { ...nominal.interactive, protectedConcurrent: interactiveProtectedConcurrent },
          inFlight: 0, inFlightTokens: 0, borrowedConcurrent: 0, admitted: 0, rejected: 0
        },
        batch: {
          limits: { ...nominal.batch },
          inFlight: 0, inFlightTokens: 0, borrowedConcurrent: 0, admitted: 0, rejected: 0
        }
      }
    });
    console.log(JSON.stringify({
      profile: LOCAL_CONTENTION_PROFILE,
      descriptor: CONTENTION_PROFILE,
      sweep: LOCAL_CONTENTION_SWEEP_NAME,
      policy: CONTENTION_POLICY,
      nominal,
      staticBatchMax: staticPool.admissionClassLimits.batch.globalMaxConcurrent,
      mofluxBatchMax: mofluxPool.admissionClassLimits.batch.globalMaxConcurrent,
      staticInteractiveUnlentConcurrent:
        staticPool.admissionClassLimits.interactive.globalUnlentProtectedConcurrent ?? null,
      mofluxInteractiveUnlentConcurrent:
        mofluxPool.admissionClassLimits.interactive.globalUnlentProtectedConcurrent ?? null,
      mofluxBatchUnlentConcurrent:
        mofluxPool.admissionClassLimits.batch.globalUnlentProtectedConcurrent ?? null,
      restorationClaim: contentionRestorationClaim("moflux"),
      belowNativeFloor: capacityInvariantViolations([sample(0)]).unlentFloorViolations,
      atNativeFloor: capacityInvariantViolations([sample(CONTENTION_POLICY.unlentProtectedConcurrent.interactive)]).unlentFloorViolations
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
assert.equal(experiment.descriptor.implementation, "latchflo-native-unlent-concurrency");
assert.equal(experiment.policy.physical.maxConcurrent, 4);
assert.equal(experiment.policy.classes.interactive.globalProtectedConcurrent, 3);
assert.equal(experiment.policy.classes.batch.globalProtectedConcurrent, 1);
assert.equal(experiment.policy.classes.interactive.globalMaxConcurrent, 4);
assert.equal(experiment.policy.classes.batch.globalMaxConcurrent, 4);
assert.equal(experiment.policy.unlentProtectedConcurrent.interactive, 1);
assert.equal(experiment.staticBatchMax, 4);
assert.equal(experiment.mofluxBatchMax, 4);
assert.equal(
  experiment.staticInteractiveUnlentConcurrent,
  null,
  "the non-lending static arm must not need a native unlent field",
);
assert.equal(
  experiment.mofluxInteractiveUnlentConcurrent,
  1,
  "the lending arm must send Latchflo the one-slot native unlent floor",
);
assert.equal(experiment.mofluxBatchUnlentConcurrent, null);
assert.equal(experiment.restorationClaim.unlentProtectedConcurrent.interactive, 1);
assert.deepEqual(
  Object.fromEntries(Object.entries(experiment.nominal).map(([k, v]) => [k, v.protectedConcurrent])),
  { interactive: 3, batch: 1 },
  "the follow-up must not change the protected 3/1 partition",
);

// The borrower's class ceiling remains unchanged. Latchflo withholds one of
// interactive's three protected slots, so only two slots can become shared.
assert.equal(
  experiment.policy.classes.interactive.globalProtectedConcurrent -
    experiment.policy.unlentProtectedConcurrent.interactive,
  2,
  "exactly two interactive protected slots remain lendable",
);
assert.equal(
  experiment.policy.classes.batch.globalMaxConcurrent,
  baseline.policy.classes.batch.globalMaxConcurrent,
  "the follow-up must not enforce the reserve by narrowing batch",
);
assert.equal(experiment.belowNativeFloor.length, 1);
assert.equal(experiment.belowNativeFloor[0].resource, "concurrency");
assert.equal(experiment.belowNativeFloor[0].threshold, 1);
assert.equal(
  experiment.atNativeFloor.filter((entry) => entry.resource === "concurrency").length,
  0,
  "an applied protected concurrency floor at the native unlent slice is safe",
);


const runnerSource = readFileSync(path.join(ROOT, "demo", "local-contention.mjs"), "utf8");
const evidenceSource = readFileSync(
  path.join(ROOT, "demo", "restoration-enforceability-lib.mjs"),
  "utf8",
);
assert.match(evidenceSource, /latchflo_admission_class_unlent_protected_concurrent/);
assert.match(runnerSource, /unlentConcurrentObserved/);
assert.match(runnerSource, /unlentGauges: mofluxEvidence\.unlentGauges/);
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
assert.match(dry.stdout, /latchflo-native-unlent-concurrency/);
assert.match(dry.stdout, /PASS dry-run/);

console.log("PASS local-contention unlent-concurrency profile");
