/**
 * local-inference-lib.mjs — pure helpers for the local inference benchmark.
 *
 * Why this benchmark has a locality guard instead of a spend guard
 * ---------------------------------------------------------------
 * `demo/openai-live.mjs` may run only after a conservative worst-case token
 * bill is computed and compared against `--max-usd`. This benchmark has no such
 * guard, because a self-hosted server has no price to compute. That absence is
 * only safe while the upstream genuinely cannot bill anybody: `--direct-url` and
 * `--moflux-url` are ordinary flags, and pointing either at `api.openai.com`
 * would otherwise run a paid benchmark with every cost control removed.
 *
 * So the guard here is on the address rather than the amount, and it is
 * deliberately not overridable. A run against a hosted provider is not a
 * degraded local run, it is a different benchmark with different safety
 * requirements, and `npm run demo:openai` already implements it.
 */

/** Evidence sweep name; also the results/ subdirectory a run writes into. */
export const LOCAL_INFERENCE_SWEEP_NAME = "local-inference-compatibility";

/**
 * Loopback ports published by demo/ollama/compose.yaml.
 *
 * The Ollama port is deliberately 11435 rather than the default 11434: a
 * developer running a local inference benchmark very often already has an
 * Ollama on 11434, and colliding with it would either refuse to start or
 * measure their server — with their concurrency settings and their loaded
 * model — while reporting the pinned one.
 */
export const LOCAL_OLLAMA_PORT = 11435;
export const LOCAL_TYR_PORT = 18114;

/**
 * Ollama exposes an OpenAI-compatible surface at `/v1/chat/completions` only.
 * There is no `/v1/responses`, so the Responses arm of the OpenAI demos has no
 * counterpart here and asking for it is an error rather than a silent fallback.
 */
export const LOCAL_ENDPOINT = "/v1/chat/completions";

const PRIVATE_IPV4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
];

const LOCAL_HOSTNAMES = new Set([
  "localhost",
  "host.docker.internal",
  "gateway.docker.internal",
  "ollama",
]);

/**
 * True when `hostname` cannot reach a metered provider: loopback, an RFC1918
 * or link-local address, an IPv6 unique-local or link-local address, an mDNS
 * `.local` name, or a single-label name such as a compose service.
 *
 * Fails closed. An address this cannot positively classify as local is refused,
 * so the rare local form written unusually (an IPv4-mapped `::ffff:7f00:1`, for
 * instance) costs a confusing error rather than an unguarded paid run.
 */
export function isLocalHostname(hostname) {
  if (typeof hostname !== "string" || hostname.length === 0) return false;
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (LOCAL_HOSTNAMES.has(host)) return true;

  // IPv6 is decided entirely here and never falls through. It has no dots, so
  // the single-label rule at the bottom would otherwise classify every public
  // IPv6 address — a provider's included — as a local container name.
  if (host.includes(":")) {
    if (host === "::1" || host === "::") return true;
    // fc00::/7 unique-local and fe80::/10 link-local.
    return /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
  }

  // Any dotted-quad is decided by the private ranges alone, for the same
  // reason: a public IPv4 literal must not reach the name-shaped rules below.
  if (/^\d+(\.\d+){3}$/.test(host)) {
    return PRIVATE_IPV4.some((pattern) => pattern.test(host));
  }

  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  // A public provider is always a dotted, multi-label public name. A bare
  // single label is a container or LAN name and cannot resolve to one.
  return !host.includes(".");
}

/**
 * Refuses any upstream that could be a metered provider.
 *
 * Throws rather than warning: this runs before the first request, and a warning
 * on a benchmark that streams hundreds of calls is a bill with a footnote.
 */
export function assertLocalUpstream(url, label) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must be an http(s) URL, got ${parsed.protocol}`);
  }
  if (!isLocalHostname(parsed.hostname)) {
    throw new Error(
      `Refusing to run: ${label} points at ${parsed.hostname}, which is not a local address. ` +
        "The local inference benchmark has no spend guard because a self-hosted server has no " +
        "price; it therefore may not talk to a host that could bill you. Use npm run demo:openai " +
        "for a metered provider — it enforces a conservative worst-case cost against --max-usd.",
    );
  }
  return parsed;
}

/**
 * OpenAI-compatible chat body accepted by Ollama.
 *
 * Deliberately not `buildOpenAIRequestBody` from openai-api-lib.mjs. That
 * builder emits `max_completion_tokens` and `reasoning_effort`, which are
 * hosted-OpenAI spellings; Ollama reads `max_tokens` and would silently ignore
 * the others, so the output cap would not be applied and a run's length would
 * be set by the model rather than by the flag. Stream parsing is shared with
 * the OpenAI path — that half really is compatible.
 *
 * `temperature: 0` and a per-pair `seed` make the two arms replay the same
 * decode, so a latency delta between them is proxy overhead rather than two
 * different completions being compared.
 */
export function buildLocalChatBody({ model, prompt, maxOutputTokens, seed, stream = true }) {
  return {
    model,
    messages: [{ role: "user", content: prompt }],
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    max_tokens: maxOutputTokens,
    temperature: 0,
    ...(Number.isSafeInteger(seed) ? { seed } : {}),
  };
}

/** Nearest-rank percentile over the finite values only; null when there are none. */
export function percentile(values, q) {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return null;
  const index = Math.min(finite.length - 1, Math.max(0, Math.ceil(q * finite.length) - 1));
  return +finite[index].toFixed(2);
}

/** Per-arm aggregation. Token counts are sums over successful requests only. */
export function summarizeArm(records) {
  const successes = records.filter((record) => record.ok);
  return {
    requests: records.length,
    success: successes.length,
    failures: records.length - successes.length,
    successRate: records.length === 0 ? 0 : +(successes.length / records.length).toFixed(4),
    ttftMs: {
      p50: percentile(successes.map((record) => record.ttftMs), 0.5),
      p95: percentile(successes.map((record) => record.ttftMs), 0.95),
    },
    latencyMs: {
      p50: percentile(successes.map((record) => record.latencyMs), 0.5),
      p95: percentile(successes.map((record) => record.latencyMs), 0.95),
    },
    promptTokens: successes.reduce((sum, record) => sum + (Number(record.promptTokens) || 0), 0),
    completionTokens: successes.reduce(
      (sum, record) => sum + (Number(record.completionTokens) || 0),
      0,
    ),
  };
}

/**
 * Median output tokens per second across successful requests.
 *
 * Reported per arm because it is the number a local run is actually bounded by:
 * unlike a hosted provider, the server here is the machine running the
 * benchmark, and a decode-rate difference between arms is the signal that the
 * proxy is competing with the model for the same CPU.
 */
export function decodeTokensPerSecond(records) {
  const rates = records
    .filter((record) => record.ok && Number.isFinite(record.completionTokens))
    .map((record) => {
      const decodeMs = record.latencyMs - (record.ttftMs ?? 0);
      if (!(decodeMs > 0) || !(record.completionTokens > 0)) return null;
      return (record.completionTokens / decodeMs) * 1000;
    })
    .filter((value) => Number.isFinite(value));
  return percentile(rates, 0.5);
}

/**
 * The warm-up requests whose measurements must not be read as steady state.
 *
 * The first call after the stack starts pays for loading the weights into
 * memory, and Tyr's `adaptiveEstimation` needs `minSamples` observations before
 * its token estimate is corrected. Both inflate early requests in whichever arm
 * happens to go first, which is exactly the kind of asymmetry alternating pair
 * order exists to remove — so the count is reported rather than silently
 * dropped, and acceptance never depends on it.
 */
export function warmupPairs(adaptiveMinSamples = 5) {
  return Math.max(1, adaptiveMinSamples);
}
