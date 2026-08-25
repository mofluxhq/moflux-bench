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
  const firstLeadIndex = leads.findIndex((l) => l.leaseDeficitMs <= 0);
  const stableCrossingIndex = leads.findIndex(
    (lead, index) =>
      index < leads.length - 1 &&
      lead.leaseDeficitMs <= 0 &&
      leads.slice(index).every((later) => later.leaseDeficitMs <= 0),
  );

  return {
    metric,
    leads,
    leaseBehindAtZero: first.leaseDeficitMs > 0,
    firstLeadMs: firstLeadIndex === -1 ? null : leads[firstLeadIndex].coordinatorLatencyMs,
    crossesAtMs:
      stableCrossingIndex === -1 ? null : leads[stableCrossingIndex].coordinatorLatencyMs,
    /**
     * A reported crossover has to persist through at least one subsequent
     * tested rung and every larger rung after that. A lead first observed at
     * the final rung is evidence of a lead there, not evidence of persistence.
     */
    observedCrossing: stableCrossingIndex !== -1,
    transientLeadRungsMs:
      stableCrossingIndex === -1
        ? leads.filter((l) => l.leaseDeficitMs <= 0).map((l) => l.coordinatorLatencyMs)
        : leads
            .slice(0, stableCrossingIndex)
            .filter((l) => l.leaseDeficitMs <= 0)
            .map((l) => l.coordinatorLatencyMs),
    narrowestDeficitMs: Math.min(...leads.map((l) => l.leaseDeficitMs)),
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * Paired analysis
 *
 * Why the functions above are not enough
 * --------------------------------------
 * The ladder runs a *paired* design and then threw the pairing away. Every
 * seed replays a byte-identical request trace at every rung, so the same seed
 * at 0ms and at 50ms differ only by the coordinator distance. That is the
 * whole point: seed-to-seed variation cancels inside a seed.
 *
 * `armSensitivity` never saw that structure. It was handed one cross-seed
 * median per rung, so the only variation left in its six points was the
 * between-seed spread the pairing existed to remove. Measured on the
 * 20260813T054929Z ladder, that spread is 194-505ms per rung against a 132ms
 * effect, and the median lands on a different seed at different rungs — so a
 * single seed swap reads as an outlier, r² collapses, and
 * `isCoordinatorIndependent` returns true because r² < 0.25.
 *
 * The consequence is not symmetric. For an arm predicted to be flat, noise
 * confirms the prediction; for an arm predicted to degrade, the same noise
 * refutes it. An unpaired fit over cross-seed medians can therefore only ever
 * report "no coordination cost", whichever way the underlying data points.
 *
 * These functions fit within each seed and aggregate the slopes, which is the
 * analysis the design was built for.
 * ──────────────────────────────────────────────────────────────────────── */

/** Natural log of the gamma function (Lanczos, g=7, n=9). */
function lnGamma(x) {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i += 1) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Continued fraction for the incomplete beta function (Lentz's method). */
function betaContinuedFraction(a, b, x) {
  const tiny = 1e-30;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m += 1) {
    const m2 = 2 * m;
    let numerator = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + numerator * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + numerator / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    numerator = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + numerator * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + numerator / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 3e-16) break;
  }
  return h;
}

/** Regularised incomplete beta I_x(a, b). */
function incompleteBeta(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(a, b, x)) / a
    : 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/**
 * P(T > t) for Student's t with `df` degrees of freedom — the one-sided tail.
 *
 * Exported so the verification fixtures can check it against published
 * critical values rather than trusting the implementation.
 */
export function studentTTail(t, df) {
  if (!Number.isFinite(t) || !Number.isFinite(df) || df <= 0) return null;
  const p = 0.5 * incompleteBeta(df / 2, 0.5, df / (df + t * t));
  return t >= 0 ? p : 1 - p;
}

/** Two-sided critical t value, by bisection on the tail. */
function tCritical(df, twoSidedAlpha = 0.05) {
  let lo = 0;
  let hi = 100;
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    if (studentTTail(mid, df) > twoSidedAlpha / 2) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Exact two-sided binomial sign test at p=0.5, given `k` of `n` one way. */
export function signTestP(k, n) {
  if (!Number.isInteger(k) || !Number.isInteger(n) || n < 1) return null;
  const extreme = Math.max(k, n - k);
  let tail = 0;
  let coefficient = 1;
  for (let i = 0; i <= n; i += 1) {
    if (i >= extreme) tail += coefficient;
    coefficient = (coefficient * (n - i)) / (i + 1);
  }
  return Math.min(1, (2 * tail) / 2 ** n);
}

/**
 * One linear fit per seed, across that seed's rungs.
 *
 * `series` is one entry per seed: `{ seed, rungs: [{ coordinatorLatencyMs,
 * <metric> }] }`. A seed missing a rung is fitted on the rungs it has; a seed
 * with fewer than two usable rungs is dropped and counted, never silently
 * folded into the aggregate.
 */
export function seedSlopes(series, metricKey) {
  const fitted = [];
  const dropped = [];
  for (const entry of series ?? []) {
    const points = (entry?.rungs ?? []).map((r) => ({
      x: r?.coordinatorLatencyMs,
      y: r?.[metricKey],
    }));
    const fit = linearFit(points);
    if (!fit) {
      dropped.push(entry?.seed ?? null);
      continue;
    }
    const usable = (entry.rungs ?? [])
      .filter((r) => Number.isFinite(r?.coordinatorLatencyMs) && Number.isFinite(r?.[metricKey]))
      .sort((a, b) => a.coordinatorLatencyMs - b.coordinatorLatencyMs);
    fitted.push({
      seed: entry.seed ?? null,
      slope: fit.slope,
      r2: fit.r2,
      rungs: fit.n,
      changeAcrossLadderMs: +(usable[usable.length - 1][metricKey] - usable[0][metricKey]).toFixed(1),
    });
  }
  return { fitted, dropped };
}

/**
 * Aggregate the per-seed slopes into a verdict-bearing summary.
 *
 * The reported interval is a t interval over the per-seed slopes, so its width
 * is governed by seed count. That is deliberate: seeds, not rungs, are the
 * replicate here, and a ladder that adds rungs without adding seeds buys
 * precision it cannot report.
 */
export function pairedMetric(series, metricKey) {
  const { fitted, dropped } = seedSlopes(series, metricKey);
  const n = fitted.length;
  if (n === 0) return null;
  const slopes = fitted.map((f) => f.slope);
  const changes = fitted.map((f) => f.changeAcrossLadderMs);
  const mean = slopes.reduce((sum, s) => sum + s, 0) / n;
  // Counted in both directions rather than as "positive" and "the rest". A
  // slope of exactly zero is neither degrading nor improving, and folding ties
  // into one side turns an arm with no direction at all into a unanimous
  // verdict — the sign test would read eight flat seeds as eight seeds
  // agreeing on improvement.
  const degrading = slopes.filter((s) => s > 0).length;
  const improving = slopes.filter((s) => s < 0).length;
  const tied = n - degrading - improving;

  let stdDev = null;
  let stdErr = null;
  let ci95 = null;
  let directionalP = null;
  if (n >= 2) {
    const variance = slopes.reduce((sum, s) => sum + (s - mean) ** 2, 0) / (n - 1);
    stdDev = Math.sqrt(variance);
    stdErr = stdDev / Math.sqrt(n);
    const half = tCritical(n - 1, 0.05) * stdErr;
    ci95 = [+(mean - half).toFixed(4), +(mean + half).toFixed(4)];
    // One-sided probability for a *positive* slope. Do not take abs(mean): a
    // negative observed slope is evidence against the pre-specified positive
    // direction and therefore must produce a large, not a small, p-value.
    directionalP = stdErr > 0 ? +studentTTail(mean / stdErr, n - 1).toFixed(4) : null;
  }

  return {
    metric: metricKey,
    seeds: n,
    seedsDropped: dropped,
    perSeed: fitted,
    medianSlope: +medianOf(slopes).toFixed(4),
    meanSlope: +mean.toFixed(4),
    stdDevSlope: stdDev === null ? null : +stdDev.toFixed(4),
    ci95,
    seedsDegrading: degrading,
    seedsImproving: improving,
    seedsTied: tied,
    /**
     * Exact binomial on the sign of each seed's slope, over the seeds that
     * actually moved. Dropping ties is the textbook sign test: a seed with no
     * direction carries no evidence about direction, and counting it as
     * evidence for whichever side it is not on inverts its meaning. Null when
     * no seed moved, because there is then no direction to test.
     */
    signTestP:
      degrading + improving > 0
        ? +signTestP(degrading, degrading + improving).toFixed(4)
        : null,
    directionalP,
    medianChangeAcrossLadderMs: +medianOf(changes).toFixed(1),
  };
}

function medianOf(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * The verdict, with "not measured" kept distinct from "measured as flat".
 *
 * `isCoordinatorIndependent` collapsed those two, and that collapse is what
 * made a noisy ladder read as proof of the architecture's central claim. Here:
 *
 *   degrades      the interval excludes zero from above, or a two-sided sign
 *                 test establishes a positive direction at p < 0.05
 *   improves      the interval excludes zero from below, or a two-sided sign
 *                 test establishes a negative direction at p < 0.05
 *   insensitive   the interval sits wholly inside ±slopeThreshold, so an
 *                 effect worth caring about is positively ruled out. Tested
 *                 before the interval's sign, so a negligible-but-measurable
 *                 slope is reported as negligible rather than directional
 *   inconclusive  anything else — most often an interval wide enough to
 *                 contain both zero and a real effect
 *
 * "inconclusive" is a normal outcome at five seeds and must be reported as
 * itself. It is not evidence of flatness and must never be published as any.
 */
export function pairedVerdict(metric, { slopeThreshold = 0.1 } = {}) {
  return verdictWithBasis(metric, { slopeThreshold }).verdict;
}

/**
 * The verdict and the rule that produced it.
 *
 * The two rules do not carry equal weight and must not be reported as if they
 * did. An interval excluding zero is the stronger evidence. Directional
 * consistency can also establish an effect, but only when the exact two-sided
 * sign test is below 0.05. Five unanimous seeds are p = 0.0625 and therefore
 * remain inconclusive; six are p = 0.03125 and eight are p = 0.0078125.
 */
export function verdictWithBasis(metric, { slopeThreshold = 0.1 } = {}) {
  if (!metric || metric.seeds < 2 || !metric.ci95) {
    return { verdict: "inconclusive", basis: "too few seeds to fit an interval" };
  }
  const [lo, hi] = metric.ci95;
  // The negligibility band is tested first, before the sign of the interval.
  // An interval of [0.02, 0.08] excludes zero, but calling that "degrades"
  // reports a direction of no practical size — and, tested the other way
  // round, an arm measured tightly enough to prove it is flat could never
  // earn "insensitive", because a interval excluding zero by a hair would
  // always claim a direction first. That is precisely the arm this ladder
  // exists to characterise.
  if (lo >= -slopeThreshold && hi <= slopeThreshold) {
    return {
      verdict: "insensitive",
      basis: `interval lies wholly inside ±${slopeThreshold} ms/ms`,
    };
  }
  if (lo > 0) return { verdict: "degrades", basis: "95% interval excludes zero from above" };
  if (hi < 0) return { verdict: "improves", basis: "95% interval excludes zero from below" };
  // Direction is decided by which way the moving seeds moved, not by "not the
  // other side": with ties present, `seedsDegrading < seeds / 2` is true for an
  // arm where nothing moved at all.
  if (metric.signTestP !== null && metric.signTestP < 0.05) {
    if (metric.seedsDegrading > metric.seedsImproving) {
      return {
        verdict: "degrades",
        basis: `two-sided sign test establishes positive direction (p=${metric.signTestP}); interval still spans zero`,
      };
    }
    if (metric.seedsImproving > metric.seedsDegrading) {
      return {
        verdict: "improves",
        basis: `two-sided sign test establishes negative direction (p=${metric.signTestP}); interval still spans zero`,
      };
    }
  }
  return {
    verdict: "inconclusive",
    basis: "interval contains both zero and an effect worth caring about",
  };
}

/** Paired sensitivity for one arm, across the metrics the ladder reports. */
export function pairedSensitivity(series, options = {}) {
  const ttftP50 = pairedMetric(series, "ttftP50Ms");
  const ttftP95 = pairedMetric(series, "ttftP95Ms");
  const successRate = pairedMetric(series, "successRate");
  const admissionDecisionAdmitted = pairedMetric(series, "admissionDecisionAdmittedMs");
  const admissionDecisionRejected = pairedMetric(series, "admissionDecisionRejectedMs");
  const { verdict, basis } = verdictWithBasis(ttftP50, options);
  return {
    ttftP50,
    ttftP95,
    successRate,
    admissionDecisionAdmitted,
    admissionDecisionRejected,
    verdict,
    verdictBasis: basis,
    /**
     * The smallest slope this ladder could have ruled out, i.e. half the width
     * of the interval. Published so "insensitive" and "we could not tell" are
     * distinguishable by a reader, not only by this function.
     */
    resolutionMsPerMs:
      ttftP50?.ci95 ? +((ttftP50.ci95[1] - ttftP50.ci95[0]) / 2).toFixed(4) : null,
  };
}

/**
 * The head-to-head, paired by seed.
 *
 * `crossover` compares one arm's cross-seed median against the other's, so a
 * rung whose two medians come from different seeds compares different
 * workloads. Here the deficit is computed within each seed first, which is the
 * only comparison the trace pairing licenses.
 */
export function pairedCrossover(perRequestSeries, leaseSeries, metricKey = "ttftP50Ms") {
  const bySeed = new Map();
  for (const entry of perRequestSeries ?? []) bySeed.set(entry.seed, { perRequest: entry.rungs });
  for (const entry of leaseSeries ?? []) {
    const found = bySeed.get(entry.seed);
    if (found) found.lease = entry.rungs;
  }

  const rungs = new Set();
  for (const { perRequest, lease } of bySeed.values()) {
    if (!lease) continue;
    for (const r of perRequest) rungs.add(r.coordinatorLatencyMs);
  }

  const leads = [...rungs]
    .sort((a, b) => a - b)
    .map((latencyMs) => {
      const deficits = [];
      for (const { perRequest, lease } of bySeed.values()) {
        if (!lease) continue;
        const p = perRequest.find((r) => r.coordinatorLatencyMs === latencyMs)?.[metricKey];
        const l = lease.find((r) => r.coordinatorLatencyMs === latencyMs)?.[metricKey];
        if (Number.isFinite(p) && Number.isFinite(l)) deficits.push(l - p);
      }
      if (deficits.length === 0) return null;
      return {
        coordinatorLatencyMs: latencyMs,
        seeds: deficits.length,
        // Positive means the lease-based arm is slower on that seed.
        medianLeaseDeficitMs: +medianOf(deficits).toFixed(1),
        seedsWhereLeaseLeads: deficits.filter((d) => d < 0).length,
      };
    })
    .filter(Boolean);

  if (leads.length < 2) return null;
  const hasMajorityLead = (lead) => lead.seedsWhereLeaseLeads > lead.seeds / 2;
  const firstMajorityIndex = leads.findIndex(hasMajorityLead);
  const stableCrossingIndex = leads.findIndex(
    (lead, index) =>
      index < leads.length - 1 &&
      hasMajorityLead(lead) &&
      leads.slice(index).every(hasMajorityLead),
  );
  return {
    metric: metricKey,
    leads,
    /**
     * A crossing is a majority of *seeds* changing hands and keeping the lead
     * through at least one subsequent tested rung and every larger rung. A
     * majority first seen at the final rung is a lead, not proof of persistence.
     */
    firstMajorityLeadMs:
      firstMajorityIndex === -1 ? null : leads[firstMajorityIndex].coordinatorLatencyMs,
    crossesAtMs:
      stableCrossingIndex === -1 ? null : leads[stableCrossingIndex].coordinatorLatencyMs,
    observedCrossing: stableCrossingIndex !== -1,
    transientMajorityLeadRungsMs:
      stableCrossingIndex === -1
        ? leads.filter(hasMajorityLead).map((l) => l.coordinatorLatencyMs)
        : leads
            .slice(0, stableCrossingIndex)
            .filter(hasMajorityLead)
            .map((l) => l.coordinatorLatencyMs),
    narrowestMedianDeficitMs: Math.min(...leads.map((l) => l.medianLeaseDeficitMs)),
  };
}

/**
 * Reorder rungs so magnitude is not the same variable as run position.
 *
 * Smallest, largest, next smallest, next largest. Deterministic, so a ladder
 * stays reproducible from its arguments, unlike a shuffle.
 *
 * The problem it addresses: a ladder run in ascending order always measures
 * its largest rung last, so drift over the run — thermal, background load, a
 * warming cache — is collinear with the effect and cannot be separated from it
 * afterwards. This does not remove drift; it stops drift masquerading as a
 * slope.
 */
export function alternatingRungOrder(rungs) {
  const remaining = [...rungs].sort((a, b) => a - b);
  const ordered = [];
  while (remaining.length > 0) {
    ordered.push(remaining.shift());
    if (remaining.length > 0) ordered.push(remaining.pop());
  }
  return ordered;
}

/**
 * Spearman rank correlation between rung magnitude and run position.
 *
 * 1 means the ladder ran strictly ascending and drift is fully confounded with
 * the effect; 0 means position carries no information about magnitude.
 * Published with the report so the confound is a number a reader can see
 * rather than an assumption they have to make.
 */
export function orderConfounding(executionOrder) {
  const n = executionOrder.length;
  if (n < 2) return null;
  const sorted = [...executionOrder].sort((a, b) => a - b);
  const rankOf = new Map(sorted.map((value, index) => [value, index + 1]));
  const meanRank = (n + 1) / 2;
  let covariance = 0;
  let variance = 0;
  executionOrder.forEach((value, index) => {
    const positionDeviation = index + 1 - meanRank;
    covariance += positionDeviation * (rankOf.get(value) - meanRank);
    variance += positionDeviation ** 2;
  });
  return variance === 0 ? null : +(covariance / variance).toFixed(4);
}

/**
 * What an arm's admission-decision measurement actually is.
 *
 * Three different states currently collapse to a null average, and reading
 * them as one is the same mistake as reading a poor fit as proof of flatness:
 *
 *   measured               the arm consults a coordinator while admitting and
 *                          the decision was timed
 *   no-coordinator-calls   the arm was instrumented and made no coordinator
 *                          calls at all — a measured zero, not a missing one
 *   not-instrumented       this evidence artifact predates direct timing support,
 *                          or the selected runtime does not expose the metric.
 *                          Tyr >= 0.27.0 treats missing/zero timing as an error
 *                          before this classifier is reached
 *
 * The distinction matters because "not measured" printed as a dash next to
 * MoFlux reads as "MoFlux has no admission overhead", which is a claim this
 * ladder has not made.
 */
export const ADMISSION_DECISION_STATES = Object.freeze({
  measured: "measured",
  noCoordinatorCalls: "no-coordinator-calls",
  notInstrumented: "not-instrumented",
});

export function admissionDecisionStatus(samples) {
  if (samples === null || samples === undefined || !Number.isFinite(Number(samples))) {
    return ADMISSION_DECISION_STATES.notInstrumented;
  }
  return Number(samples) > 0
    ? ADMISSION_DECISION_STATES.measured
    : ADMISSION_DECISION_STATES.noCoordinatorCalls;
}

/** How the status should read in a table cell, where a bare dash is ambiguous. */
export function admissionDecisionLabel(status) {
  if (status === ADMISSION_DECISION_STATES.measured) return "measured";
  if (status === ADMISSION_DECISION_STATES.noCoordinatorCalls) return "none made";
  return "not measured";
}
