/**
 * version-lib.mjs — semantic version comparison for runtime capability gating.
 *
 * Capability gates in this benchmark are deliberately two-sided. A missing
 * feature on an older runtime is a legitimate "not instrumented" result; the
 * same absence on a runtime that claims the feature is lost instrumentation
 * and must fail loudly rather than quietly publish a zero.
 */

/** Parses the leading `major.minor.patch` of a version string. */
export function versionTuple(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? "").trim());
  return match ? match.slice(1).map(Number) : null;
}

/**
 * True when `version` is at least `minimum`, where `minimum` is a
 * `[major, minor, patch]` tuple. An unparseable version is never "at least"
 * anything: an unknown runtime must not be credited with a capability.
 */
export function versionAtLeast(version, minimum) {
  const tuple = versionTuple(version);
  if (!tuple) return false;
  for (let index = 0; index < 3; index += 1) {
    if (tuple[index] > minimum[index]) return true;
    if (tuple[index] < minimum[index]) return false;
  }
  return true;
}
