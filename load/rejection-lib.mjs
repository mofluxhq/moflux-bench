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
