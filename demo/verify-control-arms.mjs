/**
 * verify-control-arms.mjs — the sweep aggregates arms 2 and 4 correctly.
 *
 * Why this matters more than it looks: the published comparison used to be
 * MoFlux against no admission control, which is a comparison nobody is
 * actually choosing between. The decision a reader faces is MoFlux against a
 * static per-replica cap or a Redis token bucket — policies they could write
 * themselves. If those arms aggregate wrongly, or silently vanish from the
 * summary, the sweep goes back to answering the easy question while appearing
 * to answer the hard one.
 *
 * Pure aggregation only; no Docker, no licensed image.
 *
 * Run: node demo/verify-control-arms.mjs
 */
import { buildSweepSummary } from "./seed-sweep-lib.mjs";

const failures = [];
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`PASS  ${name}`);
  } else {
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
}

const SEEDS = [1, 2, 3];

function scenario(seed) {
  return {
    id: `scenario-${seed}`,
    workload: { seed, durationMs: 45000, interactiveRps: 6, batchStartMs: 27000 },
    provider: { seed, envelope: 32, sigma: 0.25 },
    routing: { interactiveReplicas: ["a", "b", "c", "d"], batchReplicas: ["d"] },
    trace: { version: 1, hash: `hash-${seed}`, planned: { interactive: 270, batch: 60, total: 330 } },
  };
}

/** One arm's result file, with only the fields the aggregation reads. */
function arm({ seed, successRate, goodputSuccess, p95, ttftP95, batchRate, upstream429, peakActive, admissionGapMs = null, budgetLimited = 0 }) {
  return {
    generatorSaturated: 0,
    wallClockMs: 46000,
    scenario: scenario(seed),
    classes: {
      interactive: {
        logical: 270,
        attempts: Math.round(270 * 1.5),
        success: goodputSuccess,
        successRate,
        retryAmplification: 1.5,
        localReject: 40,
        upstreamReject: upstream429,
        latencyMs: { p50: p95 / 2, p95 },
        ttftMs: { p50: ttftP95 / 3, p95: ttftP95 },
        bindingConstraint: {
          budgetLimited,
          concurrencyLimited: 40 - budgetLimited,
          tokenBoundShare: +(budgetLimited / 40).toFixed(4),
          exercisedTokenAwareness: budgetLimited > 0,
        },
        requestSizes: { n: 270, min: 150, p50: 1215, p95: 3828, max: 4800, spread: 32 },
      },
      batch: {
        logical: 60,
        success: Math.round(60 * batchRate),
        successRate: batchRate,
        localReject: 20,
        upstreamReject: 0,
        latencyMs: { p50: 8000, p95: 15000 },
        ttftMs: { p50: 6000, p95: 9000 },
        admissionGapMs,
      },
    },
    simCounters: { peakActive, rejected429: upstream429 },
  };
}

function record(seed) {
  const baseline = arm({
    seed, successRate: 0.65, goodputSuccess: 176, p95: 14900, ttftP95: 7300,
    batchRate: 0.45, upstream429: 650, peakActive: 32,
  });
  const staticCap = arm({
    seed, successRate: 0.9, goodputSuccess: 243, p95: 12000, ttftP95: 8500,
    batchRate: 0.9, upstream429: 0, peakActive: 24, admissionGapMs: 200,
    budgetLimited: 0, // a semaphore has no token budget to refuse against
  });
  const redis = arm({
    seed, successRate: 0.95, goodputSuccess: 257, p95: 8000, ttftP95: 3000,
    batchRate: 0.11, upstream429: 0, peakActive: 32, admissionGapMs: 400,
    budgetLimited: 12,
  });
  const moflux = arm({
    seed, successRate: 0.944, goodputSuccess: 254, p95: 9200, ttftP95: 2800,
    batchRate: 0.027, upstream429: 0, peakActive: 32, admissionGapMs: 300,
    budgetLimited: 15,
  });
  const delta = (ref, cand) => ({
    interactiveSuccessPercentagePointChange: +(
      (cand.classes.interactive.successRate - ref.classes.interactive.successRate) * 100
    ).toFixed(2),
    interactiveP95LatencyChangePercent: +(
      ((cand.classes.interactive.latencyMs.p95 / ref.classes.interactive.latencyMs.p95) - 1) * 100
    ).toFixed(2),
    interactiveTtftP95ChangePercent: +(
      ((cand.classes.interactive.ttftMs.p95 / ref.classes.interactive.ttftMs.p95) - 1) * 100
    ).toFixed(2),
    batchSuccessPercentagePointChange: +(
      (cand.classes.batch.successRate - ref.classes.batch.successRate) * 100
    ).toFixed(2),
  });
  return {
    seed,
    baseline,
    moflux,
    scenario: scenario(seed),
    arms: {},
    controlArms: { staticCap, redis },
    comparison: { scenario: scenario(seed), metrics: delta(baseline, moflux) },
    armComparisons: {
      versusBaseline: {
        staticCap: delta(baseline, staticCap),
        redis: delta(baseline, redis),
        moflux: delta(baseline, moflux),
      },
      mofluxVersus: {
        staticCap: delta(staticCap, moflux),
        redis: delta(redis, moflux),
      },
    },
  };
}

const records = SEEDS.map(record);
const summary = buildSweepSummary({ mode: "compare", fault: false, seeds: SEEDS, records });

// ── the arms survive aggregation ─────────────────────────────────────
check("control arms are listed on the summary", 
  JSON.stringify(summary.controlArms) === JSON.stringify(["staticCap", "redis"]),
  JSON.stringify(summary.controlArms));
check("static cap is aggregated", Boolean(summary.aggregate.arms.staticCap));
check("redis is aggregated", Boolean(summary.aggregate.arms.redis));
check("baseline and MoFlux still aggregate", 
  Boolean(summary.aggregate.arms.baseline) && Boolean(summary.aggregate.arms.moflux));

// ── the numbers are the arm's own, not another arm's ─────────────────
check("static cap keeps its own batch rate",
  summary.aggregate.arms.staticCap.batchSuccessRate.median === 0.9,
  String(summary.aggregate.arms.staticCap.batchSuccessRate.median));
check("redis keeps its own TTFT",
  summary.aggregate.arms.redis.interactiveTtftP95Ms.median === 3000);
check("MoFlux keeps its own peak occupancy",
  summary.aggregate.arms.moflux.peakActive.median === 32);
check("the static cap's lower occupancy is preserved",
  summary.aggregate.arms.staticCap.peakActive.median === 24);
check("batch response-header gap aggregates for the lending benchmark",
  summary.aggregate.arms.moflux.batchResponseHeadersGapMs.median === 300);

// ── head-to-head, which is the point of the exercise ─────────────────
const versusStatic = summary.aggregate.mofluxVersus.staticCap;
const versusRedis = summary.aggregate.mofluxVersus.redis;
check("MoFlux is compared against the static cap", Boolean(versusStatic));
check("MoFlux is compared against Redis", Boolean(versusRedis));
check("a TTFT win against the static cap is reported as a win",
  versusStatic.interactiveTtftP95ChangePercent.median < 0,
  String(versusStatic.interactiveTtftP95ChangePercent.median));
check("a p95 loss against Redis is reported as a loss",
  versusRedis.interactiveP95LatencyChangePercent.median > 0,
  String(versusRedis.interactiveP95LatencyChangePercent.median));
check("the batch cost against the static cap is not hidden",
  versusStatic.batchSuccessPercentagePointChange.median < -80,
  String(versusStatic.batchSuccessPercentagePointChange.median));

// ── every arm against no control ─────────────────────────────────────
check("versusBaseline covers all three policies",
  ["staticCap", "redis", "moflux"].every((key) => Boolean(summary.aggregate.versusBaseline[key])));
check("the static cap also beats no control on success",
  summary.aggregate.versusBaseline.staticCap.interactiveSuccessPercentagePointChange.median > 0);

// ── an arm missing on one seed is dropped, not half-aggregated ───────
{
  const partial = SEEDS.map((seed) => {
    const base = record(seed);
    if (seed === 2) delete base.controlArms.redis;
    return base;
  });
  const partialSummary = buildSweepSummary({ mode: "compare", fault: false, seeds: SEEDS, records: partial });
  check("an arm absent from one seed is not aggregated",
    !partialSummary.aggregate.arms.redis,
    JSON.stringify(partialSummary.controlArms));
  check("the arm present on every seed still aggregates",
    Boolean(partialSummary.aggregate.arms.staticCap));
}

// ── backward compatibility: no control arms means no new sections ────
{
  const plain = SEEDS.map((seed) => {
    const base = record(seed);
    base.controlArms = {};
    base.armComparisons = null;
    return base;
  });
  const plainSummary = buildSweepSummary({ mode: "compare", fault: false, seeds: SEEDS, records: plain });
  check("a two-arm sweep still aggregates as before",
    Boolean(plainSummary.aggregate.arms.baseline) && Boolean(plainSummary.aggregate.arms.moflux));
  check("no control arms means no head-to-head section",
    plainSummary.aggregate.mofluxVersus === null);
  check("the paired baseline comparison is untouched",
    Boolean(plainSummary.aggregate.paired));
}

// ── the binding constraint reaches the aggregate ─────────────────────
{
  // The gap this closes: bindingConstraint and requestSizes were recorded in
  // every per-seed arm file but never aggregated, so answering "did the token
  // budget decide anything" meant opening five files by hand — and until it is
  // answered, a token-aware arm cannot be meaningfully compared with a
  // concurrency-only one.
  const moflux = summary.aggregate.arms.moflux;
  check("budget-limited rejects are aggregated", moflux.budgetLimitedRejects?.median === 15);
  check("concurrency-limited rejects are aggregated", moflux.concurrencyLimitedRejects?.median === 25);
  check("the token-bound share is aggregated", moflux.tokenBoundShare?.median === 0.375);
  check("realised request sizes are aggregated",
    moflux.requestSizeP50?.median === 1215 && moflux.requestSizeSpread?.median === 32);

  const awareness = summary.tokenAwareness;
  check("a token-aware arm is reported as exercised",
    awareness.moflux.exercisedTokenAwareness === true);
  check("its per-seed coverage is reported, not just a boolean",
    awareness.moflux.seedsExercised === 3 && awareness.moflux.seeds === 3);
  check("exercised-on-every-seed is distinguished from exercised-once",
    awareness.moflux.exercisedOnEverySeed === true);
  check("a concurrency-only arm is reported as not exercised",
    awareness.staticCap.exercisedTokenAwareness === false);
  check("the control arm's total is zero, not null",
    awareness.staticCap.totalBudgetLimitedRejects === 0);
  check("Redis is also reported as token-aware", awareness.redis.exercisedTokenAwareness === true);

  // A single seed exercising the budget must not read as the sweep doing so.
  const mostlySilent = SEEDS.map((seed) => {
    const base = record(seed);
    if (seed !== 1) {
      base.moflux.classes.interactive.bindingConstraint = {
        budgetLimited: 0, concurrencyLimited: 40, tokenBoundShare: 0, exercisedTokenAwareness: false,
      };
    }
    return base;
  });
  const partial = buildSweepSummary({ mode: "compare", fault: false, seeds: SEEDS, records: mostlySilent });
  check("one seed exercising the budget is not reported as every seed",
    partial.tokenAwareness.moflux.exercisedTokenAwareness === true &&
      partial.tokenAwareness.moflux.exercisedOnEverySeed === false,
    JSON.stringify(partial.tokenAwareness.moflux));
}

console.log();
if (failures.length > 0) {
  console.log(`${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("All checks passed.");
