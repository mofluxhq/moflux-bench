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

/**
 * Per-arm summary of whether the token budget ever bound.
 *
 * Reported as counts and the number of seeds on which it fired, rather than a
 * bare boolean, so a single seed exercising it is not mistaken for the
 * benchmark exercising it throughout.
 */
function tokenAwarenessByArm(records, controlArmKeys) {
  const armsOf = (record) => ({
    baseline: record.baseline,
    ...Object.fromEntries(controlArmKeys.map((key) => [key, record.controlArms?.[key]])),
    moflux: record.moflux,
  });
  const names = [...new Set(records.flatMap((record) => Object.keys(armsOf(record))))];
  return Object.fromEntries(
    names.map((name) => {
      const perSeed = records
        .map((record) => armsOf(record)[name]?.classes?.interactive?.bindingConstraint)
        .filter(Boolean);
      if (perSeed.length === 0) return [name, null];
      const budget = perSeed.reduce((total, b) => total + (b.budgetLimited ?? 0), 0);
      const seedsExercised = perSeed.filter((b) => (b.budgetLimited ?? 0) > 0).length;
      return [
        name,
        {
          seeds: perSeed.length,
          seedsExercised,
          totalBudgetLimitedRejects: budget,
          exercisedTokenAwareness: seedsExercised > 0,
          /** True only when every seed exercised it, not merely one. */
          exercisedOnEverySeed: seedsExercised === perSeed.length,
        },
      ];
    }),
  );
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
    batchAdmissionGapMs: summary.classes.batch?.admissionGapMs ?? null,
    coordinatorLatencyMs: summary.coordinatorLatencyMs ?? 0,
    // Which limit actually refused work. Without these in the aggregate, a
    // reader has to open five per-seed files to learn whether the token budget
    // decided anything — and a comparison between a token-aware arm and a
    // concurrency-only one is uninterpretable until they do.
    budgetLimitedRejects: interactive.bindingConstraint?.budgetLimited ?? null,
    concurrencyLimitedRejects: interactive.bindingConstraint?.concurrencyLimited ?? null,
    tokenBoundShare: interactive.bindingConstraint?.tokenBoundShare ?? null,
    // The realised workload, so a claimed size distribution can be checked
    // against what the arm was actually offered.
    requestSizeP50: interactive.requestSizes?.p50 ?? null,
    requestSizeP95: interactive.requestSizes?.p95 ?? null,
    requestSizeSpread: interactive.requestSizes?.spread ?? null,
    borrowedSlots: summary.lending?.idleWindow?.borrowedSlots ?? null,
    occupancyLendingObserved: summary.lending?.idleWindow?.borrowed ?? null,
    controllerLendingObserved: summary.lending?.controlPlane?.lendingObserved ?? null,
    floorRestored: summary.lending?.controlPlane?.floorRestored ?? null,
    floorRestorationDurationMs: summary.lending?.controlPlane?.restorationDurationMs ?? null,
    batchFloorAdmissionGapMs: summary.lending?.floorReassertion?.admissionGapMs ?? null,
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
    capacityGroup: capacity.capacityGroup ?? null,
    demandPolicy: capacity.demandPolicy ?? null,
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

  // Every control arm present on every seed. An arm that appears on only some
  // seeds is dropped rather than aggregated across an inconsistent set, which
  // would silently compare different sample sizes.
  const controlArmKeys = [
    ...new Set(records.flatMap((record) => Object.keys(record.controlArms ?? {}))),
  ].filter((key) => records.every((record) => record.controlArms?.[key]));

  const controlArmAggregates = Object.fromEntries(
    controlArmKeys.map((key) => [
      key,
      aggregateMetricObjects(records.map((record) => armMetrics(record.controlArms[key]))),
    ]),
  );

  // MoFlux against each alternative, paired per seed then medianed — the
  // comparison that decides whether MoFlux is worth deploying over a policy
  // someone could write themselves.
  const headToHead = Object.fromEntries(
    controlArmKeys.map((key) => [
      key,
      aggregateMetricObjects(
        records
          .map((record) => record.armComparisons?.mofluxVersus?.[key])
          .filter(Boolean),
      ),
    ]),
  );

  const versusBaseline = Object.fromEntries(
    [...controlArmKeys, "moflux"].map((key) => [
      key,
      aggregateMetricObjects(
        records
          .map((record) => record.armComparisons?.versusBaseline?.[key])
          .filter(Boolean),
      ),
    ]),
  );

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
  const progressiveConfigurations = tokenMetrics
    .map((metrics) => metrics.progressiveConfiguration);
  const progressiveConfiguration = progressiveConfigurations[0] ?? null;
  if (progressiveConfiguration) {
    if (progressiveConfigurations.some((configuration) => !configuration)) {
      throw new Error("seed sweep omitted the progressive reconciliation policy on one or more seeds");
    }
    const expected = JSON.stringify(progressiveConfiguration);
    for (const configuration of progressiveConfigurations) {
      if (JSON.stringify(configuration) !== expected) {
        throw new Error("seed sweep changed the progressive reconciliation policy");
      }
    }
  }
  const numericTokenMetrics = tokenMetrics.map(({ progressiveConfiguration: _configuration, ...metrics }) => metrics);

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
      lending: record.moflux?.lending ?? null,
    })),
    controlArms: controlArmKeys,
    /**
     * Did each arm's token budget refuse anything?
     *
     * `false` means the arm never made an admission decision a plain
     * concurrency counter could not have made, so nothing in its comparison is
     * attributable to token-aware admission — whatever the configuration says.
     * Read this before any MoFlux-versus-concurrency claim.
     */
    tokenAwareness: tokenAwarenessByArm(records, controlArmKeys),
    aggregate: {
      arms: {
        baseline: baselineMetrics.length > 0 ? aggregateMetricObjects(baselineMetrics) : null,
        ...controlArmAggregates,
        moflux: mofluxMetrics.length > 0 ? aggregateMetricObjects(mofluxMetrics) : null,
      },
      paired: pairedMetrics.length > 0 ? aggregateMetricObjects(pairedMetrics) : null,
      // Each policy against no control. Answers "does this help at all".
      versusBaseline: controlArmKeys.length > 0 ? versusBaseline : null,
      // MoFlux against each alternative. Answers "is this worth deploying".
      mofluxVersus: controlArmKeys.length > 0 ? headToHead : null,
      tokenAccounting: numericTokenMetrics.length > 0
        ? {
            ...aggregateMetricObjects(numericTokenMetrics),
            progressiveConfiguration,
          }
        : null,
      lending: mofluxMetrics.some((metrics) => metrics.controllerLendingObserved !== null)
        ? {
            borrowedSlots: summarize(mofluxMetrics.map((metrics) => metrics.borrowedSlots)),
            occupancyObservedSeeds: mofluxMetrics.filter((metrics) => metrics.occupancyLendingObserved === true).length,
            controllerObservedSeeds: mofluxMetrics.filter((metrics) => metrics.controllerLendingObserved === true).length,
            floorRestoredSeeds: mofluxMetrics.filter((metrics) => metrics.floorRestored === true).length,
            floorRestorationDurationMs: summarize(
              mofluxMetrics.map((metrics) => metrics.floorRestorationDurationMs),
            ),
            batchFloorAdmissionGapMs: summarize(
              mofluxMetrics.map((metrics) => metrics.batchFloorAdmissionGapMs),
            ),
          }
        : null,
    },
  };
}
