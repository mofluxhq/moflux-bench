/**
 * local-contention-lib.mjs — pure helpers for the local-inference contention
 * benchmark.
 *
 * What this benchmark asks, and what it is not
 * -------------------------------------------
 * `demo/local-inference.mjs` (0.32.0) is a **compatibility** benchmark: two
 * arms, one request at a time, against an unsaturated server. It establishes
 * that Tyr can sit in front of Ollama without breaking the protocol. It
 * establishes nothing about workload protection, and its latency deltas are not
 * quotable — `results/README.md` records exactly why.
 *
 * This benchmark asks a different question, and it deliberately does not reuse
 * that one's evidence:
 *
 *   When interactive and batch requests contend for the same self-hosted
 *   inference capacity, can MoFlux preserve interactive service while still
 *   letting batch traffic use otherwise-idle capacity?
 *
 * What makes the question answerable here is a measured property of the server,
 * not an assumption about it: on the reference host, `qwen3:0.6b` under
 * `ollama/ollama:0.12.3` decodes at a roughly constant aggregate rate
 * regardless of how many requests are in flight. Four concurrent requests each
 * take about four times as long as one. Concurrency is therefore a genuinely
 * scarce resource, and admitting a batch request really does cost an
 * interactive one — which is the precondition for any isolation result to mean
 * anything.
 *
 * What this benchmark may not claim
 * ---------------------------------
 * Nothing here observes a GPU, an Ollama scheduler slot, or a KV cache. The
 * measured layer is admission: which requests Tyr let through, when, and what
 * the caller experienced. A rejected batch request never reaches Ollama, so no
 * preemption or reclamation of any kind is required for the result to hold —
 * and equally, none is evidenced by it. `EVIDENCE_LIMITS` below is carried into
 * every summary this benchmark writes so the boundary travels with the numbers.
 */

import { createHash } from "node:crypto";

import {
  buildRestorationContract,
  restorationEnforceability,
  validateUnlentSlice,
} from "./restoration-contract-lib.mjs";

/** Evidence sweep name; also the results/ subdirectory a run writes into. */
export const LOCAL_CONTENTION_SWEEP_NAME = "local-inference-contention";

/**
 * Loopback ports published by demo/ollama/compose-contention.yaml.
 *
 * Ollama is on neither 11434 (very likely an operator's own server) nor 11435
 * (the compatibility stack in compose.yaml, which `--keep-stack` may have left
 * running). Measuring a different server than the summary names is the failure
 * these numbers exist to prevent.
 */
export const CONTENTION_OLLAMA_PORT = 11436;
export const CONTENTION_LATCHFLO_PORT = 18085;
export const CONTENTION_IDENTITY_PORT = 9011;

/** Ollama implements the OpenAI Chat Completions surface and no other. */
export const CONTENTION_ENDPOINT = "/v1/chat/completions";

/**
 * The arms, in their canonical declaration order.
 *
 * `direct` is the control: no admission control at all, so Ollama's own FIFO
 * queue is the only thing standing between offered load and the model.
 *
 * `static` and `moflux` are numerically identical partitions of the same
 * physical capacity. The single variable between them is whether Latchflo may
 * lend an idle protected floor and restore it on demand. That is deliberate:
 * any difference the run measures has exactly one candidate cause.
 */
export const CONTENTION_ARMS = Object.freeze([
  Object.freeze({
    id: "direct",
    managed: false,
    pool: null,
    port: CONTENTION_OLLAMA_PORT,
    lending: false,
    summary: "requests go straight to Ollama; no admission control",
  }),
  Object.freeze({
    id: "static",
    managed: true,
    pool: "local-static",
    port: 18115,
    lending: false,
    summary: "fixed per-class protected floors, never lent",
  }),
  Object.freeze({
    id: "moflux",
    managed: true,
    pool: "local-moflux",
    port: 18116,
    lending: true,
    summary: "same floors, lent while idle and restored on demand",
  }),
]);

export const CONTENTION_ARM_IDS = Object.freeze(CONTENTION_ARMS.map((arm) => arm.id));

/** Arm descriptor by id; throws rather than returning undefined. */
export function contentionArm(id) {
  const arm = CONTENTION_ARMS.find((candidate) => candidate.id === id);
  if (arm === undefined) throw new Error(`unknown local-contention arm ${JSON.stringify(id)}`);
  return arm;
}

/**
 * Capacity policy for both managed arms.
 *
 * `maxConcurrent: 4` is pinned to `OLLAMA_NUM_PARALLEL=4` in the compose file.
 * An admission bound above the server's real parallelism would shed against
 * capacity that does not exist; a bound below it would leave the server idle
 * and make the managed arms win by not using the machine.
 *
 * The 3/1 concurrency split is the experiment. Because the two floors sum to
 * the physical ceiling there is no unreserved shared capacity, so under the
 * static policy neither class can ever exceed its own floor — batch is pinned
 * at one slot even while three interactive slots sit empty. That wasted
 * capacity is precisely what the lending arm is asked to recover.
 *
 * Token floors are configured, honest, and **not the binding constraint**. A
 * measured interactive request reserves on the order of 130 tokens and a batch
 * request about 460, so four concurrent requests never approach a 4,000-token
 * budget. They are configured anyway because Latchflo's `unlent_floor`
 * mechanism is defined over token capacity and cannot be exercised at all on a
 * concurrency-only policy — and because a run must be able to report which
 * limit actually bound rather than implying it was the interesting one.
 */
export const CONTENTION_POLICY = Object.freeze({
  physical: Object.freeze({
    maxConcurrent: 4,
    tokenBudget: 4_000,
    minimumGrantMaxConcurrent: 1,
    minimumGrantTokenBudget: 512,
  }),
  classes: Object.freeze({
    interactive: Object.freeze({
      globalProtectedConcurrent: 3,
      globalMaxConcurrent: 4,
      globalProtectedInFlightTokens: 2_400,
      globalMaxInFlightTokens: 4_000,
    }),
    batch: Object.freeze({
      globalProtectedConcurrent: 1,
      globalMaxConcurrent: 4,
      globalProtectedInFlightTokens: 1_600,
      globalMaxInFlightTokens: 4_000,
    }),
  }),
  /**
   * Half of each protected token floor is withheld from borrowing under
   * Latchflo 0.15.0's `unlent_floor` mechanism.
   *
   * A 50/50 split is interpretable rather than optimal: the allocation-enforced
   * half and the objective-only half are the same size, so the arm reports what
   * the mechanism withheld without that number being an artifact of how much
   * capacity each half happened to guard. Batch carries a slice too because
   * Latchflo requires a positive slice on every token-carrying class once the
   * policy uses `unlent_floor`.
   */
  unlentProtectedTokens: Object.freeze({ interactive: 1_200, batch: 800 }),
  lending: Object.freeze({
    /**
     * Grant lease length, and the single most consequential number here.
     *
     * Measured against `latchflo-control-plane:0.15.0`, lending and restoration
     * do not travel by the same path, and the asymmetry decides what a run of a
     * given length can observe at all:
     *
     *   Restoration is accelerated. Raising a protected floor requires the
     *   borrower to give capacity back, so the allocator stages an
     *   acknowledged handoff and commits as soon as every drain grant is
     *   applied and occupancy-ready — without waiting for the lease.
     *
     *   Lending is not. Lowering a floor strands nobody, so it needs no drain,
     *   the handoff path is skipped entirely, and the change is deferred to the
     *   next grant issuance. A new grant is issued only once the current lease
     *   has expired.
     *
     * That is a safety property rather than a defect — capacity returns fast
     * and leaves slowly — but it means no lend can land inside a run shorter
     * than the lease. At the 240 s lease the tenant-fairness scenario uses,
     * this benchmark measured a floor that was correctly computed as released
     * and never once applied, across 94 samples. Fifteen seconds is short
     * enough that a lend lands well inside the 35-second borrow window and long
     * enough that expiry is rare.
     *
     * The price is paid at every expiry: Latchflo issues the replacement grant
     * only after the old one is gone, so the pool briefly holds no grant and
     * Tyr admits nothing. That window is measured per run
     * (`leaseGapSamples`), gated, and reported rather than assumed away, and
     * both managed arms carry the identical lease so it is never a variable
     * between them.
     */
    grantTtlMs: 15_000,
    enrollmentTtlMs: 3_000,
    reportStaleAfterMs: 5_000,
    /**
     * How long a class must show no demand before its floor becomes lendable.
     *
     * Shorter than the interactive quiet window in the workload below, and by a
     * wide margin: a threshold close to that window would make "did the floor
     * get lent" a question about scheduler jitter rather than about policy.
     */
    idleAfterMs: 2_000,
    /**
     * Restoration objective for both resources. Deliberately not a guarantee —
     * see `restoration-contract-lib.mjs`. Latchflo stops issuing new borrowed
     * capacity immediately; capacity already in flight returns by attrition,
     * so the honest bound on an interactive request's wait is one batch
     * request's remaining decode.
     */
    restorationSloMs: 15_000,
    observeIntervalMs: 250,
    /** Samples taken after the offered-load window closes, to catch restoration. */
    postRunObserveMs: 20_000,
    /**
     * Share of samples in which the pool may hold no usable grant.
     *
     * A lease gap is a real cost of the short lease above and is reported, not
     * hidden — but past a few percent the arm is measuring the control plane's
     * reconcile loop rather than its admission policy, and the run should fail
     * instead of publishing that.
     */
    maxLeaseGapShare: 0.1,
  }),
});

/**
 * The deterministic five-phase workload, in milliseconds from the first
 * measured arrival. Warm-up is not in here: it is issued before the trace
 * starts and never enters a measured distribution.
 *
 *   phase 2  0 – 25s     interactive only, well below capacity. Establishes
 *                        that spare capacity exists and gives an uncontended
 *                        interactive baseline.
 *   phase 3  25 – 60s    interactive quiesces; batch starts. The interactive
 *                        floor is now idle, which is the only condition under
 *                        which Latchflo will lend it.
 *   phase 4  60 – 85s    interactive returns at double its earlier rate while
 *                        batch is still running. This is the critical window:
 *                        genuine overlap, and the moment the lent floor has to
 *                        come back.
 *   phase 5  85 – 105s   no new arrivals; drain and recovery.
 *
 * Rates are low because the server is slow. Measured on the reference host, an
 * interactive request costs roughly three seconds of exclusive server time and
 * a batch request about six. The schedule offers around 1.4x what the machine
 * can decode in the window — enough that admission decisions matter, far enough
 * from a stampede that the direct arm still finishes rather than collapsing
 * into a queue whose depth is the only thing being measured.
 *
 * Phase 3 is 35 seconds rather than the 20 that would suffice to create
 * contention. Interactive demand takes `idleAfterMs` to be recognised as idle
 * and a lend then waits for the next grant issuance, so the window has to
 * exceed `idleAfterMs + grantTtlMs` by a comfortable margin or the benchmark
 * would be testing whether a lend fits in the window rather than whether
 * lending helps.
 */
export const CONTENTION_WORKLOAD = Object.freeze({
  durationMs: 105_000,

  interactiveRps: 0.25,
  interactiveStartMs: 0,
  interactiveDurationMs: 25_000,
  interactiveInputChars: 400,
  interactiveMaxTokens: 32,

  batchStartMs: 25_000,
  batchDurationMs: 60_000,
  batchRps: 0.25,
  batchInputChars: 1_600,
  batchMaxTokens: 64,

  interactiveResumeStartMs: 60_000,
  interactiveResumeDurationMs: 25_000,
  interactiveResumeRps: 0.5,

  maxAttempts: 3,
  backoffBaseMs: 500,
  sizeDistribution: "uniform",
  interactiveSizeSigma: 0.75,
  batchSizeSigma: 0,
  inFlightCeiling: 3_000,
  windowMs: 105_000,
  /**
   * `temperature: 0` and the per-attempt seed the trace already carries make a
   * single arm's decode reproducible. They do **not** make two arms decode
   * identically: a rejected request retries under a different attempt index and
   * therefore a different seed, and the server's cache state differs. See
   * `EVIDENCE_LIMITS.decodeDeterminism`.
   */
  temperature: 0,
  drainIdleMs: 90_000,
  drainMaxMs: 300_000,
});

/**
 * Requests per class issued before the measured trace, per arm, per seed.
 *
 * Five is `adaptiveEstimation.minSamples`. Below that, Tyr's token estimate for
 * this model is still an untuned GPT-4o proxy, and the first measured requests
 * would be reserving against a number the controller was in the middle of
 * correcting. It also covers weight loading and the prompt-prefix cache for
 * both request shapes, so no measured request pays a cost that only the first
 * request of a run can pay.
 */
export const WARMUP_REQUESTS_PER_CLASS = 5;

/** Seeds required before a run may describe itself as publication quality. */
export const PUBLICATION_SEED_COUNT = 5;

/**
 * Claims this benchmark is structurally incapable of supporting, carried in
 * every summary it writes.
 *
 * Kept as data rather than prose because prose gets summarized away. A reader
 * who quotes the numbers gets these in the same file.
 */
export const EVIDENCE_LIMITS = Object.freeze({
  measuredLayer:
    "Admission only. Every number here is a decision Tyr made about whether to let a request " +
    "reach Ollama, plus what the caller then experienced.",
  gpuPreemption: "not-claimed: nothing in this stack observes or controls a GPU.",
  gpuUtilization: "not-measured: no GPU counter is read, so no utilization figure is reported.",
  kvCacheReclamation: "not-claimed: Ollama's KV cache is neither observed nor addressed.",
  ollamaSchedulerPreemption:
    "not-claimed: Ollama's internal scheduler is treated as an opaque FIFO with " +
    "OLLAMA_NUM_PARALLEL slots. A shed request is one that never arrived, not one that was preempted.",
  upstreamReclamation:
    "not-claimed: no arm here configures a borrowed-slot deadline, so no in-flight upstream " +
    "request is ever cancelled. Restoration is by attrition plus withheld allocation.",
  decodeDeterminism:
    "unverified: temperature is 0 and each attempt carries a trace-derived seed, but arms " +
    "differ in retry count and therefore in attempt seeds, and the server's prefix cache state " +
    "differs. Equal token totals would not evidence equal text and are not presented as doing so.",
  generalization:
    "none: qwen3:0.6b on a CPU-only containerised Ollama. The concurrency scaling that makes " +
    "this workload contended is a property of that configuration and does not transfer to a " +
    "GPU-backed server or a larger model.",
  productionScale:
    "none: single host, single model, single replica per arm, tens of requests per arm per seed.",
});

/**
 * Latchflo capacity-group body for one managed arm's pool.
 *
 * `lending: false` produces a pool whose class floors are fixed for the life of
 * the run. `lending: true` adds the admission-class demand policy and the
 * per-resource restoration contract Latchflo 0.15.0 requires alongside it. The
 * numeric limits are identical in both cases and come from one frozen policy
 * object, so the two arms cannot drift into partitioning different amounts of
 * capacity.
 */
export function contentionPoolDefinition(name, grantTtlMs, { lending }) {
  if (typeof lending !== "boolean") {
    throw new Error("contentionPoolDefinition requires an explicit lending flag");
  }
  if (!Number.isSafeInteger(grantTtlMs) || grantTtlMs < 1) {
    throw new Error("contentionPoolDefinition requires a positive integer grant TTL");
  }
  const policy = CONTENTION_POLICY;
  const restoration = lending
    ? buildRestorationContract({
        // Both classes declare a protected token floor, so Latchflo treats this
        // policy as token-aware and the upstream contract is mandatory.
        tokenAware: true,
        upstreamMechanism: "unlent_floor",
        admissionSlotSloMs: policy.lending.restorationSloMs,
        upstreamTokenSloMs: policy.lending.restorationSloMs,
      })
    : undefined;

  const classes = Object.fromEntries(
    Object.entries(policy.classes).map(([admissionClass, limits]) => {
      if (!lending) return [admissionClass, limits];
      const unlentTokens = policy.unlentProtectedTokens[admissionClass];
      // Mirror Latchflo's own per-class rules so a bad split fails here, naming
      // the class, rather than at pool creation naming a wire path.
      validateUnlentSlice({
        label: `${name}.${admissionClass}.globalUnlentProtectedInFlightTokens`,
        unlentTokens,
        protectedTokens: limits.globalProtectedInFlightTokens,
        contract: restoration,
        lendingEnabled: true,
      });
      return [
        admissionClass,
        { ...limits, globalUnlentProtectedInFlightTokens: unlentTokens },
      ];
    }),
  );

  const floorConcurrent = Object.values(policy.classes)
    .reduce((sum, limits) => sum + limits.globalProtectedConcurrent, 0);
  if (floorConcurrent > policy.physical.maxConcurrent) {
    throw new Error(
      `protected concurrency floors sum to ${floorConcurrent}, above the pool ceiling ` +
        `${policy.physical.maxConcurrent}; Latchflo cannot grant a partition it does not have`,
    );
  }
  const floorTokens = Object.values(policy.classes)
    .reduce((sum, limits) => sum + limits.globalProtectedInFlightTokens, 0);
  if (floorTokens > policy.physical.tokenBudget) {
    throw new Error(
      `protected token floors sum to ${floorTokens}, above the pool budget ${policy.physical.tokenBudget}`,
    );
  }

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
    admissionClassLimits: classes,
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

/**
 * What each arm's configured mechanism entitles it to claim, in Latchflo's own
 * enforceability vocabulary.
 *
 * A non-lending arm has no restoration contract because it never lends, which
 * is a stronger position than any mechanism and is reported as such rather than
 * as a missing field.
 */
export function contentionRestorationClaim(armId) {
  const arm = contentionArm(armId);
  if (!arm.managed) return null;
  if (!arm.lending) {
    return Object.freeze({
      arm: armId,
      contract: null,
      // Not a mechanism and not an omission. A policy that never lends has
      // nothing to restore, which is stronger than any restoration contract and
      // is exactly the trade this arm is here to price.
      enforceability: Object.freeze({
        admissionSlots: "never-lent",
        upstreamCapacity: "never-lent",
      }),
      unlentProtectedTokens: Object.freeze(
        Object.fromEntries(
          Object.entries(CONTENTION_POLICY.classes).map(([admissionClass, limits]) => [
            admissionClass,
            limits.globalProtectedInFlightTokens,
          ]),
        ),
      ),
      upstreamReclamation: "not-claimed",
    });
  }
  const { admissionClassDemandPolicy } = contentionPoolDefinition("probe", 60_000, {
    lending: true,
  });
  const contract = admissionClassDemandPolicy.restoration;
  return Object.freeze({
    arm: armId,
    contract,
    enforceability: restorationEnforceability(contract),
    unlentProtectedTokens: Object.freeze({ ...CONTENTION_POLICY.unlentProtectedTokens }),
    /** Latchflo withholds the unlent slice; it never reclaims provider-side tokens. */
    upstreamReclamation: "not-claimed",
  });
}

/** Nominal per-class grant a single-agent pool must receive from Latchflo. */
export function nominalClassGrant() {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(CONTENTION_POLICY.classes).map(([admissionClass, limits]) => [
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

/**
 * Deterministic, counterbalanced arm order for one seed.
 *
 * Two effects have to be balanced away, and rotation alone balances only the
 * first. Position matters because the machine warms and thermally throttles
 * over a run; adjacency matters because the arm that follows `direct` inherits
 * a server that has just been driven into a deep queue. Rotating by seed index
 * and reversing every full cycle gives every arm every position and both
 * neighbours across a five-seed sweep, from a rule that is a pure function of
 * the index rather than a shuffle nobody can replay.
 */
export function armOrderForSeedIndex(index, arms = CONTENTION_ARM_IDS) {
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

/** Every arm order the sweep will use, for the record and for the proof. */
export function armOrderPlan(seeds, arms = CONTENTION_ARM_IDS) {
  return Object.freeze(
    seeds.map((seed, index) => Object.freeze({ seed, order: armOrderForSeedIndex(index, arms) })),
  );
}

/**
 * True when every arm appeared in every position at least once.
 *
 * Reported rather than enforced. A three-seed development run cannot satisfy it
 * and should still produce a readable result; a publication run that cannot is
 * a run whose ordering did not do the job it was there to do.
 */
export function armOrderIsCounterbalanced(plan, arms = CONTENTION_ARM_IDS) {
  if (plan.length === 0) return false;
  return arms.every((arm) =>
    arms.every((_, position) => plan.some((entry) => entry.order[position] === arm)),
  );
}

/** Nearest-rank percentile over finite values only; null when there are none. */
export function percentile(values, quantile) {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return null;
  const index = Math.min(
    finite.length - 1,
    Math.max(0, Math.ceil(quantile * finite.length) - 1),
  );
  return +finite[index].toFixed(2);
}

/** Median helper used for cross-seed aggregates. */
export function median(values) {
  return percentile(values, 0.5);
}

function count(value) {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

/**
 * A finite number, or `null`. Used wherever a value may legitimately be absent.
 *
 * `0` and "missing" are different claims and the summary must not conflate
 * them. Before 0.34.0 a window in which every request was rejected reported
 * `ttftP95Ms: 0`, which reads as the fastest window in the run.
 */
function observed(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * One phase window, with counts and rates kept numeric and distributions kept
 * honest.
 *
 * `completed: 0` really is zero completions and `goodputRps: 0` really is zero
 * useful work per second — both are measurements. The four percentiles are
 * `null` at zero completions, and are forced to `null` even if an upstream
 * summary supplied a zero, so a summary produced by an older load generator
 * cannot reintroduce the lie through this path.
 */
function windowMetrics(window, { sloGoodputRps = null } = {}) {
  if (!window) return null;
  const completed = count(window.completed);
  const distribution = (value) => (completed > 0 ? observed(value) : null);
  return Object.freeze({
    completed,
    goodputRps: observed(window.goodputRps),
    sloGoodputRps,
    latencyP50Ms: distribution(window.p50Ms),
    latencyP95Ms: distribution(window.p95Ms),
    ttftP50Ms: distribution(window.ttftP50Ms),
    ttftP95Ms: distribution(window.ttftP95Ms),
  });
}

function phaseArrivalMs(sample) {
  const arrival = Number(sample?.arrivalMs);
  if (Number.isFinite(arrival)) return arrival;
  const legacy = Number(sample?.offsetMs);
  return Number.isFinite(legacy) ? legacy : null;
}

function contentionSloGoodput(samples, loadgenSummary) {
  const config = loadgenSummary?.config ?? {};
  const fromMs = Number(config.interactiveResumeStartMs ?? CONTENTION_WORKLOAD.interactiveResumeStartMs);
  const durationMs = Number(config.interactiveResumeDurationMs ?? CONTENTION_WORKLOAD.interactiveResumeDurationMs);
  const toMs = fromMs + durationMs;
  if (!(durationMs > 0)) return null;
  const useful = samples.filter((sample) => {
    const arrivalMs = phaseArrivalMs(sample);
    return (
      arrivalMs !== null &&
      arrivalMs >= fromMs &&
      arrivalMs < toMs &&
      Number(sample?.ttftMs) <= HYPOTHESIS_THRESHOLDS.interactiveSloTtftMaxMs &&
      Number(sample?.latencyMs) <= HYPOTHESIS_THRESHOLDS.interactiveSloLatencyMaxMs
    );
  }).length;
  return +(useful / (durationMs / 1000)).toFixed(4);
}

/**
 * Per-class metrics for one arm, read straight off a load-generator summary.
 *
 * Every field is either something the client observed or something Tyr told it
 * in a response header. Nothing is inferred about the server's internal state.
 */
export function summarizeArmClasses(loadgenSummary) {
  const classes = loadgenSummary?.classes ?? {};
  const out = {};
  for (const workload of ["interactive", "batch"]) {
    const values = classes[workload] ?? {};
    const windows = values.windows ?? {};
    const logical = count(values.logical);
    const success = count(values.success);
    const samples = Array.isArray(values.phaseSamples) ? values.phaseSamples : [];
    const latencies = samples.map((sample) => Number(sample.latencyMs));
    const ttfts = samples.map((sample) => Number(sample.ttftMs));
    const durationMs = Number(
      loadgenSummary?.config?.durationMs ??
        loadgenSummary?.workload?.durationMs ??
        CONTENTION_WORKLOAD.durationMs,
    );
    const spanSeconds = durationMs / 1000;
    const interactiveSloGoodput =
      workload === "interactive" ? contentionSloGoodput(samples, loadgenSummary) : null;
    out[workload] = Object.freeze({
      logical,
      attempts: count(values.attempts),
      success,
      successRate: logical > 0 ? +(success / logical).toFixed(4) : null,
      goodputRps: spanSeconds > 0 ? +(success / spanSeconds).toFixed(4) : null,
      // `percentile` is already null-on-empty; the class carries `success` so a
      // reader can tell a missing distribution from a fast one.
      ttftMs: Object.freeze({
        p50: percentile(ttfts, 0.5),
        p95: percentile(ttfts, 0.95),
      }),
      latencyMs: Object.freeze({
        p50: percentile(latencies, 0.5),
        p95: percentile(latencies, 0.95),
      }),
      completionTokens: count(values.outputTokens),
      promptTokens: count(values.inputTokens),
      totalTokens: count(values.outputTokens) + count(values.inputTokens),
      /** Admission refusals: Tyr said no before any upstream work was spent. */
      rejectedAdmissions: count(values.localReject),
      rejectionReasons: Object.freeze({ ...(values.localRejectReasons ?? {}) }),
      rejectionConstraints: Object.freeze({ ...(values.localRejectConstraints ?? {}) }),
      /** Zero by construction: no arm here configures a borrowed-slot deadline. */
      deadlineAbandonments: count(values.borrowedDeadlineAbandoned),
      tornStreams: count(values.transportError),
      serverErrors: count(values.serverError),
      upstreamRejects: count(values.upstreamReject),
      exhausted: count(values.exhausted),
      admissionClassResponses: Object.freeze({ ...(values.admissionClassResponses ?? {}) }),
      windows: Object.freeze({
        idle: windowMetrics(windows.idle),
        borrow: windowMetrics(windows.borrow),
        contention: windowMetrics(windows.contention, { sloGoodputRps: interactiveSloGoodput }),
        drainCompleted: count(windows.drainCompleted),
      }),
    });
  }
  return Object.freeze(out);
}

/**
 * A ratio, or `null` when either side is missing.
 *
 * A ratio built from an absent latency distribution is not zero and not
 * infinite; it is undefined, and the only honest way to carry it is `null`.
 * `bottom <= 0` is refused for the same reason a division by zero is.
 */
function ratio(numerator, denominator) {
  const top = observed(numerator);
  const bottom = observed(denominator);
  if (top === null || bottom === null || bottom <= 0) return null;
  return +(top / bottom).toFixed(4);
}

/**
 * Pre-registered effect sizes for the two performance hypotheses.
 *
 * Fixed here, in the library, rather than derived from a run. A threshold
 * chosen after seeing the data is not a test. Both are deliberately coarse:
 * this is a five-seed benchmark on one machine, and an effect that needs a
 * tighter threshold than these to be visible is not one this design can claim.
 */
export const HYPOTHESIS_THRESHOLDS = Object.freeze({
  /** A latency-sensitive interactive request must produce a first token within 5 s. */
  interactiveSloTtftMaxMs: 5_000,
  /** And it must finish within 30 s to count as useful work. */
  interactiveSloLatencyMaxMs: 30_000,
  /** H1: at least one additional SLO-good completion per 25 s contention window. */
  interactiveSloGoodputDeltaMinRps: 0.04,
  /** H2: batch work done while the interactive floor is idle, versus static. */
  batchBorrowRatioMin: 1.2,
});

/**
 * Cross-arm comparison for one seed.
 *
 * The contention window (interactive back, batch still running) is the window
 * H1 is about; the borrow window (interactive quiet, batch running) is the one
 * H2 is about. Both are fixed offsets from the trace, identical in every arm,
 * so the windows are comparable by construction rather than by inspection.
 */
export function compareLocalContention(arms) {
  const ids = Object.keys(arms);
  const traceHashes = [...new Set(ids.map((id) => arms[id]?.trace?.hash))];
  const interactive = Object.fromEntries(
    ids.map((id) => [id, arms[id]?.classes?.interactive ?? null]),
  );
  const batch = Object.fromEntries(ids.map((id) => [id, arms[id]?.classes?.batch ?? null]));

  const contention = (id, workload) =>
    (workload === "interactive" ? interactive : batch)[id]?.windows?.contention ?? null;
  const borrow = (id, workload) =>
    (workload === "interactive" ? interactive : batch)[id]?.windows?.borrow ?? null;

  const interactiveTtftRatio = ratio(
    contention("moflux", "interactive")?.ttftP95Ms,
    contention("direct", "interactive")?.ttftP95Ms,
  );
  const interactiveGoodputRatio = ratio(
    contention("moflux", "interactive")?.goodputRps,
    contention("direct", "interactive")?.goodputRps,
  );
  const interactiveSloGoodputDelta = (() => {
    const moflux = Number(contention("moflux", "interactive")?.sloGoodputRps);
    const direct = Number(contention("direct", "interactive")?.sloGoodputRps);
    return Number.isFinite(moflux) && Number.isFinite(direct) ? +(moflux - direct).toFixed(4) : null;
  })();
  const batchBorrowRatio = ratio(
    borrow("moflux", "batch")?.completed,
    borrow("static", "batch")?.completed,
  );

  return Object.freeze({
    traceHashMatches: traceHashes.length === 1 && typeof traceHashes[0] === "string",
    traceHash: traceHashes.length === 1 ? traceHashes[0] : null,
    interactive: Object.freeze(interactive),
    batch: Object.freeze(batch),
    /** Descriptive only: successful-request tail latency under contention. */
    interactiveTtftP95RatioVsDirect: interactiveTtftRatio,
    /** Descriptive only: all successful interactive work, regardless of SLO. */
    interactiveGoodputRatioVsDirect: interactiveGoodputRatio,
    /** H1: useful interactive work, charging both deep queues and local rejection. */
    interactiveSloGoodputDeltaRpsVsDirect: interactiveSloGoodputDelta,
    /** H2: batch completions while the interactive floor was idle, versus static. */
    batchBorrowWindowRatioVsStatic: batchBorrowRatio,
    batchBorrowWindowCompleted: Object.freeze(
      Object.fromEntries(ids.map((id) => [id, borrow(id, "batch")?.completed ?? 0])),
    ),
    interactiveContentionTtftP95Ms: Object.freeze(
      Object.fromEntries(ids.map((id) => [id, contention(id, "interactive")?.ttftP95Ms ?? null])),
    ),
    interactiveContentionGoodputRps: Object.freeze(
      Object.fromEntries(ids.map((id) => [id, contention(id, "interactive")?.goodputRps ?? null])),
    ),
    interactiveContentionSloGoodputRps: Object.freeze(
      Object.fromEntries(ids.map((id) => [id, contention(id, "interactive")?.sloGoodputRps ?? null])),
    ),
  });
}

function classSample(sample, admissionClass) {
  return sample?.classes?.[admissionClass] ?? null;
}

/**
 * The three demand states this benchmark reasons about, and what each means.
 *
 * `idle` is the only one under which a floor may be lent, so it is the only one
 * the safety argument treats as "nobody is asking for this capacity". Latchflo
 * 0.15.0 reports `demanding`, `protected` and `idle`; `protected` is the state
 * of a class that is still holding its floor but is not currently pressing on
 * it, and collapsing it into `idle` would let a demand episode fragment at
 * every lull and re-baseline its grandfathered borrowers each time.
 */
export const DEMAND_STATES = Object.freeze(["idle", "protected", "demanding"]);

/**
 * Whether a class is asking for its protected capacity at this sample, and the
 * single piece of evidence that settled it.
 *
 * The predicate deliberately does **not** rest on admissions. 0.33.2 measured
 * demand as `inFlight > 0 || recentAdmissions > 0`, which is unobservable in
 * precisely the case restoration exists for: when borrowers hold the whole
 * pool, the returning owner is rejected on every attempt and is never admitted
 * and never in flight. Across the four completed 0.33.2 seeds that produced
 * eight lending episodes and zero restoration-required episodes, while the
 * sampled series plainly showed interactive being refused for twenty-five
 * seconds. A rejection is demand; so is the controller's own demand state.
 *
 * Ordering is by evidential strength, not by convenience: a caller reading
 * `reason` should get the strongest thing that was true, so `admission` beats
 * `rejection` beats the controller's opinion.
 */
export function classDemandActivity(observed) {
  if (observed === null || observed === undefined) {
    return Object.freeze({ active: false, reason: "no-sample", state: null });
  }
  const state = typeof observed.demandState === "string" ? observed.demandState : null;
  const inFlight = Number(observed.inFlight ?? 0);
  const recentAdmissions = Number(observed.recentAdmissions ?? 0);
  const recentRejections = Number(observed.recentRejections ?? 0);
  const restorationPending = observed.restorationPending === true;
  const decide = (active, reason) => Object.freeze({ active, reason, state });
  if (inFlight > 0) return decide(true, "in-flight");
  if (recentAdmissions > 0) return decide(true, "admission");
  if (recentRejections > 0) return decide(true, "rejection");
  if (restorationPending) return decide(true, "restoration-pending");
  if (state !== null && state !== "idle") return decide(true, `controller-state:${state}`);
  return decide(false, state === null ? "no-controller-view" : `controller-state:${state}`);
}

/**
 * How much of another class's nominal floor a class is currently occupying.
 *
 * This replaces the sampled `borrowedConcurrent` field as the basis for the
 * post-demand-return safety argument, and the seed-4 false positive at 29.896 s
 * is the reason. `borrowedConcurrent` is Tyr's "in flight above my own
 * *applied* floor", and a class's applied floor drops to zero when its own
 * floor has been lent out while it was idle. Batch's very first request of the
 * borrow phase therefore reported `borrowedConcurrent: 0 -> 1` while occupying
 * nothing but the single slot batch owns outright, and the invariant read that
 * as batch taking capacity from a protected interactive floor that was in fact
 * whole, untouched, and three slots wide.
 *
 * Measured against the *nominal* partition the question is well posed. The
 * floors sum to the physical ceiling, so occupancy above a class's own nominal
 * floor is exactly the occupancy that must be coming out of some other class's
 * reserved capacity — whoever lent it and whenever the applied grant catches up.
 */
export function classEncroachment(sample, admissionClass, nominal = nominalClassGrant()) {
  const observed = classSample(sample, admissionClass);
  if (observed === null) return 0;
  const floor = Number(nominal[admissionClass]?.protectedConcurrent ?? 0);
  return Math.max(0, Number(observed.inFlight ?? 0) - floor);
}

/**
 * Capacity invariants checked against every `/stats` sample of the lending arm.
 *
 * These are the H3/H4 questions, and they are asked of the data plane rather
 * than of the control plane's own account of itself. Each returns the sample
 * offsets at which it failed, so a violation is locatable rather than merely
 * counted.
 */
export function capacityInvariantViolations(samples, { unlentProtectedTokens } = {}) {
  const nominal = nominalClassGrant();
  const unlent = unlentProtectedTokens ?? CONTENTION_POLICY.unlentProtectedTokens;
  const violations = {
    /** Applied floor fell below the slice Latchflo promised never to lend. */
    unlentFloorViolations: [],
    /** Class in flight above the ceiling that class was granted. */
    classCeilingViolations: [],
    /** Ceiling granted above the nominal ceiling: capacity conjured, not moved. */
    ceilingOverAllocations: [],
    /** Sum of in-flight work above the pool's own grant. */
    poolOverAllocations: [],
    /** Protected floors summing above the capacity they are carved from. */
    floorSumOverAllocations: [],
    /**
     * H4b: batch occupancy of interactive's nominal floor grew after protected
     * interactive demand returned, beyond what was already in flight.
     */
    borrowGrowthAfterDemandReturn: [],
  };

  /**
   * Samples in which the pool held no usable grant at all.
   *
   * Not a violation, and deliberately not counted as one. Latchflo issues a
   * replacement grant only after the previous lease has expired, so a short
   * lease buys mid-run lending at the cost of a brief window per expiry in
   * which Tyr has nothing to enforce and admits nothing. Recording it as a
   * floor violation would be wrong — no floor was breached, there was no floor
   * — and ignoring it would hide a real cost of the configuration.
   */
  const leaseGaps = [];
  /**
   * The current protected-demand episode's borrowing entitlement.
   *
   * `allowed` starts at whatever batch already had in flight above its own
   * nominal floor when the episode opened — those borrowers were admitted
   * legitimately and restoration here is non-preemptive, so they are
   * grandfathered. It then *ratchets down*: when a grandfathered borrower
   * finishes, the slot belongs to the protected class again and may not be
   * refilled. Without the ratchet a borrower that completes and is immediately
   * replaced looks identical to one that never left, and continuous churn
   * against a restored floor would pass a check that only compared levels.
   */
  let demandEpisode = null;
  const demandTransitions = [];
  const previousActivity = new Map();

  for (const sample of samples) {
    const offsetMs = Number(sample?.offsetMs ?? 0);
    const poolMaxConcurrent = Number(sample?.pool?.maxConcurrent ?? 0);
    const poolTokenBudget = Number(sample?.pool?.tokenBudget ?? 0);
    if (poolMaxConcurrent < 1) {
      leaseGaps.push({ offsetMs, observed: poolMaxConcurrent, reason: "pool held no usable grant" });
      // A lease gap breaks continuity in the sampled occupancy series; do not
      // infer a new admission across a period in which no grant was observable.
      demandEpisode = null;
      continue;
    }
    let inFlightSum = 0;
    let tokensSum = 0;
    let floorConcurrentSum = 0;
    let floorTokensSum = 0;
    let borrowedSum = 0;

    for (const admissionClass of Object.keys(nominal)) {
      const observed = classSample(sample, admissionClass);
      if (observed === null) continue;
      const limits = observed.limits ?? {};
      const applied = {
        protectedConcurrent: Number(limits.protectedConcurrent ?? 0),
        maxConcurrent: Number(limits.maxConcurrent ?? 0),
        protectedInFlightTokens: Number(limits.protectedInFlightTokens ?? 0),
        maxInFlightTokens: Number(limits.maxInFlightTokens ?? 0),
      };
      const inFlight = Number(observed.inFlight ?? 0);
      const inFlightTokens = Number(observed.inFlightTokens ?? 0);
      inFlightSum += inFlight;
      tokensSum += inFlightTokens;
      floorConcurrentSum += applied.protectedConcurrent;
      floorTokensSum += applied.protectedInFlightTokens;
      borrowedSum += Number(observed.borrowedConcurrent ?? 0);

      if (applied.protectedInFlightTokens < unlent[admissionClass]) {
        violations.unlentFloorViolations.push({
          offsetMs,
          admissionClass,
          observed: applied.protectedInFlightTokens,
          threshold: unlent[admissionClass],
          reason: "applied protected token floor fell below the unlent slice",
        });
      }
      if (inFlight > applied.maxConcurrent && applied.maxConcurrent > 0) {
        violations.classCeilingViolations.push({
          offsetMs,
          admissionClass,
          observed: inFlight,
          threshold: applied.maxConcurrent,
          reason: "class in-flight exceeded its granted concurrency ceiling",
        });
      }
      if (
        applied.maxConcurrent > nominal[admissionClass].maxConcurrent ||
        applied.maxInFlightTokens > nominal[admissionClass].maxInFlightTokens
      ) {
        ceilingOverAllocation(violations, offsetMs, admissionClass, applied, nominal);
      }
    }

    if (poolMaxConcurrent > 0 && inFlightSum > poolMaxConcurrent) {
      violations.poolOverAllocations.push({
        offsetMs,
        observed: inFlightSum,
        threshold: poolMaxConcurrent,
        reason: "in-flight requests exceeded the pool concurrency grant",
      });
    }
    if (poolTokenBudget > 0 && tokensSum > poolTokenBudget) {
      violations.poolOverAllocations.push({
        offsetMs,
        observed: tokensSum,
        threshold: poolTokenBudget,
        reason: "in-flight tokens exceeded the pool token grant",
      });
    }
    if (poolMaxConcurrent > 0 && floorConcurrentSum > poolMaxConcurrent) {
      violations.floorSumOverAllocations.push({
        offsetMs,
        observed: floorConcurrentSum,
        threshold: poolMaxConcurrent,
        reason: "protected concurrency floors summed above the pool grant",
      });
    }
    if (poolTokenBudget > 0 && floorTokensSum > poolTokenBudget) {
      violations.floorSumOverAllocations.push({
        offsetMs,
        observed: floorTokensSum,
        threshold: poolTokenBudget,
        reason: "protected token floors summed above the pool grant",
      });
    }
    // H4b, and the only safety question the sampled state can actually settle
    // about borrowing. Restoration here is non-preemptive, so a borrower
    // admitted while capacity was lent is entitled to finish; what must not
    // happen is that batch takes *more* of interactive's nominal floor after
    // interactive has come back for it.
    //
    // Encroachment is measured against the nominal partition rather than the
    // applied one — see `classEncroachment` for why the applied floor produced
    // a false positive at 29.896 s on the 0.33.2 seed 4 — and the entitlement
    // ratchets down as grandfathered borrowers drain, so refilling a freed slot
    // is caught rather than mistaken for the same borrower still running.
    const interactive = classSample(sample, "interactive");
    const activity = classDemandActivity(interactive);
    const batchEncroachment = classEncroachment(sample, "batch", nominal);
    const interactiveReleasedConcurrent = Number(interactive?.releasedConcurrent ?? 0);

    for (const admissionClass of Object.keys(nominal)) {
      const observed = classSample(sample, admissionClass);
      const current = classDemandActivity(observed);
      const previous = previousActivity.get(admissionClass) ?? null;
      if (previous === null || previous.active !== current.active || previous.state !== current.state) {
        demandTransitions.push(
          demandTransition({ sample, offsetMs, admissionClass, observed, previous, current }),
        );
      }
      previousActivity.set(admissionClass, current);
    }

    if (activity.active) {
      if (demandEpisode === null) {
        demandEpisode = {
          startedAtMs: offsetMs,
          grandfathered: batchEncroachment,
          allowed: batchEncroachment,
        };
      }
      // The ratchet: capacity a grandfathered borrower gives back is not lent
      // out again while its owner is still asking for it.
      demandEpisode.allowed = Math.min(demandEpisode.allowed, batchEncroachment);
      const allowedEncroachment = demandEpisode.allowed + interactiveReleasedConcurrent;
      if (batchEncroachment > allowedEncroachment) {
        violations.borrowGrowthAfterDemandReturn.push({
          offsetMs,
          admissionClass: "batch",
          observed: {
            batchInFlight: Number(classSample(sample, "batch")?.inFlight ?? 0),
            encroachment: batchEncroachment,
            grandfathered: demandEpisode.grandfathered,
            entitlementAfterAttrition: demandEpisode.allowed,
            interactiveReleasedConcurrent,
            protectedDemandSince: demandEpisode.startedAtMs,
            protectedDemandEvidence: activity.reason,
          },
          threshold: `<= ${allowedEncroachment} while protected interactive demand is active`,
          reason:
            "batch occupied more of interactive's nominal protected floor than the borrowers " +
            "already in flight when interactive demand returned, and more than interactive " +
            "currently has explicitly released",
        });
        // One episode reports one entitlement breach; re-baseline to the level
        // now observed so a single sustained violation is not counted once per
        // 250 ms sample for the rest of the window.
        demandEpisode.allowed = batchEncroachment;
      }
    } else {
      // Once protected demand is idle again, lending may resume and a later
      // demand episode gets a fresh grandfathered baseline.
      demandEpisode = null;
    }
  }

  const total = Object.values(violations).reduce((sum, rows) => sum + rows.length, 0);
  const frozen = Object.fromEntries(
    Object.entries(violations).map(([key, rows]) => [key, Object.freeze(rows)]),
  );
  return Object.freeze({
    samples: samples.length,
    total,
    leaseGapSamples: leaseGaps.length,
    leaseGapShare:
      samples.length > 0 ? +(leaseGaps.length / samples.length).toFixed(4) : null,
    leaseGaps: Object.freeze(leaseGaps),
    ...frozen,
    /**
     * H4a: the transfer-safety violations, which are about capacity being
     * created, over-allocated, or moved below a floor that was promised never
     * to move. Deliberately separate from `borrowGrowthAfterDemandReturn`,
     * which is about *timing* rather than about an unsafe transfer.
     */
    transferSafetyViolations:
      frozen.unlentFloorViolations.length +
      frozen.classCeilingViolations.length +
      frozen.ceilingOverAllocations.length +
      frozen.poolOverAllocations.length +
      frozen.floorSumOverAllocations.length,
    /** Every observed demand-state change, for both classes, in sample order. */
    demandTransitions: Object.freeze(demandTransitions),
    /**
     * Deprecated alias for `borrowGrowthAfterDemandReturn`, kept for one release
     * so a reader holding a 0.33.x summary schema does not silently see zero.
     * The name was wrong: the check was never about restoration.
     */
    borrowedGrowthAfterRestoration: frozen.borrowGrowthAfterDemandReturn,
  });
}

/**
 * One demand-state change, with the state that produced it.
 *
 * Recorded from the sampled series rather than from a log line, because the
 * question a reader has at 60 s is not "what did the controller print" but
 * "what was true about the grant, the occupancy and the counters at the instant
 * the class was considered active again".
 */
function demandTransition({ sample, offsetMs, admissionClass, observed, previous, current }) {
  const limits = observed?.limits ?? {};
  return Object.freeze({
    atMs: offsetMs,
    class: admissionClass,
    from: previous === null ? null : previous.state ?? (previous.active ? "active" : "idle"),
    to: current.state ?? (current.active ? "active" : "idle"),
    fromActive: previous === null ? null : previous.active,
    toActive: current.active,
    reason: current.reason,
    recentAdmissions: Number(observed?.recentAdmissions ?? 0),
    recentRejections: Number(observed?.recentRejections ?? 0),
    inFlight: Number(observed?.inFlight ?? 0),
    inFlightTokens: Number(observed?.inFlightTokens ?? 0),
    protectedConcurrentInUse: Number(observed?.protectedConcurrentInUse ?? 0),
    borrowedConcurrent: Number(observed?.borrowedConcurrent ?? 0),
    restorationPending: observed?.restorationPending === true,
    grant: Object.freeze({
      protectedConcurrent: Number(limits.protectedConcurrent ?? 0),
      maxConcurrent: Number(limits.maxConcurrent ?? 0),
      protectedInFlightTokens: Number(limits.protectedInFlightTokens ?? 0),
      maxInFlightTokens: Number(limits.maxInFlightTokens ?? 0),
      releasedConcurrent: Number(observed?.releasedConcurrent ?? 0),
      releasedTokens: Number(observed?.releasedTokens ?? 0),
    }),
    pool: Object.freeze({
      maxConcurrent: Number(sample?.pool?.maxConcurrent ?? 0),
      inFlight: Number(sample?.pool?.inFlight ?? 0),
    }),
  });
}

function ceilingOverAllocation(violations, offsetMs, admissionClass, applied, nominal) {
  violations.ceilingOverAllocations.push({
    offsetMs,
    admissionClass,
    observed: {
      maxConcurrent: applied.maxConcurrent,
      maxInFlightTokens: applied.maxInFlightTokens,
    },
    threshold: {
      maxConcurrent: nominal[admissionClass].maxConcurrent,
      maxInFlightTokens: nominal[admissionClass].maxInFlightTokens,
    },
    reason: "granted ceiling exceeded the nominal ceiling",
  });
}

/**
 * Lending and restoration episodes, derived from the applied grant series.
 *
 * What a restoration-required episode is
 * --------------------------------------
 * Capacity belonging to a protected class was lent; its owner came back for it
 * while it was still lent; the controller therefore had something meaningful to
 * restore. All three conjuncts matter, and 0.33.2 could satisfy none of them
 * reliably:
 *
 *   - Demand return was detected as `inFlight > 0 || recentAdmissions > 0`.
 *     That is unobservable in exactly the case restoration is for. When the
 *     borrowers hold every slot in the pool, the returning owner is refused on
 *     every attempt: never admitted, never in flight. Four real seeds produced
 *     eight lending episodes and zero restoration-required episodes while the
 *     samples plainly showed interactive being rejected for twenty-five
 *     seconds. `classDemandActivity` now counts a rejection and the
 *     controller's own demand state as the demand they are.
 *
 *   - A floor that simply came back — because a lease rolled over, or because
 *     the class went idle and the nominal partition was reissued — was recorded
 *     with `restoredAtMs` set and `demandReturnedAtMs` null, which reads as a
 *     restoration and is not one. Those are now `passive-return` and are
 *     counted separately, never as restorations.
 *
 *   - Restoration was declared complete when the *allocation* returned. On the
 *     0.33.2 seed 4 the interactive floor was whole again 0 ms after demand
 *     returned and interactive still could not run for another 27 seconds,
 *     because four batch requests admitted before the lend held the entire
 *     physical pool and nothing preempts them. An episode therefore carries
 *     both instants: `restoredAtMs` for the grant and `occupancyRestoredAtMs`
 *     for the moment the protected class could actually use its floor. Quoting
 *     only the first would price restoration at zero.
 */
export function summarizeLendingEpisodes(samples, { restorationSloMs } = {}) {
  const nominalGrant = nominalClassGrant();
  const nominal = nominalGrant.interactive;
  const slo = Number.isFinite(restorationSloMs)
    ? restorationSloMs
    : CONTENTION_POLICY.lending.restorationSloMs;
  const ordered = [...samples].sort(
    (a, b) => Number(a.offsetMs ?? 0) - Number(b.offsetMs ?? 0),
  );
  const episodes = [];
  let open = null;
  let peakBorrowedConcurrent = 0;
  let peakLentConcurrent = 0;

  /** Closes an episode, resolving every derived timestamp from what was seen. */
  const close = (episode) => {
    const restorationRequired = episode.demandReturnedAtMs !== null;
    const restorationLatencyMs =
      restorationRequired && episode.restoredAtMs !== null
        ? episode.restoredAtMs - episode.demandReturnedAtMs
        : null;
    const occupancyRestorationLatencyMs =
      restorationRequired && episode.occupancyRestoredAtMs !== null
        ? episode.occupancyRestoredAtMs - episode.demandReturnedAtMs
        : null;
    const outcome = !restorationRequired
      ? episode.restoredAtMs === null
        ? "open-at-end-of-run"
        : "passive-return"
      : episode.restoredAtMs === null
        ? "unrestored"
        : "restored";
    return Object.freeze({
      ...episode,
      restorationRequired,
      restorationLatencyMs,
      occupancyRestorationLatencyMs,
      /** The grant came back within the objective. */
      withinRestorationSlo:
        restorationLatencyMs === null ? null : restorationLatencyMs <= slo,
      /**
       * The class could *use* its floor within the objective. This is the one a
       * caller feels, and it is the one that can be false while the grant-side
       * number reads as sub-second.
       */
      occupancyWithinRestorationSlo:
        occupancyRestorationLatencyMs === null
          ? null
          : occupancyRestorationLatencyMs <= slo,
      outcome,
    });
  };

  for (const sample of ordered) {
    // A lease gap is absence of an applied grant, not a policy decision to lend
    // the floor. Skipping it prevents the static arm from manufacturing lending
    // episodes at every lease rollover.
    if (Number(sample?.pool?.maxConcurrent ?? 0) < 1) continue;
    const observed = classSample(sample, "interactive");
    const batch = classSample(sample, "batch");
    if (observed === null) continue;
    const offsetMs = Number(sample.offsetMs ?? 0);
    const appliedFloor = Number(observed.limits?.protectedConcurrent ?? 0);
    const appliedTokenFloor = Number(observed.limits?.protectedInFlightTokens ?? 0);
    const lent = appliedFloor < nominal.protectedConcurrent;
    const activity = classDemandActivity(observed);
    const batchBorrowed = Number(batch?.borrowedConcurrent ?? 0);
    const batchEncroachment = classEncroachment(sample, "batch", nominalGrant);
    peakBorrowedConcurrent = Math.max(peakBorrowedConcurrent, batchBorrowed);
    if (lent) {
      peakLentConcurrent = Math.max(
        peakLentConcurrent,
        nominal.protectedConcurrent - appliedFloor,
      );
    }

    if (lent && open === null) {
      open = {
        lentAtMs: offsetMs,
        lentConcurrent: nominal.protectedConcurrent - appliedFloor,
        lentTokens: nominal.protectedInFlightTokens - appliedTokenFloor,
        retainedTokenFloor: appliedTokenFloor,
        demandReturnedAtMs: null,
        demandReturnEvidence: null,
        restorationStartedAtMs: null,
        restoredAtMs: null,
        occupancyRestoredAtMs: null,
        lentConcurrentAtDemandReturn: null,
        borrowedConcurrentAtDemandReturn: null,
        encroachmentAtDemandReturn: null,
        grandfatheredBorrowersAtDemandReturn: null,
      };
      continue;
    }
    if (open !== null) {
      if (activity.active && open.demandReturnedAtMs === null) {
        open.demandReturnedAtMs = offsetMs;
        open.demandReturnEvidence = activity.reason;
        open.lentConcurrentAtDemandReturn = Math.max(
          0,
          nominal.protectedConcurrent - appliedFloor,
        );
        open.borrowedConcurrentAtDemandReturn = batchBorrowed;
        open.encroachmentAtDemandReturn = batchEncroachment;
        // Borrowers already in flight when the owner returns. Restoration here
        // is non-preemptive, so these are exactly the requests the owner has to
        // wait out, and naming them is what makes the wait attributable.
        open.grandfatheredBorrowersAtDemandReturn = batchEncroachment;
      }
      // A restoration attempt is the controller having decided to take capacity
      // back: either it says so, or it has withdrawn the release it had made.
      if (
        open.restorationStartedAtMs === null &&
        open.demandReturnedAtMs !== null &&
        (observed.restorationPending === true ||
          Number(observed.releasedConcurrent ?? 0) < open.lentConcurrent)
      ) {
        open.restorationStartedAtMs = offsetMs;
      }
      if (!lent) {
        // The grant is back, which ends the lending episode. Whether the owner
        // can *use* it is a second question, resolved below from the samples
        // that follow, because a borrower does not vanish when a floor returns.
        open.restoredAtMs = offsetMs;
        episodes.push(close(open));
        open = null;
      }
    }
  }
  // An episode still open at the last sample is reported as open, not inferred
  // to have ended: the run stopped watching, which is not the same as the floor
  // coming back.
  if (open !== null) episodes.push(close(open));

  /**
   * Second pass: when did each restored floor become usable?
   *
   * Separate from the first pass on purpose. Occupancy is resolved from the
   * samples *after* the grant returned, and a floor can be lent again before
   * the previous borrowers have drained — so folding this into the episode loop
   * would let one unfinished drain swallow the next lending episode.
   */
  const resolved = episodes.map((episode) => {
    if (episode.restoredAtMs === null) return episode;
    const found = ordered.find(
      (sample) =>
        Number(sample?.pool?.maxConcurrent ?? 0) >= 1 &&
        Number(sample.offsetMs ?? 0) >= episode.restoredAtMs &&
        classEncroachment(sample, "batch", nominalGrant) <= 0,
    );
    return close({
      ...episode,
      occupancyRestoredAtMs: found === undefined ? null : Number(found.offsetMs ?? 0),
    });
  });
  episodes.length = 0;
  episodes.push(...resolved);

  const restorationRequired = episodes.filter((episode) => episode.restorationRequired);
  const restored = restorationRequired.filter((episode) => episode.restoredAtMs !== null);
  const unrestored = restorationRequired.filter((episode) => episode.restoredAtMs === null);
  const passive = episodes.filter((episode) => episode.outcome === "passive-return");
  const openAtEnd = episodes.filter((episode) => episode.outcome === "open-at-end-of-run");
  const latencies = restored
    .map((episode) => episode.restorationLatencyMs)
    .filter(Number.isFinite);
  const occupancyLatencies = restored
    .map((episode) => episode.occupancyRestorationLatencyMs)
    .filter(Number.isFinite);
  return Object.freeze({
    samples: ordered.length,
    lendingEpisodes: episodes.length,
    /** Demand returned while capacity was still lent: something to restore. */
    restorationRequiredEpisodes: restorationRequired.length,
    /** Of those, the ones whose grant came back. */
    restorationEpisodes: restored.length,
    unrestoredEpisodes: unrestored.length,
    /**
     * A floor that returned with no owner demand behind it. Not a restoration,
     * and never counted as one — a lease rollover is not an achievement.
     */
    passiveReturnEpisodes: passive.length,
    /** Still lent when sampling stopped. Reported, not inferred either way. */
    openAtEndOfRunEpisodes: openAtEnd.length,
    restorationSloMs: slo,
    restorationLatencyMsMedian: median(latencies),
    restorationLatencyMsMax: latencies.length > 0 ? Math.max(...latencies) : null,
    /** Grant-side objective breaches. */
    restorationSloBreaches: restored.filter(
      (episode) => episode.withinRestorationSlo === false,
    ).length,
    /**
     * How long the owner actually waited to be able to use its floor, which on
     * a non-preemptive policy is bounded by the borrowers' remaining decode
     * rather than by the controller's reaction time.
     */
    occupancyRestorationLatencyMsMedian: median(occupancyLatencies),
    occupancyRestorationLatencyMsMax:
      occupancyLatencies.length > 0 ? Math.max(...occupancyLatencies) : null,
    occupancyRestorationSloBreaches: restored.filter(
      (episode) => episode.occupancyWithinRestorationSlo === false,
    ).length,
    peakLentConcurrent,
    peakBorrowedConcurrent,
    /** Smallest applied protected token floor seen while the concurrency floor was lent. */
    minRetainedTokenFloor:
      episodes.length > 0
        ? Math.min(...episodes.map((episode) => episode.retainedTokenFloor))
        : null,
    episodes: Object.freeze(episodes),
  });
}

/**
 * The cross-source timeline of one protected-demand return, in one timebase.
 *
 * The 0.33.2 summary could not answer "what happened at 60 seconds" from the
 * summary alone. It reported two lending episodes, zero restorations and a
 * `null` latency, and the only way to find out that interactive had been
 * refused for the entire contention window was to open the 600 KB per-seed
 * capacity file. This object exists so that never has to happen again.
 *
 * Three clocks, reconciled rather than assumed equal
 * --------------------------------------------------
 * The trace is in workload time (arrival offsets from the first measured
 * arrival). The load generator starts a little after the sampler does, so its
 * offsets run on a third origin. `loadgenSkewMs` is the measured difference
 * between the two epochs, and every generator-side instant below is reported in
 * the sampler's timebase so the numbers can be compared without the reader
 * having to know which process produced which. `null` skew means the summary
 * did not carry the epoch, and the generator-side instants are then omitted
 * rather than silently misaligned.
 */
export function summarizeDemandTransitions({
  samples = [],
  trace = null,
  loadgenSummary = null,
  workload = CONTENTION_WORKLOAD,
  startedAtEpochMs = null,
  admissionClass = "interactive",
} = {}) {
  const nominalGrant = nominalClassGrant();
  const nominal = nominalGrant[admissionClass] ?? nominalGrant.interactive;
  const resumeStartMs = Number(
    loadgenSummary?.config?.interactiveResumeStartMs ?? workload.interactiveResumeStartMs,
  );
  const resumeDurationMs = Number(
    loadgenSummary?.config?.interactiveResumeDurationMs ?? workload.interactiveResumeDurationMs,
  );
  const resumeEndMs = resumeStartMs + resumeDurationMs;
  const ordered = [...samples].sort(
    (a, b) => Number(a.offsetMs ?? 0) - Number(b.offsetMs ?? 0),
  );
  const granted = ordered.filter((sample) => Number(sample?.pool?.maxConcurrent ?? 0) >= 1);

  const loadgenEpochMs = Number(loadgenSummary?.startedAtEpochMs);
  const loadgenSkewMs =
    Number.isFinite(loadgenEpochMs) && Number.isFinite(Number(startedAtEpochMs))
      ? +(loadgenEpochMs - Number(startedAtEpochMs)).toFixed(1)
      : null;
  /** Generator-side offset expressed on the sampler's clock. */
  const toSamplerMs = (value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || loadgenSkewMs === null) return null;
    return +(numeric + loadgenSkewMs).toFixed(1);
  };

  // The generator's own intent, taken from the immutable trace rather than from
  // what survived: a request that was rejected on every attempt still arrived.
  const traceArrivals = (Array.isArray(trace?.entries) ? trace.entries : [])
    .filter((entry) => entry?.class === admissionClass)
    .map((entry) => Number(entry.arrivalMs))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const generatorResumedAtMs =
    traceArrivals.find((arrivalMs) => arrivalMs >= resumeStartMs) ?? null;

  // Tyr's own record of the first decision it made about the resumed class,
  // whichever way it went. A refusal is an observation of demand.
  const classSummary = loadgenSummary?.classes?.[admissionClass] ?? null;
  const rejectSnapshots = (Array.isArray(classSummary?.localRejectSnapshots)
    ? classSummary.localRejectSnapshots
    : []
  )
    .map((snapshot) => Number(snapshot?.rejectedAtMs))
    .filter((value) => Number.isFinite(value) && value >= resumeStartMs);
  const successArrivals = (Array.isArray(classSummary?.phaseSamples)
    ? classSummary.phaseSamples
    : []
  )
    .filter((entry) => Number(entry?.arrivalMs) >= resumeStartMs)
    .map((entry) => Number(entry?.completedAtMs))
    .filter(Number.isFinite);
  const tyrFirstDecisionAtMs =
    rejectSnapshots.length + successArrivals.length === 0
      ? null
      : Math.min(...[...rejectSnapshots, ...successArrivals]);

  // The benchmark's own view, on the sampled grid.
  const activeSample = granted.find(
    (sample) =>
      Number(sample.offsetMs ?? 0) >= resumeStartMs &&
      classDemandActivity(classSample(sample, admissionClass)).active,
  );
  const markedActiveAtMs = activeSample === undefined ? null : Number(activeSample.offsetMs ?? 0);
  const atMark = activeSample === undefined ? null : classSample(activeSample, admissionClass);
  const appliedFloorAtMark = Number(atMark?.limits?.protectedConcurrent ?? 0);

  // Borrowing: when the last new borrower was admitted, and when the borrowed
  // capacity finally came back. `admitted` is Tyr's cumulative counter, so an
  // unchanged value across the whole contention window is positive evidence
  // that no new borrowing happened rather than merely an absent event.
  const borrower = admissionClass === "interactive" ? "batch" : "interactive";
  let lastBorrowerAdmissionAtMs = null;
  let lastBorrowerAdmissionBeforeMarkAtMs = null;
  let borrowerAdmissionsDuringResumeWindow = 0;
  let previousAdmitted = null;
  for (const sample of granted) {
    const admitted = Number(classSample(sample, borrower)?.admitted ?? 0);
    const offsetMs = Number(sample.offsetMs ?? 0);
    if (previousAdmitted !== null && admitted > previousAdmitted) {
      lastBorrowerAdmissionAtMs = offsetMs;
      if (markedActiveAtMs !== null && offsetMs < markedActiveAtMs) {
        lastBorrowerAdmissionBeforeMarkAtMs = offsetMs;
      }
      // Scoped to the resume window on purpose. Borrowing that starts again
      // after the protected class has gone quiet at 85 s is the policy working,
      // not a violation, and counting it here would make every seed look as if
      // new borrowing continued through restoration.
      if (
        markedActiveAtMs !== null &&
        offsetMs >= markedActiveAtMs &&
        offsetMs < resumeEndMs
      ) {
        borrowerAdmissionsDuringResumeWindow += admitted - previousAdmitted;
      }
    }
    previousAdmitted = admitted;
  }

  const floorRestoredSample =
    markedActiveAtMs === null
      ? undefined
      : granted.find(
          (sample) =>
            Number(sample.offsetMs ?? 0) >= markedActiveAtMs &&
            Number(classSample(sample, admissionClass)?.limits?.protectedConcurrent ?? 0) >=
              nominal.protectedConcurrent,
        );
  // Restoration is only "in progress" if there was something to restore: either
  // the grant was still short at the mark, or a borrower was still sitting on
  // the class's nominal floor. A grant that happens to be at its nominal
  // allocation with nobody encroaching is not a restoration event, and 0.34.0
  // must not fabricate one.
  const restorationWasNeeded =
    activeSample !== undefined &&
    (appliedFloorAtMark < nominal.protectedConcurrent ||
      classEncroachment(activeSample, borrower, nominalGrant) > 0);
  const restorationStartedSample =
    markedActiveAtMs === null || !restorationWasNeeded
      ? undefined
      : granted.find((sample) => {
          const observed = classSample(sample, admissionClass);
          return (
            Number(sample.offsetMs ?? 0) >= markedActiveAtMs &&
            (observed?.restorationPending === true ||
              Number(observed?.limits?.protectedConcurrent ?? 0) >= nominal.protectedConcurrent)
          );
        });
  const occupancySample =
    markedActiveAtMs === null
      ? undefined
      : granted.find(
          (sample) =>
            Number(sample.offsetMs ?? 0) >= markedActiveAtMs &&
            classEncroachment(sample, borrower, nominalGrant) <= 0,
        );

  const inWindow = (sample) => {
    const offsetMs = Number(sample.offsetMs ?? 0);
    return offsetMs >= resumeStartMs && offsetMs < resumeEndMs;
  };
  const windowSamples = granted.filter(inWindow);
  const admissionsInWindow = (() => {
    if (windowSamples.length === 0) return null;
    const first = classSample(windowSamples[0], admissionClass);
    const last = classSample(windowSamples[windowSamples.length - 1], admissionClass);
    return {
      admitted: Number(last?.admitted ?? 0) - Number(first?.admitted ?? 0),
      rejected: Number(last?.rejected ?? 0) - Number(first?.rejected ?? 0),
      maxInFlight: Math.max(
        0,
        ...windowSamples.map((sample) => Number(classSample(sample, admissionClass)?.inFlight ?? 0)),
      ),
    };
  })();

  return Object.freeze({
    admissionClass,
    resumeWindowMs: Object.freeze({ fromMs: resumeStartMs, toMs: resumeEndMs }),
    loadgenSkewMs,
    timebase:
      "Sampler offsets are milliseconds from the arm's measured start. Generator-side " +
      "instants are shifted by loadgenSkewMs onto the same origin; when that skew is " +
      "unknown they are reported as null rather than aligned by assumption.",
    /** Question 1: when did the workload actually ask again? */
    generatorResumedAtMs,
    generatorResumedAtSamplerMs: toSamplerMs(generatorResumedAtMs),
    /** Question 2: when did Tyr first decide something about that demand? */
    tyrFirstDecisionAtMs,
    tyrFirstDecisionAtSamplerMs: toSamplerMs(tyrFirstDecisionAtMs),
    tyrFirstDecisionWasRejection:
      tyrFirstDecisionAtMs === null
        ? null
        : rejectSnapshots.includes(tyrFirstDecisionAtMs),
    /** Question 3: when did this benchmark call the class active? */
    benchmarkMarkedActiveAtMs: markedActiveAtMs,
    benchmarkMarkedActiveEvidence:
      atMark === null ? null : classDemandActivity(atMark).reason,
    /** Question 4: was the class's capacity lent at that instant? */
    capacityLentAtMark:
      atMark === null ? null : appliedFloorAtMark < nominal.protectedConcurrent,
    lentConcurrentAtMark:
      atMark === null ? null : Math.max(0, nominal.protectedConcurrent - appliedFloorAtMark),
    appliedProtectedConcurrentAtMark: atMark === null ? null : appliedFloorAtMark,
    /** Question 5: how much was the other class holding? */
    borrowerAtMark: borrower,
    borrowedConcurrentAtMark:
      activeSample === undefined
        ? null
        : Number(classSample(activeSample, borrower)?.borrowedConcurrent ?? 0),
    borrowerEncroachmentAtMark:
      activeSample === undefined
        ? null
        : classEncroachment(activeSample, borrower, nominalGrant),
    /**
     * Question 6: when did new borrowing stop?
     *
     * `borrowerAdmissionsDuringResumeWindow` is the number that answers it, and
     * it is scoped to the window in which the protected class was actually
     * asking. Zero here with a positive `borrowerEncroachmentAtMark` is the
     * signature of correct non-preemptive behaviour: the loans were all made
     * before the owner came back, and none was made after.
     */
    lastBorrowerAdmissionBeforeMarkAtMs,
    borrowerAdmissionsDuringResumeWindow,
    newBorrowingDuringResumeWindow: borrowerAdmissionsDuringResumeWindow > 0,
    /** Run-wide, including the drain after the protected class goes quiet again. */
    lastBorrowerAdmissionAtMs,
    /**
     * Question 7: when did a restoration attempt begin, and how did it end?
     *
     * `restorationWasNeeded` is false when the class's grant was already whole
     * at the mark and nobody was occupying its floor; the remaining fields are
     * then reported for completeness but describe a class that never had to
     * wait for anything.
     */
    restorationWasNeeded,
    restorationStartedAtMs:
      restorationStartedSample === undefined
        ? null
        : Number(restorationStartedSample.offsetMs ?? 0),
    floorRestoredAtMs:
      floorRestoredSample === undefined ? null : Number(floorRestoredSample.offsetMs ?? 0),
    occupancyRestoredAtMs:
      occupancySample === undefined ? null : Number(occupancySample.offsetMs ?? 0),
    floorRestorationLatencyMs:
      floorRestoredSample === undefined || markedActiveAtMs === null
        ? null
        : Number(floorRestoredSample.offsetMs ?? 0) - markedActiveAtMs,
    occupancyRestorationLatencyMs:
      occupancySample === undefined || markedActiveAtMs === null
        ? null
        : Number(occupancySample.offsetMs ?? 0) - markedActiveAtMs,
    /** What the protected class actually got for the whole resume window. */
    resumeWindow: admissionsInWindow,
  });
}

/**
 * The sampled series around a chosen interval, with unchanged samples collapsed.
 *
 * The interval this benchmark cares about is 50–70 s: the last ten seconds in
 * which the interactive floor is legitimately lendable, and the first ten in
 * which its owner is back. At 250 ms that is eighty samples per arm per seed,
 * most of them identical, so only samples at which something tracked changed
 * are kept — plus the first and last, so the boundaries of the interval are
 * never inferred from a gap.
 */
export function criticalWindowDigest(samples, { fromMs, toMs } = {}) {
  const from = Number.isFinite(fromMs) ? fromMs : 50_000;
  const to = Number.isFinite(toMs) ? toMs : 70_000;
  const nominalGrant = nominalClassGrant();
  const rows = [...samples]
    .sort((a, b) => Number(a.offsetMs ?? 0) - Number(b.offsetMs ?? 0))
    .filter((sample) => {
      const offsetMs = Number(sample.offsetMs ?? 0);
      return offsetMs >= from && offsetMs < to;
    })
    .map((sample) =>
      Object.freeze({
        atMs: Number(sample.offsetMs ?? 0),
        poolMaxConcurrent: Number(sample?.pool?.maxConcurrent ?? 0),
        classes: Object.freeze(
          Object.fromEntries(
            Object.keys(nominalGrant).map((admissionClass) => {
              const observed = classSample(sample, admissionClass);
              const activity = classDemandActivity(observed);
              return [
                admissionClass,
                Object.freeze({
                  protectedConcurrent: Number(observed?.limits?.protectedConcurrent ?? 0),
                  inFlight: Number(observed?.inFlight ?? 0),
                  borrowedConcurrent: Number(observed?.borrowedConcurrent ?? 0),
                  encroachment: classEncroachment(sample, admissionClass, nominalGrant),
                  admitted: Number(observed?.admitted ?? 0),
                  rejected: Number(observed?.rejected ?? 0),
                  demandState: observed?.demandState ?? null,
                  demandActive: activity.active,
                  demandEvidence: activity.reason,
                  releasedConcurrent: Number(observed?.releasedConcurrent ?? 0),
                  restorationPending: observed?.restorationPending === true,
                }),
              ];
            }),
          ),
        ),
      }),
    );
  const kept = rows.filter((row, index) => {
    if (index === 0 || index === rows.length - 1) return true;
    return JSON.stringify({ ...row, atMs: 0 }) !== JSON.stringify({ ...rows[index - 1], atMs: 0 });
  });
  return Object.freeze({
    fromMs: from,
    toMs: to,
    samples: rows.length,
    retained: kept.length,
    note:
      "Samples identical to their predecessor are omitted; the first and last sample in the " +
      "interval are always kept so the boundaries are observed rather than inferred.",
    series: Object.freeze(kept),
  });
}

/**
 * Latchflo's own record of how capacity handoffs went, split by what each
 * outcome actually means.
 *
 * The distinction matters and an earlier draft of this module got it wrong. An
 * **aborted** handoff is the control plane declining to commit a reallocation
 * whose preconditions no longer hold — the source lease expired, membership
 * changed, a drain grant was rejected. That is the safe outcome, not an unsafe
 * one: nothing is handed over, and restoration falls back to the lease
 * deadline. It has a cost, which is that the floor comes back in seconds rather
 * than milliseconds, and the cost belongs in the cost accounting.
 *
 * A **commit whose drain grants were never acknowledged** is the genuinely
 * unsafe case, and the only one H4 is about: capacity moved before its previous
 * holder confirmed it had let go.
 *
 * Only the control plane's event log distinguishes them. The data plane sees a
 * floor that came back and nothing about how.
 */
export function summarizeClassHandoffSafety(events, pool) {
  const relevant = (Array.isArray(events) ? events : []).filter(
    (event) =>
      String(event?.type ?? "").startsWith("admission_class.handoff") &&
      (event?.entityId === pool || event?.payload?.pool === pool),
  );
  const prepared = relevant.filter((event) => event.type === "admission_class.handoff_prepared");
  const committed = relevant.filter((event) => event.type === "admission_class.handoff_committed");
  const aborted = relevant.filter((event) => event.type === "admission_class.handoff_aborted");
  const applied = relevant.filter(
    (event) => event.type === "admission_class.handoff_grant_applied",
  );
  const appliedIds = new Set(applied.map((event) => event?.payload?.handoffId));
  const committedWithoutAck = committed.filter(
    (event) => !appliedIds.has(event?.payload?.handoffId),
  );
  const abortReasons = {};
  for (const event of aborted) {
    const reason = String(event?.payload?.reason ?? "unattributed");
    abortReasons[reason] = (abortReasons[reason] ?? 0) + 1;
  }
  return Object.freeze({
    events: relevant.length,
    prepared: prepared.length,
    committed: committed.length,
    grantApplied: applied.length,
    /** Declined reallocations. Safe, and priced as slower restoration. */
    aborted: aborted.length,
    abortReasons: Object.freeze(abortReasons),
    /** A commit nobody acknowledged: the unsafe-ordering signature. */
    committedWithoutAck: committedWithoutAck.length,
    unsafeHandoffs: committedWithoutAck.length,
  });
}

function gate(passed, observed, threshold, reason) {
  return Object.freeze({ passed: passed === true, observed, threshold, reason });
}

/**
 * Per-seed acceptance: validity and safety only.
 *
 * The performance hypotheses are deliberately not gated here. They are claims
 * about a median over seeds, and a single-seed pass or fail on a machine this
 * variable would be noise dressed as a result. What must hold on every seed is
 * that the experiment was valid and that nothing unsafe happened.
 */
export function localContentionSeedProof({
  comparison,
  arms,
  lending,
  invariants,
  handoff,
  warmupRequestsPerClass,
}) {
  const moflux = arms.moflux ?? {};
  const staticArm = arms.static ?? {};
  const direct = arms.direct ?? {};
  const mofluxBatch = moflux.classes?.batch ?? {};
  const mofluxInteractive = moflux.classes?.interactive ?? {};

  const validity = Object.freeze({
    sameTrace: gate(
      comparison.traceHashMatches,
      comparison.traceHash,
      "one trace hash across every arm",
      "arms must replay one immutable trace or the comparison is between two workloads",
    ),
    everyArmRan: gate(
      Object.keys(arms).length === CONTENTION_ARM_IDS.length,
      Object.keys(arms).sort(),
      CONTENTION_ARM_IDS,
      "a missing arm makes the comparison undefined rather than partial",
    ),
    warmupExcluded: gate(
      warmupRequestsPerClass >= 1,
      warmupRequestsPerClass,
      ">= 1 per class per arm",
      "weight loading and estimator convergence must not enter a measured distribution",
    ),
    idleCapacityBeforeContention: gate(
      count(direct.classes?.interactive?.windows?.idle?.completed) > 0 &&
        count(direct.classes?.batch?.windows?.idle?.completed) === 0,
      {
        interactiveIdleCompletions: count(direct.classes?.interactive?.windows?.idle?.completed),
        batchIdleCompletions: count(direct.classes?.batch?.windows?.idle?.completed),
      },
      "interactive work before batch starts, and no batch work in that window",
      "the idle window must actually be idle of batch, or there was no spare capacity to lend",
    ),
    batchAdmittedAndCompleted: gate(
      count(mofluxBatch.success) > 0,
      count(mofluxBatch.success),
      "> 0",
      "an arm that admitted no batch work cannot evidence useful borrowing",
    ),
    interactiveConstrainedUnderContention: gate(
      count(direct.classes?.interactive?.windows?.contention?.ttftP95Ms) >
        count(direct.classes?.interactive?.windows?.idle?.ttftP95Ms),
      {
        idleTtftP95Ms: direct.classes?.interactive?.windows?.idle?.ttftP95Ms ?? null,
        idleCompleted: count(direct.classes?.interactive?.windows?.idle?.completed),
        contentionTtftP95Ms:
          direct.classes?.interactive?.windows?.contention?.ttftP95Ms ?? null,
        // Carried because a `null` tail means the window had no completions at
        // all, which is a different failure from a tail that did not grow.
        contentionCompleted: count(direct.classes?.interactive?.windows?.contention?.completed),
      },
      "contention-window tail above idle-window tail on the direct arm",
      "without measurable queueing in the control arm there is no contention to protect against",
    ),
    classesResolved: gate(
      count(mofluxInteractive.admissionClassResponses?.interactive) > 0 &&
        count(mofluxBatch.admissionClassResponses?.batch) > 0,
      {
        interactive: mofluxInteractive.admissionClassResponses ?? {},
        batch: mofluxBatch.admissionClassResponses ?? {},
      },
      "Tyr classified each workload as its own admission class",
      "a run whose traffic all landed in one class measured no partition at all",
    ),
    leaseGapWithinBudget: gate(
      invariants.leaseGapShare === null ||
        invariants.leaseGapShare <= CONTENTION_POLICY.lending.maxLeaseGapShare,
      { leaseGapShare: invariants.leaseGapShare, leaseGapSamples: invariants.leaseGapSamples },
      CONTENTION_POLICY.lending.maxLeaseGapShare,
      "a short grant lease buys mid-run lending at the cost of a brief ungranted window per " +
        "expiry; past this share the arm is measuring the reconcile loop, not the policy",
    ),
    staticArmLeftCapacityIdle: gate(
      count(staticArm.classes?.batch?.rejectedAdmissions) > 0,
      count(staticArm.classes?.batch?.rejectedAdmissions),
      "> 0",
      "rigid isolation must actually refuse batch work, or the static arm is not rigid",
    ),
  });

  const safety = Object.freeze({
    noUnlentFloorViolations: gate(
      invariants.unlentFloorViolations.length === 0,
      invariants.unlentFloorViolations.length,
      0,
      "the allocation-enforced slice of the interactive floor must never be lent",
    ),
    noClassCeilingViolations: gate(
      invariants.classCeilingViolations.length === 0,
      invariants.classCeilingViolations.length,
      0,
      "a class may never hold more in flight than its granted ceiling",
    ),
    noCeilingOverAllocation: gate(
      invariants.ceilingOverAllocations.length === 0,
      invariants.ceilingOverAllocations.length,
      0,
      "lending moves capacity between classes; it may not create any",
    ),
    noPoolOverAllocation: gate(
      invariants.poolOverAllocations.length === 0,
      invariants.poolOverAllocations.length,
      0,
      "total in-flight work may never exceed the pool grant",
    ),
    noFloorSumOverAllocation: gate(
      invariants.floorSumOverAllocations.length === 0,
      invariants.floorSumOverAllocations.length,
      0,
      "protected floors may never sum above the capacity they partition",
    ),
    /**
     * H4b. Renamed in 0.34.0: the old `noBorrowGrowthAfterRestoration` said
     * "restoration", but the check has never been about restoration — it is
     * about what happens once the owner asks again, whether or not any
     * restoration has yet occurred. The old key is preserved below as an alias.
     */
    noBorrowGrowthAfterDemandReturn: gate(
      invariants.borrowGrowthAfterDemandReturn.length === 0,
      invariants.borrowGrowthAfterDemandReturn.length,
      0,
      "borrowers already in flight when protected demand returned may drain, but the borrowing " +
        "class must not take more of the protected class's nominal floor after that instant, " +
        "and may not refill a slot a grandfathered borrower has given back",
    ),
    /**
     * H4a. The only genuinely unsafe handoff outcome: capacity that moved
     * before its previous holder confirmed it had let go. An abort is the
     * control plane declining a reallocation whose preconditions lapsed, which
     * is the safe outcome and is priced as slower restoration, and borrow
     * growth at the wrong time is a timing failure rather than an unsafe
     * transfer — neither is counted here.
     */
    noUnsafeHandoff: gate(
      handoff.unsafeHandoffs === 0,
      {
        committedWithoutAck: handoff.committedWithoutAck,
        aborted: handoff.aborted,
        committed: handoff.committed,
      },
      0,
      "a capacity handoff must be acknowledged before it is committed; an aborted handoff is " +
        "the safe outcome and is priced as slower restoration rather than gated here",
    ),
    everyLentFloorRestored: gate(
      lending.restorationRequiredEpisodes === 0 || lending.unrestoredEpisodes === 0,
      {
        lendingEpisodes: lending.lendingEpisodes,
        restorationRequiredEpisodes: lending.restorationRequiredEpisodes,
        passiveReturnEpisodes: lending.passiveReturnEpisodes,
        openAtEndOfRunEpisodes: lending.openAtEndOfRunEpisodes,
        unrestored: lending.unrestoredEpisodes,
      },
      0,
      "when protected demand returns while capacity is lent, that capacity must come back; a " +
        "lend whose owner never returned is a passive return, not a restoration failure",
    ),
    noDeadlineAbandonments: gate(
      count(mofluxBatch.deadlineAbandonments) === 0 &&
        count(mofluxInteractive.deadlineAbandonments) === 0,
      count(mofluxBatch.deadlineAbandonments) + count(mofluxInteractive.deadlineAbandonments),
      0,
      "no arm configures a borrowed-slot deadline, so an abandonment would mean the run and " +
        "its configuration disagree about which pool was measured",
    ),
  });

  const checks = Object.freeze({ ...validity, ...safety });
  return Object.freeze({
    passed: Object.values(checks).every((entry) => entry.passed),
    validity,
    /**
     * `noBorrowGrowthAfterRestoration` is a deprecated alias for
     * `noBorrowGrowthAfterDemandReturn`, kept for one release so a reader
     * holding the 0.33.x schema sees the real verdict rather than `undefined`.
     * It is not counted twice: `checks` is built before the alias is added.
     */
    safety: Object.freeze({
      ...safety,
      noBorrowGrowthAfterRestoration: safety.noBorrowGrowthAfterDemandReturn,
    }),
    failed: Object.freeze(
      Object.entries(checks)
        .filter(([, entry]) => !entry.passed)
        .map(([name, entry]) => Object.freeze({ gate: name, ...entry })),
    ),
    /** Per-seed hypothesis readings, recorded but never gated at this level. */
    observations: Object.freeze({
      interactiveTtftP95RatioVsDirect: comparison.interactiveTtftP95RatioVsDirect,
      interactiveGoodputRatioVsDirect: comparison.interactiveGoodputRatioVsDirect,
      interactiveSloGoodputDeltaRpsVsDirect: comparison.interactiveSloGoodputDeltaRpsVsDirect,
      batchBorrowWindowRatioVsStatic: comparison.batchBorrowWindowRatioVsStatic,
      lendingEpisodes: lending.lendingEpisodes,
      restorationRequiredEpisodes: lending.restorationRequiredEpisodes,
      restorationEpisodes: lending.restorationEpisodes,
      passiveReturnEpisodes: lending.passiveReturnEpisodes,
      restorationLatencyMsMedian: lending.restorationLatencyMsMedian,
      /**
       * Recorded, never gated. The grant-side latency is the controller's
       * reaction time; this is how long the owner waited to be able to use the
       * floor, and on a non-preemptive policy the two can differ by tens of
       * seconds.
       */
      occupancyRestorationLatencyMsMedian: lending.occupancyRestorationLatencyMsMedian,
      occupancyRestorationSloBreaches: lending.occupancyRestorationSloBreaches,
    }),
  });
}

/**
 * The benchmark's own acceptance object.
 *
 * Named `localContentionProof` in the summary and never merged with any other
 * benchmark's gates: an earlier release taught this repository that a shared
 * `passed` field turns one benchmark's regression into another's silent pass.
 *
 * The performance gates are evaluated on medians across seeds, against the
 * thresholds pre-registered in `HYPOTHESIS_THRESHOLDS`. They can fail, and a
 * run in which MoFlux does not protect interactive traffic is required to say
 * so — that is the difference between a benchmark and a demonstration.
 */
export function localContentionProof({ seeds, seedProofs, comparisons, requiredSeeds = 1 }) {
  const ttftRatios = comparisons
    .map((row) => row.interactiveTtftP95RatioVsDirect)
    .filter(Number.isFinite);
  const goodputRatios = comparisons
    .map((row) => row.interactiveGoodputRatioVsDirect)
    .filter(Number.isFinite);
  const sloGoodputDeltas = comparisons
    .map((row) => row.interactiveSloGoodputDeltaRpsVsDirect)
    .filter(Number.isFinite);
  const borrowRatios = comparisons
    .map((row) => row.batchBorrowWindowRatioVsStatic)
    .filter(Number.isFinite);

  const ttftMedian = median(ttftRatios);
  const goodputMedian = median(goodputRatios);
  const sloGoodputDeltaMedian = median(sloGoodputDeltas);
  const borrowMedian = median(borrowRatios);

  // H1 is deliberately based on SLO-good work, not the latency distribution of
  // survivors. A proxy that rejects most interactive requests must not win just
  // because the few requests it admitted were fast.
  const sloGoodputImproved =
    Number.isFinite(sloGoodputDeltaMedian) &&
    sloGoodputDeltaMedian >= HYPOTHESIS_THRESHOLDS.interactiveSloGoodputDeltaMinRps;

  /** H4a: nothing unsafe was transferred. */
  const transferSafe = (proof) =>
    proof.safety.noUnsafeHandoff.passed &&
    proof.safety.noUnlentFloorViolations.passed &&
    proof.safety.noClassCeilingViolations.passed &&
    proof.safety.noCeilingOverAllocation.passed &&
    proof.safety.noPoolOverAllocation.passed &&
    proof.safety.noFloorSumOverAllocation.passed;
  /** H4b: nothing new was borrowed after the owner came back, and it converged. */
  const postDemandSafe = (proof) =>
    proof.safety.noBorrowGrowthAfterDemandReturn.passed &&
    proof.safety.everyLentFloorRestored.passed;

  const checks = Object.freeze({
    enoughSeeds: gate(
      seeds.length >= requiredSeeds,
      seeds.length,
      requiredSeeds,
      "a single run is not evidence; the sweep must carry the seed count it claims",
    ),
    everySeedValidAndSafe: gate(
      seedProofs.length > 0 && seedProofs.every((proof) => proof.passed),
      seedProofs.filter((proof) => proof.passed).length,
      seedProofs.length,
      "validity and safety are absolute, not averaged: one unsafe seed fails the run",
    ),
    h1InteractivePreserved: gate(
      sloGoodputImproved,
      {
        sloGoodputDeltaRpsMedian: sloGoodputDeltaMedian,
        descriptiveTtftP95RatioMedian: ttftMedian,
        descriptiveGoodputRatioMedian: goodputMedian,
      },
      {
        sloGoodputDeltaMinRps: HYPOTHESIS_THRESHOLDS.interactiveSloGoodputDeltaMinRps,
        ttftSloMs: HYPOTHESIS_THRESHOLDS.interactiveSloTtftMaxMs,
        latencySloMs: HYPOTHESIS_THRESHOLDS.interactiveSloLatencyMaxMs,
      },
      "H1: under contention MoFlux must complete materially more interactive work within the predeclared TTFT and completion-latency SLOs than unmanaged Ollama",
    ),
    h2BatchBorrowedIdleCapacity: gate(
      Number.isFinite(borrowMedian) &&
        borrowMedian >= HYPOTHESIS_THRESHOLDS.batchBorrowRatioMin,
      { batchBorrowRatioMedian: borrowMedian },
      HYPOTHESIS_THRESHOLDS.batchBorrowRatioMin,
      "H2: while the interactive floor is idle, MoFlux must complete materially more batch " +
        "work than a rigid static partition",
    ),
    h3ProtectedFloorNeverViolated: gate(
      seedProofs.every((proof) => proof.safety.noUnlentFloorViolations.passed) &&
        seedProofs.every((proof) => proof.safety.everyLentFloorRestored.passed),
      seedProofs.filter(
        (proof) =>
          proof.safety.noUnlentFloorViolations.passed &&
          proof.safety.everyLentFloorRestored.passed,
      ).length,
      seedProofs.length,
      "H3: the configured interactive protected floor is never violated",
    ),
    /**
     * H4a — capacity transfer safety.
     *
     * Everything that would mean capacity was created, over-allocated, moved
     * below a floor promised never to move, or handed over before its previous
     * holder acknowledged letting go. These are absolute: a system that does
     * any of them is unsafe regardless of timing.
     *
     * Split from H4b in 0.34.0 because the combined gate could not say which
     * kind of failure had occurred, and had twice reported an
     * acknowledged-and-aborted-safe handoff run as "unsafe capacity handoff"
     * when what actually happened was borrow growth at a suspect instant.
     */
    h4aNoUnsafeCapacityTransfer: gate(
      seedProofs.every((proof) => transferSafe(proof)),
      seedProofs.filter((proof) => transferSafe(proof)).length,
      seedProofs.length,
      "H4a: lending and restoration move capacity without creating it, without breaching a " +
        "class ceiling, pool grant, floor sum or unlent slice, and without committing a " +
        "handoff that was never acknowledged",
    ),
    /**
     * H4b — no new borrowing after protected demand returns.
     *
     * A timing property, not a safety-of-transfer property. Borrowers already
     * in flight are grandfathered because restoration here is non-preemptive;
     * what must hold is that no new loan is made after the owner asks again,
     * that a slot a grandfathered borrower gives back is not refilled, and that
     * every episode which actually required restoration converged.
     */
    h4bNoBorrowingAfterProtectedDemandReturn: gate(
      seedProofs.every((proof) => postDemandSafe(proof)),
      seedProofs.filter((proof) => postDemandSafe(proof)).length,
      seedProofs.length,
      "H4b: once protected demand returns, no new borrowing of that class's floor begins and " +
        "every restoration-required episode converges",
    ),
  });

  return Object.freeze({
    passed: Object.values(checks).every((entry) => entry.passed),
    hypotheses: Object.freeze({
      h1: checks.h1InteractivePreserved.passed,
      h2: checks.h2BatchBorrowedIdleCapacity.passed,
      h3: checks.h3ProtectedFloorNeverViolated.passed,
      h4a: checks.h4aNoUnsafeCapacityTransfer.passed,
      h4b: checks.h4bNoBorrowingAfterProtectedDemandReturn.passed,
      /**
       * Deprecated: the 0.33.x combined verdict, retained for one release as
       * the conjunction of the two gates that replaced it. A reader who needs
       * to know *which* failed must read h4a and h4b.
       */
      h4:
        checks.h4aNoUnsafeCapacityTransfer.passed &&
        checks.h4bNoBorrowingAfterProtectedDemandReturn.passed,
    }),
    checks,
    failed: Object.freeze(
      Object.entries(checks)
        .filter(([, entry]) => !entry.passed)
        .map(([name, entry]) => Object.freeze({ gate: name, ...entry })),
    ),
    thresholds: HYPOTHESIS_THRESHOLDS,
    sampleCounts: Object.freeze({
      seeds: seeds.length,
      ttftRatioSamples: ttftRatios.length,
      goodputRatioSamples: goodputRatios.length,
      sloGoodputDeltaSamples: sloGoodputDeltas.length,
      batchBorrowRatioSamples: borrowRatios.length,
    }),
  });
}

/**
 * Cross-seed aggregate for one arm and one workload class.
 *
 * Medians with min/max and an explicit `n`, because a median without its sample
 * count is a number pretending to be a distribution.
 */
export function aggregateArmClass(rows) {
  const pick = (selector) => rows.map(selector).filter(Number.isFinite);
  const spread = (values) =>
    Object.freeze({
      median: median(values),
      min: values.length > 0 ? +Math.min(...values).toFixed(2) : null,
      max: values.length > 0 ? +Math.max(...values).toFixed(2) : null,
      n: values.length,
    });
  return Object.freeze({
    logicalTotal: rows.reduce((sum, row) => sum + count(row.logical), 0),
    successTotal: rows.reduce((sum, row) => sum + count(row.success), 0),
    successRate: spread(pick((row) => row.successRate)),
    goodputRps: spread(pick((row) => row.goodputRps)),
    ttftP50Ms: spread(pick((row) => row.ttftMs?.p50)),
    ttftP95Ms: spread(pick((row) => row.ttftMs?.p95)),
    latencyP50Ms: spread(pick((row) => row.latencyMs?.p50)),
    latencyP95Ms: spread(pick((row) => row.latencyMs?.p95)),
    promptTokensTotal: rows.reduce((sum, row) => sum + count(row.promptTokens), 0),
    completionTokensTotal: rows.reduce((sum, row) => sum + count(row.completionTokens), 0),
    totalTokensTotal: rows.reduce((sum, row) => sum + count(row.totalTokens), 0),
    rejectedAdmissionsTotal: rows.reduce((sum, row) => sum + count(row.rejectedAdmissions), 0),
    deadlineAbandonmentsTotal: rows.reduce((sum, row) => sum + count(row.deadlineAbandonments), 0),
    tornStreamsTotal: rows.reduce((sum, row) => sum + count(row.tornStreams), 0),
    serverErrorsTotal: rows.reduce((sum, row) => sum + count(row.serverErrors), 0),
    borrowWindowCompleted: spread(pick((row) => row.windows?.borrow?.completed)),
    contentionWindowCompleted: spread(pick((row) => row.windows?.contention?.completed)),
    contentionWindowGoodputRps: spread(pick((row) => row.windows?.contention?.goodputRps)),
    contentionWindowSloGoodputRps: spread(pick((row) => row.windows?.contention?.sloGoodputRps)),
    contentionWindowTtftP95Ms: spread(pick((row) => row.windows?.contention?.ttftP95Ms)),
    idleWindowTtftP95Ms: spread(pick((row) => row.windows?.idle?.ttftP95Ms)),
  });
}

/**
 * Stable identifier for "this exact experiment", so two runs can be compared
 * only when they really are the same experiment.
 */
export function scenarioId({ workload, policy, seeds, arms, model }) {
  return createHash("sha256")
    .update(JSON.stringify({ workload, policy, seeds, arms, model }))
    .digest("hex")
    .slice(0, 12);
}
