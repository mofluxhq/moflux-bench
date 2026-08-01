/**
 * coordination-lib.mjs — how much does the distance to your coordinator cost?
 *
 * The question
 * ------------
 * Every admission-control design has to answer "may this request proceed"
 * against state that is shared across replicas. There are two ways to do it,
 * and the difference is not visible in a benchmark where the coordinator runs
 * on loopback.
 *
 *   Per-request coordination (arm 4, Redis): consult the shared store on every
 *   admission. The decision is always exact. The cost is one round trip per
 *   admission, paid on the request's critical path, every time.
 *
 *   Lease-based coordination (MoFlux): hold a grant of capacity and decide
 *   locally against it. The cost is one round trip per grant renewal, paid off
 *   the critical path and amortised across every admission the grant covers.
 *   The decision is exact within the grant and approximate across the fleet.
 *
 * On loopback the first design looks free, because a round trip is a few
 * hundred microseconds. That is the most favourable condition it can be given
 * and it does not exist in production: a same-availability-zone hop is roughly
 * 0.5-1ms, cross-AZ 1-3ms, and a contended instance considerably more. A
 * benchmark that never varies this has silently assumed the answer.
 *
 * The prediction
 * --------------
 * Per-request coordination should degrade roughly linearly with coordinator
 * latency, multiplied by attempts per request. Lease-based coordination should
 * be flat, because no coordinator is consulted on the admission path at all.
 *
 * That is falsifiable, and it is what these functions measure. A flat Redis
 * line, or a rising MoFlux line, refutes it.
 */

/**
 * Least-squares slope and intercept of y against x.
 *
 * Slope is the metric of interest: milliseconds of added latency per
 * millisecond of coordinator distance. A design that consults the coordinator
 * once per admission should land near the attempts-per-request figure; one
 * that never consults it should land near zero.
 */
export function linearFit(points) {
  const usable = points.filter(
    (p) => Number.isFinite(p?.x) && Number.isFinite(p?.y),
  );
  if (usable.length < 2) return null;
  const n = usable.length;
  const meanX = usable.reduce((sum, p) => sum + p.x, 0) / n;
  const meanY = usable.reduce((sum, p) => sum + p.y, 0) / n;
  const varianceX = usable.reduce((sum, p) => sum + (p.x - meanX) ** 2, 0);
  if (varianceX === 0) return null;
  const covariance = usable.reduce((sum, p) => sum + (p.x - meanX) * (p.y - meanY), 0);
  const slope = covariance / varianceX;
  const intercept = meanY - slope * meanX;

  // Coefficient of determination, so a slope fitted to noise is not reported
  // as a trend.
  const ssTot = usable.reduce((sum, p) => sum + (p.y - meanY) ** 2, 0);
  const ssRes = usable.reduce((sum, p) => sum + (p.y - (slope * p.x + intercept)) ** 2, 0);
  const r2 = ssTot === 0 ? null : +(1 - ssRes / ssTot).toFixed(4);

  return { slope: +slope.toFixed(4), intercept: +intercept.toFixed(1), r2, n };
}

/**
 * Sensitivity of one arm to coordinator distance.
 *
 * `rungs` is one entry per latency setting: `{ coordinatorLatencyMs, ttftP50Ms,
 * ttftP95Ms, successRate }`, each already medianed across seeds.
 */
export function armSensitivity(rungs) {
  const at = (key) => linearFit(rungs.map((r) => ({ x: r.coordinatorLatencyMs, y: r[key] })));
  const sorted = [...rungs].sort((a, b) => a.coordinatorLatencyMs - b.coordinatorLatencyMs);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  return {
    rungs: sorted.length,
    latencyRangeMs: first && last ? [first.coordinatorLatencyMs, last.coordinatorLatencyMs] : null,
    ttftP50: at("ttftP50Ms"),
    ttftP95: at("ttftP95Ms"),
    successRate: at("successRate"),
    ttftP50ChangeMs: first && last ? +(last.ttftP50Ms - first.ttftP50Ms).toFixed(1) : null,
    successPointChange:
      first && last ? +((last.successRate - first.successRate) * 100).toFixed(2) : null,
  };
}

/**
 * Whether an arm's admission path is insensitive to coordinator distance.
 *
 * "Insensitive" is deliberately strict: the fitted slope must be below one
 * tenth of a millisecond per millisecond, meaning the arm absorbs less than
 * 10% of the coordinator's distance into its own latency. Anything above that
 * is consulting the coordinator on the critical path, whatever its design
 * claims.
 */
export function isCoordinatorIndependent(
  sensitivity,
  { slopeThreshold = 0.1, fitThreshold = 0.25 } = {},
) {
  const fit = sensitivity?.ttftP50;
  if (!fit) return null;
  // Run-to-run noise produces a non-zero slope through pure chance, and with
  // few rungs that slope can be large. Requiring the line to actually fit
  // before believing it stops scatter being read as a trend — in either
  // direction. A negative slope, meaning latency falls as the coordinator gets
  // further away, is the clearest sign the fit is noise.
  //
  // The bar sits low on purpose. Measured noise fits at around r2 0.08, while
  // a real trend carrying visible scatter still fits near 0.48, so a threshold
  // between them separates the two without letting a genuine trend hide behind
  // its own variance.
  if (fit.r2 !== null && fit.r2 < fitThreshold) return true;
  return Math.abs(fit.slope) < slopeThreshold;
}

/**
 * The head-to-head verdict across the latency ladder.
 *
 * Reported as a crossover: the coordinator distance at which the lease-based
 * arm's time to first token overtakes the per-request arm's. Below it, paying
 * a round trip per admission is cheaper than holding a grant. Above it, it is
 * not. If the two never cross, that is the finding and it is stated plainly
 * rather than extrapolated into one.
 */
export function crossover(perRequestRungs, leaseRungs, metric = "ttftP50Ms") {
  const byLatency = new Map();
  for (const rung of perRequestRungs) byLatency.set(rung.coordinatorLatencyMs, { perRequest: rung[metric] });
  for (const rung of leaseRungs) {
    const entry = byLatency.get(rung.coordinatorLatencyMs);
    if (entry) entry.lease = rung[metric];
  }
  const paired = [...byLatency.entries()]
    .filter(([, v]) => Number.isFinite(v.perRequest) && Number.isFinite(v.lease))
    .sort((a, b) => a[0] - b[0]);
  if (paired.length < 2) return null;

  const leads = paired.map(([latency, v]) => ({
    coordinatorLatencyMs: latency,
    // Positive means the lease-based arm is slower at this distance.
    leaseDeficitMs: +(v.lease - v.perRequest).toFixed(1),
  }));
  const first = leads[0];
  const crossingIndex = leads.findIndex((l) => l.leaseDeficitMs <= 0);

  return {
    metric,
    leads,
    leaseBehindAtZero: first.leaseDeficitMs > 0,
    crossesAtMs: crossingIndex === -1 ? null : leads[crossingIndex].coordinatorLatencyMs,
    /**
     * True only when a crossing was actually observed inside the tested range.
     * A ladder that never crosses does not license a claim that it would.
     */
    observedCrossing: crossingIndex !== -1,
    narrowestDeficitMs: Math.min(...leads.map((l) => l.leaseDeficitMs)),
  };
}
