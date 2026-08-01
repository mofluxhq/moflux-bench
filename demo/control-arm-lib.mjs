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
