/**
 * Pure helpers for the licensed presenter seed sweep.
 *
 * Kept separate from the process orchestration so aggregation can be tested
 * without Docker or proprietary images.
 */

export function parseSeedSpec(spec) {
  const text = String(spec ?? "").trim();
  if (!text) throw new Error("seed specification must not be empty");

  const seeds = [];
  for (const token of text.split(",").map((part) => part.trim()).filter(Boolean)) {
    const range = /^(\d+)-(\d+)$/.exec(token);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start > end) throw new Error(`descending seed range is not supported: ${token}`);
      if (end - start > 99) throw new Error(`seed range is too large: ${token}`);
      for (let seed = start; seed <= end; seed += 1) seeds.push(seed);
      continue;
    }

    if (!/^\d+$/.test(token)) throw new Error(`invalid seed: ${token}`);
    seeds.push(Number(token));
  }

  const unique = [...new Set(seeds)];
  if (unique.length === 0) throw new Error("at least one seed is required");
  if (unique.some((seed) => !Number.isSafeInteger(seed) || seed < 0)) {
    throw new Error("seeds must be non-negative safe integers");
  }
  if (unique.length > 20) {
    throw new Error(`refusing to run ${unique.length} seeds; the maximum is 20`);
  }
  return unique;
}

export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function summarize(values) {
  const finite = values
    .filter((value) => value !== null && value !== undefined && value !== "")
    .map(Number)
    .filter(Number.isFinite);
  if (finite.length === 0) return null;
  return {
    n: finite.length,
    median: median(finite),
    min: Math.min(...finite),
    max: Math.max(...finite),
  };
}

function tailRatio(summary) {
  const latency = summary?.classes?.interactive?.latencyMs ?? {};
  return Number(latency.p50) > 0 ? Number(latency.p95) / Number(latency.p50) : 0;
}

function interactiveGoodput(summary) {
  const durationMs = Number(summary?.config?.durationMs ?? summary?.scenario?.workload?.durationMs ?? 0);
  return durationMs > 0
    ? Number(summary?.classes?.interactive?.success ?? 0) / (durationMs / 1000)
    : 0;
}

export function armMetrics(summary) {
  const interactive = summary.classes.interactive;
  const batch = summary.classes.batch;
  return {
    interactiveSuccessRate: interactive.successRate,
    interactiveGoodputRps: interactiveGoodput(summary),
    interactiveP50Ms: interactive.latencyMs.p50,
    interactiveP95Ms: interactive.latencyMs.p95,
    interactiveTailRatio: tailRatio(summary),
    interactiveTtftP50Ms: interactive.ttftMs.p50,
    interactiveTtftP95Ms: interactive.ttftMs.p95,
    interactiveRetryAmplification: interactive.retryAmplification,
    batchSuccessRate: batch.successRate,
    localRejects: interactive.localReject + batch.localReject,
    upstream429s: interactive.upstreamReject + batch.upstreamReject,
    peakActive: Number(summary.simCounters?.peakActive ?? 0),
  };
}

function aggregateMetricObjects(objects) {
  const keys = [...new Set(objects.flatMap((object) => Object.keys(object ?? {})))];
  return Object.fromEntries(
    keys.map((key) => [key, summarize(objects.map((object) => object?.[key]))]),
  );
}


function capacityPolicy(summary) {
  const capacity = summary?.capacity;
  if (!capacity) return null;
  return {
    policy: capacity.policy ?? null,
    batchFloorPercent: capacity.batchFloorPercent ?? null,
    batchConcurrencySlots: capacity.batchConcurrencySlots,
    interactiveConcurrencySlots: capacity.interactiveConcurrencySlots,
    batchConcurrencyPercent: capacity.batchConcurrencyPercent,
    batchTokenPercent: capacity.batchTokenPercent,
    envelope: capacity.envelope,
    tokenBudget: capacity.tokenBudget,
    pools: capacity.pools,
  };
}

function omitSeed(object) {
  if (!object || typeof object !== "object") return object;
  const { seed: _seed, ...rest } = object;
  return rest;
}

export function buildSweepSummary({ mode, fault, seeds, records }) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error("cannot aggregate an empty seed sweep");
  }
  if (records.length !== seeds.length) {
    throw new Error(`seed sweep expected ${seeds.length} records but received ${records.length}`);
  }
  for (let index = 0; index < seeds.length; index += 1) {
    if (records[index]?.seed !== seeds[index]) {
      throw new Error(`seed sweep record ${index + 1} does not match seed ${seeds[index]}`);
    }
  }

  const firstScenario = records.find((record) => record.scenario)?.scenario;
  if (firstScenario) {
    const expectedTemplate = JSON.stringify({
      workload: omitSeed(firstScenario.workload),
      provider: omitSeed(firstScenario.provider),
      routing: firstScenario.routing ?? null,
    });
    for (const record of records) {
      const actualTemplate = JSON.stringify({
        workload: omitSeed(record.scenario?.workload),
        provider: omitSeed(record.scenario?.provider),
        routing: record.scenario?.routing ?? null,
      });
      if (actualTemplate !== expectedTemplate) {
        throw new Error(`seed ${record.seed} changed a non-seed scenario setting`);
      }
    }
  }
  const capacityPolicies = records
    .map((record) => ({ seed: record.seed, policy: capacityPolicy(record.moflux) }))
    .filter((entry) => entry.policy !== null);
  const firstCapacityPolicy = capacityPolicies[0]?.policy ?? null;
  if (firstCapacityPolicy) {
    const expected = JSON.stringify(firstCapacityPolicy);
    for (const { seed, policy } of capacityPolicies) {
      if (JSON.stringify(policy) !== expected) {
        throw new Error(`seed ${seed} changed the MoFlux capacity policy`);
      }
    }
  }

  const baselineMetrics = records
    .filter((record) => record.baseline)
    .map((record) => armMetrics(record.baseline));
  const mofluxMetrics = records
    .filter((record) => record.moflux)
    .map((record) => armMetrics(record.moflux));
  const pairedMetrics = records
    .map((record) => record.comparison?.metrics)
    .filter(Boolean);
  const tokenMetrics = records
    .map((record) => record.moflux?.tokenAccounting)
    .filter(Boolean);

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    kind: mode === "compare" ? "paired-seed-sweep" : "seed-sweep",
    mode,
    fault: Boolean(fault),
    seeds,
    scenarioTemplate: firstScenario
      ? {
          workload: omitSeed(firstScenario.workload),
          provider: omitSeed(firstScenario.provider),
          routing: firstScenario.routing ?? null,
        }
      : null,
    capacityPolicy: firstCapacityPolicy,
    runs: records.map((record) => ({
      seed: record.seed,
      scenario: record.scenario,
      arms: record.arms,
      metrics: record.comparison?.metrics ?? null,
      tokenAccounting: record.moflux?.tokenAccounting ?? null,
    })),
    aggregate: {
      arms: {
        baseline: baselineMetrics.length > 0 ? aggregateMetricObjects(baselineMetrics) : null,
        moflux: mofluxMetrics.length > 0 ? aggregateMetricObjects(mofluxMetrics) : null,
      },
      paired: pairedMetrics.length > 0 ? aggregateMetricObjects(pairedMetrics) : null,
      tokenAccounting: tokenMetrics.length > 0 ? aggregateMetricObjects(tokenMetrics) : null,
    },
  };
}
