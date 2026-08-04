/**
 * replica.mjs — one application replica with a pluggable admission policy.
 *
 * Every arm sits in the same position in the request path and forwards
 * identically; the ONLY thing that varies is the admission decision. That is
 * what makes the latency and goodput numbers comparable — if the arms differed
 * in their proxy implementation, the comparison would measure the proxy.
 *
 *   --arm=passthrough   Arm 1. No admission control. The baseline.
 *   --arm=static-cap    Arms 2 and 3. Local semaphore, no coordination.
 *                       Arm 2: --max-concurrent = envelope / replicaCount
 *                       Arm 3: --max-concurrent = envelope  (the pathology:
 *                       every replica believes it owns the whole envelope)
 *   --arm=redis         Arm 4. Fleet-coordinated concurrency AND token budget
 *                       via an atomic Lua script, with TTL leak recovery.
 *                       This is the buy-vs-build competitor, built properly.
 *
 * Deliberate limitations of the redis arm, which are the point of including it:
 *   - a Redis round trip on every admission (latency + a new hard dependency)
 *   - no priority reserve: batch traffic can starve interactive traffic
 *   - no reconciliation: max_tokens stays held for the whole call, so the
 *     budget is mostly phantom reservation
 *   - crash leaks capacity until the lease TTL expires
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { RedisClient } from "./redis-client.mjs";

// ── args ─────────────────────────────────────────────────────────────

const args = new Map();
for (const arg of process.argv.slice(2)) {
  const m = /^--([^=]+)=(.*)$/.exec(arg);
  if (m) args.set(m[1], m[2]);
  else if (arg.startsWith("--")) args.set(arg.slice(2), "true");
}
const num = (name, fallback) => (args.has(name) ? Number(args.get(name)) : fallback);
const str = (name, fallback) => args.get(name) ?? fallback;

const CONFIG = Object.freeze({
  port: num("port", 8100),
  upstream: str("upstream", "http://127.0.0.1:9000"),
  arm: str("arm", "passthrough"),
  id: str("id", "r1"),
  maxConcurrent: num("max-concurrent", 8),
  interactiveMaxConcurrent: num("interactive-max-concurrent", num("max-concurrent", 8)),
  batchMaxConcurrent: num("batch-max-concurrent", num("max-concurrent", 8)),
  maxQueue: num("max-queue", 0),
  queueTimeoutMs: num("queue-timeout-ms", 2000),
  // redis arm
  redisHost: str("redis-host", "127.0.0.1"),
  redisPort: num("redis-port", 6379),
  /**
   * Simulated network distance to the coordination service, per round trip.
   *
   * Only the redis arm consults a coordinator on the admission path, so only
   * it pays this. A lease-based design pays the same latency on grant renewal
   * instead, amortised across every admission the grant covers — the point of
   * the sweep is to show which of those two costs scales with request rate.
   */
  coordinatorLatencyMs: num("coordinator-latency-ms", 0),
  tokenBudget: num("token-budget", 0), // 0 disables token gating
  leaseTtlMs: num("lease-ttl-ms", 120000),
  keyPrefix: str("key-prefix", "bench"),
  // estimation (shared by the redis arm; deliberately the same crude
  // char-ratio approach a hand-rolled limiter would use)
  charRatio: num("char-ratio", 4.0),
  defaultMaxTokens: num("default-max-tokens", 2048),
});

const VALID_ARMS = new Set(["passthrough", "static-cap", "static-partition", "redis"]);
if (!VALID_ARMS.has(CONFIG.arm)) {
  console.error(`unknown --arm=${CONFIG.arm}; expected one of ${[...VALID_ARMS].join(", ")}`);
  process.exit(2);
}

function requireInteger(name, value, { minimum = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    console.error(
      `invalid --${name}=${String(value)}; expected an integer >= ${minimum}`,
    );
    process.exit(2);
  }
}

requireInteger("port", CONFIG.port, { minimum: 1 });
requireInteger("max-queue", CONFIG.maxQueue, { minimum: 0 });
requireInteger("queue-timeout-ms", CONFIG.queueTimeoutMs, { minimum: 1 });
requireInteger("token-budget", CONFIG.tokenBudget, { minimum: 0 });
requireInteger("lease-ttl-ms", CONFIG.leaseTtlMs, { minimum: 1 });
if (!Number.isFinite(CONFIG.charRatio) || CONFIG.charRatio <= 0) {
  console.error(
    `invalid --char-ratio=${String(CONFIG.charRatio)}; expected a finite number > 0`,
  );
  process.exit(2);
}
requireInteger("default-max-tokens", CONFIG.defaultMaxTokens, { minimum: 1 });
if (CONFIG.arm !== "passthrough") {
  requireInteger("max-concurrent", CONFIG.maxConcurrent, { minimum: 1 });
}
if (CONFIG.arm === "static-partition") {
  requireInteger("interactive-max-concurrent", CONFIG.interactiveMaxConcurrent, { minimum: 1 });
  requireInteger("batch-max-concurrent", CONFIG.batchMaxConcurrent, { minimum: 1 });
}

// ── metrics ──────────────────────────────────────────────────────────

const counters = {
  received: 0,
  admitted: 0,
  rejectedConcurrency: 0,
  rejectedBudget: 0,
  rejectedQueueTimeout: 0,
  upstream2xx: 0,
  upstream429: 0,
  upstream5xx: 0,
  transportErrors: 0,
  clientDisconnects: 0,
  tokensReserved: 0,
  tokensActual: 0,
  admissionWaitMsSum: 0,
  admissionOverheadMsSum: 0,
  admissionOverheadCount: 0,
};
let inFlight = 0;
let queueDepth = 0;

// ── admission policies ───────────────────────────────────────────────

/** Arm 1: everything is admitted. */
const passthroughPolicy = {
  async acquire() {
    return { ok: true, reserved: 0, release: () => {} };
  },
};

/**
 * Arms 2 and 3: a purely local semaphore with an optional bounded queue.
 * No knowledge of any other replica exists here — which is exactly the
 * failure mode arm 3 is built to expose.
 */
function createStaticCapPolicy(maxConcurrent = CONFIG.maxConcurrent) {
  let held = 0;
  const waiters = [];

  const releaseOne = () => {
    held -= 1;
    while (waiters.length > 0 && held < maxConcurrent) {
      const waiter = waiters.shift();
      queueDepth = waiters.length;
      if (waiter.settled) continue;
      waiter.settled = true;
      clearTimeout(waiter.timer);
      held += 1;
      waiter.resolve({ ok: true, reserved: 0, release: releaseOne });
    }
  };

  return {
    acquire() {
      if (held < maxConcurrent) {
        held += 1;
        return Promise.resolve({ ok: true, reserved: 0, release: releaseOne });
      }
      if (CONFIG.maxQueue <= 0 || waiters.length >= CONFIG.maxQueue) {
        return Promise.resolve({ ok: false, reason: "concurrency_limit" });
      }
      return new Promise((resolve) => {
        const waiter = { resolve, settled: false, timer: null };
        waiter.timer = setTimeout(() => {
          if (waiter.settled) return;
          waiter.settled = true;
          const idx = waiters.indexOf(waiter);
          if (idx !== -1) waiters.splice(idx, 1);
          queueDepth = waiters.length;
          resolve({ ok: false, reason: "queue_timeout" });
        }, CONFIG.queueTimeoutMs);
        waiters.push(waiter);
        queueDepth = waiters.length;
      });
    },
  };
}

/**
 * Arm 4: shared concurrency + token budget in Redis.
 *
 * Reserve and release are a single atomic script each, so two replicas cannot
 * both admit into the last slot. Expired leases are swept on every reserve,
 * which is how a crashed replica's capacity eventually comes back — note
 * "eventually": until the TTL elapses, that capacity is stranded.
 */
const RESERVE_LUA = `
local leases     = KEYS[1]
local tokensKey  = KEYS[2]
local inflightKey= KEYS[3]
local now        = tonumber(ARGV[1])
local ttl        = tonumber(ARGV[2])
local maxConc    = tonumber(ARGV[3])
local budget     = tonumber(ARGV[4])
local want       = tonumber(ARGV[5])
local leaseId    = ARGV[6]

-- Sweep expired leases: this is the crash-recovery path.
local expired = redis.call('ZRANGEBYSCORE', leases, '-inf', now)
if #expired > 0 then
  local freed = 0
  for i = 1, #expired do
    local held = redis.call('HGET', tokensKey, expired[i])
    if held then freed = freed + tonumber(held) end
    redis.call('HDEL', tokensKey, expired[i])
  end
  redis.call('ZREMRANGEBYSCORE', leases, '-inf', now)
  if freed > 0 then redis.call('DECRBY', inflightKey, freed) end
end

local conc = redis.call('ZCARD', leases)
if conc >= maxConc then
  return {0, 'concurrency_limit', conc, tonumber(redis.call('GET', inflightKey) or 0)}
end

local inflight = tonumber(redis.call('GET', inflightKey) or 0)
if budget > 0 and inflight + want > budget then
  return {0, 'budget_limit', conc, inflight}
end

redis.call('ZADD', leases, now + ttl, leaseId)
redis.call('HSET', tokensKey, leaseId, want)
if want > 0 then redis.call('INCRBY', inflightKey, want) end
return {1, 'admitted', conc + 1, inflight + want}
`;

const RELEASE_LUA = `
local leases     = KEYS[1]
local tokensKey  = KEYS[2]
local inflightKey= KEYS[3]
local leaseId    = ARGV[1]
local held = redis.call('HGET', tokensKey, leaseId)
if not held then return 0 end
redis.call('HDEL', tokensKey, leaseId)
redis.call('ZREM', leases, leaseId)
local h = tonumber(held)
if h > 0 then redis.call('DECRBY', inflightKey, h) end
return 1
`;

async function createRedisPolicy() {
  const client = new RedisClient({
    host: CONFIG.redisHost,
    port: CONFIG.redisPort,
    latencyMs: CONFIG.coordinatorLatencyMs,
  });
  await client.connect();
  const reserve = await client.loadScript(RESERVE_LUA);
  const release = await client.loadScript(RELEASE_LUA);
  const keys = [
    `${CONFIG.keyPrefix}:leases`,
    `${CONFIG.keyPrefix}:tokens`,
    `${CONFIG.keyPrefix}:inflight`,
  ];

  return {
    client,
    async acquire(reservedTokens) {
      const leaseId = `${CONFIG.id}:${randomUUID()}`;
      const started = performance.now();
      const reply = await reserve.eval(keys, [
        Date.now(),
        CONFIG.leaseTtlMs,
        CONFIG.maxConcurrent,
        CONFIG.tokenBudget,
        reservedTokens,
        leaseId,
      ]);
      // Every admission pays this round trip. Arms 1-3 do not.
      counters.admissionOverheadMsSum += performance.now() - started;
      counters.admissionOverheadCount += 1;

      const admitted = Number(reply[0]) === 1;
      if (!admitted) {
        return { ok: false, reason: String(reply[1]) };
      }
      return {
        ok: true,
        reserved: reservedTokens,
        // No reconciliation: the full max_tokens reservation is held for the
        // entire call and only returned at release.
        release: () => {
          release.eval(keys, [leaseId]).catch(() => {
            /* lease will be swept by TTL */
          });
        },
      };
    },
  };
}

// ── token estimation (crude on purpose) ──────────────────────────────

function textLength(content) {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const b of content) if (b?.type === "text" && typeof b.text === "string") n += b.text.length;
  return n;
}

function estimateReservation(body) {
  let chars = 0;
  for (const m of body.messages ?? []) chars += textLength(m.content);
  if (body.system !== undefined) chars += textLength(body.system);
  const input = Math.ceil(chars / CONFIG.charRatio);
  const output = Number(body.max_tokens ?? body.max_completion_tokens ?? CONFIG.defaultMaxTokens);
  return input + (Number.isFinite(output) ? output : CONFIG.defaultMaxTokens);
}

// ── server ───────────────────────────────────────────────────────────

const policy =
  CONFIG.arm === "passthrough"
    ? passthroughPolicy
    : CONFIG.arm === "static-cap"
      ? createStaticCapPolicy()
      : CONFIG.arm === "static-partition"
        ? {
            interactive: createStaticCapPolicy(CONFIG.interactiveMaxConcurrent),
            batch: createStaticCapPolicy(CONFIG.batchMaxConcurrent),
          }
        : await createRedisPolicy();

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  if (res.writableEnded) return;
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function renderMetrics() {
  const L = `{arm="${CONFIG.arm}",replica="${CONFIG.id}"}`;
  const lines = [];
  const g = (n, h, v) => lines.push(`# HELP ${n} ${h}`, `# TYPE ${n} gauge`, `${n}${L} ${v}`);
  const c = (n, h, v) => lines.push(`# HELP ${n} ${h}`, `# TYPE ${n} counter`, `${n}${L} ${v}`);

  g("replica_in_flight", "Requests currently forwarded upstream.", inFlight);
  g("replica_queue_depth", "Requests waiting for local admission.", queueDepth);
  g("replica_max_concurrent", "Configured local concurrency cap.", CONFIG.maxConcurrent);
  if (CONFIG.arm === "static-partition") {
    g("replica_interactive_max_concurrent", "Configured interactive-class local cap.", CONFIG.interactiveMaxConcurrent);
    g("replica_batch_max_concurrent", "Configured batch-class local cap.", CONFIG.batchMaxConcurrent);
  }
  g("replica_token_budget", "Configured token budget (0 = disabled).", CONFIG.tokenBudget);
  g(
    "replica_admission_overhead_ms_avg",
    "Mean cost of the admission decision itself.",
    counters.admissionOverheadCount === 0
      ? 0
      : (counters.admissionOverheadMsSum / counters.admissionOverheadCount).toFixed(4),
  );

  c("replica_received_total", "Requests received from clients.", counters.received);
  c("replica_admitted_total", "Requests admitted locally.", counters.admitted);
  c("replica_rejected_concurrency_total", "Local concurrency rejections.", counters.rejectedConcurrency);
  c("replica_rejected_budget_total", "Token-budget rejections.", counters.rejectedBudget);
  c("replica_rejected_queue_timeout_total", "Queue-wait timeouts.", counters.rejectedQueueTimeout);
  c("replica_upstream_2xx_total", "Successful upstream responses.", counters.upstream2xx);
  c("replica_upstream_429_total", "Upstream rate-limit responses.", counters.upstream429);
  c("replica_upstream_5xx_total", "Upstream server errors.", counters.upstream5xx);
  c("replica_transport_errors_total", "Upstream transport failures.", counters.transportErrors);
  c("replica_client_disconnects_total", "Clients that hung up mid-flight.", counters.clientDisconnects);
  c("replica_tokens_reserved_total", "Tokens reserved at admission.", counters.tokensReserved);
  c("replica_tokens_actual_total", "Tokens actually consumed per upstream usage.", counters.tokensActual);

  return lines.join("\n") + "\n";
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    sendJson(res, 200, { ok: true, arm: CONFIG.arm, id: CONFIG.id });
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

  const path = req.url ?? "";
  if (req.method !== "POST" || !(path === "/v1/chat/completions" || path === "/v1/messages")) {
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
  const reserved = CONFIG.arm === "redis" ? estimateReservation(body) : 0;
  const requestClass = body?.model === "sim-model-batch" ? "batch" : "interactive";
  const requestPolicy = CONFIG.arm === "static-partition" ? policy[requestClass] : policy;

  const waitStart = performance.now();
  const decision = await requestPolicy.acquire(reserved);
  counters.admissionWaitMsSum += performance.now() - waitStart;

  if (!decision.ok) {
    if (decision.reason === "budget_limit") counters.rejectedBudget += 1;
    else if (decision.reason === "queue_timeout") counters.rejectedQueueTimeout += 1;
    else counters.rejectedConcurrency += 1;
    // 429 with a reason the load generator can classify: a *cheap local
    // reject*, structurally different from a 429 earned after burning
    // upstream capacity.
    sendJson(
      res,
      429,
      { error: { type: "capacity_rejected", reason: decision.reason, local: true } },
      { "x-bench-reject": decision.reason, "x-bench-local": "1" },
    );
    return;
  }

  counters.admitted += 1;
  counters.tokensReserved += decision.reserved;
  inFlight += 1;

  let released = false;
  const finish = () => {
    if (released) return;
    released = true;
    inFlight -= 1;
    decision.release();
  };
  res.on("close", () => {
    if (!res.writableEnded) counters.clientDisconnects += 1;
    finish();
  });

  const controller = new AbortController();
  req.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    const upstream = await fetch(`${CONFIG.upstream}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (upstream.status === 429) counters.upstream429 += 1;
    else if (upstream.status >= 500) counters.upstream5xx += 1;
    else if (upstream.ok) counters.upstream2xx += 1;

    const headers = { "content-type": upstream.headers.get("content-type") ?? "application/json" };
    const retryAfter = upstream.headers.get("retry-after");
    if (retryAfter) headers["retry-after"] = retryAfter;
    res.writeHead(upstream.status, headers);

    if (!upstream.body) {
      res.end();
      finish();
      return;
    }

    // Stream through, sniffing usage so actual-vs-reserved is measurable.
    const decoder = new TextDecoder();
    let tail = "";
    for await (const chunk of upstream.body) {
      const text = decoder.decode(chunk, { stream: true });
      tail = (tail + text).slice(-4096);
      res.write(chunk);
    }
    res.end();

    const usage = /"usage"\s*:\s*\{[^}]*"total_tokens"\s*:\s*(\d+)/.exec(tail);
    if (usage) counters.tokensActual += Number(usage[1]);
  } catch (err) {
    if (err?.name !== "AbortError") {
      counters.transportErrors += 1;
      if (!res.headersSent) sendJson(res, 502, { error: { type: "upstream_unreachable" } });
      else res.end();
    }
  } finally {
    finish();
  }
});

server.on("error", (error) => {
  const detail = error?.code === "EADDRINUSE"
    ? `port ${CONFIG.port} is already in use by another process`
    : `${error?.code ?? "error"}: ${error?.message ?? String(error)}`;
  console.error(`replica ${CONFIG.id} failed to start: ${detail}`);
  process.exit(1);
});
server.listen(CONFIG.port, "0.0.0.0", () => {
  console.log(
    `replica ${CONFIG.id} :${CONFIG.port} arm=${CONFIG.arm} ` +
      `maxConcurrent=${CONFIG.maxConcurrent} tokenBudget=${CONFIG.tokenBudget} -> ${CONFIG.upstream}`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close();
    policy.client?.close?.();
    process.exit(0);
  });
}
