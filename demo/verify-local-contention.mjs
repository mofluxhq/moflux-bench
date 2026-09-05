#!/usr/bin/env node
/**
 * Verifies the local contention harness without Docker, Ollama, or weights.
 *
 * Everything that decides what the benchmark measures — the trace, the arm
 * partitions, the invariant arithmetic, the acceptance gates, and the shape of
 * the published evidence — is pure, and is checked here against fixtures. The
 * one thing a fixture cannot check is whether the real control plane lends a
 * real floor, which is why the runner collects that from three independent
 * sources rather than asserting it.
 *
 * The gate tests deliberately include the failing direction. A proof that only
 * has passing fixtures is a proof nobody has watched fail.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildTrace, traceVersion, validateTrace } from "../load/trace-lib.mjs";
import {
  IDENTITY_REFRESH_SKEW_SECONDS,
  IDENTITY_TOKEN_TTL_SECONDS,
  startIdentityFixture,
  tokenFingerprint,
} from "./identity-fixture-lib.mjs";
import { REVIEWED_EVIDENCE, isReviewedEvidence } from "./evidence-paths-lib.mjs";
import {
  CONTENTION_ARMS,
  CONTENTION_ARM_IDS,
  CONTENTION_ENDPOINT,
  CONTENTION_OLLAMA_PORT,
  CONTENTION_POLICY,
  CONTENTION_WORKLOAD,
  EVIDENCE_LIMITS,
  HYPOTHESIS_THRESHOLDS,
  LOCAL_CONTENTION_SWEEP_NAME,
  PUBLICATION_SEED_COUNT,
  aggregateArmClass,
  armOrderForSeedIndex,
  armOrderIsCounterbalanced,
  armOrderPlan,
  capacityInvariantViolations,
  compareLocalContention,
  contentionArm,
  contentionPoolDefinition,
  contentionRestorationClaim,
  criticalWindowDigest,
  classDemandActivity,
  classEncroachment,
  localContentionProof,
  localContentionSeedProof,
  nominalClassGrant,
  percentile,
  scenarioId,
  summarizeArmClasses,
  summarizeClassHandoffSafety,
  summarizeDemandTransitions,
  summarizeLendingEpisodes,
} from "./local-contention-lib.mjs";
import { assertLocalUpstream, isLocalHostname } from "./local-inference-lib.mjs";
import { publishRun } from "./publish-evidence-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Locality: every endpoint this benchmark can address, and nothing else
// ---------------------------------------------------------------------------

for (const arm of CONTENTION_ARMS) {
  const url = `http://127.0.0.1:${arm.port}${CONTENTION_ENDPOINT}`;
  assert.equal(isLocalHostname(new URL(url).hostname), true, `${arm.id} must be local`);
  assert.doesNotThrow(() => assertLocalUpstream(url, `arm ${arm.id}`));
}
assert.doesNotThrow(() =>
  assertLocalUpstream(`http://127.0.0.1:${CONTENTION_OLLAMA_PORT}${CONTENTION_ENDPOINT}`, "ollama"),
);

// The same guard the compatibility benchmark relies on, exercised through the
// hosts a contention run could plausibly be misdirected at.
for (const hosted of [
  "https://api.openai.com/v1/chat/completions",
  "http://api.anthropic.com/v1/chat/completions",
  "https://generativelanguage.googleapis.com/v1/chat/completions",
  "http://8.8.8.8:11436/v1/chat/completions",
]) {
  assert.throws(
    () => assertLocalUpstream(hosted, "arm endpoint"),
    /not a local address/,
    `${hosted} must be refused`,
  );
}

// The arms are addressed by fixed loopback ports derived from constants, so
// unlike the compatibility benchmark there is no endpoint flag at all. Nothing
// in the runner may reintroduce one.
const runnerSource = readFileSync(path.join(ROOT, "demo/local-contention.mjs"), "utf8");
for (const forbidden of [
  "direct-url",
  "moflux-url",
  "ollama-url",
  "allow-remote",
  "allow-nonlocal",
  "skip-locality",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
]) {
  assert.ok(
    !runnerSource.includes(forbidden),
    `demo/local-contention.mjs must not accept or read ${forbidden}`,
  );
}
assert.ok(runnerSource.includes("assertLocalUpstream"), "the locality guard must be applied");
assert.ok(
  runnerSource.includes(".loadgen.log") &&
    runnerSource.includes("childOutputTail(child)") &&
    runnerSource.includes("full output:"),
  "a failed local-contention loadgen must retain both an inline output tail and a persisted per-arm log",
);
assert.ok(
  runnerSource.includes("repoRelative(diagnosticsFile, ROOT)"),
  "failed-loadgen diagnostics must render their persisted path relative to the repository root",
);
const doctorBranch = runnerSource.indexOf("if (OPT.doctor)");
const doctorElse = runnerSource.indexOf("  } else {", doctorBranch);
const envCreation = runnerSource.indexOf("ensureDemoEnv(ENV_FILE");
assert.ok(
  doctorBranch >= 0 && doctorElse > doctorBranch && envCreation > doctorElse,
  "--doctor must not create or migrate demo/moflux/.env",
);

// ---------------------------------------------------------------------------
// Arm configuration
// ---------------------------------------------------------------------------

assert.deepEqual(CONTENTION_ARM_IDS, ["direct", "static", "moflux"]);
assert.throws(() => contentionArm("gpu-preempt"), /unknown local-contention arm/);
assert.equal(contentionArm("direct").managed, false);
assert.equal(contentionArm("static").lending, false);
assert.equal(contentionArm("moflux").lending, true);
// Every managed arm needs its own pool and its own port, or two arms would be
// measuring one partition.
const pools = CONTENTION_ARMS.filter((arm) => arm.managed).map((arm) => arm.pool);
assert.equal(new Set(pools).size, pools.length);
assert.equal(new Set(CONTENTION_ARMS.map((arm) => arm.port)).size, CONTENTION_ARMS.length);

const staticPool = contentionPoolDefinition("local-static", 60_000, { lending: false });
const mofluxPool = contentionPoolDefinition("local-moflux", 60_000, { lending: true });

// The single-variable claim: the two arms partition identical capacity and
// differ only in whether the control plane may lend an idle floor.
assert.equal(staticPool.globalMaxConcurrent, mofluxPool.globalMaxConcurrent);
assert.equal(staticPool.globalTokenBudget, mofluxPool.globalTokenBudget);
for (const admissionClass of ["interactive", "batch"]) {
  for (const field of [
    "globalProtectedConcurrent",
    "globalMaxConcurrent",
    "globalProtectedInFlightTokens",
    "globalMaxInFlightTokens",
  ]) {
    assert.equal(
      staticPool.admissionClassLimits[admissionClass][field],
      mofluxPool.admissionClassLimits[admissionClass][field],
      `${admissionClass}.${field} must match across arms`,
    );
  }
}
assert.equal(staticPool.admissionClassDemandPolicy, undefined, "the static arm must not lend");
assert.equal(mofluxPool.admissionClassDemandPolicy.enabled, true);
assert.equal(
  mofluxPool.admissionClassDemandPolicy.restoration.upstreamCapacity.releaseMechanism,
  "unlent_floor",
);
assert.equal(
  mofluxPool.admissionClassDemandPolicy.restoration.admissionSlots.releaseMechanism,
  "lease_safe_handoff",
);
for (const admissionClass of ["interactive", "batch"]) {
  const unlent = mofluxPool.admissionClassLimits[admissionClass]
    .globalUnlentProtectedInFlightTokens;
  assert.ok(unlent > 0, `${admissionClass} must carry a positive unlent slice`);
  assert.ok(
    unlent <= mofluxPool.admissionClassLimits[admissionClass].globalProtectedInFlightTokens,
    "an unlent slice cannot exceed the floor it is carved from",
  );
  assert.equal(
    staticPool.admissionClassLimits[admissionClass].globalUnlentProtectedInFlightTokens,
    undefined,
    "a non-lending policy must not declare an unlent slice",
  );
}
assert.throws(() => contentionPoolDefinition("x", 60_000, {}), /explicit lending flag/);
assert.throws(() => contentionPoolDefinition("x", 0, { lending: false }), /positive integer/);

// Protected floors must partition the physical ceiling exactly, which is what
// makes the static arm rigid rather than merely capped.
const floors = Object.values(CONTENTION_POLICY.classes);
assert.equal(
  floors.reduce((sum, limits) => sum + limits.globalProtectedConcurrent, 0),
  CONTENTION_POLICY.physical.maxConcurrent,
);
assert.ok(
  floors.reduce((sum, limits) => sum + limits.globalProtectedInFlightTokens, 0) <=
    CONTENTION_POLICY.physical.tokenBudget,
);

// Restoration claims must never out-rank what the configuration bought.
const mofluxClaim = contentionRestorationClaim("moflux");
assert.equal(mofluxClaim.enforceability.upstreamCapacity, "unlent_floor");
assert.equal(mofluxClaim.enforceability.admissionSlots, "objective");
assert.equal(mofluxClaim.upstreamReclamation, "not-claimed");
assert.equal(contentionRestorationClaim("static").contract, null);
assert.equal(contentionRestorationClaim("static").enforceability.upstreamCapacity, "never-lent");
assert.equal(contentionRestorationClaim("direct"), null);

// The published limits must keep saying what this benchmark cannot claim.
for (const key of [
  "gpuPreemption",
  "gpuUtilization",
  "kvCacheReclamation",
  "ollamaSchedulerPreemption",
  "upstreamReclamation",
  "decodeDeterminism",
  "generalization",
  "productionScale",
]) {
  assert.ok(typeof EVIDENCE_LIMITS[key] === "string" && EVIDENCE_LIMITS[key].length > 0, key);
}

// ---------------------------------------------------------------------------
// Workload trace determinism
// ---------------------------------------------------------------------------

assert.equal(traceVersion(CONTENTION_WORKLOAD), 3, "the phased workload is a version-3 trace");
const traceA = buildTrace({ ...CONTENTION_WORKLOAD, seed: 7 });
const traceB = buildTrace({ ...CONTENTION_WORKLOAD, seed: 7 });
assert.equal(traceA.hash, traceB.hash, "one seed must produce one trace");
assert.notEqual(
  buildTrace({ ...CONTENTION_WORKLOAD, seed: 8 }).hash,
  traceA.hash,
  "different seeds must produce different traces",
);
assert.doesNotThrow(() => validateTrace(traceA, { ...CONTENTION_WORKLOAD, seed: 7 }));

// The five phases have to exist in the arrivals, not just in the prose.
const interactiveArrivals = traceA.entries
  .filter((entry) => entry.class === "interactive")
  .map((entry) => entry.arrivalMs);
const batchArrivals = traceA.entries
  .filter((entry) => entry.class === "batch")
  .map((entry) => entry.arrivalMs);
assert.ok(interactiveArrivals.length > 0 && batchArrivals.length > 0);
assert.ok(
  Math.min(...batchArrivals) >= CONTENTION_WORKLOAD.batchStartMs,
  "no batch arrival may precede the batch window",
);
assert.ok(
  interactiveArrivals.some((at) => at < CONTENTION_WORKLOAD.batchStartMs),
  "phase 2 must offer interactive work before batch starts",
);
// The quiet interval is the whole point: without it no floor is ever observed
// idle, and lending cannot be exercised at all.
const quiet = interactiveArrivals.filter(
  (at) =>
    at >= CONTENTION_WORKLOAD.interactiveStartMs + CONTENTION_WORKLOAD.interactiveDurationMs &&
    at < CONTENTION_WORKLOAD.interactiveResumeStartMs,
);
assert.equal(quiet.length, 0, "the interactive class must be genuinely quiet before it resumes");
assert.ok(
  interactiveArrivals.some((at) => at >= CONTENTION_WORKLOAD.interactiveResumeStartMs),
  "phase 4 must offer interactive work again while batch is still running",
);
assert.ok(
  batchArrivals.some((at) => at >= CONTENTION_WORKLOAD.interactiveResumeStartMs),
  "batch must still be arriving when interactive returns, or there is no overlap",
);

// A version-3 trace must not be replayable by a configuration that does not
// declare the resume window, and the reverse.
assert.throws(
  () => validateTrace(traceA, { ...CONTENTION_WORKLOAD, seed: 7, interactiveResumeRps: 0 }),
  /version/,
);
// An arrival smuggled into the quiet window must be refused rather than
// replayed as an ordinary contended run.
const tampered = {
  ...traceA,
  entries: [
    ...traceA.entries,
    {
      ...traceA.entries.find((entry) => entry.class === "interactive"),
      id: "interactive-smuggled",
      arrivalMs:
        (CONTENTION_WORKLOAD.interactiveStartMs + CONTENTION_WORKLOAD.interactiveDurationMs +
          CONTENTION_WORKLOAD.interactiveResumeStartMs) / 2,
    },
  ],
  hash: undefined,
};
assert.throws(
  () => validateTrace(tampered, { ...CONTENTION_WORKLOAD, seed: 7 }),
  /outside every configured interactive window/,
);

// Adding the resume window must not have moved a single draw in the historical
// shapes. Reviewed evidence depends on those hashes reproducing exactly.
const legacy = {
  durationMs: 30_000,
  seed: 3,
  interactiveRps: 6,
  interactiveInputChars: 1200,
  interactiveMaxTokens: 400,
  batchStartMs: 5_000,
  batchDurationMs: 25_000,
  batchRps: 5,
  batchInputChars: 15_000,
  batchMaxTokens: 4_000,
  maxAttempts: 3,
  backoffBaseMs: 250,
  sizeDistribution: "uniform",
  interactiveSizeSigma: 0.75,
  batchSizeSigma: 0,
};
assert.equal(traceVersion(legacy), 1);
assert.equal(buildTrace(legacy).version, 1);
assert.equal(
  buildTrace(legacy).entries.filter((entry) => entry.class === "interactive")[0].id,
  "interactive-1",
  "single-window interactive ids must keep their historical form",
);
assert.equal(traceVersion({ ...legacy, sizeDistribution: "lognormal" }), 2);

// ---------------------------------------------------------------------------
// Counterbalanced arm order
// ---------------------------------------------------------------------------

assert.deepEqual(armOrderForSeedIndex(0), ["direct", "static", "moflux"]);
assert.deepEqual(armOrderForSeedIndex(1), ["static", "moflux", "direct"]);
assert.deepEqual(armOrderForSeedIndex(2), ["moflux", "direct", "static"]);
assert.deepEqual(armOrderForSeedIndex(3), ["moflux", "static", "direct"]);
assert.throws(() => armOrderForSeedIndex(-1), /non-negative/);
const plan = armOrderPlan([1, 2, 3, 4, 5]);
assert.equal(plan.length, 5);
assert.equal(armOrderIsCounterbalanced(plan), true, "five seeds must cover every position");
assert.equal(
  armOrderIsCounterbalanced(armOrderPlan([1])),
  false,
  "one seed cannot be counterbalanced and must not claim to be",
);

// ---------------------------------------------------------------------------
// Protected-floor and capacity-invariant arithmetic
// ---------------------------------------------------------------------------

const nominal = nominalClassGrant();
assert.equal(nominal.interactive.protectedConcurrent, 3);
assert.equal(nominal.batch.protectedConcurrent, 1);

function sampleAt(offsetMs, overrides = {}) {
  const base = {
    offsetMs,
    pool: { maxConcurrent: 4, tokenBudget: 4_000, inFlight: 0, sharedMaxConcurrent: 0 },
    classes: {
      interactive: {
        limits: { ...nominal.interactive },
        inFlight: 0,
        inFlightTokens: 0,
        borrowedConcurrent: 0,
        recentAdmissions: 0,
      },
      batch: {
        limits: { ...nominal.batch },
        inFlight: 0,
        inFlightTokens: 0,
        borrowedConcurrent: 0,
        recentAdmissions: 0,
      },
    },
  };
  return {
    ...base,
    ...overrides,
    classes: {
      interactive: { ...base.classes.interactive, ...(overrides.classes?.interactive ?? {}) },
      batch: { ...base.classes.batch, ...(overrides.classes?.batch ?? {}) },
    },
  };
}

const clean = capacityInvariantViolations([sampleAt(0), sampleAt(500)]);
assert.equal(clean.total, 0, "a nominal partition violates nothing");
assert.equal(clean.samples, 2);
assert.equal(clean.leaseGapSamples, 0);
assert.equal(clean.leaseGapShare, 0);

// A lease gap is not a floor violation. Latchflo issues a replacement grant
// only after the old one expires, so the pool briefly holds nothing; recording
// that as a breached floor would be wrong, and ignoring it would hide a real
// cost of the short lease this benchmark runs.
const gapped = capacityInvariantViolations([
  sampleAt(0),
  { offsetMs: 250, pool: { maxConcurrent: 0, tokenBudget: 0 }, classes: {} },
  sampleAt(500),
]);
assert.equal(gapped.leaseGapSamples, 1);
assert.equal(gapped.leaseGapShare, 0.3333);
assert.equal(gapped.total, 0, "an ungranted sample is a gap, not a violation");
assert.equal(gapped.unlentFloorViolations.length, 0);

// The unlent slice is the one part of the floor that must survive lending.
const belowUnlent = capacityInvariantViolations([
  sampleAt(0, {
    classes: {
      interactive: {
        limits: { ...nominal.interactive, protectedConcurrent: 0, protectedInFlightTokens: 0 },
      },
    },
  }),
]);
assert.equal(belowUnlent.unlentFloorViolations.length, 1);
assert.equal(belowUnlent.unlentFloorViolations[0].admissionClass, "interactive");
assert.equal(
  belowUnlent.unlentFloorViolations[0].threshold,
  CONTENTION_POLICY.unlentProtectedTokens.interactive,
);
assert.ok(belowUnlent.unlentFloorViolations[0].reason.length > 0, "a failed gate must say why");

// Lending down to exactly the unlent slice is legal and must not be flagged.
const lentToSlice = capacityInvariantViolations([
  sampleAt(0, {
    classes: {
      interactive: {
        limits: {
          ...nominal.interactive,
          protectedConcurrent: 0,
          protectedInFlightTokens: CONTENTION_POLICY.unlentProtectedTokens.interactive,
        },
      },
      batch: { borrowedConcurrent: 3 },
    },
  }),
]);
assert.equal(lentToSlice.total, 0, "borrowing a fully released floor is not a violation");

// ---------------------------------------------------------------------------
// H4b: no new borrowing after protected demand returns
//
// The invariant is measured as occupancy above a class's *nominal* floor, not
// as Tyr's `borrowedConcurrent` field. The seed-4 false positive at 29.896 s is
// the reason and is reproduced below.
// ---------------------------------------------------------------------------

// Borrowers admitted while a floor was lent may still be draining after the
// floor is restored. That is not over-allocation by itself: restoration here is
// non-preemptive and nothing retroactively unmakes their admission.
const grandfatheredBorrower = capacityInvariantViolations([
  sampleAt(0, {
    classes: {
      interactive: {
        limits: { ...nominal.interactive, protectedConcurrent: 0, protectedInFlightTokens: CONTENTION_POLICY.unlentProtectedTokens.interactive },
        demandState: "idle",
      },
      batch: { inFlight: 4, borrowedConcurrent: 3 },
    },
  }),
  sampleAt(500, {
    classes: {
      interactive: { demandState: "demanding", recentRejections: 1 },
      batch: { inFlight: 4, borrowedConcurrent: 3 },
    },
  }),
  sampleAt(1_000, {
    classes: {
      interactive: { demandState: "demanding", recentRejections: 1 },
      batch: { inFlight: 4, borrowedConcurrent: 3 },
    },
  }),
]);
assert.equal(
  grandfatheredBorrower.borrowGrowthAfterDemandReturn.length,
  0,
  "three borrowers already in flight when demand returned must be grandfathered",
);
// The deprecated 0.33.x key must keep reporting the same verdict for one release.
assert.equal(grandfatheredBorrower.borrowedGrowthAfterRestoration.length, 0);

// THE SEED-4 REGRESSION, reproduced from the 0.33.2 run at offset 29896.
//
// Interactive is still `demanding` because a phase-1 request is decoding, and
// its floor is whole and untouched at 3. Batch has been idle long enough that
// its *own* one-slot floor was lent away, so its applied floor reads 0. Batch's
// first request of the borrow phase therefore reports
// `borrowedConcurrent: 0 -> 1` while occupying nothing but the single slot
// batch owns outright. 0.33.2 called that unsafe. It is not: batch is inside
// its own nominal floor, and the interactive floor is three slots wide with one
// in use.
const seedFourBoundary = capacityInvariantViolations([
  sampleAt(29_579, {
    classes: {
      interactive: { inFlight: 1, protectedConcurrentInUse: 1, demandState: "demanding" },
      batch: {
        limits: { ...nominal.batch, protectedConcurrent: 0 },
        inFlight: 0,
        borrowedConcurrent: 0,
        releasedConcurrent: 1,
        demandState: "idle",
      },
    },
  }),
  sampleAt(29_896, {
    classes: {
      interactive: { inFlight: 1, protectedConcurrentInUse: 1, demandState: "demanding" },
      batch: {
        // Applied floor still 0; Latchflo has already withdrawn the release, so
        // the 0.33.2 allowance for "contemporaneously released non-interactive
        // capacity" was 0 at this very sample and the check fired.
        limits: { ...nominal.batch, protectedConcurrent: 0 },
        inFlight: 1,
        protectedConcurrentInUse: 0,
        borrowedConcurrent: 1,
        releasedConcurrent: 0,
        demandState: "demanding",
      },
    },
  }),
  sampleAt(30_154, {
    classes: {
      interactive: { inFlight: 1, protectedConcurrentInUse: 1, demandState: "demanding" },
      batch: { inFlight: 1, protectedConcurrentInUse: 1, borrowedConcurrent: 0 },
    },
  }),
]);
assert.equal(
  seedFourBoundary.borrowGrowthAfterDemandReturn.length,
  0,
  "batch running inside its own nominal floor is not borrowing interactive's",
);
assert.equal(seedFourBoundary.total, 0, "the 29.896s boundary violates nothing at all");

// Borrow growth during the batch-only idle-capacity phase is the policy working.
// Interactive is idle, its floor is fully released, and batch ramps to four.
const borrowDuringIdlePhase = capacityInvariantViolations(
  [0, 1, 2, 3, 4].map((step) =>
    sampleAt(25_000 + step * 250, {
      classes: {
        interactive: {
          limits: {
            ...nominal.interactive,
            protectedConcurrent: 0,
            protectedInFlightTokens: CONTENTION_POLICY.unlentProtectedTokens.interactive,
          },
          inFlight: 0,
          demandState: "idle",
          releasedConcurrent: 3,
        },
        batch: { inFlight: step, borrowedConcurrent: Math.max(0, step - 1) },
      },
    }),
  ),
);
assert.equal(
  borrowDuringIdlePhase.total,
  0,
  "batch taking an idle interactive floor is the behaviour the benchmark exists to measure",
);

// A whole interactive floor does not reserve capacity interactive itself has
// explicitly released. This is the shape observed by the first 0.33.1 real
// seed and the allowance survives the 0.34.0 rewrite.
const growthBackedByReleasedCapacity = capacityInvariantViolations([
  sampleAt(0, {
    classes: {
      interactive: { demandState: "demanding", inFlight: 1, releasedConcurrent: 1 },
      batch: { inFlight: 1, borrowedConcurrent: 0 },
    },
  }),
  sampleAt(250, {
    classes: {
      interactive: { demandState: "demanding", inFlight: 1, releasedConcurrent: 1 },
      batch: { inFlight: 2, borrowedConcurrent: 1 },
    },
  }),
]);
assert.equal(growthBackedByReleasedCapacity.borrowGrowthAfterDemandReturn.length, 0);

// What the sampled state can prove unsafe: batch takes MORE of interactive's
// nominal floor after interactive has come back for it.
const newBorrowAfterDemandReturn = capacityInvariantViolations([
  sampleAt(0, {
    classes: {
      interactive: { demandState: "demanding", recentRejections: 1 },
      batch: { inFlight: 3, borrowedConcurrent: 2 },
    },
  }),
  sampleAt(250, {
    classes: {
      interactive: { demandState: "demanding", recentRejections: 1 },
      batch: { inFlight: 4, borrowedConcurrent: 3 },
    },
  }),
]);
assert.equal(newBorrowAfterDemandReturn.borrowGrowthAfterDemandReturn.length, 1);
assert.equal(newBorrowAfterDemandReturn.borrowGrowthAfterDemandReturn[0].observed.encroachment, 3);
assert.equal(newBorrowAfterDemandReturn.borrowGrowthAfterDemandReturn[0].observed.grandfathered, 2);

// A rejection is demand. Before 0.34.0 the invariant only recognised
// `demandState === "demanding"`, so a returning owner that Tyr was refusing on
// every attempt — the exact state a fully-borrowed pool produces — could be
// treated as absent and new borrowing against it would pass.
const rejectionIsDemand = capacityInvariantViolations([
  sampleAt(0, {
    classes: {
      interactive: { demandState: null, recentRejections: 2, inFlight: 0 },
      batch: { inFlight: 2, borrowedConcurrent: 1 },
    },
  }),
  sampleAt(250, {
    classes: {
      interactive: { demandState: null, recentRejections: 2, inFlight: 0 },
      batch: { inFlight: 4, borrowedConcurrent: 3 },
    },
  }),
]);
assert.equal(rejectionIsDemand.borrowGrowthAfterDemandReturn.length, 1);

// The ratchet: a grandfathered borrower that finishes gives its slot back to
// the protected class, and the borrower may not refill it. Comparing levels
// alone would miss this, because encroachment never exceeds its baseline.
const refilledAfterAttrition = capacityInvariantViolations([
  sampleAt(0, {
    classes: {
      interactive: { demandState: "demanding", recentRejections: 1 },
      batch: { inFlight: 4, borrowedConcurrent: 3 },
    },
  }),
  sampleAt(250, {
    classes: {
      interactive: { demandState: "demanding", recentRejections: 1 },
      batch: { inFlight: 2, borrowedConcurrent: 1 },
    },
  }),
  sampleAt(500, {
    classes: {
      interactive: { demandState: "demanding", recentRejections: 1 },
      batch: { inFlight: 4, borrowedConcurrent: 3 },
    },
  }),
]);
assert.equal(
  refilledAfterAttrition.borrowGrowthAfterDemandReturn.length,
  1,
  "a freed grandfathered slot must not be lent out again while its owner is still asking",
);

// Demand-state transitions are recorded for both classes with the state that
// produced them.
const transitionSeries = capacityInvariantViolations([
  sampleAt(0, { classes: { interactive: { demandState: "idle" }, batch: { demandState: "idle" } } }),
  sampleAt(250, {
    classes: {
      interactive: { demandState: "demanding", recentRejections: 3, inFlight: 0 },
      batch: { demandState: "demanding", inFlight: 4, borrowedConcurrent: 3 },
    },
  }),
]).demandTransitions;
const interactiveTransition = transitionSeries.find(
  (entry) => entry.class === "interactive" && entry.to === "demanding",
);
assert.ok(interactiveTransition, "an idle -> active transition must be recorded");
assert.equal(interactiveTransition.atMs, 250);
assert.equal(interactiveTransition.from, "idle");
assert.equal(interactiveTransition.fromActive, false);
assert.equal(interactiveTransition.toActive, true);
assert.equal(interactiveTransition.reason, "rejection");
assert.equal(interactiveTransition.recentRejections, 3);
assert.equal(interactiveTransition.grant.protectedConcurrent, 3);
assert.equal(
  transitionSeries.filter((entry) => entry.class === "batch").length >= 1,
  true,
  "transitions must be captured for both classes",
);

assert.equal(
  capacityInvariantViolations([sampleAt(0, { classes: { batch: { inFlight: 5 } } })])
    .classCeilingViolations.length,
  1,
);
assert.equal(
  capacityInvariantViolations([
    sampleAt(0, { classes: { batch: { limits: { ...nominal.batch, maxConcurrent: 9 } } } }),
  ]).ceilingOverAllocations.length,
  1,
);
assert.equal(
  capacityInvariantViolations([
    sampleAt(0, { classes: { interactive: { inFlight: 3 }, batch: { inFlight: 2 } } }),
  ]).poolOverAllocations.length,
  1,
);
assert.equal(
  capacityInvariantViolations([
    sampleAt(0, {
      classes: { interactive: { limits: { ...nominal.interactive, protectedConcurrent: 4 } } },
    }),
  ]).floorSumOverAllocations.length,
  1,
);

// ---------------------------------------------------------------------------
// Lending episodes
// ---------------------------------------------------------------------------

const lentFloor = {
  ...nominal.interactive,
  protectedConcurrent: 0,
  protectedInFlightTokens: CONTENTION_POLICY.unlentProtectedTokens.interactive,
};
const episodeSeries = [
  sampleAt(0),
  sampleAt(500, { classes: { interactive: { limits: lentFloor } } }),
  sampleAt(1_000, { classes: { interactive: { limits: lentFloor } } }),
  // Demand returns while the floor is still lent.
  sampleAt(1_500, { classes: { interactive: { limits: lentFloor, recentAdmissions: 2 } } }),
  sampleAt(2_000, { classes: { interactive: { limits: lentFloor, inFlight: 1 } } }),
  // Restored.
  sampleAt(3_000, { classes: { interactive: { inFlight: 1 } } }),
];
const episodes = summarizeLendingEpisodes(episodeSeries);
assert.equal(episodes.lendingEpisodes, 1);
assert.equal(episodes.restorationEpisodes, 1);
assert.equal(episodes.unrestoredEpisodes, 0);
assert.equal(episodes.peakLentConcurrent, 3);
// Measured from the caller's return, not from the controller's notice.
assert.equal(episodes.restorationLatencyMsMedian, 1_500);
assert.equal(episodes.minRetainedTokenFloor, CONTENTION_POLICY.unlentProtectedTokens.interactive);

const unrestored = summarizeLendingEpisodes(episodeSeries.slice(0, 5));
assert.equal(unrestored.lendingEpisodes, 1);
assert.equal(unrestored.unrestoredEpisodes, 1);
assert.equal(summarizeLendingEpisodes([]).lendingEpisodes, 0);

// ---------------------------------------------------------------------------
// Restoration-required semantics
//
// The 0.33.2 accounting could report a lending episode with `restoredAtMs` set
// and `demandReturnedAtMs` null and count it as neither restored nor
// unrestored. These fixtures pin down each of the four outcomes.
// ---------------------------------------------------------------------------

// (a) Lending with no subsequent demand return is NOT restoration-required.
// The floor came back because the lease rolled over, not because anyone asked.
const passiveReturn = summarizeLendingEpisodes([
  sampleAt(0),
  sampleAt(500, { classes: { interactive: { limits: lentFloor, demandState: "idle" } } }),
  sampleAt(1_000, { classes: { interactive: { limits: lentFloor, demandState: "idle" } } }),
  sampleAt(1_500, { classes: { interactive: { demandState: "idle" } } }),
]);
assert.equal(passiveReturn.lendingEpisodes, 1);
assert.equal(
  passiveReturn.restorationRequiredEpisodes,
  0,
  "a lease returning a floor nobody asked for is not a restoration",
);
assert.equal(passiveReturn.restorationEpisodes, 0);
assert.equal(passiveReturn.passiveReturnEpisodes, 1);
assert.equal(passiveReturn.episodes[0].outcome, "passive-return");
assert.equal(passiveReturn.restorationLatencyMsMedian, null);

// (b) Demand returning while capacity is still borrowed IS restoration-required,
// even when the returning class is refused on every attempt and is therefore
// never admitted and never in flight. This is the case 0.33.2 could not see:
// four real seeds, eight lending episodes, zero restoration-required episodes.
const rejectedOwnerSeries = [
  sampleAt(0),
  sampleAt(500, {
    classes: {
      interactive: { limits: lentFloor, demandState: "idle" },
      batch: { inFlight: 4, borrowedConcurrent: 3 },
    },
  }),
  sampleAt(1_000, {
    classes: {
      interactive: {
        limits: lentFloor,
        demandState: "demanding",
        recentRejections: 1,
        inFlight: 0,
        recentAdmissions: 0,
        restorationPending: true,
      },
      batch: { inFlight: 4, borrowedConcurrent: 3 },
    },
  }),
  sampleAt(1_500, {
    classes: {
      interactive: { demandState: "demanding", recentRejections: 1, inFlight: 0, restorationPending: true },
      batch: { inFlight: 4, borrowedConcurrent: 3 },
    },
  }),
  sampleAt(20_000, {
    classes: {
      interactive: { demandState: "demanding", recentRejections: 1, inFlight: 0 },
      batch: { inFlight: 1, borrowedConcurrent: 0 },
    },
  }),
];
const rejectedOwner = summarizeLendingEpisodes(rejectedOwnerSeries);
assert.equal(rejectedOwner.restorationRequiredEpisodes, 1);
assert.equal(rejectedOwner.restorationEpisodes, 1);
assert.equal(rejectedOwner.unrestoredEpisodes, 0);
assert.equal(rejectedOwner.passiveReturnEpisodes, 0);
const rejectedEpisode = rejectedOwner.episodes[0];
assert.equal(rejectedEpisode.demandReturnedAtMs, 1_000);
assert.equal(
  rejectedEpisode.demandReturnEvidence,
  "rejection",
  "a refusal is demand; measuring demand by admissions cannot see a class that is never admitted",
);
assert.equal(rejectedEpisode.restorationStartedAtMs, 1_000);
assert.equal(rejectedEpisode.restoredAtMs, 1_500);
assert.equal(rejectedEpisode.restorationLatencyMs, 500);
assert.equal(rejectedEpisode.withinRestorationSlo, true);
assert.equal(rejectedEpisode.lentConcurrentAtDemandReturn, 3);
assert.equal(rejectedEpisode.borrowedConcurrentAtDemandReturn, 3);
assert.equal(rejectedEpisode.grandfatheredBorrowersAtDemandReturn, 3);
assert.equal(rejectedEpisode.outcome, "restored");

// (c) The grant coming back is not the owner getting its capacity back. The
// borrowers admitted before the lend hold the pool until they finish, and the
// occupancy clock is the one a caller feels.
assert.equal(rejectedEpisode.occupancyRestoredAtMs, 20_000);
assert.equal(rejectedEpisode.occupancyRestorationLatencyMs, 19_000);
assert.equal(
  rejectedEpisode.occupancyWithinRestorationSlo,
  false,
  "a 19 s wait against a 15 s objective is a breach even when the grant returned in 500 ms",
);
assert.equal(rejectedOwner.occupancyRestorationSloBreaches, 1);
assert.equal(rejectedOwner.restorationSloBreaches, 0);

// (d) Demand returned and the floor never came back: unrestored, and the
// distinction from (a) is exactly whether anyone was asking.
const neverRestored = summarizeLendingEpisodes(rejectedOwnerSeries.slice(0, 3));
assert.equal(neverRestored.restorationRequiredEpisodes, 1);
assert.equal(neverRestored.unrestoredEpisodes, 1);
assert.equal(neverRestored.episodes[0].outcome, "unrestored");

// The four outcomes partition the episodes, always.
for (const summary of [passiveReturn, rejectedOwner, neverRestored, episodes]) {
  assert.equal(
    summary.restorationEpisodes +
      summary.unrestoredEpisodes +
      summary.passiveReturnEpisodes +
      summary.openAtEndOfRunEpisodes,
    summary.lendingEpisodes,
    "every lending episode must land in exactly one outcome",
  );
}

// A lend that is still open when sampling stops is reported as open, not
// inferred to have been restored and not counted as a failure.
const openAtEnd = summarizeLendingEpisodes([
  sampleAt(0),
  sampleAt(500, { classes: { interactive: { limits: lentFloor, demandState: "idle" } } }),
]);
assert.equal(openAtEnd.openAtEndOfRunEpisodes, 1);
assert.equal(openAtEnd.restorationRequiredEpisodes, 0);
assert.equal(openAtEnd.unrestoredEpisodes, 0);

// ---------------------------------------------------------------------------
// Demand activity and encroachment primitives
// ---------------------------------------------------------------------------

assert.equal(classDemandActivity(null).active, false);
assert.equal(classDemandActivity({ demandState: "idle" }).active, false);
assert.equal(classDemandActivity({ demandState: "demanding" }).active, true);
// `protected` is a class still holding its floor. Folding it into `idle` would
// let a demand episode re-baseline its grandfathered borrowers at every lull.
assert.equal(classDemandActivity({ demandState: "protected" }).active, true);
assert.equal(classDemandActivity({ recentRejections: 1 }).reason, "rejection");
assert.equal(classDemandActivity({ inFlight: 2 }).reason, "in-flight");
assert.equal(classDemandActivity({ restorationPending: true }).reason, "restoration-pending");
assert.equal(classDemandActivity({}).active, false);

// Encroachment is occupancy above a class's own NOMINAL floor. Batch running
// one request is inside its own floor no matter what its applied floor says.
assert.equal(
  classEncroachment(
    sampleAt(0, {
      classes: { batch: { limits: { ...nominal.batch, protectedConcurrent: 0 }, inFlight: 1 } },
    }),
    "batch",
  ),
  0,
);
assert.equal(
  classEncroachment(sampleAt(0, { classes: { batch: { inFlight: 4 } } }), "batch"),
  3,
);

// ---------------------------------------------------------------------------
// Demand-return timeline: the seven questions, answerable from the summary
// ---------------------------------------------------------------------------

const timelineSamples = [
  ...[50_000, 55_000, 59_750].map((offsetMs) =>
    sampleAt(offsetMs, {
      classes: {
        interactive: { limits: lentFloor, demandState: "idle", releasedConcurrent: 3 },
        batch: { inFlight: 4, borrowedConcurrent: 3, admitted: 41 },
      },
    }),
  ),
  sampleAt(60_750, {
    classes: {
      interactive: { demandState: "demanding", recentRejections: 1, restorationPending: true },
      batch: { inFlight: 4, borrowedConcurrent: 3, admitted: 41 },
    },
  }),
  sampleAt(70_000, {
    classes: {
      interactive: { demandState: "demanding", recentRejections: 1 },
      batch: { inFlight: 4, borrowedConcurrent: 3, admitted: 41 },
    },
  }),
  sampleAt(91_000, {
    classes: {
      interactive: { demandState: "idle" },
      batch: { inFlight: 1, borrowedConcurrent: 0, admitted: 41 },
    },
  }),
];
const timelineTrace = { entries: [{ class: "interactive", arrivalMs: 60_528.8 }] };
const timeline = summarizeDemandTransitions({
  samples: timelineSamples,
  trace: timelineTrace,
  loadgenSummary: {
    startedAtEpochMs: 1_000,
    config: { interactiveResumeStartMs: 60_000, interactiveResumeDurationMs: 25_000 },
    classes: {
      interactive: {
        localRejectSnapshots: [{ rejectedAtMs: 60_548.6 }],
        phaseSamples: [],
      },
    },
  },
  startedAtEpochMs: 1_000,
});
assert.equal(timeline.loadgenSkewMs, 0);
assert.equal(timeline.generatorResumedAtMs, 60_528.8, "Q1: the trace says when the workload asked");
assert.equal(timeline.tyrFirstDecisionAtMs, 60_548.6, "Q2: Tyr's first decision, refusal included");
assert.equal(timeline.tyrFirstDecisionWasRejection, true);
assert.equal(timeline.benchmarkMarkedActiveAtMs, 60_750, "Q3: the sampled grid");
assert.equal(timeline.benchmarkMarkedActiveEvidence, "rejection");
assert.equal(timeline.capacityLentAtMark, false, "Q4: the grant had already returned");
assert.equal(timeline.borrowerEncroachmentAtMark, 3, "Q5: batch still held three of its slots");
assert.equal(timeline.borrowerAdmissionsDuringResumeWindow, 0, "Q6: no new borrowing");
assert.equal(timeline.newBorrowingDuringResumeWindow, false);
assert.equal(
  timeline.restorationWasNeeded,
  true,
  "the grant was whole at the mark, but batch was still holding three of interactive's slots",
);
assert.equal(timeline.restorationStartedAtMs, 60_750, "Q7: when restoration began");

// A class whose floor is whole and unencroached at the mark never had to wait,
// and no restoration event may be manufactured for it.
const nothingToRestore = summarizeDemandTransitions({
  samples: [
    sampleAt(59_750, { classes: { interactive: { demandState: "idle" }, batch: { inFlight: 1 } } }),
    sampleAt(60_750, {
      classes: {
        interactive: { demandState: "demanding", inFlight: 1 },
        batch: { inFlight: 1 },
      },
    }),
  ],
  trace: timelineTrace,
});
assert.equal(nothingToRestore.benchmarkMarkedActiveAtMs, 60_750);
assert.equal(nothingToRestore.capacityLentAtMark, false);
assert.equal(nothingToRestore.borrowerEncroachmentAtMark, 0);
assert.equal(nothingToRestore.restorationWasNeeded, false);
assert.equal(
  nothingToRestore.restorationStartedAtMs,
  null,
  "a grant sitting at its nominal allocation is not a restoration event",
);
assert.equal(timeline.floorRestoredAtMs, 60_750);
assert.equal(timeline.occupancyRestoredAtMs, 91_000);
assert.equal(timeline.floorRestorationLatencyMs, 0);
assert.equal(timeline.occupancyRestorationLatencyMs, 30_250);
assert.deepEqual(timeline.resumeWindow, { admitted: 0, rejected: 0, maxInFlight: 0 });

// An unknown epoch must not be aligned by assumption.
assert.equal(
  summarizeDemandTransitions({ samples: timelineSamples, trace: timelineTrace }).loadgenSkewMs,
  null,
);
assert.equal(
  summarizeDemandTransitions({ samples: timelineSamples, trace: timelineTrace })
    .generatorResumedAtSamplerMs,
  null,
);

// The 50-70 s interval is retained as a deduplicated digest with both borders.
const digest = criticalWindowDigest(timelineSamples, { fromMs: 50_000, toMs: 70_000 });
assert.equal(digest.fromMs, 50_000);
assert.equal(digest.toMs, 70_000);
assert.equal(digest.samples, 4);
assert.ok(digest.retained >= 2 && digest.retained <= digest.samples);
assert.equal(digest.series[0].atMs, 50_000);
assert.equal(digest.series[digest.series.length - 1].atMs, 60_750);
assert.equal(digest.series[0].classes.interactive.demandActive, false);
assert.equal(digest.series[digest.series.length - 1].classes.interactive.demandActive, true);
assert.equal(digest.series[digest.series.length - 1].classes.batch.encroachment, 3);

// ---------------------------------------------------------------------------
// Handoff safety
// ---------------------------------------------------------------------------

const safeHandoff = summarizeClassHandoffSafety(
  [
    { type: "admission_class.handoff_prepared", entityId: "local-moflux", payload: { handoffId: "h1" } },
    { type: "admission_class.handoff_grant_applied", entityId: "g1", payload: { handoffId: "h1", pool: "local-moflux" } },
    { type: "admission_class.handoff_committed", entityId: "local-moflux", payload: { handoffId: "h1" } },
    { type: "pool.rebalanced", entityId: "local-moflux" },
  ],
  "local-moflux",
);
assert.equal(safeHandoff.unsafeHandoffs, 0);
assert.equal(safeHandoff.committed, 1);
assert.equal(safeHandoff.events, 3, "only handoff events belong in a handoff summary");

const unacknowledged = summarizeClassHandoffSafety(
  [{ type: "admission_class.handoff_committed", entityId: "local-moflux", payload: { handoffId: "h2" } }],
  "local-moflux",
);
assert.equal(unacknowledged.committedWithoutAck, 1);
assert.equal(unacknowledged.unsafeHandoffs, 1);
// An abort is the control plane declining a reallocation whose preconditions
// lapsed. It is the safe outcome, it is priced as slower restoration, and it
// must not fail a safety gate — a measured run against Latchflo 0.15.0 with a
// short lease produces them routinely.
const abortedOnly = summarizeClassHandoffSafety(
  [
    {
      type: "admission_class.handoff_aborted",
      entityId: "local-moflux",
      payload: { handoffId: "h3", reason: "source_lease_unavailable" },
    },
  ],
  "local-moflux",
);
assert.equal(abortedOnly.aborted, 1);
assert.equal(abortedOnly.unsafeHandoffs, 0);
assert.equal(abortedOnly.abortReasons.source_lease_unavailable, 1);
// One control plane serves both arms; the other arm's events are not this one's.
assert.equal(
  summarizeClassHandoffSafety(
    [{ type: "admission_class.handoff_aborted", entityId: "local-static", payload: { handoffId: "h4" } }],
    "local-moflux",
  ).events,
  0,
);

// An aborted handoff plus borrow growth at a suspect instant is the shape that
// 0.33.x reported as "unsafe capacity handoff". It is not one: the abort was
// the control plane declining a reallocation whose preconditions lapsed, and
// the borrow growth is a timing failure. 0.34.0 must name the second and clear
// the first.
const abortedWithBorrowGrowth = summarizeClassHandoffSafety(
  [
    { type: "admission_class.handoff_prepared", entityId: "local-moflux", payload: { handoffId: "h5" } },
    {
      type: "admission_class.handoff_aborted",
      entityId: "local-moflux",
      payload: { handoffId: "h5", reason: "source_lease_unavailable" },
    },
  ],
  "local-moflux",
);
assert.equal(abortedWithBorrowGrowth.aborted, 1);
assert.equal(
  abortedWithBorrowGrowth.unsafeHandoffs,
  0,
  "an aborted handoff is a safe refusal to reallocate and must never be called unsafe",
);

// ---------------------------------------------------------------------------
// Metric aggregation
// ---------------------------------------------------------------------------

assert.equal(percentile([], 0.5), null);
assert.equal(percentile([5, 1, 3], 0.5), 3);

// ---------------------------------------------------------------------------
// Zero-observation distributions are missing, not zero
//
// A window in which every request was rejected reported `ttftP95Ms: 0` before
// 0.34.0, which reads as the fastest window in the run. Counts and rates stay
// numeric — zero completions really is zero goodput — but the shape of a
// distribution nobody sampled is `null`.
// ---------------------------------------------------------------------------

const emptyWindows = summarizeArmClasses({
  workload: { durationMs: 90_000 },
  config: { durationMs: 90_000, interactiveResumeStartMs: 60_000, interactiveResumeDurationMs: 25_000 },
  classes: {
    interactive: {
      logical: 12,
      attempts: 30,
      success: 0,
      localReject: 30,
      phaseSamples: [],
      windows: {
        idle: { completed: 0, goodputRps: 0, p50Ms: 0, p95Ms: 0, ttftP50Ms: 0, ttftP95Ms: 0 },
        borrow: { completed: 0, goodputRps: 0, p50Ms: null, p95Ms: null, ttftP50Ms: null, ttftP95Ms: null },
        contention: { completed: 0, goodputRps: 0, p50Ms: 0, p95Ms: 0, ttftP50Ms: 0, ttftP95Ms: 0 },
        drainCompleted: 0,
      },
    },
    batch: {
      logical: 4,
      success: 2,
      phaseSamples: [{ arrivalMs: 30_000, completedAtMs: 36_000, latencyMs: 6_000, ttftMs: 800 }],
      windows: {
        idle: { completed: 0, goodputRps: 0, p50Ms: 0, p95Ms: 0, ttftP50Ms: 0, ttftP95Ms: 0 },
        borrow: { completed: 2, goodputRps: 0.06, p50Ms: 6_000, p95Ms: 7_000, ttftP50Ms: 700, ttftP95Ms: 900 },
        contention: { completed: 0, goodputRps: 0, p50Ms: 0, p95Ms: 0, ttftP50Ms: 0, ttftP95Ms: 0 },
        drainCompleted: 0,
      },
    },
  },
});
for (const window of ["idle", "borrow", "contention"]) {
  const observedWindow = emptyWindows.interactive.windows[window];
  assert.equal(observedWindow.completed, 0);
  assert.equal(observedWindow.goodputRps, 0, "zero completions is zero goodput, a real measurement");
  for (const field of ["latencyP50Ms", "latencyP95Ms", "ttftP50Ms", "ttftP95Ms"]) {
    assert.equal(
      observedWindow[field],
      null,
      `${window}.${field} must be null with no observations, not 0`,
    );
  }
}
// A zero supplied by an older load generator is corrected rather than trusted:
// `completed: 0` settles it whatever the upstream summary said.
assert.equal(emptyWindows.batch.windows.contention.ttftP95Ms, null);
assert.equal(emptyWindows.batch.windows.borrow.ttftP95Ms, 900, "a sampled window keeps its tail");
// Whole-run distributions follow the same rule.
assert.equal(emptyWindows.interactive.ttftMs.p95, null);
assert.equal(emptyWindows.interactive.latencyMs.p50, null);
// SLO goodput stays a number: no useful completions really is 0 useful rps.
assert.equal(emptyWindows.interactive.windows.contention.sloGoodputRps, 0);

// Ratios derived from a missing distribution are null, never zero: an
// undefined comparison must not be readable as "no difference".
const emptyArm = { trace: { hash: "h" }, classes: emptyWindows };
const emptyComparison = compareLocalContention({
  direct: emptyArm,
  static: emptyArm,
  moflux: emptyArm,
});
assert.equal(
  emptyComparison.interactiveTtftP95RatioVsDirect,
  null,
  "a ratio of two absent tails is undefined, not 1 and not 0",
);
assert.equal(emptyComparison.interactiveGoodputRatioVsDirect, null);
// The SLO-goodput delta is a difference of two real rates and stays numeric.
assert.equal(emptyComparison.interactiveSloGoodputDeltaRpsVsDirect, 0);
// An aggregate whose every contributing value is missing reports null with n=0.
const emptyAggregate = aggregateArmClass([emptyWindows.interactive, emptyWindows.interactive]);
assert.equal(emptyAggregate.ttftP95Ms.median, null);
assert.equal(emptyAggregate.ttftP95Ms.n, 0);
assert.equal(emptyAggregate.contentionWindowTtftP95Ms.median, null);
assert.equal(
  emptyAggregate.contentionWindowGoodputRps.median,
  0,
  "a rate aggregate over real zeroes is zero, not missing",
);

function loadgenFixture({ ttftContention, goodputContention, borrowCompleted, batchSuccess = 6 }) {
  const phaseSamples = [
    { offsetMs: 1_500, arrivalMs: 1_000, completedAtMs: 1_500, latencyMs: 900, ttftMs: 100 },
    { offsetMs: 70_000, arrivalMs: 65_000, completedAtMs: 70_000, latencyMs: 1_200, ttftMs: ttftContention },
  ];
  return {
    workload: { durationMs: 90_000 },
    config: {
      durationMs: 90_000,
      interactiveResumeStartMs: 60_000,
      interactiveResumeDurationMs: 25_000,
    },
    classes: {
      interactive: {
        logical: 20,
        attempts: 22,
        success: 18,
        outputTokens: 576,
        inputTokens: 1_940,
        localReject: 2,
        localRejectReasons: { concurrency_limit: 2 },
        localRejectConstraints: { admission_class_protection: 2 },
        borrowedDeadlineAbandoned: 0,
        transportError: 0,
        serverError: 0,
        upstreamReject: 0,
        exhausted: 0,
        admissionClassResponses: { interactive: 22 },
        phaseSamples,
        windows: {
          idle: { completed: 6, goodputRps: 0.24, p50Ms: 900, p95Ms: 1_000, ttftP50Ms: 90, ttftP95Ms: 120 },
          borrow: { completed: 0, goodputRps: 0, p50Ms: 0, p95Ms: 0, ttftP50Ms: 0, ttftP95Ms: 0 },
          contention: {
            completed: 9,
            goodputRps: goodputContention,
            p50Ms: 1_100,
            p95Ms: 2_000,
            ttftP50Ms: 400,
            ttftP95Ms: ttftContention,
          },
          drainCompleted: 3,
        },
      },
      batch: {
        logical: 12,
        attempts: 15,
        success: batchSuccess,
        outputTokens: 384,
        inputTokens: 5_400,
        localReject: 5,
        localRejectReasons: { concurrency_limit: 5 },
        localRejectConstraints: { admission_class_protection: 5 },
        borrowedDeadlineAbandoned: 0,
        transportError: 0,
        serverError: 0,
        upstreamReject: 0,
        exhausted: 0,
        admissionClassResponses: { batch: 15 },
        phaseSamples: [{ offsetMs: 36_000, arrivalMs: 30_000, completedAtMs: 36_000, latencyMs: 6_000, ttftMs: 800 }],
        windows: {
          idle: { completed: 0, goodputRps: 0, p50Ms: 0, p95Ms: 0, ttftP50Ms: 0, ttftP95Ms: 0 },
          borrow: { completed: borrowCompleted, goodputRps: 0.2, p50Ms: 6_000, p95Ms: 7_000, ttftP50Ms: 700, ttftP95Ms: 900 },
          contention: { completed: 2, goodputRps: 0.07, p50Ms: 8_000, p95Ms: 9_000, ttftP50Ms: 1_200, ttftP95Ms: 1_500 },
          drainCompleted: 1,
        },
      },
    },
  };
}

const summarized = summarizeArmClasses(
  loadgenFixture({ ttftContention: 400, goodputContention: 0.3, borrowCompleted: 5 }),
);
assert.equal(summarized.interactive.logical, 20);
assert.equal(summarized.interactive.success, 18);
assert.equal(summarized.interactive.successRate, 0.9);
assert.equal(summarized.interactive.goodputRps, 0.2);
assert.equal(summarized.interactive.rejectedAdmissions, 2);
assert.equal(summarized.interactive.completionTokens, 576);
assert.equal(summarized.interactive.promptTokens, 1_940);
assert.equal(summarized.interactive.totalTokens, 2_516);
assert.equal(summarized.interactive.deadlineAbandonments, 0);
assert.equal(summarized.batch.windows.borrow.completed, 5);
assert.equal(summarized.batch.windows.contention.completed, 2);

const aggregated = aggregateArmClass([summarized.interactive, summarized.interactive]);
assert.equal(aggregated.logicalTotal, 40);
assert.equal(aggregated.successTotal, 36);
assert.equal(aggregated.successRate.n, 2);
assert.equal(aggregated.successRate.median, 0.9);
assert.equal(aggregated.completionTokensTotal, 1_152);
assert.equal(aggregateArmClass([]).successRate.n, 0, "an empty aggregate must report n=0");

// ---------------------------------------------------------------------------
// Proof behaviour, in both directions
// ---------------------------------------------------------------------------

function armSet({ mofluxTtft = 300, directTtft = 6_000, mofluxBorrow = 6, staticBorrow = 2 } = {}) {
  const build = (fixture, overrides = {}) => ({
    trace: { hash: "trace-hash" },
    classes: summarizeArmClasses(fixture),
    ...overrides,
  });
  return {
    direct: build(
      loadgenFixture({ ttftContention: directTtft, goodputContention: 0.1, borrowCompleted: 4 }),
    ),
    static: build(
      loadgenFixture({ ttftContention: 500, goodputContention: 0.25, borrowCompleted: staticBorrow }),
    ),
    moflux: build(
      loadgenFixture({ ttftContention: mofluxTtft, goodputContention: 0.3, borrowCompleted: mofluxBorrow }),
    ),
  };
}

const passingArms = armSet();
const passingComparison = compareLocalContention(passingArms);
assert.equal(passingComparison.traceHashMatches, true);
assert.equal(passingComparison.interactiveTtftP95RatioVsDirect, 0.05);
assert.equal(passingComparison.interactiveSloGoodputDeltaRpsVsDirect, 0.04);
assert.equal(passingComparison.batchBorrowWindowRatioVsStatic, 3);

// A mismatched trace hash must be caught: two arms that replayed different
// workloads are not a comparison.
const mixedArms = { ...passingArms, moflux: { ...passingArms.moflux, trace: { hash: "other" } } };
assert.equal(compareLocalContention(mixedArms).traceHashMatches, false);

const cleanEvidence = {
  lending: summarizeLendingEpisodes(episodeSeries),
  invariants: capacityInvariantViolations(episodeSeries),
  handoff: safeHandoff,
};
const seedProof = localContentionSeedProof({
  comparison: passingComparison,
  arms: passingArms,
  ...cleanEvidence,
  warmupRequestsPerClass: 5,
});
assert.equal(seedProof.passed, true, JSON.stringify(seedProof.failed));
assert.equal(seedProof.failed.length, 0);
assert.equal(seedProof.validity.sameTrace.passed, true);
assert.equal(seedProof.validity.leaseGapWithinBudget.passed, true);
assert.equal(seedProof.safety.noUnlentFloorViolations.passed, true);

// A control plane spending most of the run ungranted is measuring its own
// reconcile loop, and the run must fail rather than publish that.
const gapHeavy = capacityInvariantViolations([
  ...Array.from({ length: 8 }, (_, index) => ({
    offsetMs: index * 250,
    pool: { maxConcurrent: 0, tokenBudget: 0 },
    classes: {},
  })),
  sampleAt(2_000),
]);
const gapProof = localContentionSeedProof({
  comparison: passingComparison,
  arms: passingArms,
  lending: cleanEvidence.lending,
  invariants: gapHeavy,
  handoff: safeHandoff,
  warmupRequestsPerClass: 5,
});
assert.equal(gapProof.passed, false);
assert.ok(gapProof.failed.some((entry) => entry.gate === "leaseGapWithinBudget"));

// Safety is absolute: one unsafe sample fails the seed and names the gate.
const unsafeSeed = localContentionSeedProof({
  comparison: passingComparison,
  arms: passingArms,
  lending: cleanEvidence.lending,
  invariants: belowUnlent,
  handoff: unacknowledged,
  warmupRequestsPerClass: 5,
});
assert.equal(unsafeSeed.passed, false);
const failedGates = unsafeSeed.failed.map((entry) => entry.gate);
assert.ok(failedGates.includes("noUnlentFloorViolations"));
assert.ok(failedGates.includes("noUnsafeHandoff"));
for (const failure of unsafeSeed.failed) {
  assert.ok(failure.observed !== undefined, "a failed gate must carry its observed value");
  assert.ok(failure.threshold !== undefined, "a failed gate must carry its threshold");
  assert.ok(typeof failure.reason === "string" && failure.reason.length > 0);
}

// A run where the control arm never queued measured no contention at all.
const noContention = localContentionSeedProof({
  comparison: passingComparison,
  arms: {
    ...passingArms,
    direct: {
      ...passingArms.direct,
      classes: summarizeArmClasses(
        loadgenFixture({ ttftContention: 90, goodputContention: 0.3, borrowCompleted: 4 }),
      ),
    },
  },
  ...cleanEvidence,
  warmupRequestsPerClass: 5,
});
assert.equal(noContention.passed, false);
assert.ok(
  noContention.failed.some((entry) => entry.gate === "interactiveConstrainedUnderContention"),
);

const seeds = [1, 2, 3, 4, 5];
const passingProof = localContentionProof({
  seeds,
  seedProofs: seeds.map(() => seedProof),
  comparisons: seeds.map(() => passingComparison),
  requiredSeeds: PUBLICATION_SEED_COUNT,
});
assert.equal(passingProof.passed, true, JSON.stringify(passingProof.failed));
// H4 is split in 0.34.0. `h4` remains as the conjunction so a 0.33.x reader is
// not silently handed `undefined`, but a failure now names which half failed.
assert.deepEqual(passingProof.hypotheses, {
  h1: true,
  h2: true,
  h3: true,
  h4a: true,
  h4b: true,
  h4: true,
});
assert.ok(passingProof.checks.h4aNoUnsafeCapacityTransfer.passed);
assert.ok(passingProof.checks.h4bNoBorrowingAfterProtectedDemandReturn.passed);
assert.equal(passingProof.sampleCounts.seeds, 5);
assert.equal(passingProof.thresholds, HYPOTHESIS_THRESHOLDS);

// H1 must be able to fail. An arm that does not beat unmanaged Ollama on either
// route is a negative result, and the benchmark has to report it as one.
const flatArms = armSet({ mofluxTtft: 3_000, directTtft: 3_000 });
const flatComparison = compareLocalContention({
  ...flatArms,
  moflux: {
    ...flatArms.moflux,
    classes: summarizeArmClasses(
      loadgenFixture({ ttftContention: 3_000, goodputContention: 0.1, borrowCompleted: 6 }),
    ),
  },
});
const h1Failed = localContentionProof({
  seeds,
  seedProofs: seeds.map(() => seedProof),
  comparisons: seeds.map(() => flatComparison),
  requiredSeeds: PUBLICATION_SEED_COUNT,
});
assert.equal(h1Failed.passed, false, "a MoFlux arm that did not help must fail H1");
assert.equal(h1Failed.hypotheses.h1, false);
assert.equal(h1Failed.hypotheses.h2, true);
assert.ok(h1Failed.failed.some((entry) => entry.gate === "h1InteractivePreserved"));

// H2 must be able to fail too: lending that does not beat a rigid partition has
// bought nothing.
const noBorrowGain = compareLocalContention(armSet({ mofluxBorrow: 2, staticBorrow: 2 }));
const h2Failed = localContentionProof({
  seeds,
  seedProofs: seeds.map(() => seedProof),
  comparisons: seeds.map(() => noBorrowGain),
  requiredSeeds: PUBLICATION_SEED_COUNT,
});
assert.equal(h2Failed.hypotheses.h2, false);
assert.equal(h2Failed.passed, false);

// ---------------------------------------------------------------------------
// H4a versus H4b: an unsafe transfer and a mistimed loan are different failures
// ---------------------------------------------------------------------------

// Borrow growth after demand return fails H4b and leaves H4a intact. Before
// 0.34.0 this run said "H4: no unsafe capacity handoff" had failed, which named
// the wrong mechanism and pointed a reader at the handoff log.
const borrowGrowthSeed = localContentionSeedProof({
  comparison: passingComparison,
  arms: passingArms,
  lending: cleanEvidence.lending,
  invariants: newBorrowAfterDemandReturn,
  handoff: safeHandoff,
  warmupRequestsPerClass: 5,
});
assert.equal(borrowGrowthSeed.passed, false);
assert.equal(borrowGrowthSeed.safety.noBorrowGrowthAfterDemandReturn.passed, false);
assert.equal(borrowGrowthSeed.safety.noUnsafeHandoff.passed, true);
// The deprecated alias must report the same verdict for one release.
assert.equal(borrowGrowthSeed.safety.noBorrowGrowthAfterRestoration.passed, false);
const borrowGrowthProof = localContentionProof({
  seeds,
  seedProofs: seeds.map(() => borrowGrowthSeed),
  comparisons: seeds.map(() => passingComparison),
  requiredSeeds: PUBLICATION_SEED_COUNT,
});
assert.equal(
  borrowGrowthProof.hypotheses.h4a,
  true,
  "borrowing at the wrong time is not an unsafe capacity transfer",
);
assert.equal(borrowGrowthProof.hypotheses.h4b, false);
assert.equal(borrowGrowthProof.hypotheses.h4, false, "the combined alias still fails");
assert.ok(
  borrowGrowthProof.failed.some(
    (entry) => entry.gate === "h4bNoBorrowingAfterProtectedDemandReturn",
  ),
);
assert.ok(
  !borrowGrowthProof.failed.some((entry) => entry.gate === "h4aNoUnsafeCapacityTransfer"),
  "a failed run must name precisely what failed",
);

// A commit whose drain grants were never acknowledged is an absolute safety
// failure and stays one: it fails H4a, and no amount of correct timing rescues
// it. This is the invariant every other change in this release must preserve.
const unackedSeed = localContentionSeedProof({
  comparison: passingComparison,
  arms: passingArms,
  ...cleanEvidence,
  handoff: unacknowledged,
  warmupRequestsPerClass: 5,
});
assert.equal(unackedSeed.safety.noUnsafeHandoff.passed, false);
assert.equal(unackedSeed.safety.noBorrowGrowthAfterDemandReturn.passed, true);
const unackedProof = localContentionProof({
  seeds,
  seedProofs: seeds.map(() => unackedSeed),
  comparisons: seeds.map(() => passingComparison),
  requiredSeeds: PUBLICATION_SEED_COUNT,
});
assert.equal(unackedProof.hypotheses.h4a, false);
assert.equal(unackedProof.hypotheses.h4b, true);
assert.equal(unackedProof.passed, false);

// An aborted-only handoff run passes both halves of H4. Latchflo 0.15.0 with a
// fifteen-second lease produces aborts routinely and the benchmark measured
// three of them across four seeds; a benchmark that failed on those would be
// unusable.
const abortedSeed = localContentionSeedProof({
  comparison: passingComparison,
  arms: passingArms,
  ...cleanEvidence,
  handoff: abortedOnly,
  warmupRequestsPerClass: 5,
});
assert.equal(abortedSeed.passed, true, JSON.stringify(abortedSeed.failed));
const abortedProof = localContentionProof({
  seeds,
  seedProofs: seeds.map(() => abortedSeed),
  comparisons: seeds.map(() => passingComparison),
  requiredSeeds: PUBLICATION_SEED_COUNT,
});
assert.equal(abortedProof.hypotheses.h4a, true);
assert.equal(abortedProof.hypotheses.h4b, true);

// A lend whose owner never returned must not fail the restoration gate, and a
// demand return that never converged must.
const passiveSeed = localContentionSeedProof({
  comparison: passingComparison,
  arms: passingArms,
  lending: passiveReturn,
  invariants: cleanEvidence.invariants,
  handoff: safeHandoff,
  warmupRequestsPerClass: 5,
});
assert.equal(passiveSeed.safety.everyLentFloorRestored.passed, true);
const unconvergedSeed = localContentionSeedProof({
  comparison: passingComparison,
  arms: passingArms,
  lending: neverRestored,
  invariants: cleanEvidence.invariants,
  handoff: safeHandoff,
  warmupRequestsPerClass: 5,
});
assert.equal(unconvergedSeed.safety.everyLentFloorRestored.passed, false);
assert.equal(
  localContentionProof({
    seeds,
    seedProofs: seeds.map(() => unconvergedSeed),
    comparisons: seeds.map(() => passingComparison),
    requiredSeeds: PUBLICATION_SEED_COUNT,
  }).hypotheses.h4b,
  false,
  "restoration convergence belongs to H4b",
);

// Seed count is a gate, not a label.
assert.equal(
  localContentionProof({
    seeds: [1],
    seedProofs: [seedProof],
    comparisons: [passingComparison],
    requiredSeeds: PUBLICATION_SEED_COUNT,
  }).checks.enoughSeeds.passed,
  false,
);
// One unsafe seed fails the sweep even when four were clean.
assert.equal(
  localContentionProof({
    seeds,
    seedProofs: [seedProof, seedProof, seedProof, seedProof, unsafeSeed],
    comparisons: seeds.map(() => passingComparison),
    requiredSeeds: PUBLICATION_SEED_COUNT,
  }).passed,
  false,
);

assert.equal(
  scenarioId({ workload: CONTENTION_WORKLOAD, policy: CONTENTION_POLICY, seeds, arms: CONTENTION_ARM_IDS, model: "qwen3:0.6b" }),
  scenarioId({ workload: CONTENTION_WORKLOAD, policy: CONTENTION_POLICY, seeds, arms: CONTENTION_ARM_IDS, model: "qwen3:0.6b" }),
);
assert.notEqual(
  scenarioId({ workload: CONTENTION_WORKLOAD, policy: CONTENTION_POLICY, seeds, arms: CONTENTION_ARM_IDS, model: "qwen3:0.6b" }),
  scenarioId({ workload: CONTENTION_WORKLOAD, policy: CONTENTION_POLICY, seeds, arms: CONTENTION_ARM_IDS, model: "llama3:8b" }),
);

// ---------------------------------------------------------------------------
// Credentials survive a sweep longer than one token lifetime
//
// 0.33.2's five-seed run died in seed 5's MoFlux warm-up on HTTP 401. The
// fixture minted once at t=0 with a one-hour expiry and the sweep reached seed
// 5 at 64 minutes. The fix is re-minting on access, not a longer guess: a fixed
// lifetime only moves the cliff to whichever sweep outgrows it next.
// ---------------------------------------------------------------------------

const identityTemp = mkdtempSync(path.join(os.tmpdir(), "moflux-contention-identity-"));
try {
  const decodeClaims = (token) =>
    JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));

  // A short-lived fixture stands in for a long sweep: the same crossing, in
  // seconds rather than in an hour of wall clock.
  const shortLived = await startIdentityFixture(identityTemp, {
    port: 0,
    tokenTtlSeconds: 4,
    refreshSkewSeconds: 2,
  });
  try {
    const first = shortLived.tokens.premium;
    const firstState = shortLived.credentialState("premium");
    assert.equal(firstState.mintCount, 1);
    assert.equal(firstState.expired, false);
    assert.equal(firstState.fingerprint, tokenFingerprint(first));
    assert.ok(firstState.expiresInMs > 0);
    // The diagnostic is publishable: it identifies the credential and never
    // carries it.
    assert.equal(Object.values(firstState).includes(first), false);
    assert.ok(!JSON.stringify(firstState).includes(first));

    // Reading again well inside the lifetime must not churn the credential.
    assert.equal(shortLived.tokens.premium, first, "a valid token is reused, not re-minted");
    assert.equal(shortLived.credentialState("premium").mintCount, 1);

    await new Promise((resolve) => setTimeout(resolve, 2_600));
    const second = shortLived.tokens.premium;
    assert.notEqual(second, first, "a token approaching expiry must be replaced before it is used");
    assert.equal(shortLived.credentialState("premium").mintCount, 2);
    assert.equal(shortLived.credentialState("premium").lastMintReason, "expiry-approaching");
    assert.ok(
      decodeClaims(second).exp > decodeClaims(first).exp,
      "the replacement must outlive the token it replaced",
    );
    // Claims are stable across a re-mint: the same identity, not a new one.
    assert.equal(decodeClaims(second).tenant_id, decodeClaims(first).tenant_id);
    assert.equal(decodeClaims(second).sub, decodeClaims(first).sub);
    assert.deepEqual(decodeClaims(second).roles, decodeClaims(first).roles);

    // Every identity the contention benchmark uses is covered, including the
    // operator credential the /stats sampler carries for the whole sweep.
    for (const name of ["premium", "noisy", "operator"]) {
      assert.equal(typeof shortLived.tokens[name], "string");
      assert.equal(shortLived.credentialState(name).expired, false);
    }

    // An explicit refresh is available for a caller that has just been told its
    // token was refused, and it records why.
    const beforeForce = shortLived.credentialState("noisy");
    const forced = shortLived.refresh("noisy", "http-401-during-warmup");
    assert.equal(forced.lastMintReason, "http-401-during-warmup");
    assert.equal(forced.mintCount, beforeForce.mintCount + 1);
    assert.notEqual(forced.fingerprint, beforeForce.fingerprint);
  } finally {
    await shortLived.close();
  }

  // The shipped defaults must exceed the longest single measured run by a wide
  // margin, so a token handed to a load-generator child is never near expiry
  // when that child makes its last request.
  assert.ok(IDENTITY_TOKEN_TTL_SECONDS >= 3_600);
  assert.ok(
    IDENTITY_REFRESH_SKEW_SECONDS * 1_000 > CONTENTION_WORKLOAD.durationMs * 2,
    "the refresh margin must comfortably cover one measured run plus its drain",
  );
  assert.ok(IDENTITY_REFRESH_SKEW_SECONDS < IDENTITY_TOKEN_TTL_SECONDS);
  assert.equal(tokenFingerprint(""), null);
  assert.equal(tokenFingerprint(null), null);
} finally {
  rmSync(identityTemp, { recursive: true, force: true });
}

// The runner must read credentials through the accessor rather than caching a
// string, or the fixture's re-minting is defeated at the call site.
for (const required of [
  "identity.tokens[identityName]",
  "identity.credentialState(",
  "identity.refresh(",
  "warmupDiagnostic(",
]) {
  assert.ok(
    runnerSource.includes(required),
    `demo/local-contention.mjs must use ${required} so a long sweep cannot outlive its credential`,
  );
}
// A diagnostic may name a credential; it may never carry one.
for (const forbidden of ["Bearer ${bearer}`,\n      token", "token: bearer", "bearerToken:"]) {
  assert.equal(
    runnerSource.includes(forbidden),
    false,
    "warm-up diagnostics must never serialize a bearer token",
  );
}

// ---------------------------------------------------------------------------
// Publication registration and evidence serialization
// ---------------------------------------------------------------------------

assert.ok(
  isReviewedEvidence(`results/${LOCAL_CONTENTION_SWEEP_NAME}.json`),
  "the published summary path must be registered as reviewed evidence",
);
assert.ok(
  isReviewedEvidence(`results/${LOCAL_CONTENTION_SWEEP_NAME}/seed-1.json`),
  "the published per-seed directory must be registered as reviewed evidence",
);
assert.ok(REVIEWED_EVIDENCE.includes(`results/${LOCAL_CONTENTION_SWEEP_NAME}.json`));
// The compatibility corpus must stay a separate, differently named artifact:
// this release adds evidence, it does not restate the old result.
assert.ok(REVIEWED_EVIDENCE.includes("results/local-inference-compatibility.json"));
assert.notEqual(LOCAL_CONTENTION_SWEEP_NAME, "local-inference-compatibility");

const temp = mkdtempSync(path.join(os.tmpdir(), "moflux-local-contention-verify-"));
try {
  const runDir = path.join(temp, "runs", LOCAL_CONTENTION_SWEEP_NAME, "20260904T000000Z");
  mkdirSync(runDir, { recursive: true });
  const summary = {
    schemaVersion: 1,
    benchmark: LOCAL_CONTENTION_SWEEP_NAME,
    localContentionProof: passingProof,
    passed: passingProof.passed,
    evidenceLimits: EVIDENCE_LIMITS,
    runs: [],
  };
  writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(path.join(runDir, "trace-seed-1.json"), JSON.stringify(traceA, null, 2));
  writeFileSync(path.join(runDir, "comparison-seed-1.json"), JSON.stringify({ seed: 1 }, null, 2));

  const report = publishRun({
    root: temp,
    resultsRoot: temp,
    runDir,
    name: LOCAL_CONTENTION_SWEEP_NAME,
  });
  assert.equal(report.files, 2, "per-seed evidence must be promoted alongside the summary");
  const published = JSON.parse(
    readFileSync(path.join(temp, `${LOCAL_CONTENTION_SWEEP_NAME}.json`), "utf8"),
  );
  assert.equal(published.passed, true);
  assert.equal(published.localContentionProof.passed, true);
  assert.ok(published.publishedFrom.includes(LOCAL_CONTENTION_SWEEP_NAME));
  assert.ok(published.evidenceLimits.gpuPreemption.startsWith("not-claimed"));
  // Reviewed evidence is never replaced by accident.
  assert.throws(
    () => publishRun({ root: temp, resultsRoot: temp, runDir, name: LOCAL_CONTENTION_SWEEP_NAME }),
    /already exists/,
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// CLI argument validation
// ---------------------------------------------------------------------------

async function runCli(argv) {
  const child = spawn(process.execPath, [path.join(ROOT, "demo", "local-contention.mjs"), ...argv], {
    cwd: ROOT,
    env: { ...process.env, MOFLUX_BENCH_RESULTS_DIR: path.join(os.tmpdir(), "moflux-contention-cli") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, stdout, stderr };
}

const dry = await runCli(["--dry-run", "--seeds=1-5"]);
assert.equal(dry.code, 0, `${dry.stdout}\n${dry.stderr}`);
assert.match(dry.stdout, /no inference request was sent/);
assert.match(dry.stdout, /direct -> static -> moflux/);

for (const [argv, pattern] of [
  [["--dry-run", "--seeds="], /--seeds must contain/],
  [["--dry-run", "--seeds=5-1"], /invalid seed range/],
  [["--dry-run", "--seeds=-3"], /--seeds must contain/],
  [["--dry-run", "--arms=direct"], /at least two arms/],
  [["--dry-run", "--arms=direct,gpu"], /unknown local-contention arm/],
  [["--dry-run", "--duration-ms=1000"], /--duration-ms must be an integer of at least 30000/],
  [["--dry-run", "--warmup-requests-per-class=0"], /--warmup-requests-per-class/],
]) {
  const result = await runCli(argv);
  assert.notEqual(result.code, 0, `${argv.join(" ")} must be rejected`);
  assert.match(result.stderr + result.stdout, pattern, `${argv.join(" ")} must explain why`);
}

rmSync(path.join(os.tmpdir(), "moflux-contention-cli"), { recursive: true, force: true });

console.log(
  "PASS local contention harness: locality guard with no endpoint flag, single-variable arm " +
    "configuration, phased deterministic trace with historical hashes preserved, capacity " +
    "invariants, demand-state transitions, encroachment-based post-demand borrowing checks " +
    "including the 29.896s seed-4 boundary, restoration-required episode semantics with " +
    "grant-side and occupancy-side latency, null-not-zero empty distributions, H4a/H4b " +
    "separation, credential lifetime across a sweep, handoff safety, metric aggregation, " +
    "honest proof failure, publication registration, and CLI validation",
);
