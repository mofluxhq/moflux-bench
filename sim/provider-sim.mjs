/**
 * provider-sim.mjs — synthetic LLM provider with a parameterized
 * concurrency/throughput degradation curve.
 *
 * Models the constraint that actually bites a shared inference pool:
 * per-stream token rate falls as batch concurrency rises. The curve is the
 * Universal Scalability Law (Gunther), so it is a published model with two
 * interpretable parameters rather than an invented shape:
 *
 *   speedup(n)      = n / (1 + sigma*(n-1) + kappa*n*(n-1))
 *   aggregate(n)    = r1 * speedup(n)          tokens/sec across all streams
 *   perStream(n)    = aggregate(n) / n         tokens/sec for one stream
 *
 *   sigma = contention   (0 = linear scaling, 1 = fully serialized)
 *   kappa = coherency    (>0 makes aggregate throughput retrograde past a peak)
 *
 * sigma=0, kappa=0 is the null hypothesis: capacity is free, so token-aware
 * admission should show little benefit. Sweeping sigma upward is how you show
 * a result holds across a range instead of at one convenient point.
 *
 * Emission is simulated on a fixed tick. Each active request accrues tokens at
 * the current perStream(n) rate, so a request that starts alone and is later
 * joined by 40 others slows down mid-stream — which is what makes
 * reconciliation and overrun behavior worth measuring.
 *
 * Deliberately NOT leaked to the client: the sampled output length. The
 * estimator must not be able to see what it is trying to predict.
 */

import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";

/**
 * Identifies this specific simulator process.
 *
 * Binding a socket is not the same as owning the address a caller will dial.
 * On macOS a listener bound to `127.0.0.1:9000` and one bound to `0.0.0.0:9000`
 * can coexist, and the specific bind wins loopback — so this process can start
 * cleanly while every replica request lands somewhere else entirely. The id is
 * printed in the startup banner and served from `/admin/stats`, which lets the
 * presenter prove that the provider it dialled is the child it launched.
 */
const INSTANCE_ID = randomUUID();
const SERVICE_NAME = "moflux-provider-sim";

// ── args ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = new Map();
  for (const arg of argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    if (m) out.set(m[1], m[2]);
    else if (arg.startsWith("--")) out.set(arg.slice(2), "true");
  }
  return out;
}
const args = parseArgs(process.argv);

function num(name, fallback) {
  const raw = args.get(name);
  if (raw === undefined) return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`--${name} must be a finite number`);
  return v;
}

const CONFIG = Object.freeze({
  port: num("port", 9000),
  // capacity envelope
  envelope: num("envelope", 40), // max requests in prefill+decode
  queue: num("queue", 20), // waiters before 429
  // USL curve
  sigma: num("sigma", 0.35),
  kappa: num("kappa", 0),
  r1: num("r1", 90), // decode tokens/sec for a single stream
  prefillR1: num("prefill-r1", 4000), // prefill tokens/sec for a single stream
  // truth vs estimate
  inputCharRatio: num("input-char-ratio", 3.6), // sim's true chars/token
  inputJitter: num("input-jitter", 0.04), // +/- fraction on true input
  // output length distribution (lognormal, capped by request max_tokens)
  outputMu: num("output-mu", 5.3), // ln-space mean  -> median ~200 tok
  outputSigma: num("output-sigma", 0.9), // ln-space sd -> heavy right tail
  // faults
  failRate: num("fail-rate", 0),
  stallRate: num("stall-rate", 0),
  stallMs: num("stall-ms", 30000),
  ttftBaseMs: num("ttft-base-ms", 40),
  tickMs: num("tick-ms", 20),
  seed: num("seed", 1),
});

// ── request-keyed deterministic sampling ─────────────────────────────

function uniform(key, salt) {
  const digest = createHash("sha256").update(`${CONFIG.seed}:${key}:${salt}`).digest();
  return digest.readUInt32BE(0) / 4294967296;
}

/** Box-Muller standard normal keyed by the immutable request trace. */
function normal(key, salt) {
  const u = Math.max(Number.EPSILON, uniform(key, `${salt}:u`));
  const v = Math.max(Number.EPSILON, uniform(key, `${salt}:v`));
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function sampleOutputTokens(cap, key) {
  const drawn = Math.max(
    1,
    Math.round(Math.exp(CONFIG.outputMu + CONFIG.outputSigma * normal(key, "output"))),
  );
  return Math.min(drawn, cap);
}



// ── the curve ────────────────────────────────────────────────────────

export function speedup(n, sigma = CONFIG.sigma, kappa = CONFIG.kappa) {
  if (n <= 0) return 0;
  return n / (1 + sigma * (n - 1) + kappa * n * (n - 1));
}
const aggregate = (n, r) => r * speedup(n);
const perStream = (n, r) => (n <= 0 ? r : aggregate(n, r) / n);

// ── state ────────────────────────────────────────────────────────────

/** @type {Set<object>} */ const active = new Set();
/** @type {object[]} */ const waiting = [];

const counters = {
  received: 0,
  admitted: 0,
  rejected429: 0,
  failed500: 0,
  completed: 0,
  disconnected: 0,
  trueInputTokens: 0,
  trueOutputTokens: 0,
  peakActive: 0,
  peakQueue: 0,
  /**
   * Highest concurrent occupancy observed in each whole second since the
   * simulator started, indexed by second.
   *
   * The lending measurement is "what did occupancy reach while the batch pool
   * was idle, versus after batch arrived" — a question a single cumulative
   * high-water mark cannot answer, because one late spike hides an entire
   * quiet window. Per-second buckets let any window be reconstructed after the
   * fact without the simulator needing to know the workload's phase layout.
   */
  peakActiveBySecond: [],
  emittedTokens: 0,
  ticks: 0,
  tickDtSum: 0,
};

// ── http helpers ─────────────────────────────────────────────────────

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 64 * 1024 * 1024) throw new Error("payload too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function textLength(content) {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") n += block.text.length;
  }
  return n;
}

/**
 * True input token count. Uses a ratio distinct from any estimator's assumed
 * ratio, plus jitter, so input estimation error is non-zero and measurable.
 */
function trueInputTokens(body, key) {
  let chars = 0;
  for (const m of body.messages ?? []) chars += textLength(m.content);
  if (body.system !== undefined) chars += textLength(body.system);
  const base = chars / CONFIG.inputCharRatio;
  const jitter = 1 + CONFIG.inputJitter * (2 * uniform(key, "input-jitter") - 1);
  return Math.max(1, Math.round(base * jitter));
}

const FILLER = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do ";
function fillerFor(tokens) {
  const chars = Math.max(1, tokens * 4);
  let s = "";
  while (s.length < chars) s += FILLER;
  return s.slice(0, chars);
}

// ── admission into the simulated pool ────────────────────────────────

function tryStart() {
  while (waiting.length > 0 && active.size < CONFIG.envelope) {
    const job = waiting.shift();
    if (job.aborted) continue;
    job.queuedMs = Date.now() - job.enqueuedAt;
    active.add(job);
    counters.admitted += 1;
    if (active.size > counters.peakActive) counters.peakActive = active.size;
    recordOccupancy();
  }
}

/**
 * Occupancy is sampled on a timer as well as on admission, because a busy
 * provider can go a whole second without either an admission or a completion.
 * Event-driven sampling alone leaves gaps exactly when the pool is most full.
 */
function startOccupancySampler() {
  const timer = setInterval(recordOccupancy, 200);
  timer.unref();
  return timer;
}

/** Start of the simulator process, so buckets are indexed from run start. */
const OCCUPANCY_EPOCH_MS = Date.now();
/** Bound the array so a long-running simulator cannot grow it without limit. */
const MAX_OCCUPANCY_SECONDS = 3600;

function recordOccupancy() {
  const second = Math.floor((Date.now() - OCCUPANCY_EPOCH_MS) / 1000);
  if (second < 0 || second >= MAX_OCCUPANCY_SECONDS) return;
  const buckets = counters.peakActiveBySecond;
  // Backfill skipped seconds with the occupancy that actually held through
  // them, not zero. A second can pass with no admission and no completion
  // while the pool is full — recording 0 there would claim the provider went
  // idle, and a window containing only such seconds would read as empty.
  const current = active.size;
  while (buckets.length <= second) buckets.push(current);
  if (current > buckets[second]) buckets[second] = current;
}

function finish(job, { error } = {}) {
  recordOccupancy();
  job.settled = true;
  active.delete(job);
  if (job.timer) clearTimeout(job.timer);

  if (error === "stall") {
    // Hold the socket open without completing, then hang up.
    job.timer = setTimeout(() => {
      try {
        job.res.destroy();
      } catch {
        /* client already gone */
      }
    }, CONFIG.stallMs);
    tryStart();
    return;
  }

  if (error === "500") {
    counters.failed500 += 1;
    if (job.stream) {
      if (!job.headersSent) {
        job.res.writeHead(500, { "content-type": "application/json" });
      }
      job.res.end(JSON.stringify({ error: { type: "sim_upstream_error" } }));
    } else {
      sendJson(job.res, 500, { error: { type: "sim_upstream_error" } });
    }
    tryStart();
    return;
  }

  counters.completed += 1;
  counters.trueInputTokens += job.inputTokens;
  counters.trueOutputTokens += job.emitted;

  if (job.api === "anthropic") {
    const usage = { input_tokens: job.inputTokens, output_tokens: job.emitted };
    if (job.stream) {
      startStream(job);
      writeSse(job, {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: job.emitted },
      });
      writeSse(job, { type: "content_block_stop", index: 0 });
      writeSse(job, { type: "message_stop" });
      job.res.end();
    } else {
      sendJson(job.res, 200, {
        id: job.id,
        type: "message",
        role: "assistant",
        model: job.model,
        content: [{ type: "text", text: fillerFor(job.emitted) }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage,
      });
    }
  } else {
    const usage = {
      prompt_tokens: job.inputTokens,
      completion_tokens: job.emitted,
      total_tokens: job.inputTokens + job.emitted,
    };
    if (job.stream) {
      startStream(job);
      writeSse(job, {
        id: job.id,
        object: "chat.completion.chunk",
        model: job.model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage,
      });
      job.res.write("data: [DONE]\n\n");
      job.res.end();
    } else {
      sendJson(job.res, 200, {
        id: job.id,
        object: "chat.completion",
        model: job.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: fillerFor(job.emitted) },
            finish_reason: "stop",
          },
        ],
        usage,
      });
    }
  }
  tryStart();
}

function writeSse(job, payload) {
  const event = job.api === "anthropic" && typeof payload?.type === "string"
    ? `event: ${payload.type}\n`
    : "";
  job.res.write(`${event}data: ${JSON.stringify(payload)}\n\n`);
}

function startStream(job) {
  if (!job.stream || job.headersSent) return;
  job.headersSent = true;
  job.res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  if (job.api === "anthropic") {
    writeSse(job, {
      type: "message_start",
      message: {
        id: job.id,
        type: "message",
        role: "assistant",
        model: job.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: job.inputTokens, output_tokens: 0 },
      },
    });
    writeSse(job, {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
  }
}

// ── the tick: accrue tokens at the current degraded rate ─────────────

let lastTick = Date.now();

function tick() {
  const now = Date.now();
  const dt = (now - lastTick) / 1000;
  lastTick = now;
  if (dt <= 0) return;

  counters.ticks += 1;
  counters.tickDtSum += dt;
  const n = active.size;
  if (n === 0) return;

  const decodeRate = perStream(n, CONFIG.r1);
  const prefillRate = perStream(n, CONFIG.prefillR1);

  for (const job of [...active]) {
    if (job.aborted) {
      active.delete(job);
      continue;
    }

    if (now < job.notBefore) continue; // fixed pre-prefill overhead
    if (job.prefillRemaining > 0) {
      job.prefillRemaining -= prefillRate * dt;
      if (job.prefillRemaining > 0) continue;
      // prefill done -> TTFT
      job.ttftMs = now - job.receivedAt;
      startStream(job);
    }

    job.tokenCredit += decodeRate * dt;
    const whole = Math.floor(job.tokenCredit);
    if (whole <= 0) continue;
    job.tokenCredit -= whole;

    const remaining = job.targetOutput - job.emitted;
    const emit = Math.min(whole, remaining);
    job.emitted += emit;
    counters.emittedTokens += emit;

    if (job.stream && emit > 0) {
      if (job.api === "anthropic") {
        writeSse(job, {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: fillerFor(emit) },
        });
        // Anthropic message_delta usage is cumulative. Emitting it alongside
        // each content chunk gives Tyr a live, monotonic signal to reconcile.
        writeSse(job, {
          type: "message_delta",
          delta: { stop_reason: null, stop_sequence: null },
          usage: { output_tokens: job.emitted },
        });
      } else {
        writeSse(job, {
          id: job.id,
          object: "chat.completion.chunk",
          model: job.model,
          choices: [{ index: 0, delta: { content: fillerFor(emit) }, finish_reason: null }],
        });
      }
    }

    if (job.emitted >= job.targetOutput) {
      if (job.injectFault === "500") finish(job, { error: "500" });
      else if (job.injectFault === "stall") finish(job, { error: "stall" });
      else finish(job);
    }
  }
}

const ticker = setInterval(tick, CONFIG.tickMs);
ticker.unref?.();


// ── prometheus exposition ────────────────────────────────────────────

function renderMetrics() {
  const n = active.size;
  const lines = [];
  const g = (name, help, value) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${value}`);
  };
  const c = (name, help, value) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`, `${name} ${value}`);
  };

  g("sim_envelope", "Max concurrent requests the simulated pool will serve.", CONFIG.envelope);
  g("sim_queue_bound", "Waiters allowed before the pool returns 429.", CONFIG.queue);
  g("sim_sigma", "USL contention parameter in force.", CONFIG.sigma);
  g("sim_kappa", "USL coherency parameter in force.", CONFIG.kappa);
  g("sim_r1_tokens_per_second", "Single-stream decode rate at n=1.", CONFIG.r1);
  g("sim_active", "Requests currently in prefill or decode.", n);
  g("sim_queued", "Requests waiting for an envelope slot.", waiting.length);
  g("sim_per_stream_tokens_per_second", "Current per-stream decode rate.", perStream(n, CONFIG.r1).toFixed(3));
  g("sim_aggregate_tokens_per_second", "Current pool-wide decode rate.", aggregate(n, CONFIG.r1).toFixed(3));
  g("sim_peak_active", "High-water mark of concurrent served requests.", counters.peakActive);
  g("sim_peak_queued", "High-water mark of queue depth.", counters.peakQueue);

  c("sim_requests_received_total", "Requests accepted at the socket.", counters.received);
  c("sim_requests_admitted_total", "Requests that entered the envelope.", counters.admitted);
  c("sim_rejected_429_total", "Provider-side rate-limit rejections.", counters.rejected429);
  c("sim_failed_500_total", "Injected upstream errors.", counters.failed500);
  c("sim_completed_total", "Requests that streamed to completion.", counters.completed);
  c("sim_disconnected_total", "Requests abandoned by the client mid-flight.", counters.disconnected);
  c("sim_input_tokens_total", "True input tokens consumed.", counters.trueInputTokens);
  c("sim_output_tokens_total", "True output tokens emitted.", counters.trueOutputTokens);
  c("sim_emitted_tokens_total", "Output tokens emitted, counted live per tick.", counters.emittedTokens);

  return lines.join("\n") + "\n";
}

// ── server ───────────────────────────────────────────────────────────

let sequence = 0;

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && req.url === "/metrics") {
    const body = renderMetrics();
    res.writeHead(200, {
      "content-type": "text/plain; version=0.0.4",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }

  if (req.method === "GET" && req.url === "/admin/stats") {
    const n = active.size;
    sendJson(res, 200, {
      service: SERVICE_NAME,
      instance: INSTANCE_ID,
      config: CONFIG,
      active: n,
      queued: waiting.length,
      perStreamTokensPerSec: Number(perStream(n, CONFIG.r1).toFixed(3)),
      aggregateTokensPerSec: Number(aggregate(n, CONFIG.r1).toFixed(3)),
      counters,
    });
    return;
  }

  if (req.method === "POST" && req.url === "/admin/reset") {
    for (const key of Object.keys(counters)) counters[key] = 0;
    sendJson(res, 200, { ok: true });
    return;
  }

  const isChat = req.url === "/v1/chat/completions";
  const isMessages = req.url === "/v1/messages";
  if (req.method !== "POST" || !(isChat || isMessages)) {
    sendJson(res, 404, { error: { type: "not_found" } });
    return;
  }

  let body;
  try {
    body = await readJson(req);
  } catch {
    sendJson(res, 400, { error: { type: "invalid_request_error" } });
    return;
  }

  counters.received += 1;


  // Backpressure: envelope full and queue full -> provider-side 429.
  if (active.size >= CONFIG.envelope && waiting.length >= CONFIG.queue) {
    counters.rejected429 += 1;
    sendJson(
      res,
      429,
      { error: { type: "rate_limit_error", message: "simulated pool saturated" } },
      { "retry-after": "1" },
    );
    return;
  }

  sequence += 1;
  const directSeed = Number(body.seed);
  const anthropicReplayKey = typeof body.metadata?.user_id === "string"
    ? body.metadata.user_id.trim()
    : "";
  const requestKey = Number.isFinite(directSeed)
    ? `trace-${directSeed}`
    : anthropicReplayKey !== ""
      ? `trace-${anthropicReplayKey}`
      : `untraced-${sequence}`;
  const inputTokens = trueInputTokens(body, requestKey);
  const cap = Number(body.max_tokens ?? body.max_completion_tokens ?? 4096);

  const roll = uniform(requestKey, "fault");
  const injectFault =
    roll < CONFIG.failRate ? "500" : roll < CONFIG.failRate + CONFIG.stallRate ? "stall" : null;

  const job = {
    id: `${isMessages ? "simmsg" : "simcmpl"}_${requestKey}`,
    api: isMessages ? "anthropic" : "openai",
    res,
    model: body.model ?? "sim-model",
    stream: body.stream === true,
    receivedAt: Date.now(),
    enqueuedAt: Date.now(),
    inputTokens,
    // sampled, and never disclosed to the caller
    targetOutput: sampleOutputTokens(Number.isFinite(cap) && cap > 0 ? cap : 4096, requestKey),
    prefillRemaining: inputTokens,
    notBefore: Date.now() + CONFIG.ttftBaseMs,
    tokenCredit: 0,
    emitted: 0,
    aborted: false,
    settled: false,
    headersSent: false,
    injectFault,
    timer: null,
  };

  // `req.on("aborted")` is deprecated and does not fire reliably on modern
  // Node. Without this, an abandoned request keeps its envelope slot forever
  // and silently steals throughput from live streams — which corrupts every
  // measurement taken afterwards.
  res.on("close", () => {
    if (job.settled) return;
    job.aborted = true;
    if (job.timer) clearTimeout(job.timer);
    let reclaimed = active.delete(job);
    const queued = waiting.indexOf(job);
    if (queued !== -1) {
      waiting.splice(queued, 1);
      reclaimed = true;
    }
    if (reclaimed) counters.disconnected += 1;
    tryStart();
  });

  waiting.push(job);
  if (waiting.length > counters.peakQueue) counters.peakQueue = waiting.length;
  tryStart();
});

startOccupancySampler();
// Without this, a taken port surfaces as an unhandled 'error' event: a stack
// trace from node:net that says nothing about which demo component collided
// with what. The supervisor reads this line back out of the child's output.
server.on("error", (error) => {
  const detail = error?.code === "EADDRINUSE"
    ? `port ${CONFIG.port} is already in use by another process`
    : `${error?.code ?? "error"}: ${error?.message ?? String(error)}`;
  console.error(`provider-sim failed to start: ${detail}`);
  process.exit(1);
});
server.listen(CONFIG.port, "0.0.0.0", () => {
  console.log(
    `provider-sim :${CONFIG.port} envelope=${CONFIG.envelope} queue=${CONFIG.queue} ` +
      `sigma=${CONFIG.sigma} kappa=${CONFIG.kappa} r1=${CONFIG.r1} seed=${CONFIG.seed} ` +
      `instance=${INSTANCE_ID} APIs=openai,anthropic`,
  );
});
