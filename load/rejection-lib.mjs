/**
 * True when Tyr refused with a zero physical envelope: zero concurrency, zero
 * queue, and a zero token budget where one is configured. Under Latchflo this
 * is the even-revision fail-closed snapshot Tyr installs when a grant expires
 * before a successor is applied. Tyr still reports `budget_limit` or
 * `concurrency_limit`, but no amount of free capacity could have admitted the
 * request, so it must not be read as token pressure or contention.
 *
 * `detail` is the `error.detail` object of a Tyr admission rejection.
 */
export function zeroCapacityEnvelope(detail) {
  if (detail === null || typeof detail !== "object") return false;
  if (detail.maxConcurrent !== 0) return false;
  if (detail.maxQueue !== undefined && detail.maxQueue !== 0) return false;
  const budget = detail.tokenBudget;
  return budget === undefined || budget === null || budget.budget === 0;
}

/**
 * Counts 5xx responses by the most specific reason the body names: Tyr 0.31.0
 * `error.cause.code`, else `error.type`, else the HTTP status.
 */
export function summarizeServerErrorCauses(snapshots = []) {
  const counts = {};
  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    let error = null;
    try { error = JSON.parse(String(snapshot?.body ?? ""))?.error ?? null; } catch { /* keep null */ }
    const cause = typeof error?.cause?.code === "string"
      ? `${error.type ?? "error"}:${error.cause.code}`
      : typeof error?.type === "string" ? error.type : `http_${snapshot?.status ?? "unknown"}`;
    counts[cause] = (counts[cause] ?? 0) + 1;
  }
  return Object.freeze(counts);
}
