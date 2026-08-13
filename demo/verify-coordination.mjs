/**
 * verify-coordination.mjs — the coordinator-distance analysis is honest.
 *
 * The claims this protects are the ones most likely to be overstated, because
 * they favour the design being sold:
 *
 *   - "MoFlux is insensitive to coordinator distance" must be measured, not
 *     assumed from the architecture. A rising slope has to be reported as a
 *     rising slope.
 *   - "Redis loses beyond N milliseconds" must come from an observed crossing
 *     inside the tested ladder, never from extrapolating a fitted line past
 *     the last rung.
 *   - A slope fitted to noise must not be reported as a trend.
 *
 * Every fixture below has a known answer.
 *
 * Run: node demo/verify-coordination.mjs
 */
import {
  ADMISSION_DECISION_STATES,
  admissionDecisionLabel,
  admissionDecisionStatus,
  armSensitivity,
  crossover,
  isCoordinatorIndependent,
  linearFit,
  alternatingRungOrder,
  orderConfounding,
  pairedCrossover,
  pairedMetric,
  pairedSensitivity,
  seedSlopes,
  signTestP,
  studentTTail,
  verdictWithBasis,
} from "./coordination-lib.mjs";

const failures = [];
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`PASS  ${name}`);
  } else {
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
}

// Extends past 30ms deliberately: with the measured medians the two arms do
// not cross until roughly 36ms of coordinator distance, so a ladder stopping
// short of that could only ever report "no crossing observed".
const LADDER = [0, 1, 5, 15, 30, 50];

/** Per-request coordination: one round trip per attempt, on the critical path. */
function perRequestArm({ base = 880, attemptsPerRequest = 1.56, p95Base = 2790 } = {}) {
  return LADDER.map((ms) => ({
    coordinatorLatencyMs: ms,
    ttftP50Ms: +(base + ms * attemptsPerRequest).toFixed(1),
    ttftP95Ms: +(p95Base + ms * attemptsPerRequest * 2).toFixed(1),
    successRate: +(0.94 - ms * 0.0008).toFixed(4),
  }));
}

/** Lease-based: the coordinator is off the admission path entirely. */
function leaseArm({ base = 936, p95Base = 4730, jitter = 0 } = {}) {
  return LADDER.map((ms, index) => ({
    coordinatorLatencyMs: ms,
    ttftP50Ms: +(base + (index % 2 === 0 ? jitter : -jitter)).toFixed(1),
    ttftP95Ms: p95Base,
    successRate: 0.9654,
  }));
}

// ── the fit itself ───────────────────────────────────────────────────
{
  check("a clean line recovers its slope", linearFit([
    { x: 0, y: 100 }, { x: 10, y: 200 }, { x: 20, y: 300 },
  ]).slope === 10);
  check("a flat line has zero slope", linearFit([
    { x: 0, y: 50 }, { x: 10, y: 50 }, { x: 20, y: 50 },
  ]).slope === 0);
  check("a single point is not a trend", linearFit([{ x: 0, y: 1 }]) === null);
  check("points with no spread in x are not a trend", linearFit([
    { x: 5, y: 1 }, { x: 5, y: 9 },
  ]) === null);
  check("a perfect fit reports r2 of 1", linearFit([
    { x: 0, y: 0 }, { x: 1, y: 2 }, { x: 2, y: 4 },
  ]).r2 === 1);
  // Noise must be visible as a poor fit, or a meaningless slope reads as a
  // finding.
  const noisy = linearFit([{ x: 0, y: 10 }, { x: 10, y: 90 }, { x: 20, y: 15 }, { x: 30, y: 80 }]);
  check("scattered points report a poor fit", noisy.r2 < 0.5, String(noisy.r2));
  check("non-finite values are dropped, not coerced", linearFit([
    { x: 0, y: 10 }, { x: 10, y: 20 }, { x: 20, y: null },
  ]).n === 2);
}

// ── per-request coordination degrades with distance ──────────────────
{
  const s = armSensitivity(perRequestArm());
  check("the per-request arm's latency rises with distance", s.ttftP50.slope > 1);
  check("the slope approximates attempts per request", Math.abs(s.ttftP50.slope - 1.56) < 0.05,
    String(s.ttftP50.slope));
  check("the fit is strong for a genuinely linear cost", s.ttftP50.r2 > 0.99);
  check("it is not reported as coordinator-independent",
    isCoordinatorIndependent(s) === false);
  check("the absolute change across the ladder is reported", s.ttftP50ChangeMs > 40,
    String(s.ttftP50ChangeMs));
  check("the tested range is recorded", JSON.stringify(s.latencyRangeMs) === "[0,50]");
}

// ── lease-based coordination is flat ─────────────────────────────────
{
  const s = armSensitivity(leaseArm());
  check("the lease-based arm's latency does not track distance", Math.abs(s.ttftP50.slope) < 0.01);
  check("it is reported as coordinator-independent", isCoordinatorIndependent(s) === true);
  check("its success rate does not track distance either",
    Math.abs(s.successRate.slope) < 0.0001);

  // Small run-to-run jitter must not flip the verdict.
  const jittery = armSensitivity(leaseArm({ jitter: 25 }));
  check("modest jitter does not make a flat arm look sensitive",
    isCoordinatorIndependent(jittery) === true, String(jittery.ttftP50.slope));

  // But a genuinely rising lease arm must be reported, not excused. This is
  // the check that stops the architecture arguing on the data's behalf.
  const rising = LADDER.map((ms) => ({
    coordinatorLatencyMs: ms, ttftP50Ms: 900 + ms * 0.8, ttftP95Ms: 4000, successRate: 0.95,
  }));
  check("a lease arm that does track distance is not excused",
    isCoordinatorIndependent(armSensitivity(rising)) === false);

  // The noise allowance must not become a loophole: a strong linear trend has
  // to be reported even when some scatter rides on top of it.
  const risingNoisy = LADDER.map((ms, index) => ({
    coordinatorLatencyMs: ms,
    ttftP50Ms: 900 + ms * 0.8 + (index % 2 === 0 ? 12 : -12),
    ttftP95Ms: 4000,
    successRate: 0.95,
  }));
  const fit = armSensitivity(risingNoisy);
  check("a strong trend with scatter is still reported",
    isCoordinatorIndependent(fit) === false, `slope ${fit.ttftP50.slope}, r2 ${fit.ttftP50.r2}`);
}

// ── the crossover, and its limits ────────────────────────────────────
{
  // With this slope the lease arm first leads only at the final rung. That is
  // not enough to prove persistence because there is no subsequent rung.
  const finalOnly = crossover(perRequestArm(), leaseArm());
  check("the lease arm is behind at zero distance", finalOnly.leaseBehindAtZero === true);
  check("a final-rung lead is not promoted to a stable crossover",
    finalOnly.firstLeadMs === 50 && finalOnly.observedCrossing === false && finalOnly.crossesAtMs === null,
    JSON.stringify(finalOnly));
  check("the final-rung lead remains visible as transient evidence",
    finalOnly.transientLeadRungsMs.includes(50), JSON.stringify(finalOnly.transientLeadRungsMs));
  check("every rung's deficit is published", finalOnly.leads.length === LADDER.length);

  // A stronger synthetic effect crosses by 30ms and stays ahead at 50ms, so it
  // has the subsequent-rung confirmation required for a stable crossing.
  const c = crossover(perRequestArm({ attemptsPerRequest: 3 }), leaseArm());
  check("a persistent crossing inside the ladder is found", c.observedCrossing === true);
  check("the stable crossing is reported at a tested rung before the final rung",
    LADDER.includes(c.crossesAtMs) && c.crossesAtMs < 50, String(c.crossesAtMs));

  // A one-rung lead that disappears is not a crossover. This is the shape the
  // old implementation misreported when it simply took the first sign flip.
  const transientLease = LADDER.map((ms, index) => ({
    coordinatorLatencyMs: ms,
    ttftP50Ms: [1000, 850, 1000, 1000, 1000, 1000][index],
  }));
  const transientRequest = LADDER.map((ms) => ({ coordinatorLatencyMs: ms, ttftP50Ms: 900 }));
  const transient = crossover(transientRequest, transientLease);
  check("an isolated lead is recorded but not called a crossover",
    transient.firstLeadMs === 1 && transient.observedCrossing === false && transient.crossesAtMs === null,
    JSON.stringify(transient));
  check("transient lead rungs remain visible",
    transient.transientLeadRungsMs.join(",") === "1", transient.transientLeadRungsMs.join(","));

  // If the two never cross inside the range, no crossing may be claimed —
  // extrapolating one is exactly the overstatement this guards against.
  const farBehind = leaseArm({ base: 5000 });
  const never = crossover(perRequestArm(), farBehind);
  check("no crossing is invented beyond the tested range", never.observedCrossing === false);
  check("and no crossing latency is reported", never.crossesAtMs === null);
  check("the narrowest deficit is still published", never.narrowestDeficitMs > 0);

  // An arm that leads everywhere reports a crossing at the first rung.
  const alwaysAhead = leaseArm({ base: 100 });
  const ahead = crossover(perRequestArm(), alwaysAhead);
  check("an arm ahead throughout crosses at the first rung", ahead.crossesAtMs === 0);
  check("and is not reported as behind at zero", ahead.leaseBehindAtZero === false);

  check("a ladder with one usable rung yields no verdict",
    crossover([perRequestArm()[0]], [leaseArm()[0]]) === null);
}

// ── the statistics, against published values ─────────────────────────
{
  // Checked against standard t tables rather than against itself: a
  // hand-rolled distribution that is wrong makes every verdict below wrong in
  // a way no fixture built from the same code would reveal.
  const close = (a, b) => Math.abs(a - b) < 5e-5;
  check("t tail matches the 0.025 critical value at 4 df",
    close(studentTTail(2.776445, 4), 0.025), String(studentTTail(2.776445, 4)));
  check("t tail matches the 0.05 critical value at 4 df",
    close(studentTTail(2.131847, 4), 0.05), String(studentTTail(2.131847, 4)));
  check("t tail matches the 0.025 critical value at 10 df",
    close(studentTTail(2.228139, 10), 0.025), String(studentTTail(2.228139, 10)));
  check("t tail approaches the normal at large df",
    close(studentTTail(1.959964, 1e6), 0.025), String(studentTTail(1.959964, 1e6)));
  check("t tail is symmetric about zero", close(studentTTail(0, 4), 0.5));
  check("a negative t has a large positive-direction tail", studentTTail(-2.131847, 4) > 0.9,
    String(studentTTail(-2.131847, 4)));

  // The ceiling that governs how many seeds a ladder needs.
  check("five unanimous seeds cannot beat p=0.0625", signTestP(5, 5) === 0.0625);
  check("six unanimous seeds reach p=0.03125", signTestP(6, 6) === 0.03125);
  check("eight unanimous seeds reach p<0.01", signTestP(8, 8) < 0.01);
  check("a split result is not significant", signTestP(3, 5) === 1);
}

// ── the failure this version exists to fix ───────────────────────────
{
  /**
   * The measured Redis TTFT p50, seed by seed, from the 20260813T054929Z
   * ladder — the run whose report said every arm was coordinator-independent.
   *
   * This is the real matrix rather than a synthetic stand-in, because the
   * pathology is specific: the between-seed spread is 194-505ms against a
   * 132ms effect, so the cross-seed median lands on seed 2 at every rung
   * except 1ms, where it lands on seed 3. That single rank swap reads as an
   * outlier and drops r² to 0.0487. No fixture built from tidy offsets
   * reproduces it, which is exactly why tidy fixtures can pass while the
   * verdict is wrong on real data.
   */
  const MEASURED_REDIS_TTFT_P50 = {
    1: [878.5, 934.1, 843.2, 956.5, 958.5, 1032.2],
    2: [739.3, 931.7, 736.8, 765.0, 796.1, 858.0],
    3: [1093.5, 929.4, 987.3, 978.4, 968.4, 1287.3],
    4: [689.8, 824.8, 730.7, 633.8, 722.3, 822.0],
    5: [720.7, 740.5, 693.5, 665.7, 667.1, 781.9],
  };
  const measured = Object.entries(MEASURED_REDIS_TTFT_P50).map(([seed, values]) => ({
    seed: Number(seed),
    rungs: LADDER.map((ms, index) => ({
      coordinatorLatencyMs: ms,
      ttftP50Ms: values[index],
      ttftP95Ms: 2700,
      successRate: 0.95,
    })),
  }));

  // First, reproduce the bug, so this stays a regression test rather than a
  // claim about history.
  const asMedians = LADDER.map((ms, index) => {
    const values = Object.values(MEASURED_REDIS_TTFT_P50)
      .map((v) => v[index])
      .sort((a, b) => a - b);
    return { coordinatorLatencyMs: ms, ttftP50Ms: values[2], ttftP95Ms: 2700, successRate: 0.95 };
  });
  const unpaired = armSensitivity(asMedians);
  check("the cross-seed median destroys the fit", unpaired.ttftP50.r2 < 0.1,
    `r2 ${unpaired.ttftP50.r2}`);
  check("so the unpaired verdict calls a real coordination cost independent",
    isCoordinatorIndependent(unpaired) === true);

  // Then show the paired analysis recovers it from the same numbers.
  const paired = pairedSensitivity(measured);
  check("the paired analysis recovers a positive per-seed slope",
    paired.ttftP50.medianSlope > 1, String(paired.ttftP50.medianSlope));
  check("every seed is counted as degrading",
    paired.ttftP50.seedsDegrading === 5, `${paired.ttftP50.seedsDegrading}/5`);
  check("the pre-specified positive-direction t test clears 0.05", paired.ttftP50.directionalP < 0.05,
    String(paired.ttftP50.directionalP));
  check("but five same-direction seeds do not clear the two-sided sign test",
    paired.ttftP50.signTestP === 0.0625, String(paired.ttftP50.signTestP));
  check("so the five-seed measured arm remains inconclusive",
    paired.verdict === "inconclusive", paired.verdict);
  check("the basis does not overrule its own 0.05 threshold",
    /interval contains/.test(paired.verdictBasis), paired.verdictBasis);

  // The measured MoFlux arm from the same ladder must NOT come out as
  // degrading — a fix that simply reports everything as sensitive would pass
  // the check above and be just as useless.
  const MEASURED_MOFLUX_TTFT_P50 = {
    1: [1189.7, 1007.4, 954.8, 964.8, 1151.6, 832.0],
    2: [715.4, 788.0, 798.9, 783.7, 722.6, 797.1],
    3: [1430.5, 1569.6, 1074.4, 1322.3, 1295.6, 1298.1],
    4: [756.6, 779.5, 729.5, 731.6, 769.4, 725.5],
    5: [983.9, 817.0, 892.4, 931.1, 919.0, 1007.8],
  };
  const mofluxMeasured = Object.entries(MEASURED_MOFLUX_TTFT_P50).map(([seed, values]) => ({
    seed: Number(seed),
    rungs: LADDER.map((ms, index) => ({
      coordinatorLatencyMs: ms,
      ttftP50Ms: values[index],
      ttftP95Ms: 3600,
      successRate: 0.97,
    })),
  }));
  const mofluxPaired = pairedSensitivity(mofluxMeasured);
  check("the measured lease arm is not called degrading",
    mofluxPaired.verdict !== "degrades", mofluxPaired.verdict);
  check("nor is it called insensitive on five scattered seeds",
    mofluxPaired.verdict === "inconclusive",
    `${mofluxPaired.verdict}, CI ${JSON.stringify(mofluxPaired.ttftP50.ci95)}`);

  // A synthetic rising lease arm must still be reported, not excused — the
  // check that stops the architecture arguing on the data's behalf.
  const rising = [0.9, 1.4, 1.1, 2.2, 1.7].map((slope, index) => ({
    seed: index + 1,
    rungs: LADDER.map((ms) => ({
      coordinatorLatencyMs: ms,
      ttftP50Ms: 900 + ms * slope,
      ttftP95Ms: 3600,
      successRate: 0.97,
    })),
  }));
  check("a rising lease arm is reported, not excused",
    pairedSensitivity(rising).verdict === "degrades");
}

// ── "not measured" is not "measured as flat" ─────────────────────────
{
  // Five seeds with a wide spread of slopes cannot rule out an effect, and
  // saying "insensitive" there is the overstatement that sells the product on
  // an absence of evidence.
  const scattered = [-3.2, 0.3, -2.0, -0.4, 1.9].map((slope, index) => ({
    seed: index + 1,
    rungs: LADDER.map((ms) => ({
      coordinatorLatencyMs: ms,
      ttftP50Ms: 900 + ms * slope,
      ttftP95Ms: 3600,
      successRate: 0.97,
    })),
  }));
  const s = pairedSensitivity(scattered);
  check("a wide interval straddling zero is inconclusive, not insensitive",
    s.verdict === "inconclusive", `${s.verdict}, CI ${JSON.stringify(s.ttftP50.ci95)}`);
  check("the resolution the ladder achieved is published",
    s.resolutionMsPerMs > 1, String(s.resolutionMsPerMs));

  // Flatness must be demonstrable, not merely undisprovable: tight agreement
  // near zero does earn "insensitive".
  const tight = [0.01, -0.02, 0.0, 0.015, -0.005].map((slope, index) => ({
    seed: index + 1,
    rungs: LADDER.map((ms) => ({
      coordinatorLatencyMs: ms,
      ttftP50Ms: 900 + ms * slope,
      ttftP95Ms: 3600,
      successRate: 0.97,
    })),
  }));
  check("a tight interval around zero does earn insensitive",
    pairedSensitivity(tight).verdict === "insensitive");

  // Five unanimous but wide seeds are still not enough: the exact two-sided
  // sign test is p=0.0625, so the verdict must remain inconclusive.
  const unanimousFiveButWide = [0.2, 3.9, 0.1, 4.4, 0.15].map((slope, index) => ({
    seed: index + 1,
    rungs: LADDER.map((ms) => ({
      coordinatorLatencyMs: ms,
      ttftP50Ms: 900 + ms * slope,
      ttftP95Ms: 3600,
      successRate: 0.97,
    })),
  }));
  const five = verdictWithBasis(pairedMetric(unanimousFiveButWide, "ttftP50Ms"));
  check("five unanimous wide seeds remain inconclusive at two-sided p=0.0625",
    five.verdict === "inconclusive", `${five.verdict}: ${five.basis}`);

  // Six unanimous seeds do clear the predeclared non-parametric rule even if
  // one outlier leaves the t interval spanning zero.
  const unanimousSixButWide = [0.1, 0.1, 0.1, 0.1, 0.1, 10].map((slope, index) => ({
    seed: index + 1,
    rungs: LADDER.map((ms) => ({
      coordinatorLatencyMs: ms,
      ttftP50Ms: 900 + ms * slope,
      ttftP95Ms: 3600,
      successRate: 0.97,
    })),
  }));
  const sixMetric = pairedMetric(unanimousSixButWide, "ttftP50Ms");
  const six = verdictWithBasis(sixMetric);
  check("six unanimous wide seeds can establish direction by exact sign test",
    six.verdict === "degrades" && /sign test/.test(six.basis) && sixMetric.signTestP < 0.05,
    `${six.verdict}: ${six.basis}`);
}

// ── seeds are the replicate, and missing data is not silently folded ──
{
  const withGap = [
    { seed: 1, rungs: LADDER.map((ms) => ({ coordinatorLatencyMs: ms, ttftP50Ms: 900 + ms })) },
    { seed: 2, rungs: [{ coordinatorLatencyMs: 0, ttftP50Ms: 900 }] },
    { seed: 3, rungs: [] },
  ];
  const { fitted, dropped } = seedSlopes(withGap, "ttftP50Ms");
  check("a seed with one usable rung cannot contribute a slope", fitted.length === 1);
  check("dropped seeds are named, not silently omitted",
    dropped.length === 2 && dropped.includes(2) && dropped.includes(3), JSON.stringify(dropped));
}

// ── the head-to-head, paired ─────────────────────────────────────────
{
  // Redis leads on four of five seeds at zero distance and loses the majority
  // by the top of the ladder — the shape the measured ladder has.
  const build = (perSeedAtZero, slope) =>
    perSeedAtZero.map((base, index) => ({
      seed: index + 1,
      rungs: LADDER.map((ms) => ({ coordinatorLatencyMs: ms, ttftP50Ms: base + ms * slope })),
    }));
  const redis = build([880, 740, 1090, 690, 720], 12);
  const lease = build([1190, 715, 1430, 755, 985], 0);

  const c = pairedCrossover(redis, lease);
  check("the deficit is computed within each seed", c.leads[0].seeds === 5);
  check("the lease arm trails on most seeds at zero distance",
    c.leads[0].seedsWhereLeaseLeads < 3, String(c.leads[0].seedsWhereLeaseLeads));
  check("a crossing requires a persistent majority of seeds, not a median flip",
    c.observedCrossing === true && LADDER.includes(c.crossesAtMs), String(c.crossesAtMs));

  // A transient majority at one rung is visible but not promoted to a
  // crossover unless the majority persists at every larger tested rung.
  const transientLease = lease.map((entry) => ({
    seed: entry.seed,
    rungs: entry.rungs.map((r) => ({
      ...r,
      ttftP50Ms: r.coordinatorLatencyMs === 1 ? 100 : 5000,
    })),
  }));
  const transient = pairedCrossover(redis, transientLease);
  check("a transient paired majority is not a stable crossover",
    transient.firstMajorityLeadMs === 1 && transient.observedCrossing === false && transient.crossesAtMs === null,
    JSON.stringify(transient));
  check("transient paired lead rungs remain visible",
    transient.transientMajorityLeadRungsMs.join(",") === "1",
    transient.transientMajorityLeadRungsMs.join(","));

  // A lease arm that trails everywhere must not be reported as crossing.
  const farBehind = build([5000, 5000, 5000, 5000, 5000], 0);
  const never = pairedCrossover(redis, farBehind);
  check("no paired crossing is invented beyond the tested range",
    never.observedCrossing === false && never.crossesAtMs === null);
  check("the narrowest median deficit is still published",
    never.narrowestMedianDeficitMs > 0);
}

// ── rung order must not be the same variable as rung magnitude ───────
{
  // Ascending order is the default. Its
  // confounding is total: run position and coordinator distance are the same
  // ranking, so drift over a multi-hour ladder is inseparable from the effect.
  check("ascending order is fully confounded with magnitude",
    orderConfounding(LADDER) === 1, String(orderConfounding(LADDER)));

  const alternating = alternatingRungOrder(LADDER);
  check("alternating order takes from both ends",
    alternating.join(",") === "0,50,1,30,5,15", alternating.join(","));
  check("alternating order keeps every rung exactly once",
    [...alternating].sort((a, b) => a - b).join(",") === [...LADDER].sort((a, b) => a - b).join(","));
  check("alternating order substantially decorrelates position from magnitude",
    orderConfounding(alternating) < 0.4, String(orderConfounding(alternating)));

  // Deterministic, because a ladder has to be reproducible from its arguments;
  // a shuffle would decorrelate better and cost that.
  check("alternating order is deterministic",
    alternatingRungOrder(LADDER).join(",") === alternating.join(","));
  check("alternating order does not depend on the input being sorted",
    alternatingRungOrder([50, 0, 15, 1, 30, 5]).join(",") === alternating.join(","));

  check("a single rung yields no confounding figure", orderConfounding([5]) === null);

  /**
   * The measured motivation. On the 20260813T054929Z ladder the 1ms rung — run
   * second, ascending — sits above both its 0ms and 5ms neighbours in every
   * arm, including baseline and static-cap, which never receive the
   * coordinator flag. An apparent rung effect in arms not under the
   * manipulation is host state. Ascending order cannot separate the two, which
   * is the whole reason this option exists.
   */
  const NEIGHBOUR_EXCESS_AT_1MS = { redis: 73.2, moflux: 30.9, staticCap: 127.7, baseline: 547.7 };
  check("the artifact appears in arms that never receive the flag",
    NEIGHBOUR_EXCESS_AT_1MS.baseline > 0 && NEIGHBOUR_EXCESS_AT_1MS.staticCap > 0);
}

// ── ties carry no direction, and negligible is not directional ───────
{
  const arm = (slopes) =>
    slopes.map((slope, index) => ({
      seed: index + 1,
      rungs: LADDER.map((ms) => ({
        coordinatorLatencyMs: ms,
        ttftP50Ms: 900 + ms * slope,
        ttftP95Ms: 3600,
        successRate: 0.97,
      })),
    }));

  // A slope of exactly zero is neither degrading nor improving. Testing
  // direction as "not the other side" reads eight motionless seeds as eight
  // seeds agreeing on improvement — and at six or more seeds that clears the
  // sign test, so the arm the ladder most wants to characterise as flat gets a
  // directional verdict instead.
  const flat8 = pairedSensitivity(arm([0, 0, 0, 0, 0, 0, 0, 0]));
  check("eight motionless seeds are insensitive, not improving",
    flat8.verdict === "insensitive", flat8.verdict);
  check("ties are counted as ties",
    flat8.ttftP50.seedsTied === 8 &&
      flat8.ttftP50.seedsDegrading === 0 &&
      flat8.ttftP50.seedsImproving === 0);
  check("with nothing moving there is no sign test to report",
    flat8.ttftP50.signTestP === null, String(flat8.ttftP50.signTestP));
  check("six motionless seeds are insensitive too",
    pairedSensitivity(arm([0, 0, 0, 0, 0, 0])).verdict === "insensitive");

  // Ties are dropped rather than counted against the moving seeds: five seeds
  // rising and three motionless is a sign test on five, which cannot beat
  // 0.0625, not a sign test on eight.
  const withTies = pairedSensitivity(arm([2.8, 0.8, 4.5, 1.2, 0.7, 0, 0, 0]));
  check("the sign test drops ties rather than counting them",
    withTies.ttftP50.signTestP === 0.0625, String(withTies.ttftP50.signTestP));
  check("and five moving seeds out of eight remain inconclusive",
    withTies.verdict === "inconclusive", withTies.verdict);

  // Negligibility is tested before the interval's sign. Otherwise an arm
  // measured tightly enough to prove it is flat can never earn "insensitive":
  // an interval clearing zero by four thousandths of a millisecond per
  // millisecond would claim a direction first.
  const negligible = pairedSensitivity(
    arm([-0.004, -0.005, -0.003, -0.006, -0.004, -0.005, -0.004, -0.003]),
  );
  check("a negligible but measurable slope is reported as negligible",
    negligible.verdict === "insensitive", negligible.verdict);
  check("its interval does exclude zero, which is why ordering matters",
    negligible.ttftP50.ci95[1] < 0, JSON.stringify(negligible.ttftP50.ci95));

  // An effect worth caring about is still reported in both directions.
  check("a real rising effect is still reported",
    pairedSensitivity(arm([2.8, 0.8, 4.5, 1.2, 0.7, 1.9, 2.2, 1.1])).verdict === "degrades");
  check("a real falling effect is still reported",
    pairedSensitivity(arm([-2.8, -0.8, -4.5, -1.2, -0.7, -1.9, -2.2, -1.1])).verdict === "improves");

  // And the measured five-seed Redis arm stays inconclusive: unanimous
  // direction at two-sided p = 0.0625 is the most five seeds can produce and
  // is still short of 0.05.
  const measuredRedis = pairedSensitivity(arm([2.84, 0.83, 4.53, 1.18, 0.73]));
  check("five unanimous seeds do not license a verdict",
    measuredRedis.verdict === "inconclusive", measuredRedis.verdict);
  check("even though every seed agreed",
    measuredRedis.ttftP50.seedsDegrading === 5 && measuredRedis.ttftP50.signTestP === 0.0625);
}

// ── "not measured" is not "measured zero", here too ──────────────────
{
  // The direct admission-decision measurement only exists for arms that admit
  // in the local replica proxy, and only the Redis arm consults a coordinator
  // there. Three different states reach the report as a null average, and a
  // dash printed for all three lets an absent counter be read as evidence.
  check("an arm with timed decisions is measured",
    admissionDecisionStatus(1200) === ADMISSION_DECISION_STATES.measured);
  check("an instrumented arm that made no coordinator calls is a measured zero",
    admissionDecisionStatus(0) === ADMISSION_DECISION_STATES.noCoordinatorCalls);
  check("an arm nothing timed is not instrumented",
    admissionDecisionStatus(null) === ADMISSION_DECISION_STATES.notInstrumented);
  check("and an absent field is not silently a zero",
    admissionDecisionStatus(undefined) === ADMISSION_DECISION_STATES.notInstrumented);
  check("a non-numeric sample count does not pass as measured",
    admissionDecisionStatus(Number.NaN) === ADMISSION_DECISION_STATES.notInstrumented);

  // The MoFlux arm admits inside Tyr rather than the replica proxy, so it is
  // permanently in the not-instrumented state until Tyr exports an equivalent
  // counter. Its label must not read like a zero.
  check("the not-instrumented label does not read as a measurement",
    admissionDecisionLabel(ADMISSION_DECISION_STATES.notInstrumented) === "not measured");
  check("a measured zero is labelled distinctly from a missing one",
    admissionDecisionLabel(ADMISSION_DECISION_STATES.noCoordinatorCalls) !==
      admissionDecisionLabel(ADMISSION_DECISION_STATES.notInstrumented));
  check("every state has a label",
    Object.values(ADMISSION_DECISION_STATES).every(
      (state) => typeof admissionDecisionLabel(state) === "string" &&
        admissionDecisionLabel(state).length > 0,
    ));
}

console.log();
if (failures.length > 0) {
  console.log(`${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("All checks passed.");
