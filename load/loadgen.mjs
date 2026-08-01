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
  metricsPort: num("metrics-port", 8200),
  metricsRelayUrl: str("metrics-relay-url", ""),
  metricsPushIntervalMs: num("metrics-push-interval-ms", 1000),
  metricsRelayRequired: bool("metrics-relay-required", false),
  armLabel: str("arm-label", "unknown"),
  durationMs: num("duration-ms", 60000),
  seed: num("seed", 1),

  // Tyr routes to pools by model prefix only, so the two tiers must carry
  // distinct model strings for a per-tier capacity floor to be expressible.
  interactiveModel: str("interactive-model", "sim-model-interactive"),
  batchModel: str("batch-model", "sim-model-batch"),

  interactiveRps: num("interactive-rps", 12),
  interactiveInputChars: num("interactive-input-chars", 1200),
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
  windowMs: num("window-ms", 30000),
  traceFile: str("trace-file", ""),
  traceOut: str("trace-out", ""),
  out: str("out", ""),
});

// ── immutable request trace ──────────────────────────────────────────

if (CONFIG.interactiveTargets.length === 0 || CONFIG.batchTargets.length === 0) {
  throw new Error("interactive and batch target lists must both be non-empty");
}

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

function record(cls, latencyMs, ttftMs) {
  const s = stats[cls];
  s.samples.push({ t: Date.now(), latencyMs, ttftMs });
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

async function issue(entry) {
  const cls = entry.class;
  const s = stats[cls];
  s.logical += 1;
  inFlight += 1;

  const isBatch = cls === "batch";
  const baseBody = {
    model: isBatch ? CONFIG.batchModel : CONFIG.interactiveModel,
    stream: true,
    max_tokens: isBatch ? CONFIG.batchMaxTokens : CONFIG.interactiveMaxTokens,
    messages: [
      { role: "user", content: prompt(isBatch ? CONFIG.batchInputChars : CONFIG.interactiveInputChars) },
    ],
  };
  const logicalStart = performance.now();
  const targets = isBatch ? CONFIG.batchTargets : CONFIG.interactiveTargets;

  try {
    for (let attempt = 0; attempt < CONFIG.maxAttempts; attempt += 1) {
      s.attempts += 1;
      let response;
      try {
        const target = targets[entry.targetSlots[attempt] % targets.length];
        const body = {
          ...baseBody,
          seed: entry.providerSeeds[attempt],
        };
        response = await fetch(`${target}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-priority": isBatch ? "normal" : "high",
            "x-bench-request-id": entry.id,
            "x-bench-attempt": String(attempt + 1),
          },
          body: JSON.stringify(body),
          signal: runAbort.signal,
        });

        if (response.status === 429) {
          // The distinction that matters: was this refused cheaply at the
          // admission layer, or earned the hard way after upstream work?
          const rejectedLocally =
            response.headers.get("x-bench-local") === "1" ||
            response.headers.has("x-admission-reason");
          if (rejectedLocally) {
            s.localReject += 1;
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
          await backoff(s, entry, attempt, response);
          continue;
        }
        if (response.status >= 500) {
          s.serverError += 1;
          await response.arrayBuffer().catch(() => {});
          await backoff(s, entry, attempt, response);
          continue;
        }

        // 2xx: drain the stream, capture TTFT and output tokens. A replica may
        // disappear after the headers have arrived; in that case Undici throws
        // while iterating response.body rather than from fetch() itself. Treat
        // that as a retryable transport failure, not an unhandled rejection.
        let ttftMs = null;
        let outputTokens = 0;
        if (response.body) {
          const decoder = new TextDecoder();
          let buffer = "";
          for await (const chunk of response.body) {
            buffer += decoder.decode(chunk, { stream: true });
            let idx;
            while ((idx = buffer.indexOf("\n\n")) !== -1) {
              const frame = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              if (!frame.startsWith("data: ")) continue;
              const raw = frame.slice(6);
              if (raw === "[DONE]") continue;
              let parsed;
              try {
                parsed = JSON.parse(raw);
              } catch {
                continue;
              }
              const content = parsed?.choices?.[0]?.delta?.content;
              if (typeof content === "string" && content.length > 0) {
                if (ttftMs === null) ttftMs = performance.now() - logicalStart;
                outputTokens += content.length / 4;
              }
              if (parsed?.usage?.completion_tokens !== undefined) {
                outputTokens = parsed.usage.completion_tokens;
              }
            }
          }
        }
        s.success += 1;
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
        await backoff(s, entry, attempt, undefined);
      }
    }
    s.exhausted += 1;
  } finally {
    inFlight -= 1;
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
// Let outstanding work settle so the summary is not truncated mid-stream.
const drainDeadline = Date.now() + 20000;
while (activeIssues.size > 0 && Date.now() < drainDeadline) await sleep(100);
if (activeIssues.size > 0) {
  const remaining = activeIssues.size;
  runAbort.abort(new Error(`load generator drain deadline exceeded with ${remaining} request(s) still active`));
  await Promise.allSettled([...activeIssues]);
  throw new Error(`load generator drain deadline exceeded with ${remaining} request(s) still active`);
}

const summary = {
  arm: CONFIG.armLabel,
  seed: CONFIG.seed,
  config: {
    ...CONFIG,
    honorRetryHints: CONFIG.honorRetryHints,
    traceFile: CONFIG.traceFile ? "provided" : "",
    traceOut: CONFIG.traceOut ? "requested" : "",
    out: CONFIG.out ? "requested" : "",
  },
  generatorSaturated,
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
    upstreamReject: s.upstreamReject,
    serverError: s.serverError,
    transportError: s.transportError,
    exhausted: s.exhausted,
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
