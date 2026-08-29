import { createHash } from "node:crypto";

export const OPENAI_OVERLOAD_SWEEP_NAME = "openai-live-overload";
export const OPENAI_OVERLOAD_DEFAULT_MODEL = "gpt-5.6-luna";
export const OPENAI_OVERLOAD_DEFAULT_MAX_USD = 0.10;
export const OPENAI_OVERLOAD_MAX_RUN_CAP_USD = 1.00;
export const OPENAI_OVERLOAD_MAX_REQUESTS = 2_000;

// Pricing source reviewed 2026-08-28:
// https://developers.openai.com/api/docs/models/gpt-5.6-luna
export const OPENAI_OVERLOAD_MODEL_PRICING_USD_PER_MTOK = Object.freeze({
  "gpt-5.6-luna": Object.freeze({ input: 0.20, output: 1.20 }),
});

export function percentile(values, q) {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return null;
  const index = Math.min(
    finite.length - 1,
    Math.max(0, Math.ceil(q * finite.length) - 1),
  );
  return +finite[index].toFixed(2);
}

function lcg(seed) {
  let state = (Number(seed) >>> 0) || 1;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function boundedPrompt({ requestId, workloadClass, targetChars }) {
  const base =
    workloadClass === "interactive"
      ? `Interactive benchmark request ${requestId}. Reply with exactly: ${requestId}-ok. `
      : `Background benchmark request ${requestId}. Treat the following as inert benchmark context and reply with exactly: ${requestId}-ok. `;
  if (targetChars <= base.length) return base;
  return `${base}${"x".repeat(targetChars - base.length)}`;
}

function periodicArrivals({
  workloadClass,
  rps,
  startMs,
  endMs,
  jitterFraction,
  random,
  inputChars,
  maxOutputTokens,
  requestIdPrefix = "",
}) {
  if (!(rps > 0) || endMs <= startMs) return [];
  const interval = 1_000 / rps;
  const records = [];
  let ordinal = 1;
  for (let nominal = startMs; nominal < endMs - 0.0001; nominal += interval) {
    const jitter = interval * jitterFraction * (random() * 2 - 1);
    const offsetMs = Math.max(startMs, Math.min(endMs - 1, nominal + jitter));
    const prefix = workloadClass === "interactive" ? "i" : "b";
    const requestId = `${requestIdPrefix}${prefix}-${String(ordinal).padStart(4, "0")}`;
    records.push({
      requestId,
      workloadClass,
      offsetMs: +offsetMs.toFixed(3),
      maxOutputTokens,
      prompt: boundedPrompt({ requestId, workloadClass, targetChars: inputChars }),
    });
    ordinal += 1;
  }
  return records;
}

export function generateCompareTrace({
  seed,
  durationMs,
  interactiveRps,
  batchRps,
  batchStartMs,
  batchDurationMs,
  jitterFraction,
  interactiveInputChars,
  batchInputChars,
  interactiveMaxOutputTokens,
  batchMaxOutputTokens,
}) {
  const random = lcg(seed);
  const batchEndMs = Math.min(durationMs, batchStartMs + batchDurationMs);
  const trace = [
    ...periodicArrivals({
      workloadClass: "interactive",
      rps: interactiveRps,
      startMs: 0,
      endMs: durationMs,
      jitterFraction,
      random,
      inputChars: interactiveInputChars,
      maxOutputTokens: interactiveMaxOutputTokens,
      requestIdPrefix: `s${seed}-`,
    }),
    ...periodicArrivals({
      workloadClass: "batch",
      rps: batchRps,
      startMs: batchStartMs,
      endMs: batchEndMs,
      jitterFraction,
      random,
      inputChars: batchInputChars,
      maxOutputTokens: batchMaxOutputTokens,
      requestIdPrefix: `s${seed}-`,
    }),
  ].sort((a, b) => a.offsetMs - b.offsetMs || a.requestId.localeCompare(b.requestId));

  const fingerprint = createHash("sha256")
    .update(JSON.stringify(trace))
    .digest("hex");
  return { trace, fingerprint };
}

export function conservativeCallCostUsd({ prompt, maxOutputTokens, pricing }) {
  const conservativeInputTokens = Buffer.byteLength(prompt, "utf8") + 256;
  return (
    (conservativeInputTokens * pricing.input) / 1_000_000 +
    (maxOutputTokens * pricing.output) / 1_000_000
  );
}

export function conservativeTraceCostUsd({ trace, armCount, runs, pricing }) {
  const oneArm = trace.reduce(
    (sum, request) =>
      sum +
      conservativeCallCostUsd({
        prompt: request.prompt,
        maxOutputTokens: request.maxOutputTokens,
        pricing,
      }),
    0,
  );
  return oneArm * armCount * runs;
}

export function renderTyrOverloadConfig({
  modelPrefix,
  maxConcurrent,
  interactiveFloor,
  batchFloor,
  maxOutputTokens,
  jwksPort,
  issuer,
  audience,
}) {
  return `version: 1

server:
  port: 8787
  maxRequestBodyBytes: 1048576
  maxOutputTokens: ${maxOutputTokens}

upstreams:
  openai:
    baseUrl: https://api.openai.com

timeouts:
  responseHeadersMs: 90000
  streamIdleMs: 90000
  clientStallMs: 90000

shutdown:
  drainTimeoutMs: 30000

identity:
  jwt:
    jwksUrl: http://host.docker.internal:${jwksPort}/jwks
    issuer: ${JSON.stringify(issuer)}
    audience: ${JSON.stringify(audience)}
    header: x-tyr-identity-token
    algorithms: [RS256]
    cacheTtlMs: 300000
    requestTimeoutMs: 3000
    clockSkewSeconds: 5
    requireExpiration: true
    claims:
      applicationId: azp
      roles: roles
  roles:
    invoke: [tyr.invoke]

telemetry:
  metrics:
    enabled: true
  audit:
    enabled: false

pools:
  - name: openai-overload
    modelPrefixes: [${JSON.stringify(modelPrefix)}]
    estimatorModel: gpt-4o
    maxConcurrent: ${maxConcurrent}
    maxQueue: 0
    admissionMode: enforce
    defaultOutputReservation: ${maxOutputTokens}
    adaptiveEstimation:
      enabled: false
    admissionClasses:
      defaultClass: batch
      classes:
        interactive:
          protectedConcurrent: ${interactiveFloor}
          maxConcurrent: ${maxConcurrent}
        batch:
          protectedConcurrent: ${batchFloor}
          maxConcurrent: ${maxConcurrent}
      rules:
        - admissionClass: interactive
          applicationIds: [interactive]
        - admissionClass: batch
          applicationIds: [batch]
`;
}

function measuredCost(records) {
  const costs = records.map((record) => record.actualCostUsd).filter(Number.isFinite);
  return costs.length === 0 ? 0 : +costs.reduce((sum, value) => sum + value, 0).toFixed(8);
}

export function summarizeRecords(records, elapsedMs) {
  const success = records.filter((record) => record.ok);
  const localRejects = records.filter((record) => record.rejectionOrigin === "static_local" || record.rejectionOrigin === "moflux_local");
  const provider429s = records.filter((record) => record.rejectionOrigin === "provider_429");
  const provider5xx = records.filter((record) => record.failureOrigin === "provider" && Number(record.status) >= 500).length;
  const providerOtherFailures = records.filter((record) => record.failureOrigin === "provider" && Number(record.status) < 500).length;
  const gatewayFailures = records.filter((record) => record.failureOrigin === "moflux_gateway");
  const transportFailures = records.filter((record) => record.failureOrigin === "transport");
  const providerAttempts = records.filter((record) => record.providerAttempted === true).length;
  return {
    offered: records.length,
    providerAttempts,
    success: success.length,
    failures: records.length - success.length,
    successRate: records.length === 0 ? 0 : +(success.length / records.length).toFixed(4),
    localRejects: localRejects.length,
    provider429s: provider429s.length,
    provider5xx,
    providerOtherFailures,
    gatewayFailures: gatewayFailures.length,
    transportFailures: transportFailures.length,
    ttftMs: {
      p50: percentile(success.map((record) => record.ttftMs), 0.5),
      p95: percentile(success.map((record) => record.ttftMs), 0.95),
    },
    latencyMs: {
      p50: percentile(success.map((record) => record.latencyMs), 0.5),
      p95: percentile(success.map((record) => record.latencyMs), 0.95),
    },
    goodputRps:
      elapsedMs > 0 ? +(success.length / (elapsedMs / 1_000)).toFixed(4) : 0,
    promptTokens: success.reduce((sum, record) => sum + (Number(record.promptTokens) || 0), 0),
    completionTokens: success.reduce((sum, record) => sum + (Number(record.completionTokens) || 0), 0),
    measuredSuccessfulUsageCostUsd: measuredCost(success),
  };
}

export function summarizeArm(records, elapsedMs) {
  const overall = summarizeRecords(records, elapsedMs);
  const classes = {};
  for (const workloadClass of ["interactive", "batch"]) {
    classes[workloadClass] = summarizeRecords(
      records.filter((record) => record.workloadClass === workloadClass),
      elapsedMs,
    );
  }
  return { ...overall, classes };
}

export const OPENAI_OVERLOAD_MULTI_SWEEP_NAME = "openai-live-overload-sweep";
export const OPENAI_OVERLOAD_MULTI_SWEEP_MAX_SEEDS = 8;
export const OPENAI_OVERLOAD_MULTI_SWEEP_DEFAULT_MAX_USD = 1.50;
export const OPENAI_OVERLOAD_MULTI_SWEEP_MAX_USD = 5.00;
export const OPENAI_OVERLOAD_COUNTERBALANCED_ARM_ORDERS = Object.freeze([
  Object.freeze(["direct", "static", "moflux"]),
  Object.freeze(["static", "moflux", "direct"]),
  Object.freeze(["moflux", "direct", "static"]),
  Object.freeze(["direct", "moflux", "static"]),
  Object.freeze(["static", "direct", "moflux"]),
  Object.freeze(["moflux", "static", "direct"]),
]);

export function counterbalancedArmOrderForSeed(seed) {
  if (!Number.isSafeInteger(seed) || seed < 1) {
    throw new Error("counterbalanced arm order requires a positive integer seed");
  }
  return [...OPENAI_OVERLOAD_COUNTERBALANCED_ARM_ORDERS[(seed - 1) % OPENAI_OVERLOAD_COUNTERBALANCED_ARM_ORDERS.length]];
}

function median(values) {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return null;
  const middle = Math.floor(finite.length / 2);
  const value = finite.length % 2 === 1
    ? finite[middle]
    : (finite[middle - 1] + finite[middle]) / 2;
  return +value.toFixed(4);
}

function spread(values) {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return { samples: 0, median: null, min: null, max: null };
  return {
    samples: finite.length,
    median: median(finite),
    min: +Math.min(...finite).toFixed(4),
    max: +Math.max(...finite).toFixed(4),
  };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function compareWorkloadIdentity(summary) {
  const workload = summary?.workload ?? {};
  return {
    durationMs: workload.durationMs,
    interactiveRps: workload.interactiveRps,
    batchRps: workload.batchRps,
    batchStartMs: workload.batchStartMs,
    batchDurationMs: workload.batchDurationMs,
    jitterFraction: workload.jitterFraction,
    interactiveInputChars: workload.interactiveInputChars,
    batchInputChars: workload.batchInputChars,
    interactiveMaxOutputTokens: workload.interactiveMaxOutputTokens,
    batchMaxOutputTokens: workload.batchMaxOutputTokens,
    retryPolicy: workload.retryPolicy,
  };
}

function summaryArms(summary) {
  return Object.keys(summary?.aggregate ?? {});
}

function sameArmSet(left, right) {
  return sameJson([...left].sort(), [...right].sort());
}

function summaryArmOrder(summary) {
  const aggregateArms = summaryArms(summary);
  const declared = summary?.runs?.[0]?.armOrder;
  const order = Array.isArray(declared) && declared.length > 0
    ? [...declared]
    : Object.keys(summary?.runs?.[0]?.arms ?? {});
  if (order.length !== aggregateArms.length || new Set(order).size !== order.length || !sameArmSet(order, aggregateArms)) {
    throw new Error(`seed ${summary?.workload?.seed ?? "?"} armOrder does not match aggregate arm set`);
  }
  return order;
}

function armPositionSummary(summaries, arms) {
  const positionCounts = Object.fromEntries(arms.map((arm) => [arm, Array(arms.length).fill(0)]));
  const schedule = summaries
    .map((summary) => ({ seed: summary.workload.seed, armOrder: summaryArmOrder(summary) }))
    .sort((left, right) => left.seed - right.seed);
  for (const entry of schedule) {
    entry.armOrder.forEach((arm, index) => { positionCounts[arm][index] += 1; });
  }
  const allArmsSeenInEveryPosition = arms.every((arm) => positionCounts[arm].every((count) => count > 0));
  const positionCountSpreadWithinOne = arms.every((arm) => {
    const counts = positionCounts[arm];
    return Math.max(...counts) - Math.min(...counts) <= 1;
  });
  return {
    strategy: "six-permutation-by-seed",
    cycleLength: OPENAI_OVERLOAD_COUNTERBALANCED_ARM_ORDERS.length,
    schedule,
    positionCounts,
    allArmsSeenInEveryPosition,
    positionCountSpreadWithinOne,
    counterbalanced: allArmsSeenInEveryPosition && positionCountSpreadWithinOne,
  };
}

function requireSingleCompareSummary(summary, index) {
  const label = `summary[${index}]`;
  if (!summary || typeof summary !== "object") throw new Error(`${label} must be an object`);
  if (summary.mode !== "compare") throw new Error(`${label} must have mode=compare`);
  if (summary.benchmark !== OPENAI_OVERLOAD_SWEEP_NAME) {
    throw new Error(`${label} must have benchmark=${OPENAI_OVERLOAD_SWEEP_NAME}`);
  }
  if (summary.workload?.runs !== 1) throw new Error(`${label} must contain exactly one compare run`);
  if (!Number.isSafeInteger(summary.workload?.seed) || summary.workload.seed < 1) {
    throw new Error(`${label} must contain a positive integer workload.seed`);
  }
  if (!Array.isArray(summary.runs) || summary.runs.length !== 1) {
    throw new Error(`${label} must contain exactly one detailed run`);
  }
  if (summary.runs[0]?.seed !== summary.workload.seed) {
    throw new Error(`${label} detailed run seed does not match workload.seed`);
  }
  if (summary.acceptance?.executionCompleted !== true) {
    throw new Error(`${label} did not complete execution`);
  }
  if (summary.acceptance?.matchedTraceByRun !== true) {
    throw new Error(`${label} did not preserve a matched trace across arms`);
  }
  if (summary.interpretation?.conclusiveProviderOverloadComparison !== true) {
    throw new Error(`${label} is not a conclusive provider-overload comparison`);
  }
  if (summary.interpretation?.rateLimitIsolationPassed !== true) {
    throw new Error(`${label} did not pass rate-limit isolation`);
  }
  const arms = summaryArms(summary);
  if (arms.length === 0) throw new Error(`${label} has no aggregate arms`);
  for (const arm of arms) {
    if (!summary.runs[0]?.arms?.[arm] || !Array.isArray(summary.runs[0].arms[arm].records)) {
      throw new Error(`${label} is missing raw records for arm ${arm}`);
    }
  }
}

export function aggregateOpenAiOverloadCompareSummaries(summaries, { sourceFiles = [] } = {}) {
  if (!Array.isArray(summaries) || summaries.length === 0) {
    throw new Error("at least one compare summary is required");
  }
  summaries.forEach(requireSingleCompareSummary);

  const first = summaries[0];
  const workloadIdentity = compareWorkloadIdentity(first);
  const arms = summaryArms(first);
  const runtime = first.runtime;
  const policies = first.policies;
  const rateLimitTargetRatio = first.rateLimitIsolation?.targetRatio;

  for (let index = 1; index < summaries.length; index += 1) {
    const summary = summaries[index];
    if (!sameJson(compareWorkloadIdentity(summary), workloadIdentity)) {
      throw new Error(`summary[${index}] workload configuration differs from summary[0]`);
    }
    if (!sameJson(summary.runtime, runtime)) {
      throw new Error(`summary[${index}] runtime differs from summary[0]`);
    }
    if (!sameJson(summary.policies, policies)) {
      throw new Error(`summary[${index}] policies differ from summary[0]`);
    }
    if (!sameArmSet(summaryArms(summary), arms)) {
      throw new Error(`summary[${index}] arm set differs from summary[0]`);
    }
    if (summary.rateLimitIsolation?.targetRatio !== rateLimitTargetRatio) {
      throw new Error(`summary[${index}] rate-limit start target differs from summary[0]`);
    }
  }

  const seeds = summaries.map((summary) => summary.workload.seed);
  if (new Set(seeds).size !== seeds.length) throw new Error("compare sweep contains duplicate seeds");

  const aggregate = {};
  for (const arm of arms) {
    const records = summaries.flatMap((summary) => summary.runs[0].arms[arm].records);
    const elapsedMs = summaries.reduce(
      (sum, summary) => sum + Number(summary.runs[0].arms[arm].elapsedMs ?? 0),
      0,
    );
    aggregate[arm] = summarizeArm(records, elapsedMs);
  }

  const pairedSeedResults = summaries
    .map((summary) => {
      const direct = summary.aggregate.direct ?? null;
      const staticArm = summary.aggregate.static ?? null;
      const moflux = summary.aggregate.moflux ?? null;
      const staticInteractive = staticArm?.classes?.interactive ?? null;
      const mofluxInteractive = moflux?.classes?.interactive ?? null;
      const staticBatch = staticArm?.classes?.batch ?? null;
      const mofluxBatch = moflux?.classes?.batch ?? null;
      const armOrder = summaryArmOrder(summary);
      return {
        seed: summary.workload.seed,
        traceFingerprint: summary.workload.traceFingerprints?.[0] ?? summary.runs[0].fingerprint ?? null,
        armOrder,
        armPositions: Object.fromEntries(armOrder.map((arm, index) => [arm, index + 1])),
        conclusive: summary.interpretation.conclusiveProviderOverloadComparison === true,
        directProvider429s: direct?.provider429s ?? null,
        staticProvider429s: staticArm?.provider429s ?? null,
        mofluxProvider429s: moflux?.provider429s ?? null,
        directInteractiveSuccessRate: direct?.classes?.interactive?.successRate ?? null,
        staticInteractiveSuccessRate: staticInteractive?.successRate ?? null,
        mofluxInteractiveSuccessRate: mofluxInteractive?.successRate ?? null,
        staticBatchSuccessRate: staticBatch?.successRate ?? null,
        mofluxBatchSuccessRate: mofluxBatch?.successRate ?? null,
        interactiveSuccessAdvantagePp:
          staticInteractive && mofluxInteractive
            ? +((mofluxInteractive.successRate - staticInteractive.successRate) * 100).toFixed(4)
            : null,
        batchSuccessDeltaPp:
          staticBatch && mofluxBatch
            ? +((mofluxBatch.successRate - staticBatch.successRate) * 100).toFixed(4)
            : null,
        overallSuccessDeltaPp:
          staticArm && moflux
            ? +((moflux.successRate - staticArm.successRate) * 100).toFixed(4)
            : null,
        interactiveTtftP95DeltaMs:
          Number.isFinite(mofluxInteractive?.ttftMs?.p95) && Number.isFinite(staticInteractive?.ttftMs?.p95)
            ? +(mofluxInteractive.ttftMs.p95 - staticInteractive.ttftMs.p95).toFixed(2)
            : null,
        interactiveLatencyP95DeltaMs:
          Number.isFinite(mofluxInteractive?.latencyMs?.p95) && Number.isFinite(staticInteractive?.latencyMs?.p95)
            ? +(mofluxInteractive.latencyMs.p95 - staticInteractive.latencyMs.p95).toFixed(2)
            : null,
      };
    })
    .sort((left, right) => left.seed - right.seed);

  const allConclusive = summaries.every(
    (summary) => summary.interpretation.conclusiveProviderOverloadComparison === true,
  );
  const allRateLimitIsolationPassed = summaries.every(
    (summary) => summary.interpretation.rateLimitIsolationPassed === true,
  );
  const directPressureEverySeed = summaries.every(
    (summary) => summary.interpretation.directProviderPressureObserved === true,
  );
  const localAdmissionContentionEverySeed = summaries.every(
    (summary) => summary.interpretation.localAdmissionContentionObserved === true,
  );
  const mofluxAdmissionClassProofEverySeed = summaries.every(
    (summary) => summary.interpretation.mofluxAdmissionClassProof === true,
  );
  const controlledProvider429FreeEverySeed = summaries.every((summary) =>
    (summary.aggregate.static?.provider429s ?? 0) === 0 &&
    (summary.aggregate.moflux?.provider429s ?? 0) === 0,
  );
  const mofluxInteractiveAdvantageEverySeed = pairedSeedResults.every(
    (entry) => Number.isFinite(entry.interactiveSuccessAdvantagePp) && entry.interactiveSuccessAdvantagePp > 0,
  );

  const armOrdering = armPositionSummary(summaries, arms);

  const recoveryGates = summaries.flatMap((summary) =>
    (summary.rateLimitIsolation?.gates ?? []).map((gate) => ({
      seed: summary.workload.seed,
      ...gate,
    })),
  );

  const total = (selector) => +summaries.reduce((sum, summary) => sum + Number(selector(summary) ?? 0), 0).toFixed(8);
  const sourceEntries = summaries
    .map((summary, index) => ({
      seed: summary.workload.seed,
      file: sourceFiles[index] ?? null,
      traceFingerprint: summary.workload.traceFingerprints?.[0] ?? null,
    }))
    .sort((left, right) => left.seed - right.seed);

  return {
    schemaVersion: 1,
    benchmark: OPENAI_OVERLOAD_MULTI_SWEEP_NAME,
    generatedAt: new Date().toISOString(),
    mode: "sweep",
    purpose:
      "Sequential matched real-OpenAI overload comparisons aggregated across independently guarded, rate-limit-isolated seeds. Each seed replays one immutable trace through direct OpenAI, an undifferentiated static cap, and Tyr protected admission classes.",
    runtime,
    workload: {
      ...workloadIdentity,
      seedCount: seeds.length,
      seeds: [...seeds].sort((a, b) => a - b),
      traceFingerprints: sourceEntries.map(({ seed, traceFingerprint }) => ({ seed, traceFingerprint })),
    },
    policies,
    experimentalDesign: {
      armOrdering,
    },
    budget: {
      seedCount: summaries.length,
      perSeedHardRunCapUsd: first.budget?.hardRunCapUsd ?? null,
      totalPlannedRequests: total((summary) => summary.budget?.plannedRequests),
      totalWorkloadRequests: total((summary) => summary.budget?.workloadRequests),
      totalRecoveryProbeBudget: total((summary) => summary.budget?.recoveryProbeBudget),
      totalWorstCaseUsd: total((summary) => summary.budget?.worstCaseUsd),
      measuredSuccessfulUsageCostUsd: total((summary) => summary.budget?.measuredSuccessfulUsageCostUsd),
      pricingUsdPerMillionTokens: first.budget?.pricingUsdPerMillionTokens ?? null,
      note:
        "Every seed was admitted through the original per-invocation request and spend guards before execution. Totals here are aggregate reporting, not a replacement for the per-seed guards.",
    },
    rateLimitIsolation: {
      targetRatio: rateLimitTargetRatio,
      passed: allRateLimitIsolationPassed,
      expectedGates: summaries.reduce((sum, summary) => sum + Number(summary.rateLimitIsolation?.expectedGates ?? 0), 0),
      gates: recoveryGates,
    },
    aggregate,
    pairedSeedResults,
    pairedSummary: {
      interactiveSuccessAdvantagePp: spread(pairedSeedResults.map((entry) => entry.interactiveSuccessAdvantagePp)),
      batchSuccessDeltaPp: spread(pairedSeedResults.map((entry) => entry.batchSuccessDeltaPp)),
      overallSuccessDeltaPp: spread(pairedSeedResults.map((entry) => entry.overallSuccessDeltaPp)),
      interactiveTtftP95DeltaMs: spread(pairedSeedResults.map((entry) => entry.interactiveTtftP95DeltaMs)),
      interactiveLatencyP95DeltaMs: spread(pairedSeedResults.map((entry) => entry.interactiveLatencyP95DeltaMs)),
    },
    validation: {
      allConclusive,
      allRateLimitIsolationPassed,
      directPressureEverySeed,
      localAdmissionContentionEverySeed,
      mofluxAdmissionClassProofEverySeed,
      controlledProvider429FreeEverySeed,
      mofluxInteractiveAdvantageEverySeed,
      counterbalancedArmOrdering: armOrdering.counterbalanced,
      sameWorkloadRuntimePolicies: true,
    },
    interpretation: {
      conclusiveProviderOverloadSweep:
        allConclusive && allRateLimitIsolationPassed && directPressureEverySeed &&
        localAdmissionContentionEverySeed && mofluxAdmissionClassProofEverySeed &&
        armOrdering.counterbalanced,
      warning:
        "Publish workload-priority claims from paired seed behavior and pooled logical outcomes only when the sweep is counterbalanced. The sweep does not exercise Latchflo fleet coordination or Tyr in-flight token-budget admission.",
    },
    seeds: summaries
      .map((summary) => ({
        seed: summary.workload.seed,
        generatedAt: summary.generatedAt,
        traceFingerprint: summary.workload.traceFingerprints?.[0] ?? null,
        armOrder: summaryArmOrder(summary),
        aggregate: summary.aggregate,
        interpretation: summary.interpretation,
        acceptance: summary.acceptance,
      }))
      .sort((left, right) => left.seed - right.seed),
    sources: sourceEntries,
  };
}
