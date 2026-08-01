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
  armSensitivity,
  crossover,
  isCoordinatorIndependent,
  linearFit,
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
  // Measured reality: the lease arm starts behind on TTFT p50 (936 vs 880).
  const c = crossover(perRequestArm(), leaseArm());
  check("the lease arm is behind at zero distance", c.leaseBehindAtZero === true);
  check("a crossing inside the ladder is found", c.observedCrossing === true);
  check("the crossing is reported at a tested rung",
    LADDER.includes(c.crossesAtMs), String(c.crossesAtMs));
  check("every rung's deficit is published", c.leads.length === LADDER.length);

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

console.log();
if (failures.length > 0) {
  console.log(`${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("All checks passed.");
