/**
 * Pure configuration helpers for the public comparison arms.
 *
 * Keeping this arithmetic outside the presenter makes it testable without
 * Docker or licensed images. Arm 2 previously divided by an undefined
 * presenter option, serialized `NaN` into the replica command line, and then
 * rejected every request because all semaphore comparisons against NaN are
 * false.
 */

/**
 * What `--control-arms=all` expands to.
 *
 * "All" means the buy-vs-build alternatives a reader would otherwise build:
 * arm 2 (local semaphore) and arm 4 (Redis-coordinated). It deliberately does
 * not include `static-partition`, which is the lending control and is selected
 * explicitly by `demo:lending`.
 *
 * This lives here because the presenter and the sweep wrapper both resolve the
 * word and had drifted: the wrapper expanded it to two arms while the presenter
 * expanded it to every registered spec. The presenter therefore ran the
 * partition arm on every seed of every sweep and the wrapper then discarded the
 * file, spending a full arm of run time per seed on a measurement nothing read.
 */
export const DEFAULT_CONTROL_ARM_NAMES = Object.freeze(["static-cap", "redis"]);

/**
 * Resolve a `--control-arms` value into an ordered list of arm names.
 *
 * `available` is the caller's registry of known names, so each caller still
 * rejects what it cannot run, but the meaning of "" and "all" is shared.
 */
export function resolveControlArmNames(raw, available) {
  const value = String(raw ?? "").trim();
  if (value === "") return [];
  const names = value === "all" ? [...DEFAULT_CONTROL_ARM_NAMES] : value.split(",").map((name) => name.trim());
  return names.filter(Boolean).map((name) => {
    if (!available.includes(name)) {
      throw new Error(
        `unsupported --control-arms entry "${name}"; expected ${available.join(", ")} or all`,
      );
    }
    return name;
  });
}

/**
 * Return the local concurrency ceiling for Arm 2.
 *
 * Arm 2 is intentionally a static per-replica split: each replica owns an
 * equal integer share of the provider envelope and cannot borrow from peers.
 * The function refuses configurations that would produce a zero-slot replica
 * or rely on a missing/non-integer topology value.
 */
export function dividedStaticCap({ envelope, replicaCount }) {
  if (!Number.isSafeInteger(envelope) || envelope < 1) {
    throw new Error(`Arm 2 requires a positive integer envelope; got ${String(envelope)}`);
  }
  if (!Number.isSafeInteger(replicaCount) || replicaCount < 1) {
    throw new Error(
      `Arm 2 requires a positive integer replica count; got ${String(replicaCount)}`,
    );
  }

  const localCap = Math.floor(envelope / replicaCount);
  if (localCap < 1) {
    throw new Error(
      `Arm 2 cannot divide envelope ${envelope} across ${replicaCount} replicas: ` +
        "the resulting local cap would be zero",
    );
  }
  return localCap;
}

/**
 * Deterministically partition a fleet-wide static ceiling across replicas.
 * Earlier replicas receive the remainder so the sum is exact and no slot is
 * fabricated or stranded by integer division.
 */
export function partitionStaticCap({ envelope, replicaCount }) {
  if (!Number.isSafeInteger(envelope) || envelope < 1) {
    throw new Error(`static partition requires a positive integer envelope; got ${String(envelope)}`);
  }
  if (!Number.isSafeInteger(replicaCount) || replicaCount < 1) {
    throw new Error(`static partition requires a positive integer replica count; got ${String(replicaCount)}`);
  }
  if (envelope < replicaCount) {
    throw new Error(`cannot give ${replicaCount} replicas a usable share of envelope ${envelope}`);
  }
  const base = Math.floor(envelope / replicaCount);
  const remainder = envelope % replicaCount;
  return Array.from({ length: replicaCount }, (_, index) => base + (index < remainder ? 1 : 0));
}
