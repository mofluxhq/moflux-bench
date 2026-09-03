/**
 * restoration-contract-lib.mjs — per-resource restoration contracts for
 * Latchflo 0.15.0 and Tyr 0.30.0.
 *
 * The claim being configured
 * --------------------------
 * Up to Latchflo 0.14, a lending policy priced restoration as one number: a
 * wall-clock SLO over "the protected floor". That conflated two resources with
 * genuinely different physics.
 *
 *   - Admission slots are Tyr-local. Tyr can stop issuing them, and from
 *     0.30.0 it can take one back from a borrower mid-request by expiring a
 *     bounded post-admission deadline. That is enforceable.
 *
 *   - Upstream token capacity is the provider's. Nothing in this stack can
 *     make a provider forget an in-flight request's tokens. The only honest
 *     enforcement is to never lend a slice of the floor in the first place
 *     (`unlent_floor`); everything else is an objective, not a guarantee.
 *
 * 0.15.0 therefore requires an enabled lending policy to state both contracts
 * separately, and this module is where the benchmark says which mechanism it
 * is measuring. Getting the shape wrong is a control-plane rejection at
 * bootstrap, so every rule Latchflo enforces is mirrored here to fail locally
 * with a message that names the benchmark flag rather than the wire field.
 *
 * What this module refuses to do
 * ------------------------------
 * It never labels an upstream token contract "enforced". `unlent_floor` is
 * allocation-enforced — Latchflo will not hand the slice to a borrower — which
 * is a strictly weaker claim than reclaiming capacity already in flight at the
 * provider. The vocabulary is kept identical to Latchflo's own
 * `enforceability` field so a published record cannot drift into a stronger
 * claim than the control plane made.
 */

import { versionAtLeast } from "./version-lib.mjs";

/** Latchflo's only admission-slot mechanism: acknowledged handoff or lease fallback. */
export const ADMISSION_SLOT_RELEASE_MECHANISM = "lease_safe_handoff";

/** Latchflo's upstream-token mechanisms. `unlent_floor` is the 0.15.0 addition. */
export const UPSTREAM_RELEASE_MECHANISMS = Object.freeze([
  "non_preemptive",
  "unlent_floor",
]);

/** Tyr 0.30.0's per-class borrowed-slot mechanism. */
export const BORROWED_ADMISSION_SLOT_RELEASE_MECHANISM = "deadline_abandonment";

/** Latchflo's own default when it migrates a pre-0.14 policy in place. */
export const DEFAULT_RESTORATION_SLO_MS = 30_000;

const LATCHFLO_PER_RESOURCE_MIN = [0, 15, 0];
const TYR_BORROWED_DEADLINE_MIN = [0, 30, 0];

/** Latchflo 0.15.0 replaced `restoration.{mode,sloMs}` with per-resource contracts. */
export function latchfloPerResourceRestorationExpected(version) {
  return versionAtLeast(version, LATCHFLO_PER_RESOURCE_MIN);
}

/** `unlent_floor` and the unlent gauges arrived in the same release. */
export function latchfloUnlentFloorExpected(version) {
  return versionAtLeast(version, LATCHFLO_PER_RESOURCE_MIN);
}

/** Tyr 0.30.0 added `borrowedAdmissionSlot` deadlines and the restoration stats block. */
export function tyrBorrowedSlotDeadlinesExpected(version) {
  return versionAtLeast(version, TYR_BORROWED_DEADLINE_MIN);
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

/**
 * Builds the `restoration` contract for one enabled lending policy.
 *
 * `tokenAware` mirrors exactly what Latchflo checks: a capacity group is
 * token-aware when it carries `globalTokenBudget`, and an admission-class
 * policy is token-aware when any class declares a protected token floor.
 * Latchflo rejects a token contract on a policy with no protected token
 * resource, so this is not a stylistic choice.
 */
export function buildRestorationContract({
  admissionSlotSloMs = DEFAULT_RESTORATION_SLO_MS,
  upstreamTokenSloMs = DEFAULT_RESTORATION_SLO_MS,
  upstreamMechanism = "non_preemptive",
  tokenAware,
} = {}) {
  if (typeof tokenAware !== "boolean") {
    throw new Error("restoration contract requires an explicit tokenAware flag");
  }
  positiveInteger(admissionSlotSloMs, "restoration.admissionSlots.sloMs");
  const contract = {
    admissionSlots: {
      releaseMechanism: ADMISSION_SLOT_RELEASE_MECHANISM,
      sloMs: admissionSlotSloMs,
    },
  };
  if (!tokenAware) {
    if (upstreamMechanism === "unlent_floor") {
      throw new Error(
        "restoration.upstreamCapacity requires a protected token resource; " +
          "an unlent floor cannot be configured on a concurrency-only policy",
      );
    }
    return Object.freeze(contract);
  }
  if (!UPSTREAM_RELEASE_MECHANISMS.includes(upstreamMechanism)) {
    throw new Error(
      `restoration.upstreamCapacity.releaseMechanism must be one of ${UPSTREAM_RELEASE_MECHANISMS.join(", ")}`,
    );
  }
  positiveInteger(upstreamTokenSloMs, "restoration.upstreamCapacity.sloMs");
  return Object.freeze({
    ...contract,
    upstreamCapacity: {
      releaseMechanism: upstreamMechanism,
      sloMs: upstreamTokenSloMs,
    },
  });
}

/**
 * The enforceability Latchflo will publish for this contract.
 *
 * Kept identical to Latchflo's `RestorationResourceEvidence.enforceability` so
 * a benchmark record and the control plane cannot disagree about how strong
 * the claim is. Admission slots are always `objective` at the Latchflo layer:
 * the control plane's mechanism is acknowledged handoff, and Tyr's enforceable
 * deadline is separate local policy that Latchflo does not own.
 */
export function restorationEnforceability(contract) {
  const upstream = contract?.upstreamCapacity;
  return Object.freeze({
    admissionSlots: "objective",
    ...(upstream === undefined
      ? {}
      : {
          upstreamCapacity:
            upstream.releaseMechanism === "unlent_floor" ? "unlent_floor" : "objective",
        }),
  });
}

/** True when the contract keeps a token slice out of borrowing entirely. */
export function usesUnlentFloor(contract) {
  return contract?.upstreamCapacity?.releaseMechanism === "unlent_floor";
}

/**
 * Validates an unlent token slice against the floor it protects.
 *
 * Latchflo requires a positive slice on every token-carrying member or class
 * once the policy uses `unlent_floor`, and rejects a slice larger than the
 * guarantee it is carved from. Both checks are reproduced so a misconfigured
 * split fails before Docker rather than during enrollment.
 */
export function validateUnlentSlice({
  label,
  unlentTokens,
  protectedTokens,
  contract,
  lendingEnabled,
}) {
  const unlent = unlentTokens ?? 0;
  if (unlent !== 0 && !Number.isSafeInteger(unlent)) {
    throw new Error(`${label} must be an integer number of tokens`);
  }
  if (unlent < 0) throw new Error(`${label} must not be negative`);
  if (usesUnlentFloor(contract)) {
    if (lendingEnabled && protectedTokens > 0 && unlent < 1) {
      throw new Error(
        `${label} must be positive when restoration.upstreamCapacity uses unlent_floor`,
      );
    }
    if (unlent > protectedTokens) {
      throw new Error(
        `${label} (${unlent}) cannot exceed the protected token floor it is carved from (${protectedTokens})`,
      );
    }
  } else if (unlent > 0) {
    throw new Error(
      `${label} requires restoration.upstreamCapacity.releaseMechanism="unlent_floor"`,
    );
  }
  return unlent;
}

/**
 * Builds Tyr 0.30.0's per-class `borrowedAdmissionSlot` policy.
 *
 * This is Tyr-local configuration. Latchflo replaces the numeric class grants
 * atomically and never sends this deadline, so it stays in the Tyr config file
 * rather than in a capacity-group write.
 *
 * What the deadline actually is
 * -----------------------------
 * Measured directly against `tyr-admission-controller:0.30.0`: the deadline is
 * an **unconditional** wall-clock bound on how long any borrowed slot may be
 * held. It is not triggered by the floor owner demanding its capacity back. A
 * borrowed request running past `deadlineMs` is abandoned even when nothing is
 * waiting and the pool is otherwise idle.
 *
 * That is a stronger and blunter instrument than "return it when asked", and
 * the difference is the whole reason it can be called enforced: the floor
 * owner's worst-case wait is bounded by `deadlineMs` rather than by the
 * borrower's longest possible request. The bill is paid by every borrower that
 * legitimately runs longer than the deadline, whether or not the capacity was
 * ever actually needed.
 *
 * So `deadlineMs` is a workload parameter, not a safety margin. Set below the
 * borrower's normal completion time it sheds continuously; the
 * `releasedByCause.deadline` share in `/stats` is the signal that this has
 * happened.
 */
export function buildBorrowedAdmissionSlotPolicy({ deadlineMs }) {
  positiveInteger(deadlineMs, "borrowedAdmissionSlot.deadlineMs");
  return Object.freeze({
    releaseMechanism: BORROWED_ADMISSION_SLOT_RELEASE_MECHANISM,
    deadlineMs,
  });
}
