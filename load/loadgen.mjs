/**
 * loadgen.mjs — open-loop, multi-class load generator.
 *
 * OPEN-LOOP IS THE WHOLE POINT. A fixed worker pool ("send N, wait, send N
 * more") cannot generate more load than the system can absorb, so overload
 * hides inside the generator instead of showing up in the numbers. That is
 * coordinated omission, and it is the most common way a benchmark like this
 * quietly lies in the vendor's favour. Arrivals are generated once as an
 * immutable Poisson trace, then scheduled against absolute offsets without
 * waiting for any request to complete.
 *
 * If the generator itself ever runs out of headroom it increments
 * `generator_saturated_total`. Any run where that counter is non-zero must be
 * discarded — the bottleneck was the measuring instrument.
 *
 * Two competing classes, because the scenario under test is contention:
 *   interactive — small prompts, latency-sensitive, priority high
 *   batch       — large prompts, large max_tokens, arrives as a step function
 *
 * Retries use exponential backoff with jitter, which is what turns provider
 * rejection into retry amplification.
 */

import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { buildTrace, traceHash, validateTrace } from "./trace-lib.mjs";
import { chooseRetryDelay } from "./retry-policy.mjs";

// ── args ─────────────────────────────────────────────────────────────

const args = new Map();
for (const arg of process.argv.slice(2)) {
  const m = /^--([^=]+)=(.*)$/.exec(arg);
  if (m) args.set(m[1], m[2]);
  else if (arg.startsWith("--")) args.set(arg.slice(2), "true");
}
const num = (n, d) => (args.has(n) ? Number(args.get(n)) : d);
const str = (n, d) => args.get(n) ?? d;
const bool = (n, d = false) => (args.has(n) ? args.get(n) === "true" : d);

const CONFIG = Object.freeze({
  targets: str("targets", "http://127.0.0.1:8100").split(",").filter(Boolean),
  interactiveTargets: str("interactive-targets", str("targets", "http://127.0.0.1:8100")).split(",").filter(Boolean),
  batchTargets: str("batch-targets", str("targets", "http://127.0.0.1:8100")).split(",").filter(Boolean),
  interactiveIdentityToken: str("interactive-identity-token", ""),
  batchIdentityToken: str("batch-identity-token", ""),
  metricsPort: num("metrics-port", 8200),
  metricsRelayUrl: str("metrics-relay-url", ""),
  metricsPushIntervalMs: num("metrics-push-interval-ms", 1000),
  metricsRelayRequired: bool("metrics-relay-required", false),
  armLabel: str("arm-label", "unknown"),
  // The presenter uses Anthropic-shaped streams so Tyr can observe cumulative
  // usage during the call. Direct load-generator users retain the historical
  // OpenAI default unless they opt in explicitly.
  providerApi: str("provider-api", "openai"),
  durationMs: num("duration-ms", 60000),
  seed: num("seed", 1),

  // Tyr routes to pools by model prefix only, so the two tiers must carry
  // distinct model strings for a per-tier capacity floor to be expressible.
  interactiveModel: str("interactive-model", "sim-model-interactive"),
  batchModel: str("batch-model", "sim-model-batch"),

  interactiveRps: num("interactive-rps", 12),
  interactiveInputChars: num("interactive-input-chars", 1200),
  /**
   * "uniform" reproduces the version-1 trace exactly. "lognormal" draws a size
   * per request, which is what makes token-aware admission distinguishable
   * from a plain concurrency semaphore: with one fixed size per class the two
   * are the same algorithm.
   */
  sizeDistribution: str("size-distribution", "uniform"),
  interactiveSizeSigma: num("interactive-size-sigma", 0.75),
  batchSizeSigma: num("batch-size-sigma", 0),
  interactiveMaxTokens: num("interactive-max-tokens", 400),

  batchStartMs: num("batch-start-ms", 20000),
  batchDurationMs: num("batch-duration-ms", 25000),
  batchRps: num("batch-rps", 6),
  batchInputChars: num("batch-input-chars", 40000),
  batchMaxTokens: num("batch-max-tokens", 4000),

  maxAttempts: num("max-attempts", 4),
  backoffBaseMs: num("backoff-base-ms", 250),
  // When an admission layer tells the client when to come back, honor it.
  // Set false to force blind backoff and measure the hint's contribution in
  // isolation — the trace is identical either way, so the pair is an exact A/B.
  honorRetryHints: bool("honor-retry-hints", true),
  inFlightCeiling: num("in-flight-ceiling", 3000),
  /**
   * Drain bounds, applied after the last arrival so the summary is not written
   * mid-stream.
   *
   * `drainIdleMs` bounds a drain that has *stopped making progress*;
   * `drainMaxMs` bounds it absolutely. The distinction matters because the
   * uncontrolled arm's slowest request is not a hang: one batch call carries
   * roughly `batchInputChars / 3.6` prefill tokens and can draw up to
   * `batchMaxTokens` of decode, and the simulator's per-stream rate degrades by
   * close to an order of magnitude at a full envelope. A single constant
   * covering total drain time therefore does not bound that request — it just
   * decides the run on how loaded the host happened to be.
   */
  drainIdleMs: num("drain-idle-ms", 20000),
  drainMaxMs: num("drain-max-ms", 180000),
  windowMs: num("window-ms", 30000),
  traceFile: str("trace-file", ""),
  traceOut: str("trace-out", ""),
  out: str("out", ""),
});

// ── immutable request trace ──────────────────────────────────────────

if (CONFIG.interactiveTargets.length === 0 || CONFIG.batchTargets.length === 0) {
  throw new Error("interactive and batch target lists must both be non-empty");
}
if (!["openai", "anthropic"].includes(CONFIG.providerApi)) {
  throw new Error("--provider-api must be openai or anthropic");
}
const PROVIDER_PATH = CONFIG.providerApi === "anthropic"
  ? "/v1/messages"
  : "/v1/chat/completions";

const loadedTrace = CONFIG.traceFile
  ? JSON.parse(readFileSync(CONFIG.traceFile, "utf8"))
  : buildTrace(CONFIG);
const TRACE = validateTrace(loadedTrace, CONFIG);
const TRACE_HASH = traceHash(TRACE);
if (CONFIG.traceOut) {
  writeFileSync(CONFIG.traceOut, JSON.stringify({ ...TRACE, hash: TRACE_HASH }, null, 2));
}

// ── state ────────────────────────────────────────────────────────────

const classes = ["interactive", "batch"];
const stats = {};
for (const cls of classes) {
  stats[cls] = {
    logical: 0,
    attempts: 0,
    success: 0,
    localReject: 0, // cheap: refused before upstream work was spent
    upstreamReject: 0, // expensive: 429 after provider capacity was consumed
    serverError: 0,
    transportError: 0,
    exhausted: 0, // gave up after maxAttempts
    outputTokens: 0,
    localRejectReasons: {},
    localRejectPools: {},
    localRejectDetails: {},
    admissionClassResponses: {},
    firstAttemptAtMs: null,
    lastAttemptAtMs: null,
    lastLocalRejectAtMs: null,
    firstResponseHeadersAtMs: null,
    firstSuccessAtMs: null,
    /**
     * Every completion, kept for the whole run.
     *
     * Distinct from `samples`, which pruneWindows() trims to the rolling
     * metrics window on each scrape. Phase analysis needs the start of the run
     * to still be present when the summary is written, which for any run
     * longer than windowMs the rolling array cannot guarantee.
     */
    phaseSamples: [],
    retryHints: {
      received: 0, // rejections that carried a usable hint
      applied: 0, // hints that moved the wait off blind backoff
      blindSleepMs: 0,
      hintedSleepMs: 0,
    },
    samples: [], // { t, latencyMs, ttftMs }
  };
}
let inFlight = 0;
let generatorSaturated = 0;
const startedAt = Date.now();
const startedAtMonotonic = performance.now();
let metricsRelayPushFailures = 0;
const runAbort = new AbortController();

function sleep(ms, signal = undefined) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    let settled = false;
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      finish();
    };
    function finish() {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Milliseconds since the run began. Wall-clock `t` is kept for the metrics
 * relay, but every lending calculation uses this monotonic offset so it is
 * unaffected by clock adjustment mid-run.
 */
function offsetMs() {
  return performance.now() - startedAtMonotonic;
}

/** First attempt, first 2xx response headers, and first fully completed request for each class. */
function markAttempt(cls) {
  const s = stats[cls];
  const at = +offsetMs().toFixed(1);
  if (s.firstAttemptAtMs === null) s.firstAttemptAtMs = at;
  s.lastAttemptAtMs = at;
}

function markResponseHeaders(cls) {
  const s = stats[cls];
  if (s.firstResponseHeadersAtMs === null) s.firstResponseHeadersAtMs = +offsetMs().toFixed(1);
}

function markSuccess(cls) {
  const s = stats[cls];
  if (s.firstSuccessAtMs === null) s.firstSuccessAtMs = +offsetMs().toFixed(1);
}

function record(cls, latencyMs, ttftMs) {
  const s = stats[cls];
  const sample = { t: Date.now(), offsetMs: +offsetMs().toFixed(1), latencyMs, ttftMs };
  s.samples.push(sample);
  s.phaseSamples.push(sample);
}

function pruneWindows(now = Date.now()) {
  for (const cls of classes) {
    const s = stats[cls];
    const cutoff = now - CONFIG.windowMs;
    let i = 0;
    while (i < s.samples.length && s.samples[i].t < cutoff) i += 1;
    if (i > 0) s.samples.splice(0, i);
  }
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

/**
 * Splits one class's completions at the configured batch arrival.
 *
 * The boundary is the configured `batchStartMs`, not an observed first
 * arrival: an observed boundary lands differently in each arm and would make
 * the two windows incomparable across a paired run.
 *
 * Reads `phaseSamples`, which is never pruned. Deriving this from the rolling
 * `samples` array would lose the idle window entirely on any run longer than
 * `windowMs`, and would report zero idle goodput rather than failing.
 */
/** Realised per-request sizes for this class, from the replayed trace. */
function sizeSummary(cls) {
  const sizes = TRACE.entries.filter((entry) => entry.class === cls && entry.inputChars !== undefined)
    .map((entry) => entry.inputChars)
    .sort((a, b) => a - b);
  if (sizes.length === 0) return null;
  const at = (p) => sizes[Math.min(sizes.length - 1, Math.max(0, Math.ceil(p * sizes.length) - 1))];
  return {
    n: sizes.length,
    min: sizes[0],
    p50: at(0.5),
    p95: at(0.95),
    max: sizes[sizes.length - 1],
    spread: +(sizes[sizes.length - 1] / sizes[0]).toFixed(1),
  };
}

/**
 * Splits local rejections into the limit that caused them.
 *
 * `tokenBoundShare` is the fraction of refusals a concurrency-only limiter
 * could not have made. A share of zero means the benchmark did not exercise
 * token-aware admission at all, whatever the configuration says.
 */
function bindingConstraint(s) {
  const reasons = s.localRejectReasons ?? {};
  const budget = reasons.budget_limit ?? 0;
  const concurrency = (reasons.concurrency_limit ?? 0) + (reasons.queue_limit ?? 0);
  const total = budget + concurrency;
  return {
    budgetLimited: budget,
    concurrencyLimited: concurrency,
    tokenBoundShare: total > 0 ? +(budget / total).toFixed(4) : null,
    exercisedTokenAwareness: budget > 0,
  };
}

function phaseWindows(s) {
  const boundaryMs = CONFIG.batchStartMs;
  const endMs = CONFIG.durationMs;
  if (!Number.isFinite(boundaryMs) || boundaryMs <= 0 || boundaryMs >= endMs) return null;
  const inRange = (x, from, to) => x.offsetMs >= from && x.offsetMs < to;
  const describe = (bucket, spanMs) => ({
    completed: bucket.length,
    goodputRps: spanMs > 0 ? +(bucket.length / (spanMs / 1000)).toFixed(3) : null,
    p50Ms: percentile(bucket.map((x) => x.latencyMs), 0.5),
    p95Ms: percentile(bucket.map((x) => x.latencyMs), 0.95),
    ttftP50Ms: percentile(bucket.map((x) => x.ttftMs), 0.5),
    ttftP95Ms: percentile(bucket.map((x) => x.ttftMs), 0.95),
  });
  // Requests admitted before the offered-load window closes can complete after
  // it. Those completions belong to neither phase — including them would
  // inflate the contended window's goodput with work the window did not offer.
  // They are counted separately so idle + contended + drain equals the class's
  // total successes, and the split can be checked rather than trusted.
  const drained = s.phaseSamples.filter((x) => x.offsetMs >= endMs);
  return {
    boundaryMs,
    endMs,
    idle: describe(s.phaseSamples.filter((x) => inRange(x, 0, boundaryMs)), boundaryMs),
    contended: describe(
      s.phaseSamples.filter((x) => inRange(x, boundaryMs, endMs)),
      Math.max(0, endMs - boundaryMs),
    ),
    /** Completed after the offered-load window closed. */
    drainCompleted: drained.length,
  };
}

// ── one logical request, including its retries ───────────────────────

const FILLER = "The quick brown fox jumps over the lazy dog. ";
function prompt(chars) {
  let s = "";
  while (s.length < chars) s += FILLER;
  return s.slice(0, chars);
}

/** Waits before the next attempt and records which policy decided the wait. */
async function backoff(s, entry, attempt, response) {
  const decision = chooseRetryDelay({
    response,
    honorRetryHints: CONFIG.honorRetryHints,
    baseMs: CONFIG.backoffBaseMs,
    attempt,
    jitter: entry.retryJitter[attempt],
  });
  if (decision.kind === "blind") {
    s.retryHints.blindSleepMs += decision.waitMs;
  } else {
    s.retryHints.received += 1;
    if (decision.applied) s.retryHints.applied += 1;
    s.retryHints.hintedSleepMs += decision.waitMs;
  }
  await sleep(decision.waitMs, runAbort.signal);
}

/**
 * Progress records for requests currently in flight, keyed by trace id.
 *
 * A failed drain has to say which request is unfinished and what it was doing.
 * A bare count cannot separate a slow decode from a hung socket, and that is
 * exactly the distinction between a legitimate tail and a broken harness.
 */
const liveRequests = new Map();

async function issue(entry) {
  const cls = entry.class;
  const s = stats[cls];
  s.logical += 1;
  inFlight += 1;

  const isBatch = cls === "batch";
  const progress = {
    id: entry.id,
    class: cls,
    arrivalMs: entry.arrivalMs,
    maxTokens: entry.maxTokens ?? (isBatch ? CONFIG.batchMaxTokens : CONFIG.interactiveMaxTokens),
    inputChars: entry.inputChars ?? (isBatch ? CONFIG.batchInputChars : CONFIG.interactiveInputChars),
    startedAt: Date.now(),
    updatedAt: Date.now(),
    attempt: 0,
    phase: "scheduled",
    lastStatus: null,
    outputTokens: 0,
  };
  liveRequests.set(entry.id, progress);
  /**
   * Marks forward motion. The drain watches this, not the in-flight count: a
   * lone request still receiving stream frames is progressing, and a socket
   * that died holding a 200 is not. Only the second is a reason to fail a run.
   */
  const touch = (phase) => {
    progress.phase = phase;
    progress.updatedAt = Date.now();
  };
  const baseBody = {
    model: isBatch ? CONFIG.batchModel : CONFIG.interactiveModel,
    stream: true,
    ...(CONFIG.providerApi === "openai"
      ? { stream_options: { include_usage: true } }
      : {}),
    // Version-2 traces carry a size per request; version-1 traces fall back to
    // the class constant, so an old trace replays byte-identically.
    max_tokens: entry.maxTokens ?? (isBatch ? CONFIG.batchMaxTokens : CONFIG.interactiveMaxTokens),
    messages: [
      {
        role: "user",
        content: prompt(
          entry.inputChars ?? (isBatch ? CONFIG.batchInputChars : CONFIG.interactiveInputChars),
        ),
      },
    ],
  };
  const logicalStart = performance.now();
  const targets = isBatch ? CONFIG.batchTargets : CONFIG.interactiveTargets;

  try {
    for (let attempt = 0; attempt < CONFIG.maxAttempts; attempt += 1) {
      s.attempts += 1;
      markAttempt(cls);
      progress.attempt = attempt;
      touch("request");
      let response;
      try {
        const target = targets[entry.targetSlots[attempt] % targets.length];
        const providerSeed = entry.providerSeeds[attempt];
        const body = CONFIG.providerApi === "anthropic"
          ? {
              ...baseBody,
              // Anthropic has no top-level `seed` field. Use its metadata
              // envelope for the simulator's deterministic replay key so the
              // benchmark remains protocol-shaped instead of relying on an
              // upstream-invalid request property.
              metadata: { user_id: `moflux-bench:${providerSeed}` },
            }
          : { ...baseBody, seed: providerSeed };
        response = await fetch(`${target}${PROVIDER_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(CONFIG.providerApi === "anthropic"
              ? { "anthropic-version": "2023-06-01", "x-api-key": "benchmark-local" }
              : {}),
            "x-priority": isBatch ? "normal" : "high",
            ...((isBatch ? CONFIG.batchIdentityToken : CONFIG.interactiveIdentityToken)
              ? { "x-tyr-identity-token": `Bearer ${isBatch ? CONFIG.batchIdentityToken : CONFIG.interactiveIdentityToken}` }
              : {}),
            "x-bench-request-id": entry.id,
            "x-bench-attempt": String(attempt + 1),
          },
          body: JSON.stringify(body),
          signal: runAbort.signal,
        });

        progress.lastStatus = response.status;
        const responseAdmissionClass = response.headers.get("x-admission-class") ?? "unclassified";
        s.admissionClassResponses[responseAdmissionClass] =
          (s.admissionClassResponses[responseAdmissionClass] ?? 0) + 1;
        touch("response");
        if (response.status === 429) {
          // The distinction that matters: was this refused cheaply at the
          // admission layer, or earned the hard way after upstream work?
          const rejectedLocally =
            response.headers.get("x-bench-local") === "1" ||
            response.headers.has("x-admission-reason");
          if (rejectedLocally) {
            s.localReject += 1;
            s.lastLocalRejectAtMs = +offsetMs().toFixed(1);
            const raw = await response.text().catch(() => "");
            let parsed = null;
            try {
              parsed = raw ? JSON.parse(raw) : null;
            } catch {
              // Preserve the header reason even when a proxy returns non-JSON.
            }
            const reason =
              response.headers.get("x-admission-reason") ??
              parsed?.error?.reason ??
              "unknown";
            const pool = parsed?.error?.pool ?? "unknown";
            s.localRejectReasons[reason] = (s.localRejectReasons[reason] ?? 0) + 1;
            s.localRejectPools[pool] = (s.localRejectPools[pool] ?? 0) + 1;
            const detail = parsed?.error?.detail?.tokenBudget;
            const key = `${pool}/${reason}`;
            const aggregate = s.localRejectDetails[key] ?? {
              pool,
              reason,
              count: 0,
              requestedMin: null,
              requestedMax: null,
              availableMin: null,
              availableMax: null,
              budgetMin: null,
              budgetMax: null,
            };
            aggregate.count += 1;
            for (const [field, minKey, maxKey] of [
              ["requested", "requestedMin", "requestedMax"],
              ["available", "availableMin", "availableMax"],
              ["budget", "budgetMin", "budgetMax"],
            ]) {
              const value = Number(detail?.[field]);
              if (!Number.isFinite(value)) continue;
              aggregate[minKey] = aggregate[minKey] === null ? value : Math.min(aggregate[minKey], value);
              aggregate[maxKey] = aggregate[maxKey] === null ? value : Math.max(aggregate[maxKey], value);
            }
            s.localRejectDetails[key] = aggregate;
          } else {
            s.upstreamReject += 1;
            await response.arrayBuffer().catch(() => {});
          }
          if (attempt + 1 < CONFIG.maxAttempts) {
            touch("backoff");
            await backoff(s, entry, attempt, response);
          }
          continue;
        }
        if (response.status >= 500) {
          s.serverError += 1;
          await response.arrayBuffer().catch(() => {});
          if (attempt + 1 < CONFIG.maxAttempts) {
            touch("backoff");
            await backoff(s, entry, attempt, response);
          }
          continue;
        }

        // 2xx response headers are client-visible only after the upstream has
        // produced its own headers. Do not call this admission latency: for
        // streaming LLM traffic it includes provider prefill / TTFT.
        markResponseHeaders(cls);

        // Drain the stream, capture TTFT and output tokens. A replica may
        // disappear after the headers have arrived; in that case Undici throws
        // while iterating response.body rather than from fetch() itself. Treat
        // that as a retryable transport failure, not an unhandled rejection.
        let ttftMs = null;
        let outputTokens = 0;
        touch("streaming");
        if (response.body) {
          const decoder = new TextDecoder();
          let buffer = "";
          for await (const chunk of response.body) {
            buffer += decoder.decode(chunk, { stream: true });
            let idx;
            while ((idx = buffer.indexOf("\n\n")) !== -1) {
              const frame = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              const dataLine = frame.split(/\r?\n/).find((line) => line.startsWith("data:"));
              if (!dataLine) continue;
              const raw = dataLine.slice(5).trim();
              if (raw === "[DONE]") continue;
              let parsed;
              try {
                parsed = JSON.parse(raw);
              } catch {
                continue;
              }
              const openAIContent = parsed?.choices?.[0]?.delta?.content;
              const anthropicContent =
                parsed?.type === "content_block_delta" && parsed?.delta?.type === "text_delta"
                  ? parsed.delta.text
                  : undefined;
              const content = typeof openAIContent === "string"
                ? openAIContent
                : anthropicContent;
              if (typeof content === "string" && content.length > 0) {
                if (ttftMs === null) ttftMs = performance.now() - logicalStart;
                outputTokens += content.length / 4;
              }
              if (parsed?.usage?.completion_tokens !== undefined) {
                outputTokens = parsed.usage.completion_tokens;
              } else if (
                parsed?.type === "message_delta" &&
                parsed?.usage?.output_tokens !== undefined
              ) {
                outputTokens = parsed.usage.output_tokens;
              }
              progress.outputTokens = outputTokens;
              progress.updatedAt = Date.now();
            }
          }
        }
        s.success += 1;
        markSuccess(cls);
        s.outputTokens += outputTokens;
        record(cls, performance.now() - logicalStart, ttftMs ?? performance.now() - logicalStart);
        return;
      } catch {
        if (runAbort.signal.aborted) return;
        // Covers both connection failures before headers and stream termination
        // after a 2xx response has begun. Partial output is deliberately not
        // counted as a successful logical request; the request is retried.
        s.transportError += 1;
        await response?.body?.cancel().catch(() => {});
        // A stream that died mid-flight carries no capacity hint.
        if (attempt + 1 < CONFIG.maxAttempts) {
          touch("backoff");
          await backoff(s, entry, attempt, undefined);
        }
      }
    }
    s.exhausted += 1;
  } finally {
    inFlight -= 1;
    liveRequests.delete(entry.id);
  }
}

// ── immutable open-loop arrival replay ───────────────────────────────

const activeIssues = new Set();

function scheduleEntry(entry) {
  return new Promise((resolve) => {
    const delay = Math.max(0, entry.arrivalMs - (performance.now() - startedAtMonotonic));
    setTimeout(() => {
      if (inFlight >= CONFIG.inFlightCeiling) {
        // Never block the arrival process: record the breach loudly instead.
        generatorSaturated += 1;
      } else {
        const pending = issue(entry);
        activeIssues.add(pending);
        pending.finally(() => activeIssues.delete(pending));
      }
      resolve();
    }, delay);
  });
}

// ── metrics endpoint ─────────────────────────────────────────────────

function promLabel(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\"", "\\\"");
}

function renderMetrics() {
  pruneWindows();
  const lines = [];
  const emit = (type, name, help, rows) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, value] of rows) lines.push(`${name}${labels} ${value}`);
  };
  const arm = promLabel(CONFIG.armLabel);
  const seed = promLabel(CONFIG.seed);
  const L = (cls) => `{arm="${arm}",seed="${seed}",class="${promLabel(cls)}"}`;

  const rows = (pick) => classes.map((cls) => [L(cls), pick(stats[cls], cls)]);

  emit("counter", "bench_logical_requests_total", "Logical requests issued.", rows((s) => s.logical));
  emit("counter", "bench_attempts_total", "HTTP attempts including retries.", rows((s) => s.attempts));
  emit("counter", "bench_success_total", "Logical requests that completed.", rows((s) => s.success));
  emit("counter", "bench_local_rejects_total", "Cheap rejects at the admission layer.", rows((s) => s.localReject));
  {
    const detailRows = [];
    for (const cls of classes) {
      for (const detail of Object.values(stats[cls].localRejectDetails)) {
        detailRows.push([
          `{arm="${arm}",seed="${seed}",class="${promLabel(cls)}",pool="${promLabel(detail.pool)}",reason="${promLabel(detail.reason)}"}`,
          detail.count,
        ]);
      }
    }
    emit(
      "counter",
      "bench_local_reject_reason_total",
      "Local admission rejects split by pool and exact reason.",
      detailRows,
    );
  }
  emit("counter", "bench_upstream_rejects_total", "429s earned after upstream work.", rows((s) => s.upstreamReject));
  emit("counter", "bench_server_errors_total", "5xx responses.", rows((s) => s.serverError));
  emit("counter", "bench_transport_errors_total", "Connection failures.", rows((s) => s.transportError));
  emit("counter", "bench_exhausted_total", "Logical requests that never succeeded.", rows((s) => s.exhausted));
  emit("counter", "bench_output_tokens_total", "Output tokens delivered to clients.", rows((s) => Math.round(s.outputTokens)));

  emit(
    "gauge",
    "bench_retry_amplification",
    "Attempts per logical request. 1.0 means no retries.",
    rows((s) => (s.logical === 0 ? 0 : (s.attempts / s.logical).toFixed(3))),
  );

  for (const [p, label] of [
    [0.5, "p50"],
    [0.95, "p95"],
    [0.99, "p99"],
  ]) {
    emit(
      "gauge",
      `bench_latency_${label}_ms`,
      `Rolling ${CONFIG.windowMs}ms ${label} end-to-end latency.`,
      rows((s) => percentile(s.samples.map((x) => x.latencyMs), p).toFixed(1)),
    );
    emit(
      "gauge",
      `bench_ttft_${label}_ms`,
      `Rolling ${CONFIG.windowMs}ms ${label} time to first token.`,
      rows((s) => percentile(s.samples.map((x) => x.ttftMs), p).toFixed(1)),
    );
  }

  lines.push(
    "# HELP bench_run_info Benchmark run identity. Always 1 for an active or retained run.",
    "# TYPE bench_run_info gauge",
    `bench_run_info{arm="${arm}",seed="${seed}"} 1`,
    "# HELP bench_in_flight Logical requests currently outstanding.",
    "# TYPE bench_in_flight gauge",
    `bench_in_flight{arm="${arm}",seed="${seed}"} ${inFlight}`,
    "# HELP generator_saturated_total Arrivals dropped by the generator. Non-zero invalidates the run.",
    "# TYPE generator_saturated_total counter",
    `generator_saturated_total{arm="${arm}",seed="${seed}"} ${generatorSaturated}`,
    "# HELP bench_metrics_relay_push_failures_total Telemetry pushes that failed before reaching the relay.",
    "# TYPE bench_metrics_relay_push_failures_total counter",
    `bench_metrics_relay_push_failures_total{arm="${arm}",seed="${seed}"} ${metricsRelayPushFailures}`,
  );
  return lines.join("\n") + "\n";
}

let server = null;
if (CONFIG.metricsPort > 0) {
  server = createServer((req, res) => {
    if (req.url === "/metrics") {
      const body = renderMetrics();
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      res.end(body);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(CONFIG.metricsPort, "0.0.0.0", resolve);
  });
}

async function pushMetricsToRelay() {
  if (!CONFIG.metricsRelayUrl) return;
  const url = new URL(CONFIG.metricsRelayUrl);
  url.searchParams.set("run", `${CONFIG.armLabel}:seed-${CONFIG.seed}`);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "text/plain; version=0.0.4" },
      body: renderMetrics(),
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    metricsRelayPushFailures += 1;
    if (CONFIG.metricsRelayRequired) {
      throw new Error(
        `failed to push benchmark telemetry to ${CONFIG.metricsRelayUrl}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

let metricsPushTimer = null;
if (CONFIG.metricsRelayUrl) {
  await pushMetricsToRelay();
  metricsPushTimer = setInterval(() => {
    void pushMetricsToRelay().catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
    });
  }, CONFIG.metricsPushIntervalMs);
  metricsPushTimer.unref();
}

// ── run ──────────────────────────────────────────────────────────────

console.log(
  `loadgen arm=${CONFIG.armLabel} interactiveTargets=${CONFIG.interactiveTargets.length} batchTargets=${CONFIG.batchTargets.length} ` +
    `interactive=${CONFIG.interactiveRps}rps batch=${CONFIG.batchRps}rps@+${CONFIG.batchStartMs}ms ` +
    `duration=${CONFIG.durationMs}ms`,
);

await Promise.all(TRACE.entries.map(scheduleEntry));

/**
 * Let outstanding work settle so the summary is not truncated mid-stream.
 *
 * The bound is on lack of progress, not on elapsed time. A drain that is still
 * completing requests is not stuck, and in the uncontrolled arm the last one
 * out is routinely a batch call in the middle of a multi-thousand-token decode
 * at a degraded per-stream rate. Failing that run would delete the arm's own
 * tail — the very thing the comparison exists to measure — and would do it
 * non-deterministically, since the trace fixes what is requested but not how
 * fast the host serves it.
 *
 * Every arm replays the same trace through the same rule, so extending the
 * wait cannot flatter one of them: a slow arm pays for its tail in the recorded
 * latency percentiles instead of crashing the sweep.
 */
const drainStartedAt = Date.now();
const drainHardDeadline = drainStartedAt + CONFIG.drainMaxMs;
let lastProgressAt = drainStartedAt;
let lastActiveCount = activeIssues.size;
let drainStalled = false;
while (activeIssues.size > 0) {
  if (Date.now() >= drainHardDeadline) break;
  if (Date.now() - lastProgressAt >= CONFIG.drainIdleMs) {
    drainStalled = true;
    break;
  }
  await sleep(100);
  // Either a request finished, or one of the survivors advanced a state or took
  // another stream frame. A single slow decode is the normal tail of the
  // uncontrolled arm and must not be mistaken for a stall.
  if (activeIssues.size < lastActiveCount) {
    lastActiveCount = activeIssues.size;
    lastProgressAt = Date.now();
  }
  for (const record of liveRequests.values()) {
    if (record.updatedAt > lastProgressAt) lastProgressAt = record.updatedAt;
  }
}
if (activeIssues.size > 0) {
  const remaining = activeIssues.size;
  const elapsedMs = Date.now() - drainStartedAt;
  const stragglers = [...liveRequests.values()]
    .sort((a, b) => a.startedAt - b.startedAt)
    .slice(0, 10)
    .map(
      (r) =>
        `${r.id} class=${r.class} arrivalMs=${Math.round(r.arrivalMs)} ` +
        `attempt=${r.attempt + 1}/${CONFIG.maxAttempts} phase=${r.phase} ` +
        `lastStatus=${r.lastStatus ?? "none"} inputChars=${r.inputChars} maxTokens=${r.maxTokens} ` +
        `outputTokens=${Math.round(r.outputTokens)} ageMs=${Date.now() - r.startedAt}`,
    );
  const cause = drainStalled
    ? `no request completed for ${CONFIG.drainIdleMs}ms (--drain-idle-ms)`
    : `drain exceeded ${CONFIG.drainMaxMs}ms (--drain-max-ms)`;
  const detail = [
    `load generator drain failed with ${remaining} request(s) still active after ${elapsedMs}ms: ${cause}`,
    ...stragglers.map((line) => `  ${line}`),
  ].join("\n");
  runAbort.abort(new Error(detail));
  await Promise.allSettled([...activeIssues]);
  throw new Error(detail);
}

const {
  interactiveIdentityToken,
  batchIdentityToken,
  ...publicConfig
} = CONFIG;
const summary = {
  arm: CONFIG.armLabel,
  seed: CONFIG.seed,
  /**
   * How long the run took to quiesce after the last arrival, against the bounds
   * that were in force. Published so the margin is visible in the result rather
   * than only in a crash: a drain creeping toward its idle window is the arm
   * telling you its tail is growing.
   */
  drain: {
    elapsedMs: Date.now() - drainStartedAt,
    idleMs: CONFIG.drainIdleMs,
    maxMs: CONFIG.drainMaxMs,
  },
  config: {
    ...publicConfig,
    interactiveIdentityToken: interactiveIdentityToken ? "provided" : "",
    batchIdentityToken: batchIdentityToken ? "provided" : "",
    honorRetryHints: CONFIG.honorRetryHints,
    traceFile: CONFIG.traceFile ? "provided" : "",
    traceOut: CONFIG.traceOut ? "requested" : "",
    out: CONFIG.out ? "requested" : "",
  },
  generatorSaturated,
  startedAt: new Date(startedAt).toISOString(),
  startedAtEpochMs: startedAt,
  wallClockMs: Date.now() - startedAt,
  trace: {
    version: TRACE.version,
    hash: TRACE_HASH,
    planned: TRACE.planned,
    source: CONFIG.traceFile ? "provided" : "generated",
  },
  classes: {},
};
for (const cls of classes) {
  const s = stats[cls];
  const latencies = s.samples.map((x) => x.latencyMs);
  const ttfts = s.samples.map((x) => x.ttftMs);
  summary.classes[cls] = {
    logical: s.logical,
    attempts: s.attempts,
    success: s.success,
    successRate: s.logical === 0 ? 0 : +(s.success / s.logical).toFixed(4),
    retryAmplification: s.logical === 0 ? 0 : +(s.attempts / s.logical).toFixed(3),
    localReject: s.localReject,
    localRejectReasons: s.localRejectReasons,
    localRejectPools: s.localRejectPools,
    localRejectDetails: Object.values(s.localRejectDetails),
    admissionClassResponses: s.admissionClassResponses,
    upstreamReject: s.upstreamReject,
    serverError: s.serverError,
    transportError: s.transportError,
    exhausted: s.exhausted,
    requestSizes: sizeSummary(cls),
    /**
     * Which limit actually refused work.
     *
     * The question this answers: did the token budget ever decide an
     * admission, or did concurrency decide every one? If `budget_limit` is
     * zero, token-aware admission made no decision a plain semaphore could not
     * have made, and any advantage claimed over one is not attributable to it.
     */
    bindingConstraint: bindingConstraint(s),
    firstAttemptAtMs: s.firstAttemptAtMs,
    lastAttemptAtMs: s.lastAttemptAtMs,
    lastLocalRejectAtMs: s.lastLocalRejectAtMs,
    firstResponseHeadersAtMs: s.firstResponseHeadersAtMs,
    firstSuccessAtMs: s.firstSuccessAtMs,
    /** Client-visible wait from first attempt until the first 2xx response headers. */
    responseHeadersGapMs:
      s.firstAttemptAtMs === null || s.firstResponseHeadersAtMs === null
        ? null
        : +(s.firstResponseHeadersAtMs - s.firstAttemptAtMs).toFixed(1),
    /** End-to-end wait to the first fully completed request. */
    firstSuccessGapMs:
      s.firstAttemptAtMs === null || s.firstSuccessAtMs === null
        ? null
        : +(s.firstSuccessAtMs - s.firstAttemptAtMs).toFixed(1),
    /** The run split at batch arrival. See phaseWindows(). */
    windows: phaseWindows(s),
    retryHints: {
      received: s.retryHints.received,
      applied: s.retryHints.applied,
      blindSleepMs: Math.round(s.retryHints.blindSleepMs),
      hintedSleepMs: Math.round(s.retryHints.hintedSleepMs),
      // Total time this class spent waiting between attempts. The headline
      // number: hints should cut wasted attempts, not necessarily wait time.
      totalSleepMs: Math.round(
        s.retryHints.blindSleepMs + s.retryHints.hintedSleepMs,
      ),
    },
    outputTokens: Math.round(s.outputTokens),
    latencyMs: {
      p50: +percentile(latencies, 0.5).toFixed(1),
      p95: +percentile(latencies, 0.95).toFixed(1),
      p99: +percentile(latencies, 0.99).toFixed(1),
    },
    ttftMs: {
      p50: +percentile(ttfts, 0.5).toFixed(1),
      p95: +percentile(ttfts, 0.95).toFixed(1),
      p99: +percentile(ttfts, 0.99).toFixed(1),
    },
  };
}

if (CONFIG.out) {
  writeFileSync(CONFIG.out, JSON.stringify(summary, null, 2));
  console.log(`wrote ${CONFIG.out}`);
}
console.log(JSON.stringify(summary.classes, null, 2));
if (generatorSaturated > 0) {
  console.error(
    `\nWARNING: generator saturated ${generatorSaturated} times — DISCARD this run.`,
  );
}
if (metricsPushTimer) clearInterval(metricsPushTimer);
await pushMetricsToRelay();
if (server) {
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
