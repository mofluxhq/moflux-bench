/**
 * Pure configuration, telemetry parsing, and proof helpers for the GPU-backed
 * vLLM contention experiment. Nothing in this module starts Docker or touches
 * evidence, which keeps its decisions fixture-testable without a GPU.
 */

import { buildRestorationContract, validateUnlentSlice } from "./restoration-contract-lib.mjs";

export const VLLM_SWEEP_NAME = "vllm-contention";
export const VLLM_METAL_SWEEP_NAME = "vllm-metal-contention";
export const VLLM_ENDPOINT = "/v1/chat/completions";
export const VLLM_PORT = 18000;
export const VLLM_LATCHFLO_PORT = 18086;
export const VLLM_IDENTITY_PORT = 9012;
export const VLLM_MAX_NUM_SEQS = 4;
export const VLLM_PUBLICATION_SEED_COUNT = 5;
export const VLLM_WARMUP_REQUESTS_PER_CLASS = 5;
export const VLLM_METAL_RUNTIME_PROBE_PREFIX = "MOFLUX_VLLM_METAL_RUNTIME_JSON=";

export const VLLM_ARMS = Object.freeze([
  Object.freeze({
    id: "vllm-fcfs",
    managed: false,
    lending: false,
    pool: null,
    port: VLLM_PORT,
    schedulingPolicy: "fcfs",
    requestPriorities: false,
    summary: "direct vLLM with its default first-come-first-served scheduler",
  }),
  Object.freeze({
    id: "vllm-priority",
    managed: false,
    lending: false,
    pool: null,
    port: VLLM_PORT,
    schedulingPolicy: "priority",
    requestPriorities: true,
    summary: "direct vLLM priority scheduling; interactive=0 and batch=10",
  }),
  Object.freeze({
    id: "static",
    managed: true,
    lending: false,
    pool: "vllm-static",
    port: 18125,
    schedulingPolicy: "priority",
    requestPriorities: true,
    summary: "fixed 3/1 protected admission partition in front of vLLM priority scheduling",
  }),
  Object.freeze({
    id: "moflux",
    managed: true,
    lending: true,
    pool: "vllm-moflux",
    port: 18126,
    schedulingPolicy: "priority",
    requestPriorities: true,
    summary: "the same 3/1 partition, with two idle interactive slots lendable and restored",
  }),
]);
export const VLLM_ARM_IDS = Object.freeze(VLLM_ARMS.map(({ id }) => id));

export function vllmArm(id) {
  const arm = VLLM_ARMS.find((candidate) => candidate.id === id);
  if (!arm) throw new Error(`unknown vLLM contention arm ${JSON.stringify(id)}`);
  return arm;
}

/**
 * Backend-specific fields for a fixed-output OpenAI request.
 *
 * vLLM Metal 0.29.0 rejects `min_tokens` because that sampling control depends
 * on a logits processor the plugin does not implement. With no explicit stop
 * sequence, `ignore_eos` still makes `max_tokens` the terminal bound. CUDA vLLM
 * keeps the stronger, redundant `min_tokens=max_tokens` spelling.
 */
export function vllmFixedOutputFields(backend, maxTokens) {
  if (!["nvidia", "metal"].includes(backend)) {
    throw new Error(`unknown vLLM backend ${JSON.stringify(backend)}`);
  }
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw new Error("fixed-output maxTokens must be a positive integer");
  }
  return Object.freeze({
    ignore_eos: true,
    ...(backend === "nvidia" ? { min_tokens: maxTokens } : {}),
  });
}

/** Bind a local vLLM API key to its option in one argv token.
 *
 * A base64url secret may begin with `-`. Passing that value as the token after
 * `--api-key` lets argparse reinterpret it as another option and report that
 * `--api-key` has no argument. The equals form is unambiguous for every key.
 */
export function vllmApiKeyArgument(apiKey) {
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new Error("vLLM API key must be a non-empty string");
  }
  return `--api-key=${apiKey}`;
}

/**
 * Extract the machine-readable record from a native Python probe. Importing
 * vLLM can write informational log lines to stdout, so the whole stream is not
 * itself a JSON document.
 */
export function parseMetalRuntimeProbeOutput(output) {
  const text = String(output ?? "");
  const firstMarker = text.indexOf(VLLM_METAL_RUNTIME_PROBE_PREFIX);
  if (firstMarker < 0) {
    throw new Error("native vLLM runtime probe did not emit its marked JSON record");
  }
  if (firstMarker !== text.lastIndexOf(VLLM_METAL_RUNTIME_PROBE_PREFIX)) {
    throw new Error("native vLLM runtime probe emitted more than one marked JSON record");
  }
  const payload = text
    .slice(firstMarker + VLLM_METAL_RUNTIME_PROBE_PREFIX.length)
    .split(/\r?\n/u, 1)[0]
    .trim();
  try {
    const parsed = JSON.parse(payload);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError("record must be a JSON object");
    }
    return Object.freeze(parsed);
  } catch (error) {
    throw new Error(`native vLLM runtime probe emitted invalid marked JSON: ${error.message}`);
  }
}

/**
 * Decode-heavy CUDA workload. Rates intentionally exceed a four-sequence
 * 1.5B model on common single GPUs; the validity gate still requires observed
 * queueing, so a faster GPU produces an inconclusive result rather than a
 * fabricated contention result.
 */
export const VLLM_NVIDIA_WORKLOAD = Object.freeze({
  profile: "nvidia-decode-heavy-v1",
  durationMs: 105_000,
  interactiveRps: 1,
  interactiveStartMs: 0,
  interactiveDurationMs: 25_000,
  interactiveInputChars: 400,
  interactiveMaxTokens: 128,
  batchStartMs: 25_000,
  batchDurationMs: 60_000,
  batchRps: 6,
  batchInputChars: 1_600,
  batchMaxTokens: 768,
  interactiveResumeStartMs: 60_000,
  interactiveResumeDurationMs: 25_000,
  interactiveResumeRps: 4,
  maxAttempts: 1,
  backoffBaseMs: 500,
  sizeDistribution: "uniform",
  interactiveSizeSigma: 0,
  batchSizeSigma: 0,
  inFlightCeiling: 3_000,
  windowMs: 105_000,
  temperature: 0,
  drainIdleMs: 90_000,
  drainMaxMs: 180_000,
  interactivePriority: 0,
  batchPriority: 10,
  forceOutputLength: true,
});

/**
 * Apple-Silicon workload for the same mechanism question, not the same raw
 * throughput envelope. Replaying the CUDA trace on an M1 made one 768-token
 * batch request run for roughly three minutes, built queues above 400, and
 * starved the evidence collectors. Shorter fixed generations retain direct-arm
 * queueing and the 3/1 borrow/restoration transition while keeping the trace
 * within the service envelope of the slowest supported Apple-Silicon host.
 * Metal and CUDA remain separate corpora and are never compared numerically.
 */
export const VLLM_METAL_WORKLOAD = Object.freeze({
  profile: "metal-balanced-v1",
  durationMs: 105_000,
  interactiveRps: 0.25,
  interactiveStartMs: 0,
  interactiveDurationMs: 25_000,
  interactiveInputChars: 400,
  interactiveMaxTokens: 16,
  batchStartMs: 25_000,
  batchDurationMs: 60_000,
  batchRps: 0.75,
  batchInputChars: 800,
  batchMaxTokens: 32,
  interactiveResumeStartMs: 60_000,
  interactiveResumeDurationMs: 25_000,
  interactiveResumeRps: 0.5,
  maxAttempts: 1,
  backoffBaseMs: 500,
  sizeDistribution: "uniform",
  interactiveSizeSigma: 0,
  batchSizeSigma: 0,
  inFlightCeiling: 256,
  windowMs: 105_000,
  temperature: 0,
  drainIdleMs: 90_000,
  drainMaxMs: 180_000,
  interactivePriority: 0,
  batchPriority: 10,
  forceOutputLength: true,
});

/** Backward-compatible name for the canonical CUDA profile. */
export const VLLM_WORKLOAD = VLLM_NVIDIA_WORKLOAD;

export function vllmWorkloadForBackend(backend) {
  if (backend === "nvidia") return VLLM_NVIDIA_WORKLOAD;
  if (backend === "metal") return VLLM_METAL_WORKLOAD;
  throw new Error(`unknown vLLM workload backend ${JSON.stringify(backend)}`);
}

const VLLM_NVIDIA_SAMPLING = Object.freeze({
  vllmIntervalMs: 250,
  vllmTimeoutMs: 3_000,
  managedIntervalMs: 250,
  managedTimeoutMs: 3_000,
  platformIntervalMs: 1_000,
  platformTimeoutMs: 5_000,
});

const VLLM_METAL_SAMPLING = Object.freeze({
  vllmIntervalMs: 1_000,
  vllmTimeoutMs: 8_000,
  managedIntervalMs: 1_000,
  managedTimeoutMs: 8_000,
  platformIntervalMs: 5_000,
  platformTimeoutMs: 15_000,
});

export function vllmSamplingForBackend(backend) {
  if (backend === "nvidia") return VLLM_NVIDIA_SAMPLING;
  if (backend === "metal") return VLLM_METAL_SAMPLING;
  throw new Error(`unknown vLLM sampling backend ${JSON.stringify(backend)}`);
}

const VLLM_PROTECTED_TOKEN_FLOORS = Object.freeze({
  interactive: 49_152,
  batch: 16_384,
});

function makeVllmPolicy(tokenBudget) {
  if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 65_536) {
    throw new Error("vLLM token budget must preserve the registered 65,536-token floors");
  }
  return Object.freeze({
    physical: Object.freeze({
      maxConcurrent: VLLM_MAX_NUM_SEQS,
      tokenBudget,
      minimumGrantMaxConcurrent: 1,
      minimumGrantTokenBudget: 4_096,
    }),
    classes: Object.freeze({
      interactive: Object.freeze({
        globalProtectedConcurrent: 3,
        globalMaxConcurrent: 4,
        globalProtectedInFlightTokens: VLLM_PROTECTED_TOKEN_FLOORS.interactive,
        globalMaxInFlightTokens: tokenBudget,
      }),
      batch: Object.freeze({
        globalProtectedConcurrent: 1,
        globalMaxConcurrent: 4,
        globalProtectedInFlightTokens: VLLM_PROTECTED_TOKEN_FLOORS.batch,
        globalMaxInFlightTokens: tokenBudget,
      }),
    }),
    unlentProtectedConcurrent: Object.freeze({ interactive: 1, batch: 0 }),
    unlentProtectedTokens: Object.freeze({ interactive: 8_192, batch: 4_096 }),
    lending: Object.freeze({
      grantTtlMs: 15_000,
      enrollmentTtlMs: 3_000,
      reportStaleAfterMs: 5_000,
      idleAfterMs: 2_000,
      restorationSloMs: 15_000,
      postRunObserveMs: 5_000,
    }),
  });
}

/** CUDA retains the preregistered envelope used by `nvidia-decode-heavy-v1`. */
export const VLLM_NVIDIA_POLICY = makeVllmPolicy(65_536);

/**
 * Metal uses the same 65,536-token envelope as CUDA. Four slots of at most 256
 * tokens cannot exhaust it, so a Metal `budget_limit` refusal is either a real
 * validity failure or, with a zero capacity envelope, Tyr's fail-closed state
 * between Latchflo grants. A larger ceiling would hide neither.
 */
export const VLLM_METAL_POLICY = makeVllmPolicy(65_536);

/**
 * vLLM `--gpu-memory-utilization` per backend.
 *
 * CUDA keeps its preregistered 0.85 of dedicated GPU memory. On Apple Silicon,
 * vLLM Metal budgets KV cache as this fraction of the unified-memory Metal
 * working-set limit, minus model weights and overhead, so it competes directly
 * with macOS and the Docker VM running Tyr and Latchflo. The workload can hold
 * at most maxNumSeqs x maxModelLen = 16,384 KV tokens, about 450 MiB for
 * Qwen2.5-1.5B (28 layers x 2 x 2 KV heads x 128 dims x 2 bytes per token).
 * At 0.4 on a 16 GB M1 that still leaves about three times that KV capacity
 * after roughly 3.6 GB of weights and overhead, without the multi-gigabyte
 * reservation that forces the host to swap.
 */
export const VLLM_GPU_MEMORY_UTILIZATION = Object.freeze({ nvidia: 0.85, metal: 0.4 });

export function vllmGpuMemoryUtilizationForBackend(backend) {
  const value = VLLM_GPU_MEMORY_UTILIZATION[backend];
  if (value === undefined) throw new Error(`unknown vLLM memory backend ${JSON.stringify(backend)}`);
  return value;
}

/**
 * A Metal seed is valid only if the host kept memory headroom in every arm.
 * vLLM, macOS, and the Docker VM share unified memory; once the host swaps,
 * Docker-to-host connections, control-plane requests, and engine latency all
 * degrade together, and later arms degrade more. That is host contention, not
 * an arm effect. A healthy arm swaps out almost nothing; 256 MiB tolerates
 * incidental background paging while failing a host that is thrashing.
 */
export const VLLM_METAL_HOST_PRESSURE_LIMITS = Object.freeze({
  maxSwapoutMiBPerArm: 256,
  maxCriticalPressureSamples: 0,
});

/** Backward-compatible policy name for the canonical NVIDIA experiment. */
export const VLLM_POLICY = VLLM_NVIDIA_POLICY;

export function vllmPolicyForBackend(backend) {
  if (backend === "nvidia") return VLLM_NVIDIA_POLICY;
  if (backend === "metal") return VLLM_METAL_POLICY;
  throw new Error(`unknown vLLM policy backend ${JSON.stringify(backend)}`);
}

/** Nominal managed-arm grant in the shape shared analysis helpers consume. */
export function vllmNominalClassGrant(policy = VLLM_POLICY) {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(policy.classes).map(([admissionClass, limits]) => [
        admissionClass,
        Object.freeze({
          protectedConcurrent: limits.globalProtectedConcurrent,
          maxConcurrent: limits.globalMaxConcurrent,
          protectedInFlightTokens: limits.globalProtectedInFlightTokens,
          maxInFlightTokens: limits.globalMaxInFlightTokens,
        }),
      ]),
    ),
  );
}

export const VLLM_HYPOTHESIS_THRESHOLDS = Object.freeze({
  interactiveSloTtftMaxMs: 5_000,
  interactiveSloLatencyMaxMs: 30_000,
  priorityGoodputDeltaMinRps: 0,
  mofluxPriorityNonInferiorityRps: -0.04,
  batchBorrowGoodputDeltaMinRps: 0.02,
  minimumSeedsWithLending: 3,
  minimumSeedsWithRestoration: 3,
  requiredQueuePeak: 1,
});

export const VLLM_EVIDENCE_LIMITS = Object.freeze({
  measuredLayer:
    "Client outcomes, Tyr admission state, vLLM production metrics, and host GPU telemetry " +
    "from one single-GPU vLLM process.",
  causality:
    "The experiment can associate outcomes with configured arms and observed state; it does not " +
    "prove that any single scheduler counter caused an individual request latency.",
  gpuReclamation:
    "not-claimed: MoFlux prevents or delays admission. It does not reclaim GPU work already " +
    "accepted by vLLM, and a restored Tyr grant is not GPU reclamation.",
  kvCacheReclamation:
    "not-claimed: KV-cache utilization and vLLM preemptions are observed. No MoFlux component " +
    "evicts or reclaims vLLM KV blocks.",
  schedulerPreemption:
    "vLLM preemptions are reported as an engine counter, not attributed to MoFlux and not " +
    "treated as protected-capacity restoration.",
  generalization:
    "none beyond the recorded GPU, image digest, model revision, engine arguments, and workload.",
});

export const VLLM_METAL_EVIDENCE_LIMITS = Object.freeze({
  measuredLayer:
    "Client outcomes, Tyr admission state, vLLM production metrics, and host process CPU/RSS " +
    "from one native vLLM Metal process on Apple Silicon.",
  causality: VLLM_EVIDENCE_LIMITS.causality,
  gpuReclamation: VLLM_EVIDENCE_LIMITS.gpuReclamation,
  kvCacheReclamation: VLLM_EVIDENCE_LIMITS.kvCacheReclamation,
  schedulerPreemption: VLLM_EVIDENCE_LIMITS.schedulerPreemption,
  platformBoundary:
    "Apple unified memory and Metal are not NVIDIA CUDA. These results are a separate companion " +
    "corpus and must not be pooled with or substituted for vllm-contention results.",
  generalization:
    "none beyond the recorded Mac chip, system memory, macOS release, vLLM/vllm-metal versions, " +
    "model revision, engine arguments, and workload.",
});

export function vllmPoolDefinition(name, grantTtlMs, { lending, policy = VLLM_POLICY }) {
  if (typeof lending !== "boolean") {
    throw new Error("vllmPoolDefinition requires an explicit lending flag");
  }
  if (!Number.isSafeInteger(grantTtlMs) || grantTtlMs < 1) {
    throw new Error("vllmPoolDefinition requires a positive integer grant TTL");
  }
  const restoration = lending
    ? buildRestorationContract({
        tokenAware: true,
        upstreamMechanism: "unlent_floor",
        admissionSlotSloMs: policy.lending.restorationSloMs,
        upstreamTokenSloMs: policy.lending.restorationSloMs,
      })
    : undefined;
  const admissionClassLimits = Object.fromEntries(
    Object.entries(policy.classes).map(([admissionClass, limits]) => {
      if (!lending) return [admissionClass, limits];
      const unlentTokens = policy.unlentProtectedTokens[admissionClass];
      validateUnlentSlice({
        label: `${name}.${admissionClass}.globalUnlentProtectedInFlightTokens`,
        unlentTokens,
        protectedTokens: limits.globalProtectedInFlightTokens,
        contract: restoration,
        lendingEnabled: true,
      });
      const unlentConcurrent = policy.unlentProtectedConcurrent[admissionClass] ?? 0;
      if (!Number.isSafeInteger(unlentConcurrent) || unlentConcurrent < 0 ||
          unlentConcurrent > limits.globalProtectedConcurrent) {
        throw new Error(`${name}.${admissionClass}.globalUnlentProtectedConcurrent is invalid`);
      }
      return [
        admissionClass,
        {
          ...limits,
          ...(unlentConcurrent > 0 ? { globalUnlentProtectedConcurrent: unlentConcurrent } : {}),
          globalUnlentProtectedInFlightTokens: unlentTokens,
        },
      ];
    }),
  );
  return Object.freeze({
    name,
    globalMaxConcurrent: policy.physical.maxConcurrent,
    minimumGrantMaxConcurrent: policy.physical.minimumGrantMaxConcurrent,
    maxQueuePerAgent: 0,
    globalTokenBudget: policy.physical.tokenBudget,
    minimumGrantTokenBudget: policy.physical.minimumGrantTokenBudget,
    globalHighPriorityReserve: 0,
    safetyReservePercent: 0,
    grantTtlMs,
    admissionClassLimits,
    ...(lending
      ? {
          admissionClassDemandPolicy: {
            enabled: true,
            reportStaleAfterMs: policy.lending.reportStaleAfterMs,
            idleAfterMs: policy.lending.idleAfterMs,
            restoration,
          },
        }
      : {}),
  });
}

export function armOrderForSeedIndex(index, arms = VLLM_ARM_IDS) {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error("armOrderForSeedIndex requires a non-negative integer index");
  }
  const list = [...arms];
  if (list.length === 0) throw new Error("armOrderForSeedIndex requires at least one arm");
  const rotation = index % list.length;
  const cycle = Math.floor(index / list.length);
  const rotated = [...list.slice(rotation), ...list.slice(0, rotation)];
  return Object.freeze(cycle % 2 === 1 ? rotated.reverse() : rotated);
}

export function armOrderPlan(seeds, arms = VLLM_ARM_IDS) {
  return Object.freeze(
    seeds.map((seed, index) => Object.freeze({ seed, order: armOrderForSeedIndex(index, arms) })),
  );
}

export function armOrderIsCounterbalanced(plan, arms = VLLM_ARM_IDS) {
  if (plan.length < arms.length) return false;
  return arms.every((arm) =>
    arms.every((_, position) => plan.some(({ order }) => order[position] === arm)),
  );
}

function unescapeLabel(value) {
  return value.replace(/\\n/g, "\n").replace(/\\\"/g, '"').replace(/\\\\/g, "\\");
}

function parseLabels(raw = "") {
  const labels = {};
  const pattern = /([A-Za-z_][A-Za-z0-9_]*)="((?:\\.|[^"\\])*)"/g;
  for (const match of raw.matchAll(pattern)) labels[match[1]] = unescapeLabel(match[2]);
  return labels;
}

/** Parse Prometheus/OpenMetrics samples while ignoring comments and exemplars. */
export function parsePrometheus(text) {
  const rows = [];
  for (const rawLine of String(text ?? "").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z_:][A-Za-z0-9_:]*)(?:\{([^}]*)\})?\s+([^\s]+)(?:\s+\d+)?(?:\s+#.*)?$/u.exec(line);
    if (!match) continue;
    const value = Number(match[3]);
    if (Number.isNaN(value)) continue;
    rows.push(Object.freeze({ name: match[1], labels: parseLabels(match[2]), value }));
  }
  return rows;
}

export const VLLM_METRICS = Object.freeze({
  running: "vllm:num_requests_running",
  waiting: "vllm:num_requests_waiting",
  kvCacheUsage: "vllm:kv_cache_usage_perc",
  preemptions: "vllm:num_preemptions",
  ttft: "vllm:time_to_first_token_seconds",
  itl: "vllm:inter_token_latency_seconds",
  queue: "vllm:request_queue_time_seconds",
  prefill: "vllm:request_prefill_time_seconds",
  decode: "vllm:request_decode_time_seconds",
  inference: "vllm:request_inference_time_seconds",
  e2e: "vllm:e2e_request_latency_seconds",
});

function valuesFor(rows, names) {
  const accepted = new Set(Array.isArray(names) ? names : [names]);
  return rows.filter(({ name }) => accepted.has(name)).map(({ value }) => value);
}

function sumMetric(rows, name) {
  const values = valuesFor(rows, [name, `${name}_total`]).filter(Number.isFinite);
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0);
}

function histogram(rows, base) {
  const buckets = new Map();
  for (const row of rows) {
    if (row.name !== `${base}_bucket`) continue;
    const le = row.labels.le;
    if (le === undefined) continue;
    const bound = le === "+Inf" ? Infinity : Number(le);
    if (Number.isNaN(bound) || !Number.isFinite(row.value)) continue;
    buckets.set(bound, (buckets.get(bound) ?? 0) + row.value);
  }
  const count = sumMetric(rows, `${base}_count`);
  const sum = sumMetric(rows, `${base}_sum`);
  if (count === null && sum === null && buckets.size === 0) return null;
  return Object.freeze({
    count,
    sum,
    buckets: Object.freeze(
      [...buckets.entries()].sort(([left], [right]) => left - right)
        .map(([le, value]) => Object.freeze({ le, value })),
    ),
  });
}

/** Aggregate a vLLM metrics scrape across engine/model label dimensions. */
export function snapshotVllmMetrics(text) {
  const rows = parsePrometheus(text);
  const gauges = Object.freeze({
    running: sumMetric(rows, VLLM_METRICS.running),
    waiting: sumMetric(rows, VLLM_METRICS.waiting),
    kvCacheUsage: sumMetric(rows, VLLM_METRICS.kvCacheUsage),
  });
  const histograms = Object.freeze(
    Object.fromEntries(
      Object.entries(VLLM_METRICS)
        .filter(([key]) => ["ttft", "itl", "queue", "prefill", "decode", "inference", "e2e"].includes(key))
        .map(([key, base]) => [key, histogram(rows, base)]),
    ),
  );
  const preemptions = sumMetric(rows, VLLM_METRICS.preemptions);
  const available = Object.freeze([
    ...Object.entries(gauges).filter(([, value]) => value !== null).map(([key]) => key),
    ...(preemptions === null ? [] : ["preemptions"]),
    ...Object.entries(histograms).filter(([, value]) => value !== null).map(([key]) => key),
  ]);
  return Object.freeze({ gauges, preemptions, histograms, available });
}

function percentile(values, quantile) {
  const ordered = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (ordered.length === 0) return null;
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(quantile * ordered.length) - 1))];
}

function round(value, digits = 4) {
  return Number.isFinite(value) ? +value.toFixed(digits) : null;
}

function gaugeSummary(samples, key) {
  const values = samples.map((sample) => Number(sample?.snapshot?.gauges?.[key])).filter(Number.isFinite);
  if (values.length === 0) return null;
  return Object.freeze({
    samples: values.length,
    min: round(Math.min(...values)),
    p50: round(percentile(values, 0.5)),
    p95: round(percentile(values, 0.95)),
    max: round(Math.max(...values)),
    mean: round(values.reduce((sum, value) => sum + value, 0) / values.length),
    nonzeroShare: round(values.filter((value) => value > 0).length / values.length),
  });
}

function histogramDelta(before, after) {
  if (!before || !after) return null;
  const beforeBuckets = new Map(before.buckets.map(({ le, value }) => [le, value]));
  const buckets = after.buckets.map(({ le, value }) => ({
    le,
    value: Math.max(0, value - (beforeBuckets.get(le) ?? 0)),
  }));
  const count = Math.max(0, Number(after.count ?? 0) - Number(before.count ?? 0));
  const sum = Math.max(0, Number(after.sum ?? 0) - Number(before.sum ?? 0));
  const quantile = (q) => {
    if (!(count > 0)) return null;
    const target = q * count;
    const hit = buckets.find(({ value }) => value >= target);
    return hit && Number.isFinite(hit.le) ? round(hit.le) : null;
  };
  return Object.freeze({
    count,
    sum: round(sum),
    mean: count > 0 ? round(sum / count) : null,
    p50: quantile(0.5),
    p95: quantile(0.95),
    p99: quantile(0.99),
    unit: "seconds",
  });
}

export const REQUIRED_VLLM_METRICS = Object.freeze([
  "running", "waiting", "kvCacheUsage", "preemptions", "ttft", "itl",
  "queue", "prefill", "decode", "inference", "e2e",
]);

function counterDeltaForWindow(samples, fromMs, toMs) {
  const window = samples.filter(({ atMs }) => atMs >= fromMs && atMs < toMs);
  const values = window.map((sample) => Number(sample?.snapshot?.preemptions)).filter(Number.isFinite);
  return values.length < 2 ? null : Math.max(0, values.at(-1) - values[0]);
}

export function summarizeVllmTelemetry({
  samples = [],
  start,
  end,
  errors = [],
  workload = VLLM_WORKLOAD,
  workloadSkewMs = 0,
} = {}) {
  const available = new Set([...(start?.available ?? []), ...(end?.available ?? [])]);
  const boundary = (value) => Number(value) + Number(workloadSkewMs || 0);
  const borrowFrom = boundary(workload.batchStartMs);
  const contentionFrom = boundary(workload.interactiveResumeStartMs);
  const arrivalsEnd = boundary(Math.max(
    workload.batchStartMs + workload.batchDurationMs,
    workload.interactiveResumeStartMs + workload.interactiveResumeDurationMs,
  ));
  const phases = Object.freeze({
    borrow: Object.freeze({
      fromMs: borrowFrom,
      toMs: contentionFrom,
      running: gaugeSummary(samples.filter(({ atMs }) => atMs >= borrowFrom && atMs < contentionFrom), "running"),
      waiting: gaugeSummary(samples.filter(({ atMs }) => atMs >= borrowFrom && atMs < contentionFrom), "waiting"),
      kvCacheUsage: gaugeSummary(samples.filter(({ atMs }) => atMs >= borrowFrom && atMs < contentionFrom), "kvCacheUsage"),
      preemptionsDelta: counterDeltaForWindow(samples, borrowFrom, contentionFrom),
    }),
    contention: Object.freeze({
      fromMs: contentionFrom,
      toMs: arrivalsEnd,
      running: gaugeSummary(samples.filter(({ atMs }) => atMs >= contentionFrom && atMs < arrivalsEnd), "running"),
      waiting: gaugeSummary(samples.filter(({ atMs }) => atMs >= contentionFrom && atMs < arrivalsEnd), "waiting"),
      kvCacheUsage: gaugeSummary(samples.filter(({ atMs }) => atMs >= contentionFrom && atMs < arrivalsEnd), "kvCacheUsage"),
      preemptionsDelta: counterDeltaForWindow(samples, contentionFrom, arrivalsEnd),
    }),
  });
  const afterArrivals = samples.filter(({ atMs }) => atMs >= arrivalsEnd);
  const queueClear = afterArrivals.find((sample) => Number(sample?.snapshot?.gauges?.waiting) === 0);
  const engineIdle = afterArrivals.find((sample) =>
    Number(sample?.snapshot?.gauges?.waiting) === 0 &&
    Number(sample?.snapshot?.gauges?.running) === 0);
  const kvLow = afterArrivals.find((sample) =>
    Number(sample?.snapshot?.gauges?.kvCacheUsage) <= 0.1);
  return Object.freeze({
    sampleCount: samples.length,
    scrapeErrors: [...errors],
    missingRequiredMetrics: REQUIRED_VLLM_METRICS.filter((name) => !available.has(name)),
    gauges: Object.freeze({
      running: gaugeSummary(samples, "running"),
      waiting: gaugeSummary(samples, "waiting"),
      kvCacheUsage: gaugeSummary(samples, "kvCacheUsage"),
    }),
    preemptions: {
      start: start?.preemptions ?? null,
      end: end?.preemptions ?? null,
      delta:
        Number.isFinite(start?.preemptions) && Number.isFinite(end?.preemptions)
          ? Math.max(0, end.preemptions - start.preemptions)
          : null,
    },
    histograms: Object.freeze(
      Object.fromEntries(
        ["ttft", "itl", "queue", "prefill", "decode", "inference", "e2e"]
          .map((key) => [key, histogramDelta(start?.histograms?.[key], end?.histograms?.[key])]),
      ),
    ),
    phases,
    recovery: Object.freeze({
      lastArrivalAtMs: arrivalsEnd,
      queueClearedAtMs: queueClear?.atMs ?? null,
      queueClearanceMs: queueClear ? Math.max(0, queueClear.atMs - arrivalsEnd) : null,
      engineIdleAtMs: engineIdle?.atMs ?? null,
      engineIdleLatencyMs: engineIdle ? Math.max(0, engineIdle.atMs - arrivalsEnd) : null,
      kvCacheAtOrBelow10PctAtMs: kvLow?.atMs ?? null,
      kvCacheAtOrBelow10PctLatencyMs: kvLow ? Math.max(0, kvLow.atMs - arrivalsEnd) : null,
      note:
        "These are observed vLLM engine states after the last arrival. They do not imply " +
        "that MoFlux reclaimed GPU execution or KV-cache blocks.",
    }),
  });
}

/** Parse the stable nounits CSV requested by the runner from nvidia-smi. */
export function parseNvidiaSmiRow(text) {
  const values = String(text ?? "").trim().split(/\s*,\s*/u);
  if (values.length < 7) throw new Error("nvidia-smi returned fewer than seven fields");
  const number = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return Object.freeze({
    uuid: values[0],
    name: values[1],
    utilizationGpuPct: number(values[2]),
    memoryUsedMiB: number(values[3]),
    memoryTotalMiB: number(values[4]),
    powerDrawW: number(values[5]),
    temperatureC: number(values[6]),
  });
}

export function summarizeGpuTelemetry(samples = [], errors = []) {
  const metric = (key) => {
    const values = samples.map((sample) => Number(sample?.[key])).filter(Number.isFinite);
    if (values.length === 0) return null;
    return Object.freeze({
      p50: round(percentile(values, 0.5), 2),
      p95: round(percentile(values, 0.95), 2),
      max: round(Math.max(...values), 2),
      mean: round(values.reduce((sum, value) => sum + value, 0) / values.length, 2),
    });
  };
  return Object.freeze({
    sampleCount: samples.length,
    errors: [...errors],
    gpu: samples.length > 0 ? { uuid: samples[0].uuid, name: samples[0].name } : null,
    utilizationGpuPct: metric("utilizationGpuPct"),
    memoryUsedMiB: metric("memoryUsedMiB"),
    memoryTotalMiB: metric("memoryTotalMiB"),
    powerDrawW: metric("powerDrawW"),
    temperatureC: metric("temperatureC"),
  });
}

/** Aggregate one `ps -axo pid=,ppid=,%cpu=,rss=` snapshot for a process tree. */
export function parseProcessTreeSnapshot(text, rootPid) {
  const rows = String(text ?? "").split(/\r?\n/u).map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)$/u.exec(line);
      return match
        ? { pid: Number(match[1]), ppid: Number(match[2]), cpuPct: Number(match[3]), rssKiB: Number(match[4]) }
        : null;
    })
    .filter(Boolean);
  const wanted = new Set([Number(rootPid)]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (wanted.has(row.ppid) && !wanted.has(row.pid)) {
        wanted.add(row.pid);
        changed = true;
      }
    }
  }
  const tree = rows.filter(({ pid }) => wanted.has(pid));
  if (tree.length === 0) throw new Error(`ps snapshot did not contain vLLM root PID ${rootPid}`);
  return Object.freeze({
    rootPid: Number(rootPid),
    processCount: tree.length,
    cpuPct: round(tree.reduce((sum, row) => sum + row.cpuPct, 0), 2),
    rssMiB: round(tree.reduce((sum, row) => sum + row.rssKiB, 0) / 1_024, 2),
  });
}

export function summarizeProcessTelemetry(samples = [], errors = []) {
  const metric = (key) => {
    const values = samples.map((sample) => Number(sample?.[key])).filter(Number.isFinite);
    if (values.length === 0) return null;
    return Object.freeze({
      p50: round(percentile(values, 0.5), 2),
      p95: round(percentile(values, 0.95), 2),
      max: round(Math.max(...values), 2),
      mean: round(values.reduce((sum, value) => sum + value, 0) / values.length, 2),
    });
  };
  return Object.freeze({
    sampleCount: samples.length,
    errors: [...errors],
    rootPid: samples[0]?.rootPid ?? null,
    processCount: metric("processCount"),
    cpuPct: metric("cpuPct"),
    rssMiB: metric("rssMiB"),
  });
}

// ── macOS host pressure (Metal) ──────────────────────────────────────
//
// vLLM Metal shares unified memory with the Docker VM that runs Tyr and
// Latchflo. Process CPU/RSS cannot show memory pressure, swap, or thermal
// throttling, so the runner samples them from commands that need no root.

const MEMORY_PRESSURE_LEVELS = Object.freeze({ 1: "normal", 2: "warn", 4: "critical" });
const VM_STAT_FIELDS = Object.freeze({
  "Pages free": "freePages",
  "Pages active": "activePages",
  "Pages inactive": "inactivePages",
  "Pages speculative": "speculativePages",
  "Pages wired down": "wiredPages",
  "Pages occupied by compressor": "compressorPages",
  "Pageins": "pageins",
  "Pageouts": "pageouts",
  "Swapins": "swapins",
  "Swapouts": "swapouts",
  "Compressions": "compressions",
  "Decompressions": "decompressions",
});

/** Parses `vm_stat`. Counters are cumulative since boot; gauges are current. */
export function parseVmStat(text) {
  const pageSize = /page size of (\d+) bytes/u.exec(String(text))?.[1];
  if (pageSize === undefined) throw new Error("vm_stat output has no page size");
  const out = { pageSizeBytes: Number(pageSize) };
  for (const line of String(text).split(/\r?\n/u)) {
    const match = /^"?([^":]+)"?:\s+(\d+)\.?\s*$/u.exec(line.trim());
    const key = match ? VM_STAT_FIELDS[match[1]] : undefined;
    if (key !== undefined) out[key] = Number(match[2]);
  }
  for (const key of Object.values(VM_STAT_FIELDS)) {
    if (!Number.isFinite(out[key])) throw new Error(`vm_stat output has no ${key}`);
  }
  return Object.freeze(out);
}

/** Parses `sysctl kern.memorystatus_vm_pressure_level vm.swapusage`. */
export function parseMemorySysctl(text) {
  const levelRaw = /kern\.memorystatus_vm_pressure_level:\s*(\d+)/u.exec(String(text))?.[1];
  const swap = /vm\.swapusage:\s*total = ([\d.]+)M\s+used = ([\d.]+)M\s+free = ([\d.]+)M/u
    .exec(String(text));
  if (levelRaw === undefined || swap === null) {
    throw new Error("sysctl output lacks memory pressure level or swap usage");
  }
  const level = Number(levelRaw);
  return Object.freeze({
    pressureLevel: level,
    pressure: MEMORY_PRESSURE_LEVELS[level] ?? "unknown",
    swapTotalMiB: Number(swap[1]),
    swapUsedMiB: Number(swap[2]),
    swapFreeMiB: Number(swap[3]),
  });
}

/**
 * Parses `pmset -g therm`. Apple Silicon prints only "Note: No ... has been
 * recorded" lines when nothing is limited; any other line is a recorded
 * thermal, performance, or CPU power condition and is kept verbatim (bounded).
 */
export function parsePmsetTherm(text) {
  const lines = String(text).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const recorded = lines.filter((line) => !/^Note: No .* has been recorded$/u.test(line));
  return Object.freeze({
    thermalWarning: !lines.some((line) => /No thermal warning level has been recorded/u.test(line)),
    performanceWarning: !lines.some((line) => /No performance warning level has been recorded/u.test(line)),
    recordedLines: Object.freeze(recorded.slice(0, 8).map((line) => line.slice(0, 160))),
  });
}

export function summarizeHostPressure(samples = [], errors = []) {
  const valid = samples.filter((sample) => sample?.vm && sample?.memory && sample?.therm);
  const first = valid[0];
  const last = valid.at(-1);
  const mib = (pages, pageSizeBytes) => round((pages * pageSizeBytes) / 1_048_576, 1);
  const pressureCounts = { normal: 0, warn: 0, critical: 0, unknown: 0 };
  for (const sample of valid) pressureCounts[sample.memory.pressure] += 1;
  const swapUsed = valid.map((sample) => sample.memory.swapUsedMiB);
  const freeMiB = valid.map((sample) => mib(sample.vm.freePages, sample.vm.pageSizeBytes));
  const compressorMiB = valid.map((sample) =>
    mib(sample.vm.compressorPages, sample.vm.pageSizeBytes));
  const delta = (key) =>
    first === undefined ? null : last.vm[key] - first.vm[key];
  const worst = ["critical", "warn", "normal"].find((level) => pressureCounts[level] > 0) ?? null;
  return Object.freeze({
    sampleCount: valid.length,
    errors: [...errors],
    pressureSamples: Object.freeze(pressureCounts),
    worstPressure: worst,
    swapUsedMiB: valid.length === 0
      ? null
      : Object.freeze({
          start: swapUsed[0],
          end: swapUsed.at(-1),
          max: Math.max(...swapUsed),
          delta: round(swapUsed.at(-1) - swapUsed[0], 1),
        }),
    freeMiB: valid.length === 0
      ? null
      : Object.freeze({ min: Math.min(...freeMiB), p50: round(percentile(freeMiB, 0.5), 1) }),
    compressorMiBMax: valid.length === 0 ? null : Math.max(...compressorMiB),
    pagesDuringArm: first === undefined
      ? null
      : Object.freeze({
          swapouts: delta("swapouts"),
          swapins: delta("swapins"),
          pageouts: delta("pageouts"),
          pageins: delta("pageins"),
          compressions: delta("compressions"),
          decompressions: delta("decompressions"),
        }),
    swapoutMiBDuringArm: first === undefined ? null : mib(delta("swapouts"), first.vm.pageSizeBytes),
    thermalWarningSamples: valid.filter((sample) => sample.therm.thermalWarning).length,
    performanceWarningSamples: valid.filter((sample) => sample.therm.performanceWarning).length,
    thermalRecordedLines: Object.freeze([
      ...new Set(valid.flatMap((sample) => sample.therm.recordedLines)),
    ].slice(0, 8)),
  });
}

export function summarizeManagedRecovery(
  samples = [],
  workload = VLLM_WORKLOAD,
  demandReturn = null,
  policy = VLLM_POLICY,
) {
  const ordered = [...samples].sort((a, b) => Number(a.offsetMs) - Number(b.offsetMs));
  const resume = Number.isFinite(Number(demandReturn?.benchmarkMarkedActiveAtMs))
    ? Number(demandReturn.benchmarkMarkedActiveAtMs)
    : workload.interactiveResumeStartMs;
  const nominalFloor = policy.classes.interactive.globalProtectedConcurrent;
  const borrowWindow = ordered.filter(
    (sample) => sample.offsetMs >= workload.batchStartMs && sample.offsetMs < resume,
  );
  const afterReturn = ordered.filter((sample) => sample.offsetMs >= resume);
  const lent = borrowWindow.some(
    (sample) => Number(sample?.classes?.interactive?.limits?.protectedConcurrent) < nominalFloor,
  );
  const atReturn = afterReturn[0] ?? null;
  const restorationRequired = demandReturn?.restorationWasNeeded === true ||
    (atReturn !== null &&
      (Number(atReturn?.classes?.interactive?.limits?.protectedConcurrent ?? 0) < nominalFloor ||
        Number(atReturn?.classes?.batch?.inFlight ?? 0) >
          policy.classes.batch.globalProtectedConcurrent));
  const restored = afterReturn.find(
    (sample) => Number(sample?.classes?.interactive?.limits?.protectedConcurrent) >= nominalFloor,
  );
  const occupancy = afterReturn.find(
    (sample) => Number(sample?.classes?.batch?.inFlight ?? 0) <=
      policy.classes.batch.globalProtectedConcurrent,
  );
  const floorLatency = restorationRequired && restored
    ? Math.max(0, Number(restored.offsetMs) - resume)
    : null;
  const occupancyLatency = restorationRequired && occupancy
    ? Math.max(0, Number(occupancy.offsetMs) - resume)
    : null;
  const unlentBreaches = ordered.filter((sample) => {
    if (Number(sample?.pool?.maxConcurrent ?? 0) < 1) return false;
    return Number(sample?.classes?.interactive?.limits?.protectedConcurrent ?? 0) <
      policy.unlentProtectedConcurrent.interactive;
  }).length;
  return Object.freeze({
    lendingObserved: lent,
    demandReturnAtMs: resume,
    restorationRequired,
    floorRestored: !restorationRequired || restored !== undefined,
    floorRestorationLatencyMs: floorLatency,
    floorWithinSlo:
      !restorationRequired ||
      (floorLatency !== null && floorLatency <= policy.lending.restorationSloMs),
    occupancyRestored: !restorationRequired || occupancy !== undefined,
    occupancyRestorationLatencyMs: occupancyLatency,
    occupancyWithinSlo:
      !restorationRequired ||
      (occupancyLatency !== null && occupancyLatency <= policy.lending.restorationSloMs),
    nativeUnlentConcurrentBreaches: unlentBreaches,
  });
}

function observed(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function delta(left, right) {
  const a = observed(left);
  const b = observed(right);
  return a === null || b === null ? null : round(a - b);
}

export function compareVllmArms(arms) {
  const contentionGoodput = (id) => arms[id]?.classes?.interactive?.windows?.contention?.sloGoodputRps;
  const borrowGoodput = (id) => arms[id]?.classes?.batch?.windows?.borrow?.goodputRps;
  const ttft = (id) => arms[id]?.classes?.interactive?.windows?.contention?.ttftP95Ms;
  return Object.freeze({
    traceHash: arms[VLLM_ARM_IDS.find((id) => arms[id])]?.trace?.hash ?? null,
    interactiveContentionSloGoodputRps: Object.freeze(
      Object.fromEntries(VLLM_ARM_IDS.map((id) => [id, observed(contentionGoodput(id))])),
    ),
    interactiveContentionTtftP95Ms: Object.freeze(
      Object.fromEntries(VLLM_ARM_IDS.map((id) => [id, observed(ttft(id))])),
    ),
    batchBorrowGoodputRps: Object.freeze(
      Object.fromEntries(VLLM_ARM_IDS.map((id) => [id, observed(borrowGoodput(id))])),
    ),
    priorityGoodputDeltaVsFcfsRps: delta(contentionGoodput("vllm-priority"), contentionGoodput("vllm-fcfs")),
    mofluxGoodputDeltaVsPriorityRps: delta(contentionGoodput("moflux"), contentionGoodput("vllm-priority")),
    mofluxBatchBorrowDeltaVsStaticRps: delta(borrowGoodput("moflux"), borrowGoodput("static")),
  });
}

function gate(name, passed, observedValue, threshold, reason) {
  return Object.freeze({ gate: name, passed: passed === true, observed: observedValue, threshold, reason });
}

export function vllmSeedProof({
  arms = {},
  evidence = {},
  backend = "nvidia",
  workload = VLLM_WORKLOAD,
  policy = VLLM_POLICY,
  gpuMemoryUtilization,
} = {}) {
  if (!["nvidia", "metal"].includes(backend)) {
    throw new Error(`unknown vLLM proof backend ${JSON.stringify(backend)}`);
  }
  const metal = backend === "metal";
  const expectedGpuMemoryUtilization =
    gpuMemoryUtilization ?? vllmGpuMemoryUtilizationForBackend(backend);
  const gates = [];
  gates.push(gate(
    "allArmsPresent",
    VLLM_ARM_IDS.every((id) => arms[id]),
    Object.keys(arms),
    VLLM_ARM_IDS,
    "all four arms must complete",
  ));
  const hashes = VLLM_ARM_IDS.map((id) => arms[id]?.trace?.hash).filter(Boolean);
  gates.push(gate(
    "identicalTrace",
    hashes.length === VLLM_ARM_IDS.length && new Set(hashes).size === 1,
    hashes,
    "one hash",
    "every arm must replay the same immutable request trace",
  ));
  gates.push(gate(
    "generatorHeadroom",
    VLLM_ARM_IDS.every((id) => Number(arms[id]?.generatorSaturated ?? 1) === 0),
    Object.fromEntries(VLLM_ARM_IDS.map((id) => [id, arms[id]?.generatorSaturated ?? null])),
    0,
    "a saturated load generator invalidates the run",
  ));
  const missing = Object.fromEntries(
    VLLM_ARM_IDS.map((id) => [id, arms[id]?.vllm?.missingRequiredMetrics ?? REQUIRED_VLLM_METRICS]),
  );
  gates.push(gate(
    "vllmMetricsComplete",
    VLLM_ARM_IDS.every((id) =>
      Array.isArray(missing[id]) &&
      missing[id].length === 0 &&
      Number(arms[id]?.vllm?.sampleCount ?? 0) > 0),
    missing,
    "no missing required metrics",
    "queue, occupancy, KV, preemption, and timing claims require their engine metrics",
  ));
  const inferenceActivity = Object.fromEntries(VLLM_ARM_IDS.map((id) => {
    const interactive = arms[id]?.classes?.interactive ?? {};
    const batch = arms[id]?.classes?.batch ?? {};
    return [id, {
      successes: Number(interactive.success ?? 0) + Number(batch.success ?? 0),
      completionTokens:
        Number(interactive.completionTokens ?? 0) + Number(batch.completionTokens ?? 0),
      expectedCompletionTokens:
        Number(interactive.success ?? 0) * workload.interactiveMaxTokens +
        Number(batch.success ?? 0) * workload.batchMaxTokens,
      promptTokens: Number(interactive.promptTokens ?? 0) + Number(batch.promptTokens ?? 0),
      promptTokenReports:
        Number(interactive.promptTokenReports ?? 0) + Number(batch.promptTokenReports ?? 0),
    }];
  }));
  gates.push(gate(
    "successfulInferenceObserved",
    VLLM_ARM_IDS.every((id) => {
      const observed = inferenceActivity[id];
      return observed.successes > 0 &&
        observed.completionTokens === observed.expectedCompletionTokens &&
        observed.promptTokens > 0 &&
        observed.promptTokenReports === observed.successes;
    }),
    inferenceActivity,
    "exact fixed completion tokens plus prompt usage for every success in every arm",
    "HTTP or stream completion without generated-token evidence is not successful inference",
  ));
  const requestMetricActivity = Object.fromEntries(VLLM_ARM_IDS.map((id) => [id, {
    ttftCount: arms[id]?.vllm?.histograms?.ttft?.count ?? null,
    e2eCount: arms[id]?.vllm?.histograms?.e2e?.count ?? null,
  }]));
  gates.push(gate(
    "vllmRequestMetricsActive",
    VLLM_ARM_IDS.every((id) =>
      Number(requestMetricActivity[id].ttftCount ?? 0) > 0 &&
      Number(requestMetricActivity[id].e2eCount ?? 0) > 0),
    requestMetricActivity,
    "positive measured TTFT and end-to-end histogram counts per arm",
    "metric names alone do not prove that vLLM executed any measured request",
  ));
  gates.push(gate(
    metal ? "hostProcessTelemetryPresent" : "gpuTelemetryPresent",
    VLLM_ARM_IDS.every((id) =>
      Number((metal ? arms[id]?.hostProcess : arms[id]?.gpu)?.sampleCount ?? 0) > 0),
    Object.fromEntries(VLLM_ARM_IDS.map((id) => [
      id,
      (metal ? arms[id]?.hostProcess : arms[id]?.gpu)?.sampleCount ?? 0,
    ])),
    ">0 per arm",
    metal
      ? "a native Metal experiment must record the vLLM process tree and its host pressure"
      : "a GPU-backed experiment must record the GPU it used and its pressure",
  ));
  gates.push(gate(
    "telemetryIntegrity",
    VLLM_ARM_IDS.every((id) =>
      (arms[id]?.vllm?.scrapeErrors?.length ?? 1) === 0 &&
      ((metal ? arms[id]?.hostProcess : arms[id]?.gpu)?.errors?.length ?? 1) === 0),
    Object.fromEntries(VLLM_ARM_IDS.map((id) => [id, {
      vllmScrapeErrors: arms[id]?.vllm?.scrapeErrors ?? null,
      platformSampleErrors: (metal ? arms[id]?.hostProcess : arms[id]?.gpu)?.errors ?? null,
    }])),
    "zero scrape/sample errors",
    "missing intervals can hide the short queue, KV, or restoration transition under test",
  ));
  if (metal) {
    const limits = VLLM_METAL_HOST_PRESSURE_LIMITS;
    const byArm = Object.fromEntries(VLLM_ARM_IDS.map((id) => {
      const pressure = arms[id]?.hostPressure;
      return [id, {
        samples: pressure?.sampleCount ?? 0,
        errors: pressure?.errors ?? null,
        worstPressure: pressure?.worstPressure ?? null,
        criticalSamples: pressure?.pressureSamples?.critical ?? null,
        swapoutMiB: pressure?.swapoutMiBDuringArm ?? null,
        minFreeMiB: pressure?.freeMiB?.min ?? null,
      }];
    }));
    gates.push(gate(
      "hostMemoryHeadroom",
      Object.values(byArm).every((arm) =>
        arm.samples > 0 &&
        Array.isArray(arm.errors) && arm.errors.length === 0 &&
        arm.criticalSamples !== null && arm.criticalSamples <= limits.maxCriticalPressureSamples &&
        arm.swapoutMiB !== null && arm.swapoutMiB <= limits.maxSwapoutMiBPerArm),
      byArm,
      `per arm: pressure samples present and error-free, critical <= ${limits.maxCriticalPressureSamples}, ` +
        `swap-out <= ${limits.maxSwapoutMiBPerArm} MiB`,
      "a swapping host degrades Docker networking, control-plane requests, and engine latency together; that is host contention, not an arm effect",
    ));
  }
  gates.push(gate(
    "managedSamplerIntegrity",
    ["static", "moflux"].every((id) =>
      Number(arms[id]?.managedSampleCount ?? 0) > 0 &&
      (arms[id]?.managedSampleErrors?.length ?? 1) === 0),
    Object.fromEntries(["static", "moflux"].map((id) => [id, {
      samples: arms[id]?.managedSampleCount ?? 0,
      errors: arms[id]?.managedSampleErrors ?? null,
    }])),
    "at least one sample and zero errors per managed arm",
    "admission restoration cannot be reconstructed through gaps in Tyr/controller sampling",
  ));
  const managedConstraints = ["static", "moflux"].flatMap((id) =>
    ["interactive", "batch"].map((cls) => arms[id]?.bindingConstraint?.[cls] ?? {}));
  const budgetLimited = managedConstraints.reduce(
    (sum, value) => sum + Number(value?.budgetLimited ?? 0),
    0,
  );
  const concurrencyLimited = managedConstraints.reduce(
    (sum, value) => sum + Number(value?.concurrencyLimited ?? 0),
    0,
  );
  const budgetRejectionEvidence = Object.fromEntries(
    ["static", "moflux"].map((id) => [
      id,
      Object.fromEntries(["interactive", "batch"].map((admissionClass) => [
        admissionClass,
        {
          ranges: (Array.isArray(arms[id]?.classes?.[admissionClass]?.rejectionDetails)
            ? arms[id].classes[admissionClass].rejectionDetails
            : []
          ).filter((detail) => detail?.reason === "budget_limit" && detail?.grantUnavailable !== true),
          snapshots: Array.isArray(
            arms[id]?.classes?.[admissionClass]?.budgetRejectionSnapshots,
          )
            ? arms[id].classes[admissionClass].budgetRejectionSnapshots
            : [],
        },
      ])),
    ]),
  );
  gates.push(gate(
    "concurrencyAdmissionExercised",
    concurrencyLimited > 0 && budgetLimited === 0,
    { concurrencyLimited, budgetLimited, budgetRejectionEvidence },
    "concurrencyLimited>0 and budgetLimited=0",
    "the 3/1 concurrency treatment must bind without turning into a token-budget experiment",
  ));
  // Tyr reports these as budget_limit or concurrency_limit, but they were made
  // with a zero capacity envelope: the arm had no live Latchflo grant.
  const grantUnavailable = Object.fromEntries(["static", "moflux"].map((id) => [
    id,
    Object.fromEntries(["interactive", "batch"].map((admissionClass) => [admissionClass, {
      count: Number(arms[id]?.classes?.[admissionClass]?.grantUnavailableRejections ?? 0),
      snapshots: Array.isArray(arms[id]?.classes?.[admissionClass]?.grantUnavailableSnapshots)
        ? arms[id].classes[admissionClass].grantUnavailableSnapshots
        : [],
    }])),
  ]));
  const grantUnavailableTotal = Object.values(grantUnavailable)
    .flatMap((byClass) => Object.values(byClass))
    .reduce((sum, entry) => sum + entry.count, 0);
  gates.push(gate(
    "managedGrantContinuity",
    grantUnavailableTotal === 0,
    { grantUnavailable: grantUnavailableTotal, byArm: grantUnavailable },
    "0 refusals with a zero capacity envelope",
    "a managed arm that refuses work because it holds no live grant is measuring a control-plane gap, not the 3/1 treatment",
  ));
  const queuePeak = Math.max(
    0,
    ...["vllm-fcfs", "vllm-priority"].map((id) => Number(arms[id]?.vllm?.gauges?.waiting?.max ?? 0)),
  );
  gates.push(gate(
    "contentionExercised",
    queuePeak >= VLLM_HYPOTHESIS_THRESHOLDS.requiredQueuePeak,
    queuePeak,
    `>=${VLLM_HYPOTHESIS_THRESHOLDS.requiredQueuePeak}`,
    "at least one direct arm must show a non-empty vLLM waiting queue",
  ));
  const directSloGoodput = Object.fromEntries(
    ["vllm-fcfs", "vllm-priority"].map((id) => [
      id,
      observed(arms[id]?.classes?.interactive?.windows?.contention?.sloGoodputRps),
    ]),
  );
  gates.push(gate(
    "interactiveSloSignal",
    Object.values(directSloGoodput).some((value) => value !== null && value > 0),
    directSloGoodput,
    ">0 req/s in at least one direct arm",
    "an all-zero direct comparison cannot support priority or non-inferiority claims",
  ));
  const identities = VLLM_ARM_IDS.map((id) => arms[id]?.runtimeIdentity).filter(Boolean);
  const identityKeys = identities.map((value) => JSON.stringify(metal
    ? {
        backend: value.backend,
        engineVersion: value.engineVersion,
        pluginVersion: value.pluginVersion,
        model: value.model,
        modelRevision: value.modelRevision,
        servedModel: value.servedModel,
        appleChip: value.appleChip,
        systemMemoryBytes: value.systemMemoryBytes,
        platform: value.platform,
        arch: value.arch,
        macosVersion: value.macosVersion,
        maxNumSeqs: value.maxNumSeqs,
        maxModelLen: value.maxModelLen,
        gpuMemoryUtilization: value.gpuMemoryUtilization,
        prefixCaching: value.prefixCaching,
        pagedAttention: value.pagedAttention,
      }
    : {
        backend: value.backend,
        imageId: value.imageId,
        engineVersion: value.engineVersion,
        model: value.model,
        modelRevision: value.modelRevision,
        servedModel: value.servedModel,
        gpuUuid: value.gpuUuid,
        maxNumSeqs: value.maxNumSeqs,
        maxModelLen: value.maxModelLen,
        gpuMemoryUtilization: value.gpuMemoryUtilization,
        prefixCaching: value.prefixCaching,
      }));
  gates.push(gate(
    "runtimeIdentityStable",
    identities.length === VLLM_ARM_IDS.length && new Set(identityKeys).size === 1,
    identities,
    metal ? "same vLLM/plugin/model/Mac/capacity" : "same image/model/GPU/capacity",
    "only the declared scheduling/admission policy may vary",
  ));
  gates.push(gate(
    "runtimeConfigurationObserved",
    identities.length === VLLM_ARM_IDS.length && identities.every((value) =>
      value.backend === backend &&
      (!metal || (
        typeof value.pluginVersion === "string" && value.pluginVersion.length > 0 &&
        typeof value.appleChip === "string" && value.appleChip.length > 0 &&
        Number(value.systemMemoryBytes) > 0 &&
        value.platform === "darwin" && value.arch === "arm64" &&
        typeof value.macosVersion === "string" && value.macosVersion.length > 0 &&
        value.pagedAttention === true
      )) &&
      (metal || (typeof value.imageId === "string" && value.imageId.length > 0)) &&
      typeof value.engineVersion === "string" && value.engineVersion.length > 0 &&
      typeof value.model === "string" && value.model.length > 0 &&
      /^[0-9a-f]{40,64}$/iu.test(String(value.modelRevision ?? "")) &&
      value.servedModel === "moflux-vllm" &&
      (metal || (typeof value.gpuUuid === "string" && value.gpuUuid.length > 0)) &&
      value.maxNumSeqs === VLLM_MAX_NUM_SEQS &&
      value.maxModelLen === 4_096 &&
      value.gpuMemoryUtilization === expectedGpuMemoryUtilization &&
      value.prefixCaching === false),
    identities,
    metal
      ? "observed vLLM/plugin/model commit/Apple platform and pinned engine arguments"
      : "observed image/version/model commit/GPU and pinned engine arguments",
    "a stable null or silently changed setting is not a controlled runtime",
  ));
  gates.push(metal
    ? gate(
        "applePlatformIdentity",
        VLLM_ARM_IDS.every((id) =>
          arms[id]?.runtimeIdentity?.platform === "darwin" &&
          arms[id]?.runtimeIdentity?.arch === "arm64"),
        Object.fromEntries(VLLM_ARM_IDS.map((id) => [id, {
          platform: arms[id]?.runtimeIdentity?.platform ?? null,
          arch: arms[id]?.runtimeIdentity?.arch ?? null,
        }])),
        "darwin/arm64 for every arm",
        "Metal evidence is invalid unless every arm ran natively on Apple Silicon",
      )
    : gate(
        "gpuDeviceSelection",
        VLLM_ARM_IDS.every((id) => arms[id]?.runtimeIdentity?.gpuSelectionMatches === true),
        Object.fromEntries(VLLM_ARM_IDS.map((id) => [id, arms[id]?.runtimeIdentity?.containerGpuDeviceIds ?? []])),
        "selected host GPU requested by every container",
        "GPU telemetry is invalid if Docker assigned a different device",
      ));
  gates.push(gate(
    "schedulerPolicies",
    VLLM_ARM_IDS.every((id) => arms[id]?.runtimeIdentity?.schedulingPolicy === vllmArm(id).schedulingPolicy),
    Object.fromEntries(VLLM_ARM_IDS.map((id) => [id, arms[id]?.runtimeIdentity?.schedulingPolicy ?? null])),
    Object.fromEntries(VLLM_ARM_IDS.map((id) => [id, vllmArm(id).schedulingPolicy])),
    "FCFS is isolated to its control arm; all other arms use vLLM priority scheduling",
  ));
  gates.push(gate(
    "noEngineOrTransportErrors",
    VLLM_ARM_IDS.every((id) =>
      ["interactive", "batch"].every((cls) =>
        Number(arms[id]?.classes?.[cls]?.serverErrors ?? 0) === 0 &&
        Number(arms[id]?.classes?.[cls]?.requestErrors ?? 0) === 0 &&
        Number(arms[id]?.classes?.[cls]?.tornStreams ?? 0) === 0)),
    Object.fromEntries(VLLM_ARM_IDS.map((id) => [id, {
      serverErrors: ["interactive", "batch"].reduce((sum, cls) => sum + Number(arms[id]?.classes?.[cls]?.serverErrors ?? 0), 0),
      serverErrorCauses: Object.fromEntries(["interactive", "batch"].map((cls) => [
        cls,
        arms[id]?.classes?.[cls]?.serverErrorCauses ?? {},
      ])),
      requestErrors: ["interactive", "batch"].reduce((sum, cls) => sum + Number(arms[id]?.classes?.[cls]?.requestErrors ?? 0), 0),
      tornStreams: ["interactive", "batch"].reduce((sum, cls) => sum + Number(arms[id]?.classes?.[cls]?.tornStreams ?? 0), 0),
    }])),
    0,
    "engine faults and torn streams are not admission-policy outcomes",
  ));
  if (evidence?.moflux?.recovery) {
    gates.push(gate(
      "nativeUnlentFloor",
      evidence.moflux.recovery.nativeUnlentConcurrentBreaches === 0,
      evidence.moflux.recovery.nativeUnlentConcurrentBreaches,
      0,
      "the one-slot allocation-enforced reserve must never disappear from a usable grant",
    ));
  }
  const controlPlane = evidence?.moflux?.controlPlane ?? null;
  gates.push(gate(
    "controlPlaneEvidence",
    controlPlane !== null,
    controlPlane === null ? "missing" : "present",
    "present",
    "restoration and unlent-floor claims require controller-side evidence",
  ));
  const requiredUnlentTokens = Object.values(policy.unlentProtectedTokens)
    .reduce((sum, value) => sum + Number(value), 0);
  gates.push(gate(
    "allocatorUnlentReserve",
    controlPlane?.unlentGauges?.concurrencyStatus === "measured" &&
      Number(controlPlane?.unlentGauges?.totalUnlentConcurrent ?? 0) >= 1 &&
      Number(controlPlane?.unlentGauges?.totalUnlentTokens ?? 0) >= requiredUnlentTokens,
    controlPlane?.unlentGauges ?? null,
    `>=1 concurrent and >=${requiredUnlentTokens} tokens withheld`,
    "the allocator's gauges, not the submitted policy, must confirm the native reserve",
  ));
  gates.push(gate(
    "handoffSafety",
    controlPlane?.handoff?.proofComplete === true &&
      Number(controlPlane?.handoff?.unsafeHandoffs ?? 1) === 0,
    controlPlane?.handoff ?? null,
    "complete bounded event window and zero unsafe handoffs",
    "a grant must not move before required drain acknowledgements",
  ));
  if (evidence?.moflux?.recovery?.restorationRequired === true) {
    gates.push(gate(
      "restorationEpisodeEvidence",
      controlPlane?.latchfloEpisodes?.status === "measured" &&
        Number(controlPlane?.latchfloEpisodes?.episodes ?? 0) > 0,
      controlPlane?.latchfloEpisodes ?? null,
      ">0 measured per-resource episodes",
      "sampled grant recovery must agree with Latchflo's per-resource restoration record",
    ));
  }
  const failed = gates.filter(({ passed }) => !passed);
  return Object.freeze({ valid: failed.length === 0, passed: failed.length === 0, gates, failed });
}

export function median(values) {
  const ordered = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (ordered.length === 0) return null;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? round((ordered[middle - 1] + ordered[middle]) / 2) : ordered[middle];
}

export function vllmSweepProof({ rows = [], armOrder = [], requiredSeeds = VLLM_PUBLICATION_SEED_COUNT } = {}) {
  const validityGates = [
    gate("publicationSeedCount", rows.length >= requiredSeeds, rows.length, `>=${requiredSeeds}`, "publication claims require the preregistered seed count"),
    gate("counterbalancedOrder", armOrderIsCounterbalanced(armOrder), armOrder, "every arm in every position", "thermal and warm-state order must be balanced"),
    gate("allSeedsValid", rows.every((row) => row?.proof?.valid === true), rows.filter((row) => row?.proof?.valid === true).length, rows.length, "invalid seeds are not silently dropped"),
  ];
  const comparisons = rows.map((row) => row.comparison ?? {});
  const priorityDelta = median(comparisons.map((row) => row.priorityGoodputDeltaVsFcfsRps));
  const mofluxDelta = median(comparisons.map((row) => row.mofluxGoodputDeltaVsPriorityRps));
  const borrowDelta = median(comparisons.map((row) => row.mofluxBatchBorrowDeltaVsStaticRps));
  const recovery = rows.map((row) => row?.evidence?.moflux?.recovery).filter(Boolean);
  const lendingSeeds = recovery.filter((value) => value.lendingObserved).length;
  const restorationSeeds = recovery.filter((value) => value.restorationRequired).length;
  const hypothesisGates = [
    gate("h1PriorityVsFcfs", priorityDelta !== null && priorityDelta >= VLLM_HYPOTHESIS_THRESHOLDS.priorityGoodputDeltaMinRps, priorityDelta, `>=${VLLM_HYPOTHESIS_THRESHOLDS.priorityGoodputDeltaMinRps} req/s`, "native priority should not reduce interactive contention-window SLO goodput"),
    gate("h2MofluxVsPriority", mofluxDelta !== null && mofluxDelta >= VLLM_HYPOTHESIS_THRESHOLDS.mofluxPriorityNonInferiorityRps, mofluxDelta, `>=${VLLM_HYPOTHESIS_THRESHOLDS.mofluxPriorityNonInferiorityRps} req/s`, "MoFlux interactive SLO goodput must be non-inferior to native priority within one request per window"),
    gate("h3BorrowVsStatic", borrowDelta !== null && borrowDelta >= VLLM_HYPOTHESIS_THRESHOLDS.batchBorrowGoodputDeltaMinRps, borrowDelta, `>=${VLLM_HYPOTHESIS_THRESHOLDS.batchBorrowGoodputDeltaMinRps} req/s`, "lending should turn otherwise-idle protected capacity into batch goodput"),
    gate("h4LendingObserved", lendingSeeds >= Math.min(requiredSeeds, VLLM_HYPOTHESIS_THRESHOLDS.minimumSeedsWithLending), lendingSeeds, `>=${Math.min(requiredSeeds, VLLM_HYPOTHESIS_THRESHOLDS.minimumSeedsWithLending)} seeds`, "restoration cannot be tested unless capacity was first lent"),
    gate("h5GrantRestoration", restorationSeeds >= Math.min(requiredSeeds, VLLM_HYPOTHESIS_THRESHOLDS.minimumSeedsWithRestoration) && recovery.every((value) => value.floorWithinSlo && value.nativeUnlentConcurrentBreaches === 0), { restorationSeeds, recovery }, `>=${Math.min(requiredSeeds, VLLM_HYPOTHESIS_THRESHOLDS.minimumSeedsWithRestoration)} restoration-required seeds; all grant floors restored within 15s; zero reserve breaches`, "raw occupancy recovery is reported separately; this is an admission-grant claim, not GPU reclamation"),
  ];
  const valid = validityGates.every(({ passed }) => passed);
  const hypothesesPassed = hypothesisGates.every(({ passed }) => passed);
  return Object.freeze({
    status: valid ? (hypothesesPassed ? "pass" : "fail") : "inconclusive",
    valid,
    hypothesesPassed,
    passed: valid && hypothesesPassed,
    validityGates,
    hypothesisGates,
    medians: { priorityGoodputDeltaVsFcfsRps: priorityDelta, mofluxGoodputDeltaVsPriorityRps: mofluxDelta, mofluxBatchBorrowDeltaVsStaticRps: borrowDelta },
  });
}
