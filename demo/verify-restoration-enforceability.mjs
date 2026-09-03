#!/usr/bin/env node
/**
 * verify-restoration-enforceability.mjs — executable coverage for the
 * Tyr 0.30.0 / Latchflo 0.15.0 restoration model.
 *
 * The Tyr fixtures in this file are not invented. They are the verbatim
 * `/stats` block, response headers, and 504 body produced by
 * `tyr-admission-controller:0.30.0` driven against a stalling upstream with
 * `borrowedAdmissionSlot.deadlineMs: 1200`, and the Latchflo shapes match what
 * `latchflo-control-plane:0.15.0` accepted and exposed. Keeping the real wire
 * shapes here is the point: a parser tested only against its author's guess
 * about a payload proves nothing about the payload.
 */

import assert from "node:assert/strict";
import {
  ADMISSION_SLOT_RELEASE_MECHANISM,
  BORROWED_ADMISSION_SLOT_RELEASE_MECHANISM,
  buildBorrowedAdmissionSlotPolicy,
  buildRestorationContract,
  latchfloUnlentFloorExpected,
  restorationEnforceability,
  tyrBorrowedSlotDeadlinesExpected,
  usesUnlentFloor,
  validateUnlentSlice,
} from "./restoration-contract-lib.mjs";
import {
  aggregateRestorationLadder,
  restorationEnforceabilityVerdict,
  summarizeBorrowedDeadlineCost,
  summarizeLatchfloRestorationEpisodes,
  summarizeTyrRestoration,
  summarizeUnlentFloorGauges,
} from "./restoration-enforceability-lib.mjs";
import {
  BORROWED_ADMISSION_SLOT_DEADLINE_MS,
  TENANT_FAIRNESS_POLICY,
  tenantClassRestorationClaim,
  tenantPoolDefinition,
} from "./tenant-fairness-lib.mjs";
import {
  buildDemandAwareCapacityGroup,
  capacityGroupRestorationClaim,
} from "./lending-evidence-lib.mjs";

// ── version gating ───────────────────────────────────────────────────

assert.equal(tyrBorrowedSlotDeadlinesExpected("0.30.0"), true);
assert.equal(tyrBorrowedSlotDeadlinesExpected("0.29.0"), false);
assert.equal(tyrBorrowedSlotDeadlinesExpected("0.31.2"), true);
assert.equal(tyrBorrowedSlotDeadlinesExpected("1.0.0"), true);
assert.equal(latchfloUnlentFloorExpected("0.15.0"), true);
assert.equal(latchfloUnlentFloorExpected("0.14.0"), false);
assert.equal(latchfloUnlentFloorExpected("0.13.1"), false);
// An unknown runtime is never credited with a capability.
assert.equal(tyrBorrowedSlotDeadlinesExpected(undefined), false);
assert.equal(latchfloUnlentFloorExpected("not-a-version"), false);
console.log("  ok  capability gates track the 0.30.0 / 0.15.0 boundaries");

// ── restoration contracts ────────────────────────────────────────────

const objectiveContract = buildRestorationContract({ tokenAware: true });
assert.equal(objectiveContract.admissionSlots.releaseMechanism, ADMISSION_SLOT_RELEASE_MECHANISM);
assert.equal(objectiveContract.upstreamCapacity.releaseMechanism, "non_preemptive");
assert.deepEqual(restorationEnforceability(objectiveContract), {
  admissionSlots: "objective",
  upstreamCapacity: "objective",
});
assert.equal(usesUnlentFloor(objectiveContract), false);

const unlentContract = buildRestorationContract({
  tokenAware: true,
  upstreamMechanism: "unlent_floor",
  admissionSlotSloMs: 15_000,
  upstreamTokenSloMs: 15_000,
});
assert.deepEqual(restorationEnforceability(unlentContract), {
  admissionSlots: "objective",
  upstreamCapacity: "unlent_floor",
});
assert.equal(usesUnlentFloor(unlentContract), true);

// Latchflo omits the upstream contract entirely when no token resource exists,
// and rejects one that is supplied anyway.
const concurrencyOnly = buildRestorationContract({ tokenAware: false });
assert.equal(concurrencyOnly.upstreamCapacity, undefined);
assert.deepEqual(restorationEnforceability(concurrencyOnly), { admissionSlots: "objective" });
assert.throws(
  () => buildRestorationContract({ tokenAware: false, upstreamMechanism: "unlent_floor" }),
  /requires a protected token resource/,
);
assert.throws(
  () => buildRestorationContract({ tokenAware: true, upstreamMechanism: "preemptive" }),
  /releaseMechanism must be one of/,
);
assert.throws(
  () => buildRestorationContract({ tokenAware: true, admissionSlotSloMs: 0 }),
  /sloMs must be a positive integer/,
);
assert.throws(() => buildRestorationContract({}), /explicit tokenAware/);
console.log("  ok  restoration contracts mirror Latchflo 0.15.0 shape rules");

// ── unlent slice validation ──────────────────────────────────────────

assert.equal(
  validateUnlentSlice({
    label: "premium",
    unlentTokens: 4_000,
    protectedTokens: 8_000,
    contract: unlentContract,
    lendingEnabled: true,
  }),
  4_000,
);
assert.throws(
  () => validateUnlentSlice({
    label: "premium",
    unlentTokens: 9_000,
    protectedTokens: 8_000,
    contract: unlentContract,
    lendingEnabled: true,
  }),
  /cannot exceed the protected token floor/,
);
assert.throws(
  () => validateUnlentSlice({
    label: "premium",
    unlentTokens: 0,
    protectedTokens: 8_000,
    contract: unlentContract,
    lendingEnabled: true,
  }),
  /must be positive when restoration\.upstreamCapacity uses unlent_floor/,
);
// A slice on a non_preemptive contract is a configuration error, not a no-op:
// Latchflo would reject it, so it must not reach the wire.
assert.throws(
  () => validateUnlentSlice({
    label: "premium",
    unlentTokens: 4_000,
    protectedTokens: 8_000,
    contract: objectiveContract,
    lendingEnabled: true,
  }),
  /requires restoration\.upstreamCapacity\.releaseMechanism="unlent_floor"/,
);
console.log("  ok  unlent slices are rejected unless the mechanism supports them");

// ── capacity group wiring ────────────────────────────────────────────

const groupArgs = {
  envelope: 32,
  tokenBudget: 40_000,
  reportStaleAfterMs: 6_000,
  idleAfterMs: 3_000,
  maxStarvationMs: 5_000,
};
const objectiveGroup = buildDemandAwareCapacityGroup({
  ...groupArgs,
  interactive: { pool: "sim-interactive", priority: 100, guaranteedMaxConcurrent: 28, guaranteedTokenBudget: 24_000 },
  batch: { pool: "sim-batch", priority: 10, guaranteedMaxConcurrent: 4, guaranteedTokenBudget: 16_000 },
});
// Latchflo 0.15.0 refuses an enabled lending policy with no restoration
// contract, so the default must supply one rather than omitting the field.
assert.deepEqual(objectiveGroup.demandPolicy.restoration, {
  admissionSlots: { releaseMechanism: "lease_safe_handoff", sloMs: 30_000 },
  upstreamCapacity: { releaseMechanism: "non_preemptive", sloMs: 30_000 },
});
assert.equal(objectiveGroup.members[0].unlentTokenBudget, undefined);

const unlentGroup = buildDemandAwareCapacityGroup({
  ...groupArgs,
  restoration: unlentContract,
  interactive: {
    pool: "sim-interactive", priority: 100,
    guaranteedMaxConcurrent: 28, guaranteedTokenBudget: 24_000, unlentTokenBudget: 12_000,
  },
  batch: {
    pool: "sim-batch", priority: 10,
    guaranteedMaxConcurrent: 4, guaranteedTokenBudget: 16_000, unlentTokenBudget: 8_000,
  },
});
assert.equal(unlentGroup.members[0].unlentTokenBudget, 12_000);
assert.equal(unlentGroup.members[1].unlentTokenBudget, 8_000);
const groupClaim = capacityGroupRestorationClaim(unlentGroup);
assert.equal(groupClaim.enforceability.upstreamCapacity, "unlent_floor");
assert.equal(groupClaim.upstreamReclamation, "not-claimed");
assert.deepEqual(groupClaim.unlentTokenBudgetByPool, {
  "sim-interactive": 12_000,
  "sim-batch": 8_000,
});

// Withholding the entire guarantee is a static split, not a lending policy.
assert.throws(
  () => buildDemandAwareCapacityGroup({
    ...groupArgs,
    restoration: unlentContract,
    interactive: {
      pool: "sim-interactive", priority: 100,
      guaranteedMaxConcurrent: 28, guaranteedTokenBudget: 24_000, unlentTokenBudget: 24_000,
    },
    batch: {
      pool: "sim-batch", priority: 10,
      guaranteedMaxConcurrent: 4, guaranteedTokenBudget: 16_000, unlentTokenBudget: 16_000,
    },
  }),
  /this is a static split, not a lending policy/,
);
console.log("  ok  demand-aware capacity groups carry a 0.15.0 restoration contract");

// ── tenant-fairness class policies ───────────────────────────────────

const adaptivePool = tenantPoolDefinition("sim-adaptive", 240_000, { classPolicy: "adaptive" });
assert.equal(
  adaptivePool.admissionClassDemandPolicy.restoration.upstreamCapacity.releaseMechanism,
  "non_preemptive",
);
assert.equal(adaptivePool.admissionClassLimits.premium.globalUnlentProtectedInFlightTokens, undefined);

const unlentPool = tenantPoolDefinition("sim-unlent", 240_000, { classPolicy: "unlent" });
assert.equal(
  unlentPool.admissionClassDemandPolicy.restoration.upstreamCapacity.releaseMechanism,
  "unlent_floor",
);
assert.equal(unlentPool.admissionClassLimits.premium.globalUnlentProtectedInFlightTokens, 4_000);
assert.equal(unlentPool.admissionClassLimits.noisy.globalUnlentProtectedInFlightTokens, 18_000);
// The two arms differ only in the mechanism, so the numeric floors must match.
for (const admissionClass of ["premium", "noisy"]) {
  for (const field of [
    "globalProtectedConcurrent",
    "globalMaxConcurrent",
    "globalProtectedInFlightTokens",
    "globalMaxInFlightTokens",
  ]) {
    assert.equal(
      unlentPool.admissionClassLimits[admissionClass][field],
      adaptivePool.admissionClassLimits[admissionClass][field],
      `${admissionClass}.${field} must match the adaptive arm so the mechanism is the only variable`,
    );
  }
}
// Non-lending arms must not acquire a contract they never asked for.
for (const classPolicy of ["shared", "ceilings", "protected"]) {
  const pool = tenantPoolDefinition(`sim-${classPolicy}`, 240_000, { classPolicy });
  assert.equal(pool.admissionClassDemandPolicy, undefined);
  assert.equal(tenantClassRestorationClaim(classPolicy), null);
}
assert.throws(() => tenantPoolDefinition("x", 1_000, { classPolicy: "bogus" }), /unknown tenant-fairness/);

const unlentClaim = tenantClassRestorationClaim("unlent");
assert.equal(unlentClaim.enforceability.upstreamCapacity, "unlent_floor");
assert.deepEqual(unlentClaim.unlentProtectedTokens, { premium: 4_000, noisy: 18_000 });
assert.equal(tenantClassRestorationClaim("adaptive").enforceability.upstreamCapacity, "objective");
console.log("  ok  tenant-fairness gains an unlent-floor arm that isolates the mechanism");

// ── Tyr borrowed-slot policy ─────────────────────────────────────────

const slotPolicy = buildBorrowedAdmissionSlotPolicy({ deadlineMs: BORROWED_ADMISSION_SLOT_DEADLINE_MS });
assert.deepEqual(slotPolicy, {
  releaseMechanism: BORROWED_ADMISSION_SLOT_RELEASE_MECHANISM,
  deadlineMs: 2_500,
});
assert.equal(TENANT_FAIRNESS_POLICY.borrowedAdmissionSlotDeadlineMs, 2_500);
assert.throws(() => buildBorrowedAdmissionSlotPolicy({ deadlineMs: 0 }), /positive integer/);

// ── Tyr /stats restoration, verbatim from tyr-admission-controller:0.30.0 ──

const TYR_STATS_FIXTURE = {
  probe: {
    tyr: {
      restoration: {
        admissionSlots: {
          releaseMechanism: "deadline_abandonment",
          enforceability: "enforced",
          configuredDeadlinesMs: { borrower: 1200 },
          released: 2,
          releasedByCause: { deadline: 2 },
        },
        upstreamCapacity: {
          releaseMechanism: "abort_signal",
          enforceability: "unverified",
          cancellationRequested: 2,
          activeAccountingHolds: 0,
        },
      },
    },
  },
};

const tyrRestoration = summarizeTyrRestoration({
  statsByPool: TYR_STATS_FIXTURE,
  tyrVersion: "0.30.0",
});
assert.equal(tyrRestoration.status, "measured");
assert.equal(tyrRestoration.admissionSlots.enforceability, "enforced");
assert.equal(tyrRestoration.admissionSlots.released, 2);
assert.equal(tyrRestoration.admissionSlots.releasedByCause.deadline, 2);
// Tyr omits `manual` entirely when it never fired; it must read as zero, not NaN.
assert.equal(tyrRestoration.admissionSlots.releasedByCause.manual, 0);
assert.equal(tyrRestoration.admissionSlots.releasedByCause.unattributed, 0);
assert.equal(tyrRestoration.admissionSlots.deadlineShare, 1);
assert.deepEqual(tyrRestoration.admissionSlots.configuredDeadlinesMs, { "probe/borrower": 1200 });
// The upstream side is never upgraded past what Tyr itself claims.
assert.equal(tyrRestoration.upstreamCapacity.enforceability, "unverified");
assert.equal(tyrRestoration.upstreamCapacity.reclamation, "unverified");
assert.equal(tyrRestoration.upstreamCapacity.cancellationRequested, 2);

// A manual abandonment must stay distinguishable from an expired lease: the
// two mean different things about whether the deadline was configured too tight.
const mixedCause = summarizeTyrRestoration({
  statsByPool: {
    probe: {
      tyr: {
        restoration: {
          admissionSlots: {
            releaseMechanism: "deadline_abandonment",
            enforceability: "enforced",
            configuredDeadlinesMs: { borrower: 1200 },
            released: 5,
            releasedByCause: { deadline: 3, manual: 2 },
          },
          upstreamCapacity: {
            releaseMechanism: "abort_signal",
            enforceability: "unverified",
            cancellationRequested: 3,
            activeAccountingHolds: 1,
          },
        },
      },
    },
  },
  tyrVersion: "0.30.0",
});
assert.equal(mixedCause.admissionSlots.deadlineShare, 0.6);
assert.equal(mixedCause.upstreamCapacity.cancellationRequested, 3);
assert.equal(mixedCause.upstreamCapacity.activeAccountingHolds, 1);

// Absent instrumentation on a runtime that advertises it is lost data.
assert.throws(
  () => summarizeTyrRestoration({ statsByPool: { probe: { tyr: {} } }, tyrVersion: "0.30.0" }),
  /claims borrowed-slot deadline support but no pool exposed/,
);
assert.equal(
  summarizeTyrRestoration({ statsByPool: { probe: { tyr: {} } }, tyrVersion: "0.29.0" }).status,
  "not-instrumented",
);
assert.throws(
  () => summarizeTyrRestoration({
    statsByPool: {
      probe: {
        tyr: {
          restoration: {
            admissionSlots: { released: 1, releasedByCause: { deadline: 3 } },
            upstreamCapacity: {},
          },
        },
      },
    },
    tyrVersion: "0.30.0",
  }),
  /cause split \(3\) exceeds total slot releases \(1\)/,
);
console.log("  ok  Tyr 0.30.0 restoration stats parse from the real /stats payload");

// ── Latchflo per-resource restoration episodes ───────────────────────

const EPISODES = [
  {
    scope: "admission_class",
    durationMs: 4_200,
    resources: {
      admissionSlots: {
        releaseMechanism: "lease_safe_handoff",
        enforceability: "objective",
        sloMs: 15_000,
        target: 4,
      },
      upstreamCapacity: {
        releaseMechanism: "unlent_floor",
        enforceability: "unlent_floor",
        sloMs: 15_000,
        target: 36_000,
        unlent: 18_000,
      },
    },
    resourceSloViolatedAt: {},
  },
  {
    scope: "admission_class",
    durationMs: 21_000,
    resources: {
      admissionSlots: {
        releaseMechanism: "lease_safe_handoff",
        enforceability: "objective",
        sloMs: 15_000,
        target: 4,
      },
      upstreamCapacity: {
        releaseMechanism: "unlent_floor",
        enforceability: "unlent_floor",
        sloMs: 15_000,
        target: 36_000,
        unlent: 18_000,
      },
    },
    // 0.15.0's whole point: the slot objective was missed, the withheld token
    // slice was not, and a single flat SLO field could not say which.
    resourceSloViolatedAt: { admissionSlots: "2026-09-03T20:52:27.000Z" },
  },
];

const episodes = summarizeLatchfloRestorationEpisodes({
  episodes: EPISODES,
  latchfloVersion: "0.15.0",
});
assert.equal(episodes.status, "measured");
assert.equal(episodes.episodes, 2);
const slotRow = episodes.resources.find((row) => row.resource === "admissionSlots");
const tokenRow = episodes.resources.find((row) => row.resource === "upstreamCapacity");
assert.equal(slotRow.enforceability, "objective");
assert.equal(slotRow.sloViolations, 1);
assert.equal(slotRow.medianDurationMs, 12_600);
assert.equal(tokenRow.enforceability, "unlent_floor");
assert.equal(tokenRow.sloViolations, 0);
assert.equal(tokenRow.unlentTotal, 36_000);

assert.equal(
  summarizeLatchfloRestorationEpisodes({ episodes: [], latchfloVersion: "0.15.0" }).status,
  "no-episodes",
);
// Episodes without per-resource evidence on a 0.15.0 controller are lost data.
assert.throws(
  () => summarizeLatchfloRestorationEpisodes({
    episodes: [{ restorationSloMs: 30_000, sloViolatedAt: null }],
    latchfloVersion: "0.15.0",
  }),
  /without per-resource evidence/,
);
assert.throws(
  () => summarizeLatchfloRestorationEpisodes({
    episodes: [
      { resources: { admissionSlots: { releaseMechanism: "lease_safe_handoff", enforceability: "objective", sloMs: 1, target: 1 } } },
      { resources: { admissionSlots: { releaseMechanism: "lease_safe_handoff", enforceability: "unlent_floor", sloMs: 1, target: 1 } } },
    ],
    latchfloVersion: "0.15.0",
  }),
  /as both objective and unlent_floor/,
);
console.log("  ok  Latchflo 0.15.0 episodes report per-resource SLO evidence");

// ── unlent gauges, as exposed by latchflo-control-plane:0.15.0 ───────

const METRICS = `
latchflo_admission_class_unlent_protected_in_flight_tokens{admission_class="noisy",pool="sim-unlent"} 18000
latchflo_admission_class_unlent_protected_in_flight_tokens{admission_class="premium",pool="sim-unlent"} 4000
latchflo_capacity_group_member_unlent_token_budget{capacity_group="grp-unlent",pool="sim-interactive"} 12000
latchflo_capacity_group_member_unlent_token_budget{capacity_group="grp-unlent",pool="sim-batch"} 8000
`;
const gauges = summarizeUnlentFloorGauges({ metricsTexts: [METRICS], latchfloVersion: "0.15.0" });
assert.equal(gauges.status, "measured");
assert.equal(gauges.totalUnlentTokens, 42_000);
assert.equal(gauges.admissionClasses.length, 2);
assert.equal(gauges.capacityGroupMembers.length, 2);
// The gauges are the allocator's own view. A run that only echoes its config
// has not measured the control plane, so an empty scrape is not "measured".
assert.equal(
  summarizeUnlentFloorGauges({ metricsTexts: [""], latchfloVersion: "0.15.0" }).status,
  "not-configured",
);
assert.equal(
  summarizeUnlentFloorGauges({ metricsTexts: [""], latchfloVersion: "0.13.1" }).status,
  "not-instrumented",
);
console.log("  ok  unlent-floor gauges are read from Latchflo rather than from configuration");

// ── the deadline mechanism's bill ────────────────────────────────────

const LOADGEN_SUMMARY = {
  classes: {
    interactive: {
      logical: 200,
      success: 188,
      borrowedDeadlineAbandoned: 9,
      borrowedDeadlineSnapshots: [
        // Verbatim from the real 504 body.
        {
          admissionClass: "premium", deadlineMs: 2_500, releaseMechanism: "deadline_abandonment",
          localSlotReleased: true, upstreamCancellation: "requested", upstreamReclamation: "unverified",
          resources: { borrowedConcurrency: true, borrowedTokens: 274 }, outcome: "gateway_timeout",
        },
        ...Array.from({ length: 8 }, () => ({
          admissionClass: "premium", deadlineMs: 2_500, releaseMechanism: "deadline_abandonment",
          localSlotReleased: true, upstreamCancellation: "requested", upstreamReclamation: "unverified",
          resources: null, outcome: "stream_destroyed",
        })),
      ],
    },
    batch: { logical: 60, success: 55, borrowedDeadlineAbandoned: 0, borrowedDeadlineSnapshots: [] },
  },
};
const cost = summarizeBorrowedDeadlineCost(LOADGEN_SUMMARY);
assert.equal(cost.abandoned, 9);
assert.equal(cost.abandonedRate, +(9 / 260).toFixed(4));
assert.deepEqual(cost.observedDeadlinesMs, [2_500]);
assert.deepEqual(cost.admissionClasses, ["premium"]);
assert.equal(cost.localSlotReleasedAlways, true);
assert.equal(cost.upstreamReclamation, "unverified");
// Streaming callers get a truncated body with no explanation; that is the
// common case and must be reported rather than averaged away.
assert.equal(cost.byOutcome.gateway_timeout, 1);
assert.equal(cost.byOutcome.stream_destroyed, 8);
assert.equal(cost.silentTruncationRate, 0.8889);
// A response claiming more than Tyr's wire contract allows is refused.
assert.throws(
  () => summarizeBorrowedDeadlineCost({
    classes: {
      interactive: {
        logical: 1, success: 0, borrowedDeadlineAbandoned: 1,
        borrowedDeadlineSnapshots: [{ upstreamReclamation: "reclaimed" }],
      },
    },
  }),
  /only "unverified" is a supported claim/,
);
console.log("  ok  deadline abandonment is priced from the client's side, split by outcome");

// ── the headline verdict ─────────────────────────────────────────────

const enforcedVerdict = restorationEnforceabilityVerdict({
  arm: "moflux-unlent-plus-deadline",
  restorationClaim: unlentClaim,
  tyrRestoration,
  latchfloEpisodes: episodes,
  unlentGauges: gauges,
  deadlineCost: cost,
});
assert.equal(enforcedVerdict.admissionSlots.effectiveEnforceability, "enforced");
assert.equal(enforcedVerdict.admissionSlots.releaseMechanism, "deadline_abandonment");
assert.equal(enforcedVerdict.admissionSlots.observed, true);
assert.equal(enforcedVerdict.admissionSlots.deadlinesReleased, 2);
assert.equal(enforcedVerdict.upstreamCapacity.effectiveEnforceability, "unlent_floor");
assert.equal(enforcedVerdict.upstreamCapacity.unlentTokens, 42_000);
// The one claim that never changes, whatever is configured.
assert.equal(enforcedVerdict.upstreamCapacity.reclamation, "not-claimed");
assert.equal(enforcedVerdict.cost.requestsShed, 9);
assert.equal(enforcedVerdict.cost.tokensWithheldFromBorrowing, 42_000);
// Tyr's count and the client's count are the same event from opposite ends.
// A measured run against the licensed stack produced 26 controller-side
// releases against 0 client-side attributions, because the first attribution
// rule compared elapsed time to the wrong instant. The gap is reported so that
// failure is visible in the record instead of reading as a free mechanism.
assert.equal(enforcedVerdict.cost.controllerReportedDeadlineReleases, 2);
assert.equal(enforcedVerdict.cost.clientAttributionGap, 2 - 9);
const unattributedRun = restorationEnforceabilityVerdict({
  arm: "moflux-unlent-plus-slot-deadline",
  restorationClaim: unlentClaim,
  tyrRestoration: summarizeTyrRestoration({
    statsByPool: {
      "sim-deadline@r1": {
        tyr: {
          restoration: {
            admissionSlots: {
              releaseMechanism: "deadline_abandonment",
              enforceability: "enforced",
              configuredDeadlinesMs: { premium: 2_500 },
              released: 26,
              releasedByCause: { deadline: 26 },
            },
            upstreamCapacity: {
              releaseMechanism: "abort_signal",
              enforceability: "unverified",
              cancellationRequested: 26,
              activeAccountingHolds: 0,
            },
          },
        },
      },
    },
    tyrVersion: "0.30.0",
  }),
  latchfloEpisodes: episodes,
  unlentGauges: gauges,
  deadlineCost: summarizeBorrowedDeadlineCost({
    classes: { interactive: { logical: 89, success: 42, borrowedDeadlineAbandoned: 0, borrowedDeadlineSnapshots: [] } },
  }),
});
assert.equal(unattributedRun.cost.controllerReportedDeadlineReleases, 26);
assert.equal(unattributedRun.cost.requestsShed, 0);
assert.equal(unattributedRun.cost.clientAttributionGap, 26);

// Without a Tyr deadline the same evidence must fall back to an objective.
const objectiveVerdict = restorationEnforceabilityVerdict({
  arm: "moflux-adaptive-class-floors",
  restorationClaim: tenantClassRestorationClaim("adaptive"),
  tyrRestoration: summarizeTyrRestoration({ statsByPool: {}, tyrVersion: "0.29.0" }),
  latchfloEpisodes: episodes,
  unlentGauges: summarizeUnlentFloorGauges({ metricsTexts: [""], latchfloVersion: "0.15.0" }),
  deadlineCost: summarizeBorrowedDeadlineCost({ classes: {} }),
});
assert.equal(objectiveVerdict.admissionSlots.effectiveEnforceability, "objective");
assert.equal(objectiveVerdict.admissionSlots.releaseMechanism, "lease_safe_handoff");
assert.equal(objectiveVerdict.upstreamCapacity.effectiveEnforceability, "objective");
assert.equal(objectiveVerdict.upstreamCapacity.unlentTokens, 0);
assert.equal(objectiveVerdict.cost.requestsShed, 0);
// An objective arm may not report a withheld-token benefit it never bought.
assert.equal(objectiveVerdict.cost.tokensWithheldFromBorrowing, 0);

// One Latchflo serves every arm, so an unscoped scrape carries the unlent
// arm's gauges into the adaptive arm's summary. That would credit a
// non_preemptive configuration with capacity it never withheld.
assert.throws(
  () => restorationEnforceabilityVerdict({
    arm: "moflux-adaptive-class-floors",
    restorationClaim: tenantClassRestorationClaim("adaptive"),
    tyrRestoration,
    latchfloEpisodes: episodes,
    unlentGauges: gauges,
    deadlineCost: cost,
  }),
  /configured as objective but was given 42000 unlent tokens; scope the gauges/,
);

// Scoping the scrape to the arm's own pool is what makes the comparison sound.
const scopedToUnlent = summarizeUnlentFloorGauges({
  metricsTexts: [METRICS],
  latchfloVersion: "0.15.0",
  pools: ["sim-unlent"],
});
assert.equal(scopedToUnlent.totalUnlentTokens, 22_000);
assert.equal(scopedToUnlent.capacityGroupMembers.length, 0);
const scopedToAdaptive = summarizeUnlentFloorGauges({
  metricsTexts: [METRICS],
  latchfloVersion: "0.15.0",
  pools: ["sim-adaptive"],
});
assert.equal(scopedToAdaptive.status, "not-configured");
assert.equal(scopedToAdaptive.totalUnlentTokens, 0);
assert.equal(
  restorationEnforceabilityVerdict({
    arm: "moflux-adaptive-class-floors",
    restorationClaim: tenantClassRestorationClaim("adaptive"),
    tyrRestoration,
    latchfloEpisodes: episodes,
    unlentGauges: scopedToAdaptive,
    deadlineCost: cost,
  }).upstreamCapacity.unlentTokens,
  0,
);
console.log("  ok  verdicts never out-rank the configured contract");

// ── cross-seed rollup ────────────────────────────────────────────────

function ladderSeed(seed, { shed, unlentTokens, deadlineObserved, silentRate }) {
  const verdict = {
    admissionSlots: {
      effectiveEnforceability: deadlineObserved ? "enforced" : "objective",
      observed: deadlineObserved,
      deadlinesReleased: deadlineObserved ? shed : 0,
    },
    upstreamCapacity: {
      effectiveEnforceability: "unlent_floor",
      observed: unlentTokens > 0,
      unlentTokens,
      reclamation: "not-claimed",
    },
    cost: { requestsShed: shed, tokensWithheldFromBorrowing: unlentTokens },
  };
  return {
    seed,
    restorationLadder: {
      unlent: {
        pool: "sim-unlent",
        deadlineCost: { silentTruncationRate: null },
        verdict: {
          ...verdict,
          admissionSlots: { effectiveEnforceability: "objective", observed: false, deadlinesReleased: 0 },
          cost: { requestsShed: 0, tokensWithheldFromBorrowing: unlentTokens },
        },
      },
      deadline: {
        pool: "sim-deadline",
        deadlineCost: { silentTruncationRate: silentRate },
        verdict,
      },
    },
  };
}

const ladderRows = [
  ladderSeed(1, { shed: 6, unlentTokens: 22_000, deadlineObserved: true, silentRate: 0.8 }),
  ladderSeed(2, { shed: 10, unlentTokens: 22_000, deadlineObserved: true, silentRate: 0.9 }),
  ladderSeed(3, { shed: 8, unlentTokens: 22_000, deadlineObserved: true, silentRate: 1 }),
];
const rollup = aggregateRestorationLadder(ladderRows);
assert.equal(rollup.arms.unlent.admissionSlotEnforceability, "objective");
assert.equal(rollup.arms.unlent.upstreamEnforceability, "unlent_floor");
assert.equal(rollup.arms.unlent.requestsShedTotal, 0);
assert.equal(rollup.arms.unlent.tokensWithheldFromBorrowing, 22_000);
assert.equal(rollup.arms.deadline.admissionSlotEnforceability, "enforced");
assert.equal(rollup.arms.deadline.seedsWithSlotDeadlineObserved, 3);
assert.equal(rollup.arms.deadline.requestsShedTotal, 24);
assert.equal(rollup.arms.deadline.requestsShedMedian, 8);
assert.equal(rollup.arms.deadline.silentTruncationRateMedian, 0.9);
// Restated per arm so a reader of one row cannot miss the one claim that never
// varies, whatever the mechanism.
for (const arm of Object.values(rollup.arms)) {
  assert.equal(arm.upstreamReclamation, "not-claimed");
  assert.equal(arm.seeds, 3);
}
assert.equal(aggregateRestorationLadder([{ seed: 1 }]), null);

// Enforceability is categorical: a mean of "enforced" and "objective" is not a
// thing, so an arm that changed mechanism mid-sweep must fail rather than
// silently report whichever seed came first.
assert.throws(
  () => aggregateRestorationLadder([
    ladderRows[0],
    ladderSeed(2, { shed: 0, unlentTokens: 22_000, deadlineObserved: false, silentRate: null }),
  ]),
  /arm deadline reported different admission-slot enforceability across seeds: enforced, objective/,
);
console.log("  ok  the cross-seed rollup counts seeds and refuses a mixed mechanism");

console.log("\nPASS  Tyr 0.30.0 borrowed-slot deadlines and Latchflo 0.15.0 unlent floors");
