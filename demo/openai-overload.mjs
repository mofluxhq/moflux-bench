#!/usr/bin/env node
/**
 * Budget-capped live OpenAI overload experiment.
 *
 * Compare mode replays one immutable mixed interactive/batch trace through:
 *   1. direct OpenAI (no application admission control),
 *   2. a fail-fast static local concurrency cap, and
 *   3. Tyr protected admission classes with the same physical concurrency cap.
 *
 * Calibration mode defaults to bounded sustained-RPS stages with a separately
 * sampled baseline. Legacy concurrent-burst calibration remains available for
 * backward compatibility. Calibration traffic is intentionally separate from
 * compare mode so it cannot be mistaken for matched-arm evidence.
 */
import {
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { ensureDemoEnv, TYR_VERSION } from "./env-lib.mjs";
import {
  assertSafeOutputFile,
  assertSafeResultsDir,
  assertSafeRunDir,
  latestPointerFile,
  repoRelative,
  runDir as runDirFor,
  runId as newRunId,
} from "./evidence-paths-lib.mjs";
import {
  assertDockerAvailable,
  composeCommand,
  ensureRuntimeImage,
  parseEnvFile,
} from "./runtime-image-lib.mjs";
import {
  OPENAI_OVERLOAD_DEFAULT_MAX_USD,
  OPENAI_OVERLOAD_DEFAULT_MODEL,
  OPENAI_OVERLOAD_MAX_REQUESTS,
  OPENAI_OVERLOAD_MAX_RUN_CAP_USD,
  OPENAI_OVERLOAD_MODEL_PRICING_USD_PER_MTOK,
  OPENAI_OVERLOAD_SWEEP_NAME,
  conservativeCallCostUsd,
  conservativeTraceCostUsd,
  generateCompareTrace,
  percentile,
  renderTyrOverloadConfig,
  summarizeArm,
  summarizeRecords,
} from "./openai-overload-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = process.env.MOFLUX_BENCH_ENV_FILE
  ? path.resolve(process.env.MOFLUX_BENCH_ENV_FILE)
  : path.join(ROOT, "demo", "moflux", ".env");
const COMPOSE_FILE = path.join(ROOT, "demo", "openai", "compose-overload.yaml");
const PROJECT = "moflux-openai-overload";
const RESULTS = process.env.MOFLUX_BENCH_RESULTS_DIR
  ? path.resolve(process.env.MOFLUX_BENCH_RESULTS_DIR)
  : path.join(ROOT, "results");

const args = new Map();
for (const arg of process.argv.slice(2)) {
  const match = /^--([^=]+)=(.*)$/.exec(arg);
  if (match) args.set(match[1], match[2]);
  else if (arg.startsWith("--")) args.set(arg.slice(2), "true");
}
const num = (name, fallback) => (args.has(name) ? Number(args.get(name)) : fallback);
const str = (name, fallback) => args.get(name) ?? fallback;
const bool = (name, fallback) => (args.has(name) ? args.get(name) === "true" : fallback);
const int = (name, fallback) => num(name, fallback);

const mode = str("mode", "compare");
if (!new Set(["compare", "calibrate"]).has(mode)) {
  throw new Error("--mode must be compare or calibrate");
}

const model = str("model", process.env.MOFLUX_OPENAI_MODEL ?? OPENAI_OVERLOAD_DEFAULT_MODEL);
const maxUsd = num(
  "max-usd",
  Number(process.env.MOFLUX_OPENAI_OVERLOAD_MAX_USD ?? String(OPENAI_OVERLOAD_DEFAULT_MAX_USD)),
);
const requestTimeoutMs = int("request-timeout-ms", 90_000);
const directUrl = str(
  "direct-url",
  process.env.MOFLUX_OPENAI_DIRECT_URL ?? "https://api.openai.com/v1/chat/completions",
);
const mofluxUrl = str(
  "moflux-url",
  process.env.MOFLUX_OPENAI_OVERLOAD_TYR_URL ?? "http://127.0.0.1:18112/v1/chat/completions",
);
const manageStack = bool("manage-stack", process.env.MOFLUX_OPENAI_MANAGE_STACK !== "false");
const keepStack = bool("keep-stack", false);
const dryRun = bool("dry-run", false);
const runId = str("run-id", newRunId());
const explicitOut = args.has("out") ? path.resolve(str("out", "")) : null;

if (!Number.isFinite(maxUsd) || maxUsd <= 0 || maxUsd > OPENAI_OVERLOAD_MAX_RUN_CAP_USD) {
  throw new Error(
    `--max-usd must be greater than 0 and no more than ${OPENAI_OVERLOAD_MAX_RUN_CAP_USD}`,
  );
}
if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1_000) {
  throw new Error("--request-timeout-ms must be an integer >= 1000");
}

const configuredPricing = OPENAI_OVERLOAD_MODEL_PRICING_USD_PER_MTOK[model];
const customInputPrice = args.has("input-usd-per-mtok")
  ? num("input-usd-per-mtok", NaN)
  : undefined;
const customOutputPrice = args.has("output-usd-per-mtok")
  ? num("output-usd-per-mtok", NaN)
  : undefined;
const pricing = configuredPricing ?? (
  Number.isFinite(customInputPrice) && customInputPrice >= 0 &&
  Number.isFinite(customOutputPrice) && customOutputPrice >= 0
    ? { input: customInputPrice, output: customOutputPrice }
    : undefined
);
if (!pricing) {
  throw new Error(
    `No reviewed pricing is bundled for ${model}. Supply both --input-usd-per-mtok and ` +
      "--output-usd-per-mtok from the current OpenAI model page before running.",
  );
}

let runOutputDir = null;
let out;
let pointerFile = null;
try {
  assertSafeResultsDir(RESULTS, ROOT, "OpenAI overload results root");
  if (explicitOut) {
    out = assertSafeOutputFile(explicitOut, ROOT, "OpenAI overload output file");
  } else {
    runOutputDir = assertSafeRunDir(
      runDirFor(RESULTS, OPENAI_OVERLOAD_SWEEP_NAME, runId),
      ROOT,
      "OpenAI overload run directory",
    );
    out = path.join(runOutputDir, "summary.json");
    pointerFile = latestPointerFile(RESULTS, OPENAI_OVERLOAD_SWEEP_NAME);
  }
} catch (error) {
  console.error(`\nRefusing to run: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseCsvIntegers(value, field) {
  const parsed = String(value)
    .split(",")
    .map((entry) => Number(entry.trim()));
  if (parsed.length === 0 || parsed.some((entry) => !Number.isSafeInteger(entry) || entry < 1)) {
    throw new Error(`${field} must be a comma-separated list of positive integers`);
  }
  return parsed;
}

function parseArms(value) {
  const allowed = ["direct", "static", "moflux"];
  const arms = String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (arms.length === 0 || arms.some((arm) => !allowed.includes(arm))) {
    throw new Error(`--arms must contain only ${allowed.join(", ")}`);
  }
  if (new Set(arms).size !== arms.length) throw new Error("--arms must not contain duplicates");
  return arms;
}

function authHeaders({ identityToken }) {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
    ...(process.env.OPENAI_PROJECT ? { "openai-project": process.env.OPENAI_PROJECT } : {}),
    ...(process.env.OPENAI_ORGANIZATION ? { "openai-organization": process.env.OPENAI_ORGANIZATION } : {}),
    ...(identityToken ? { "x-tyr-identity-token": `Bearer ${identityToken}` } : {}),
  };
}

function capturedHeaders(response) {
  const get = (name) => response.headers.get(name);
  const rateLimit = {
    limitRequests: get("x-ratelimit-limit-requests"),
    remainingRequests: get("x-ratelimit-remaining-requests"),
    resetRequests: get("x-ratelimit-reset-requests"),
    limitTokens: get("x-ratelimit-limit-tokens"),
    remainingTokens: get("x-ratelimit-remaining-tokens"),
    resetTokens: get("x-ratelimit-reset-tokens"),
  };
  return {
    providerRequestId: get("x-request-id"),
    retryAfter: get("retry-after"),
    rateLimit,
    admission: {
      outcome: get("x-admission-outcome"),
      reason: get("x-admission-reason"),
      admissionClass: get("x-admission-class"),
      revision: get("x-admission-revision"),
      reservedTokens: get("x-admission-reserved-tokens"),
    },
  };
}

function parseResetDurationMs(value) {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const input = value.trim().toLowerCase().replace(/\s+/g, "");
  const multipliers = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
  const pattern = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
  let total = 0;
  let consumed = "";
  for (const match of input.matchAll(pattern)) {
    total += Number(match[1]) * multipliers[match[2]];
    consumed += match[0];
  }
  return consumed === input && Number.isFinite(total) ? total : null;
}

function parseRetryAfterMs(value) {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return numeric * 1_000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : null;
}

function rateLimitSnapshot(rateLimit) {
  const metric = (limitRaw, remainingRaw, resetRaw) => {
    const limit = Number(limitRaw);
    const remaining = Number(remainingRaw);
    return {
      limit: Number.isFinite(limit) && limit > 0 ? limit : null,
      remaining: Number.isFinite(remaining) && remaining >= 0 ? remaining : null,
      ratio: Number.isFinite(limit) && limit > 0 && Number.isFinite(remaining) && remaining >= 0
        ? +Math.min(1, remaining / limit).toFixed(4)
        : null,
      reset: typeof resetRaw === "string" ? resetRaw : null,
      resetMs: parseResetDurationMs(resetRaw),
    };
  };
  return {
    requests: metric(rateLimit?.limitRequests, rateLimit?.remainingRequests, rateLimit?.resetRequests),
    tokens: metric(rateLimit?.limitTokens, rateLimit?.remainingTokens, rateLimit?.resetTokens),
  };
}

function rateLimitIsolationOptions() {
  const targetRatio = num("rate-limit-start-headroom-ratio", 0.95);
  const timeoutMs = int("rate-limit-recovery-timeout-ms", 120_000);
  const maxProbes = int("rate-limit-recovery-max-probes", 6);
  if (!Number.isFinite(targetRatio) || targetRatio <= 0 || targetRatio > 1) {
    throw new Error("--rate-limit-start-headroom-ratio must be > 0 and <= 1");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) {
    throw new Error("--rate-limit-recovery-timeout-ms must be an integer from 1000 to 600000");
  }
  if (!Number.isSafeInteger(maxProbes) || maxProbes < 1 || maxProbes > 20) {
    throw new Error("--rate-limit-recovery-max-probes must be an integer from 1 to 20");
  }
  return { targetRatio, timeoutMs, maxProbes };
}

function recoveryProbeSampleRequest() {
  return calibrationSampleRequest({ inputChars: 64, maxOutputTokens: 8 });
}

async function waitForRateLimitRecovery({ label, options }) {
  const probeTemplate = recoveryProbeSampleRequest();
  const startedAt = performance.now();
  const observations = [];
  let measuredSuccessfulUsageCostUsd = 0;

  for (let probeIndex = 1; probeIndex <= options.maxProbes; probeIndex += 1) {
    const probeId = `rate-limit-probe-${label.replace(/[^a-zA-Z0-9_-]+/g, "-")}-${probeIndex}`;
    const request = {
      ...probeTemplate,
      requestId: probeId,
      prompt: probeTemplate.prompt.replace(CALIBRATION_RESPONSE_PLACEHOLDER, `${probeId}-ok`),
    };
    const record = await providerRequest({
      arm: "direct",
      request,
      url: directUrl,
      identityToken: null,
      run: 0,
      scheduledOffsetMs: 0,
      dispatchDelayMs: 0,
    });
    measuredSuccessfulUsageCostUsd += Number(record.actualCostUsd ?? 0);
    const snapshot = rateLimitSnapshot(record.rateLimit);
    const observation = {
      probe: probeIndex,
      status: record.status,
      provider429: record.rejectionOrigin === "provider_429",
      failureOrigin: record.failureOrigin ?? null,
      retryAfter: record.retryAfter ?? null,
      requests: snapshot.requests,
      tokens: snapshot.tokens,
    };
    observations.push(observation);

    const headersComplete = snapshot.requests.ratio !== null && snapshot.tokens.ratio !== null;
    const recovered = headersComplete &&
      snapshot.requests.ratio >= options.targetRatio &&
      snapshot.tokens.ratio >= options.targetRatio &&
      record.failureOrigin === null &&
      record.rejectionOrigin !== "provider_429";
    if (recovered) {
      return {
        label,
        passed: true,
        targetRatio: options.targetRatio,
        probes: observations.length,
        waitedMs: +(performance.now() - startedAt).toFixed(2),
        startHeadroom: snapshot,
        measuredSuccessfulUsageCostUsd: +measuredSuccessfulUsageCostUsd.toFixed(8),
        observations,
      };
    }

    if (!headersComplete) {
      return {
        label,
        passed: false,
        targetRatio: options.targetRatio,
        probes: observations.length,
        waitedMs: +(performance.now() - startedAt).toFixed(2),
        startHeadroom: snapshot,
        measuredSuccessfulUsageCostUsd: +measuredSuccessfulUsageCostUsd.toFixed(8),
        failureReason: "missing_rate_limit_headers",
        observations,
      };
    }
    if (record.failureOrigin !== null && record.rejectionOrigin !== "provider_429") {
      return {
        label,
        passed: false,
        targetRatio: options.targetRatio,
        probes: observations.length,
        waitedMs: +(performance.now() - startedAt).toFixed(2),
        startHeadroom: snapshot,
        measuredSuccessfulUsageCostUsd: +measuredSuccessfulUsageCostUsd.toFixed(8),
        failureReason: `recovery_probe_${record.failureOrigin}`,
        observations,
      };
    }

    const elapsedMs = performance.now() - startedAt;
    const remainingMs = options.timeoutMs - elapsedMs;
    if (probeIndex >= options.maxProbes || remainingMs <= 0) break;

    const waits = [250];
    if (snapshot.requests.ratio < options.targetRatio && snapshot.requests.resetMs !== null) {
      waits.push(snapshot.requests.resetMs + 100);
    }
    if (snapshot.tokens.ratio < options.targetRatio && snapshot.tokens.resetMs !== null) {
      waits.push(snapshot.tokens.resetMs + 100);
    }
    const retryAfterMs = parseRetryAfterMs(record.retryAfter);
    if (retryAfterMs !== null) waits.push(retryAfterMs + 100);
    await sleep(Math.min(Math.max(...waits), Math.max(0, remainingMs)));
  }

  const last = observations.at(-1);
  return {
    label,
    passed: false,
    targetRatio: options.targetRatio,
    probes: observations.length,
    waitedMs: +(performance.now() - startedAt).toFixed(2),
    startHeadroom: last ? { requests: last.requests, tokens: last.tokens } : null,
    measuredSuccessfulUsageCostUsd: +measuredSuccessfulUsageCostUsd.toFixed(8),
    failureReason: "rate_limit_headroom_not_recovered",
    observations,
  };
}

async function parseStream(response, startedAt) {
  let ttftMs = null;
  let promptTokens = null;
  let completionTokens = null;
  let textChars = 0;
  if (!response.body) return { ttftMs, promptTokens, completionTokens, textChars };

  const decoder = new TextDecoder();
  let buffer = "";
  const consume = (frame) => {
    for (const line of frame.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      const content = parsed?.choices?.[0]?.delta?.content;
      if (typeof content === "string" && content.length > 0) {
        if (ttftMs === null) ttftMs = performance.now() - startedAt;
        textChars += content.length;
      }
      if (Number.isFinite(parsed?.usage?.prompt_tokens)) promptTokens = parsed.usage.prompt_tokens;
      if (Number.isFinite(parsed?.usage?.completion_tokens)) completionTokens = parsed.usage.completion_tokens;
    }
  };

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      consume(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) consume(buffer);
  return { ttftMs, promptTokens, completionTokens, textChars };
}

async function providerRequest({
  arm,
  request,
  url,
  identityToken,
  run,
  scheduledOffsetMs,
  dispatchDelayMs,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  const startedAt = performance.now();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: authHeaders({ identityToken }),
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: request.prompt }],
        stream: true,
        stream_options: { include_usage: true },
        max_completion_tokens: request.maxOutputTokens,
        reasoning_effort: "none",
      }),
      signal: controller.signal,
    });
    const headersMs = performance.now() - startedAt;
    const headers = capturedHeaders(response);
    const admissionReason = headers.admission.reason;
    const providerAttempted = arm === "moflux"
      ? admissionReason === null && ![401, 403, 503].includes(response.status)
      : true;

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const rejectionOrigin =
        response.status === 429 && admissionReason !== null
          ? "moflux_local"
          : response.status === 429
            ? "provider_429"
            : null;
      const failureOrigin =
        rejectionOrigin !== null
          ? null
          : arm === "moflux" && !providerAttempted
            ? "moflux_gateway"
            : "provider";
      return {
        run,
        arm,
        requestId: request.requestId,
        workloadClass: request.workloadClass,
        scheduledOffsetMs,
        dispatchDelayMs: +dispatchDelayMs.toFixed(2),
        ok: false,
        status: response.status,
        headersMs: +headersMs.toFixed(2),
        providerAttempted,
        rejectionOrigin,
        failureOrigin,
        admissionReason,
        admissionClass: headers.admission.admissionClass,
        admissionRevision: headers.admission.revision,
        providerRequestId: headers.providerRequestId,
        rateLimit: headers.rateLimit,
        retryAfter: headers.retryAfter,
        error: body.slice(0, 300),
      };
    }

    const stream = await parseStream(response, startedAt);
    const latencyMs = performance.now() - startedAt;
    if (!(stream.textChars > 0) || !Number.isFinite(stream.promptTokens) || !Number.isFinite(stream.completionTokens)) {
      return {
        run,
        arm,
        requestId: request.requestId,
        workloadClass: request.workloadClass,
        scheduledOffsetMs,
        dispatchDelayMs: +dispatchDelayMs.toFixed(2),
        ok: false,
        status: response.status,
        headersMs: +headersMs.toFixed(2),
        latencyMs: +latencyMs.toFixed(2),
        providerAttempted: true,
        rejectionOrigin: null,
        failureOrigin: "provider",
        admissionReason,
        admissionClass: headers.admission.admissionClass,
        admissionRevision: headers.admission.revision,
        providerRequestId: headers.providerRequestId,
        rateLimit: headers.rateLimit,
        retryAfter: headers.retryAfter,
        error: "OpenAI stream omitted response text or final usage accounting",
      };
    }

    const actualCostUsd =
      (stream.promptTokens * pricing.input + stream.completionTokens * pricing.output) / 1_000_000;
    return {
      run,
      arm,
      requestId: request.requestId,
      workloadClass: request.workloadClass,
      scheduledOffsetMs,
      dispatchDelayMs: +dispatchDelayMs.toFixed(2),
      ok: true,
      status: response.status,
      headersMs: +headersMs.toFixed(2),
      ttftMs: +(stream.ttftMs ?? latencyMs).toFixed(2),
      latencyMs: +latencyMs.toFixed(2),
      promptTokens: stream.promptTokens,
      completionTokens: stream.completionTokens,
      outputChars: stream.textChars,
      actualCostUsd: +actualCostUsd.toFixed(8),
      providerAttempted: true,
      rejectionOrigin: null,
      failureOrigin: null,
      admissionReason,
      admissionClass: headers.admission.admissionClass,
      admissionRevision: headers.admission.revision,
      providerRequestId: headers.providerRequestId,
      rateLimit: headers.rateLimit,
      retryAfter: headers.retryAfter,
    };
  } catch (error) {
    return {
      run,
      arm,
      requestId: request.requestId,
      workloadClass: request.workloadClass,
      scheduledOffsetMs,
      dispatchDelayMs: +dispatchDelayMs.toFixed(2),
      ok: false,
      status: null,
      providerAttempted: arm !== "moflux",
      rejectionOrigin: null,
      failureOrigin: "transport",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function makeIdentityMaterial() {
  const kid = `moflux-bench-${runId}`;
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  const issuer = "moflux-bench-openai-overload";
  const audience = "moflux-bench-openai-overload";
  const encode = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const mint = (applicationId) => {
    const now = Math.floor(Date.now() / 1_000);
    const header = encode({ alg: "RS256", kid, typ: "JWT" });
    const payload = encode({
      iss: issuer,
      aud: audience,
      sub: `moflux-bench-${applicationId}`,
      azp: applicationId,
      roles: ["tyr.invoke"],
      iat: now,
      exp: now + 3_600,
    });
    const signature = sign(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`, "ascii"),
      privateKey,
    ).toString("base64url");
    return `${header}.${payload}.${signature}`;
  };
  return {
    issuer,
    audience,
    jwks: { keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] },
    tokens: {
      interactive: mint("interactive"),
      batch: mint("batch"),
    },
  };
}

async function startJwksServer(jwks, port) {
  const server = createServer((req, res) => {
    if (req.method !== "GET" || req.url !== "/jwks") {
      res.writeHead(404).end();
      return;
    }
    const body = JSON.stringify(jwks);
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    });
    res.end(body);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", resolve);
  });
  return server;
}

async function closeServer(server) {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
}

function writeSummary(summary) {
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  if (pointerFile) {
    mkdirSync(path.dirname(pointerFile), { recursive: true });
    writeFileSync(pointerFile, `${JSON.stringify({ runId, summary: repoRelative(out, ROOT) }, null, 2)}\n`, "utf8");
  }
  console.log(`\nWrote ${repoRelative(out, ROOT)}`);
}

const apiKey = dryRun ? null : process.env.OPENAI_API_KEY;
if (!dryRun && (typeof apiKey !== "string" || apiKey.trim().length === 0)) {
  throw new Error(
    "OPENAI_API_KEY is required for a live run. The key is read only from the caller process environment.",
  );
}

async function runCalibration() {
  const legacyBurstRequested = args.has("calibration-steps") || args.has("calibration-requests-per-worker");
  const strategy = str("calibration-strategy", legacyBurstRequested ? "burst" : "sustained");
  if (!new Set(["sustained", "burst"]).has(strategy)) {
    throw new Error("--calibration-strategy must be sustained or burst");
  }
  if (strategy === "burst") {
    return runBurstCalibration();
  }

  const rpsSteps = parseCsvPositiveNumbers(
    str("calibration-rps-steps", "10,20,30,40"),
    "--calibration-rps-steps",
  );
  const stageMs = int("calibration-stage-ms", 10_000);
  const baselineRequests = int("calibration-baseline-requests", 24);
  const baselineRps = num("calibration-baseline-rps", 4);
  const inputChars = int("calibration-input-chars", 128);
  const maxOutputTokens = int("calibration-max-output-tokens", 8);
  const latencyFactor = num("latency-factor", 2.0);
  const minThroughputRatio = num("calibration-min-throughput-ratio", 0.85);
  const rateLimitHeadroomRatio = num("calibration-rate-limit-headroom-ratio", 0.05);
  const rateLimitHeadroomSamples = int("calibration-rate-limit-headroom-samples", 3);
  const stopOnPressure = bool("stop-on-pressure", true);
  const rateLimitIsolation = rateLimitIsolationOptions();

  for (const [field, value, min, max] of [
    ["--calibration-stage-ms", stageMs, 500, 60_000],
    ["--calibration-baseline-requests", baselineRequests, 5, 200],
    ["--calibration-input-chars", inputChars, 64, 20_000],
    ["--calibration-max-output-tokens", maxOutputTokens, 1, 1_024],
    ["--calibration-rate-limit-headroom-samples", rateLimitHeadroomSamples, 1, 100],
  ]) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${field} must be an integer from ${min} to ${max}`);
    }
  }
  for (const [field, value, min, max] of [
    ["--calibration-baseline-rps", baselineRps, 0.1, 100],
    ["--latency-factor", latencyFactor, 1, 20],
    ["--calibration-min-throughput-ratio", minThroughputRatio, 0.1, 1],
    ["--calibration-rate-limit-headroom-ratio", rateLimitHeadroomRatio, 0, 1],
  ]) {
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`${field} must be between ${min} and ${max}`);
    }
  }
  if (rpsSteps.some((rps) => rps > 100)) {
    throw new Error("--calibration-rps-steps values must be <= 100 RPS");
  }

  const stagePlans = rpsSteps.map((offeredRps) => ({
    offeredRps,
    requestCount: Math.max(1, Math.round(offeredRps * stageMs / 1_000)),
  }));
  const workloadRequests = baselineRequests + stagePlans.reduce((sum, stage) => sum + stage.requestCount, 0);
  const recoveryGateCount = 1 + stagePlans.length;
  const recoveryProbeBudget = recoveryGateCount * rateLimitIsolation.maxProbes;
  const plannedRequests = workloadRequests + recoveryProbeBudget;
  if (plannedRequests > OPENAI_OVERLOAD_MAX_REQUESTS) {
    throw new Error(`calibration plans up to ${plannedRequests} requests including recovery probes; hard cap is ${OPENAI_OVERLOAD_MAX_REQUESTS}`);
  }

  const sampleRequest = calibrationSampleRequest({ inputChars, maxOutputTokens });
  const recoverySample = recoveryProbeSampleRequest();
  const worstCaseUsd = workloadRequests * conservativeCallCostUsd({
    prompt: sampleRequest.prompt,
    maxOutputTokens,
    pricing,
  }) + recoveryProbeBudget * conservativeCallCostUsd({
    prompt: recoverySample.prompt,
    maxOutputTokens: recoverySample.maxOutputTokens,
    pricing,
  });
  const budget = {
    model,
    mode,
    strategy,
    plannedRequests,
    workloadRequests,
    recoveryProbeBudget,
    pricingUsdPerMillionTokens: pricing,
    worstCaseUsd: +worstCaseUsd.toFixed(6),
    hardRunCapUsd: maxUsd,
  };
  console.log("OpenAI overload sustained calibration spend guard:");
  console.table([budget]);
  if (worstCaseUsd > maxUsd) {
    throw new Error(
      `Refusing to run: conservative worst-case cost $${worstCaseUsd.toFixed(6)} exceeds --max-usd=$${maxUsd.toFixed(4)}.`,
    );
  }
  if (dryRun) {
    console.log("PASS dry-run: no API request was sent");
    return;
  }

  const recoveryGates = [];
  const baselineStartGate = await waitForRateLimitRecovery({
    label: "calibration-baseline",
    options: rateLimitIsolation,
  });
  recoveryGates.push(baselineStartGate);
  if (!baselineStartGate.passed) {
    writeSummary({
      schemaVersion: 1,
      benchmark: OPENAI_OVERLOAD_SWEEP_NAME,
      generatedAt: new Date().toISOString(),
      mode: "calibrate",
      purpose: "Bounded sustained direct-provider calibration for selecting a later matched overload workload.",
      runtime: { model },
      budget: {
        ...budget,
        measuredSuccessfulUsageCostUsd: baselineStartGate.measuredSuccessfulUsageCostUsd,
        note: "Measured cost includes recovery probes plus successful workload responses with final usage; the pre-run guard reserves the maximum configured recovery probes.",
      },
      calibration: {
        strategy, rpsSteps, stageMs, baselineRequests, baselineRps, latencyFactor, minThroughputRatio,
        throughputRatioRole: "diagnostic_only_drain_inclusive", rateLimitHeadroomRatio, rateLimitHeadroomSamples, stopOnPressure,
        baseline: null, pressureDetected: false, pressureStepRps: null, invalidCalibration: true,
        invalidReasons: [`rate_limit_recovery_failed:${baselineStartGate.failureReason}`], results: [],
        rateLimitIsolation: { ...rateLimitIsolation, passed: false, gates: recoveryGates },
        note: "Calibration did not start because provider rate-limit headroom could not be restored to the required starting threshold.",
      },
    });
    process.exitCode = 1;
    return;
  }

  console.log(`\nEstablishing baseline: ${baselineRequests} requests at ${baselineRps} RPS`);
  const baseline = await runPacedCalibrationStage({
    offeredRps: baselineRps,
    requestCount: baselineRequests,
    sampleRequest,
    stageLabel: "baseline",
  });
  const baselineInvalidReasons = calibrationInvalidReasons(baseline.summary);
  if (baselineInvalidReasons.length > 0) {
    throw new Error(
      `Calibration baseline is invalid (${baselineInvalidReasons.join(",")}); fix provider/configuration errors before probing overload.`,
    );
  }
  if (baseline.summary.success < 5 || baseline.summary.ttftMs.p95 === null || baseline.summary.latencyMs.p95 === null) {
    throw new Error("Calibration baseline did not produce enough successful latency samples");
  }

  const stepResults = [];
  let pressureDetected = false;
  let pressureStepRps = null;
  let invalidCalibration = false;
  const invalidReasons = [];

  for (const stage of stagePlans) {
    const startGate = await waitForRateLimitRecovery({
      label: `calibration-rps-${stage.offeredRps}`,
      options: rateLimitIsolation,
    });
    recoveryGates.push(startGate);
    if (!startGate.passed) {
      invalidCalibration = true;
      invalidReasons.push(`rate_limit_recovery_failed:${startGate.failureReason}`);
      break;
    }
    const result = await runPacedCalibrationStage({
      offeredRps: stage.offeredRps,
      requestCount: stage.requestCount,
      sampleRequest,
      stageLabel: `rps-${stage.offeredRps}`,
    });
    const summary = result.summary;
    const invalid = calibrationInvalidReasons(summary);
    const headroom = summarizeRateLimitHeadroom(result.records, {
      thresholdRatio: rateLimitHeadroomRatio,
    });
    // summarizeRecords() uses the full stage wall clock, including the final drain tail.
    // That makes this ratio useful as a diagnostic, but it must not be used to
    // infer provider saturation: a healthy fixed-duration stage can fall below
    // the threshold simply because the last in-flight requests finish after
    // the offering window closes.
    const achievedGoodputRatio = stage.offeredRps > 0
      ? +(summary.goodputRps / stage.offeredRps).toFixed(4)
      : null;
    const throughputDiagnosticWarnings = [];
    if (
      invalid.length === 0 &&
      achievedGoodputRatio !== null &&
      achievedGoodputRatio < minThroughputRatio
    ) {
      throughputDiagnosticWarnings.push("drain_inclusive_goodput_below_threshold");
    }
    const reasons = [];

    if (summary.provider429s > 0) reasons.push("provider_429");
    if (summary.provider5xx > 0) reasons.push("provider_5xx");
    if (summary.transportFailures > 0) reasons.push("transport_failure");
    if (
      summary.ttftMs.p95 !== null &&
      summary.ttftMs.p95 >= baseline.summary.ttftMs.p95 * latencyFactor
    ) {
      reasons.push("ttft_inflation");
    }
    if (
      summary.latencyMs.p95 !== null &&
      summary.latencyMs.p95 >= baseline.summary.latencyMs.p95 * latencyFactor
    ) {
      reasons.push("latency_inflation");
    }
    if (
      headroom.lowRequestSamples >= rateLimitHeadroomSamples ||
      headroom.lowTokenSamples >= rateLimitHeadroomSamples
    ) {
      reasons.push("rate_limit_headroom");
    }

    const pressured = reasons.length > 0;
    stepResults.push({
      offeredRps: stage.offeredRps,
      requestCount: stage.requestCount,
      startHeadroom: startGate.startHeadroom,
      recoveryProbes: startGate.probes,
      recoveryWaitedMs: startGate.waitedMs,
      elapsedMs: result.elapsedMs,
      achievedGoodputRatio,
      drainInclusiveGoodputRatio: achievedGoodputRatio,
      ...summary,
      rateLimitHeadroom: headroom,
      pressureReasons: reasons,
      throughputDiagnosticWarnings,
      invalidReasons: invalid,
    });
    console.log(
      `calibration ${stage.offeredRps} RPS: success=${summary.success}/${summary.offered}, ` +
        `goodput=${summary.goodputRps} RPS (drain-inclusive ratio=${achievedGoodputRatio}), provider429=${summary.provider429s}, ` +
        `ttftP95=${summary.ttftMs.p95 ?? "n/a"}ms` +
        (invalid.length > 0 ? ` INVALID(${invalid.join(",")})` : "") +
        (pressured ? ` PRESSURE(${reasons.join(",")})` : "") +
        (throughputDiagnosticWarnings.length > 0 ? ` DIAGNOSTIC(${throughputDiagnosticWarnings.join(",")})` : ""),
    );

    if (invalid.length > 0) {
      invalidCalibration = true;
      invalidReasons.push(...invalid);
      break;
    }
    if (pressured) {
      pressureDetected = true;
      pressureStepRps = stage.offeredRps;
      if (stopOnPressure) break;
    }
  }

  const recoveryMeasuredUsd = recoveryGates
    .reduce((sum, gate) => sum + Number(gate.measuredSuccessfulUsageCostUsd ?? 0), 0);
  const actualMeasuredUsd = +(recoveryMeasuredUsd + baseline.summary.measuredSuccessfulUsageCostUsd + stepResults
    .reduce((sum, step) => sum + step.measuredSuccessfulUsageCostUsd, 0))
    .toFixed(8);
  writeSummary({
    schemaVersion: 1,
    benchmark: OPENAI_OVERLOAD_SWEEP_NAME,
    generatedAt: new Date().toISOString(),
    mode: "calibrate",
    purpose: "Bounded sustained direct-provider calibration for selecting a later matched overload workload.",
    runtime: { model },
    budget: {
      ...budget,
      measuredSuccessfulUsageCostUsd: actualMeasuredUsd,
      note: "Measured cost includes recovery probes plus successful workload responses with final usage; the pre-run guard reserves the maximum configured recovery probes.",
    },
    calibration: {
      strategy,
      rpsSteps,
      stageMs,
      baselineRequests,
      baselineRps,
      latencyFactor,
      minThroughputRatio,
      throughputRatioRole: "diagnostic_only_drain_inclusive",
      rateLimitHeadroomRatio,
      rateLimitHeadroomSamples,
      stopOnPressure,
      baseline: {
        startHeadroom: baselineStartGate.startHeadroom,
        recoveryProbes: baselineStartGate.probes,
        recoveryWaitedMs: baselineStartGate.waitedMs,
        elapsedMs: baseline.elapsedMs,
        ...baseline.summary,
        rateLimitHeadroom: summarizeRateLimitHeadroom(baseline.records, {
          thresholdRatio: rateLimitHeadroomRatio,
        }),
      },
      rateLimitIsolation: {
        ...rateLimitIsolation,
        passed: recoveryGates.length === 1 + stepResults.length && recoveryGates.every((gate) => gate.passed),
        gates: recoveryGates,
      },
      pressureDetected,
      pressureStepRps,
      invalidCalibration,
      invalidReasons: [...new Set(invalidReasons)],
      note: invalidCalibration
        ? "Calibration stopped because non-overload provider failures invalidate pressure inference."
        : pressureDetected
          ? "Use the first pressure RPS as a starting point for a later mixed-workload compare load; calibration itself is not arm-comparison evidence."
          : "No configured sustained-pressure criterion fired. Increase only after reviewing measured spend and provider/account limits.",
      results: stepResults,
    },
  });
}

function parseCsvPositiveNumbers(value, field) {
  const parsed = String(value)
    .split(",")
    .map((entry) => Number(entry.trim()));
  if (parsed.length === 0 || parsed.some((entry) => !Number.isFinite(entry) || entry <= 0)) {
    throw new Error(`${field} must be a comma-separated list of positive numbers`);
  }
  return parsed;
}

const CALIBRATION_RESPONSE_PLACEHOLDER = "calibration-response-placeholder-0000000000000000";

function calibrationSampleRequest({ inputChars, maxOutputTokens }) {
  const base = `OpenAI overload calibration. Reply exactly: ${CALIBRATION_RESPONSE_PLACEHOLDER}. `;
  return {
    requestId: "calibration",
    workloadClass: "calibration",
    prompt: `${base}${"x".repeat(Math.max(0, inputChars - base.length))}`,
    maxOutputTokens,
  };
}

async function runPacedCalibrationStage({ offeredRps, requestCount, sampleRequest, stageLabel }) {
  const intervalMs = 1_000 / offeredRps;
  const stageStarted = performance.now();
  const promises = Array.from({ length: requestCount }, async (_, index) => {
    const scheduledOffsetMs = index * intervalMs;
    const target = stageStarted + scheduledOffsetMs;
    const waitMs = target - performance.now();
    if (waitMs > 0) await sleep(waitMs);
    const dispatchDelayMs = Math.max(0, performance.now() - target);
    const requestId = `${stageLabel}-${String(index + 1).padStart(5, "0")}`;
    const request = {
      ...sampleRequest,
      requestId,
      prompt: sampleRequest.prompt.replace(CALIBRATION_RESPONSE_PLACEHOLDER, `${requestId}-ok`),
    };
    return providerRequest({
      arm: "direct",
      request,
      url: directUrl,
      identityToken: null,
      run: 1,
      scheduledOffsetMs,
      dispatchDelayMs,
    });
  });
  const records = await Promise.all(promises);
  const elapsedMs = +(performance.now() - stageStarted).toFixed(2);
  return {
    elapsedMs,
    records,
    summary: summarizeRecords(records, elapsedMs),
  };
}

function calibrationInvalidReasons(summary) {
  const reasons = [];
  if (summary.providerOtherFailures > 0) reasons.push("provider_non_overload_failure");
  if (summary.gatewayFailures > 0) reasons.push("unexpected_gateway_failure");
  return reasons;
}

function summarizeRateLimitHeadroom(records, { thresholdRatio }) {
  const requestRatios = [];
  const tokenRatios = [];
  for (const record of records) {
    const rateLimit = record.rateLimit ?? {};
    for (const [remainingKey, limitKey, target] of [
      ["remainingRequests", "limitRequests", requestRatios],
      ["remainingTokens", "limitTokens", tokenRatios],
    ]) {
      const remaining = Number(rateLimit[remainingKey]);
      const limit = Number(rateLimit[limitKey]);
      if (Number.isFinite(remaining) && Number.isFinite(limit) && limit > 0 && remaining >= 0) {
        target.push(remaining / limit);
      }
    }
  }
  const summarize = (ratios) => ({
    samples: ratios.length,
    minRatio: ratios.length > 0 ? +Math.min(...ratios).toFixed(4) : null,
    p10Ratio: ratios.length > 0 ? percentile(ratios, 0.10) : null,
    lowSamples: ratios.filter((ratio) => ratio <= thresholdRatio).length,
  });
  const requests = summarize(requestRatios);
  const tokens = summarize(tokenRatios);
  return {
    thresholdRatio,
    requests,
    tokens,
    lowRequestSamples: requests.lowSamples,
    lowTokenSamples: tokens.lowSamples,
  };
}

async function runBurstCalibration() {
  const steps = parseCsvIntegers(str("calibration-steps", "1,2,4,8,12,16"), "--calibration-steps");
  const requestsPerWorker = int("calibration-requests-per-worker", 2);
  const inputChars = int("calibration-input-chars", 400);
  const maxOutputTokens = int("calibration-max-output-tokens", 24);
  const latencyFactor = num("latency-factor", 2.0);
  const stopOnPressure = bool("stop-on-pressure", true);
  for (const [field, value, min, max] of [
    ["--calibration-requests-per-worker", requestsPerWorker, 1, 20],
    ["--calibration-input-chars", inputChars, 64, 20_000],
    ["--calibration-max-output-tokens", maxOutputTokens, 1, 1_024],
  ]) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${field} must be an integer from ${min} to ${max}`);
    }
  }
  if (!Number.isFinite(latencyFactor) || latencyFactor < 1) {
    throw new Error("--latency-factor must be >= 1");
  }

  const plannedRequests = steps.reduce((sum, concurrency) => sum + concurrency * requestsPerWorker, 0);
  if (plannedRequests > OPENAI_OVERLOAD_MAX_REQUESTS) {
    throw new Error(`calibration plans ${plannedRequests} requests; hard cap is ${OPENAI_OVERLOAD_MAX_REQUESTS}`);
  }
  const sampleRequest = calibrationSampleRequest({ inputChars, maxOutputTokens });
  const worstCaseUsd = steps.reduce(
    (sum, concurrency) => sum + concurrency * requestsPerWorker * conservativeCallCostUsd({
      prompt: sampleRequest.prompt,
      maxOutputTokens,
      pricing,
    }),
    0,
  );
  const budget = {
    model,
    mode,
    strategy: "burst",
    plannedRequests,
    pricingUsdPerMillionTokens: pricing,
    worstCaseUsd: +worstCaseUsd.toFixed(6),
    hardRunCapUsd: maxUsd,
  };
  console.log("OpenAI overload legacy burst calibration spend guard:");
  console.table([budget]);
  if (worstCaseUsd > maxUsd) {
    throw new Error(
      `Refusing to run: conservative worst-case cost $${worstCaseUsd.toFixed(6)} exceeds --max-usd=$${maxUsd.toFixed(4)}.`,
    );
  }
  if (dryRun) {
    console.log("PASS dry-run: no API request was sent");
    return;
  }

  const stepResults = [];
  let baselineP95 = null;
  let pressureDetected = false;
  let pressureStep = null;
  for (const concurrency of steps) {
    let next = 0;
    const count = concurrency * requestsPerWorker;
    const records = [];
    const stepStarted = performance.now();
    const workers = Array.from({ length: concurrency }, async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= count) return;
        const request = {
          ...sampleRequest,
          requestId: `c${concurrency}-${String(index + 1).padStart(4, "0")}`,
          prompt: sampleRequest.prompt.replace(CALIBRATION_RESPONSE_PLACEHOLDER, `c${concurrency}-${index + 1}-ok`),
        };
        records.push(await providerRequest({
          arm: "direct",
          request,
          url: directUrl,
          identityToken: null,
          run: 1,
          scheduledOffsetMs: 0,
          dispatchDelayMs: 0,
        }));
      }
    });
    await Promise.all(workers);
    const elapsedMs = performance.now() - stepStarted;
    const summary = summarizeRecords(records, elapsedMs);
    if (baselineP95 === null && summary.ttftMs.p95 !== null) baselineP95 = summary.ttftMs.p95;
    const reasons = [];
    if (summary.provider429s > 0) reasons.push("provider_429");
    if (summary.provider5xx > 0) reasons.push("provider_5xx");
    if (summary.transportFailures > 0) reasons.push("transport_failure");
    if (
      baselineP95 !== null &&
      summary.ttftMs.p95 !== null &&
      concurrency > steps[0] &&
      summary.ttftMs.p95 >= baselineP95 * latencyFactor
    ) {
      reasons.push("ttft_inflation");
    }
    const pressured = reasons.length > 0;
    stepResults.push({ concurrency, elapsedMs: +elapsedMs.toFixed(2), ...summary, pressureReasons: reasons });
    console.log(
      `legacy burst concurrency=${concurrency}: success=${summary.success}/${summary.offered}, ` +
        `provider429=${summary.provider429s}, ttftP95=${summary.ttftMs.p95 ?? "n/a"}ms` +
        (pressured ? ` PRESSURE(${reasons.join(",")})` : ""),
    );
    if (pressured) {
      pressureDetected = true;
      pressureStep = concurrency;
      if (stopOnPressure) break;
    }
  }

  const actualMeasuredUsd = +stepResults
    .reduce((sum, step) => sum + step.measuredSuccessfulUsageCostUsd, 0)
    .toFixed(8);
  writeSummary({
    schemaVersion: 1,
    benchmark: OPENAI_OVERLOAD_SWEEP_NAME,
    generatedAt: new Date().toISOString(),
    mode: "calibrate",
    purpose: "Legacy bounded direct-provider concurrent-burst calibration retained for backward compatibility.",
    runtime: { model },
    budget: {
      ...budget,
      measuredSuccessfulUsageCostUsd: actualMeasuredUsd,
      note: "Measured cost includes only successful responses with final usage; the pre-run guard assumes every planned request reaches maximum usage.",
    },
    calibration: {
      strategy: "burst",
      steps,
      requestsPerWorker,
      latencyFactor,
      stopOnPressure,
      baselineTtftP95Ms: baselineP95,
      pressureDetected,
      pressureStep,
      note: pressureDetected
        ? "Legacy burst calibration found a pressure signal; sustained calibration is preferred for selecting compare load."
        : "Legacy burst calibration found no pressure signal; sustained calibration is preferred before increasing concurrency further.",
      results: stepResults,
    },
  });
}

async function waitForTyr(timeoutMs = 30_000) {
  const healthUrl = new URL(mofluxUrl);
  healthUrl.pathname = "/readyz";
  healthUrl.search = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) return;
    } catch {
      // retry
    }
    await sleep(150);
  }
  throw new Error(`Tyr did not become ready at ${healthUrl} within ${timeoutMs}ms`);
}

async function runCompare() {
  const arms = parseArms(str("arms", "direct,static,moflux"));
  const runs = int("runs", 1);
  const seed = int("seed", 1);
  const durationMs = int("duration-ms", 10_000);
  const interactiveRps = num("interactive-rps", 2);
  const batchRps = num("batch-rps", 6);
  const batchStartMs = int("batch-start-ms", 2_000);
  const batchDurationMs = int("batch-duration-ms", 7_000);
  const jitterFraction = num("jitter-fraction", 0.05);
  const interactiveInputChars = int("interactive-input-chars", 300);
  const batchInputChars = int("batch-input-chars", 1_500);
  const interactiveMaxOutputTokens = int("interactive-max-output-tokens", 24);
  const batchMaxOutputTokens = int("batch-max-output-tokens", 32);
  const staticCap = int("static-cap", 8);
  const mofluxMaxConcurrent = int("moflux-max-concurrent", staticCap);
  const interactiveFloor = int("interactive-floor", 6);
  const batchFloor = int("batch-floor", 2);
  const cooldownMs = int("arm-cooldown-ms", 2_000);
  const jwksPort = int("jwks-port", 18_113);
  const rateLimitIsolation = rateLimitIsolationOptions();

  if (!Number.isSafeInteger(runs) || runs < 1 || runs > 10) throw new Error("--runs must be an integer from 1 to 10");
  if (!Number.isSafeInteger(seed) || seed < 1) throw new Error("--seed must be a positive integer");
  if (!Number.isSafeInteger(durationMs) || durationMs < 1_000 || durationMs > 120_000) throw new Error("--duration-ms must be 1000..120000");
  for (const [field, value] of [["--interactive-rps", interactiveRps], ["--batch-rps", batchRps]]) {
    if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error(`${field} must be between 0 and 100`);
  }
  if (interactiveRps === 0 && batchRps === 0) throw new Error("at least one workload RPS must be > 0");
  if (!Number.isSafeInteger(batchStartMs) || batchStartMs < 0 || batchStartMs >= durationMs) throw new Error("--batch-start-ms must be within the run duration");
  if (!Number.isSafeInteger(batchDurationMs) || batchDurationMs < 1 || batchStartMs + batchDurationMs > durationMs) throw new Error("--batch-duration-ms must fit within the run duration");
  if (!Number.isFinite(jitterFraction) || jitterFraction < 0 || jitterFraction > 0.5) throw new Error("--jitter-fraction must be between 0 and 0.5");
  for (const [field, value, min, max] of [
    ["--interactive-input-chars", interactiveInputChars, 64, 20_000],
    ["--batch-input-chars", batchInputChars, 64, 50_000],
    ["--interactive-max-output-tokens", interactiveMaxOutputTokens, 1, 1_024],
    ["--batch-max-output-tokens", batchMaxOutputTokens, 1, 1_024],
    ["--static-cap", staticCap, 1, 1_000],
    ["--moflux-max-concurrent", mofluxMaxConcurrent, 1, 1_000],
    ["--interactive-floor", interactiveFloor, 0, 1_000],
    ["--batch-floor", batchFloor, 0, 1_000],
    ["--arm-cooldown-ms", cooldownMs, 0, 300_000],
    ["--jwks-port", jwksPort, 1_024, 65_535],
  ]) {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${field} must be an integer from ${min} to ${max}`);
  }
  if (staticCap !== mofluxMaxConcurrent) {
    throw new Error("--static-cap and --moflux-max-concurrent must match for the primary comparison");
  }
  if (interactiveFloor + batchFloor > mofluxMaxConcurrent) {
    throw new Error("interactive and batch protected floors must not exceed --moflux-max-concurrent");
  }
  if (interactiveFloor === 0 || batchFloor === 0) {
    console.warn("WARNING: a zero protected floor weakens the workload-isolation experiment.");
  }

  const traces = Array.from({ length: runs }, (_, index) => generateCompareTrace({
    seed: seed + index,
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
  }));
  const workloadRequests = traces.reduce((sum, entry) => sum + entry.trace.length * arms.length, 0);
  const recoveryGateCount = runs * arms.length;
  const recoveryProbeBudget = recoveryGateCount * rateLimitIsolation.maxProbes;
  const plannedRequests = workloadRequests + recoveryProbeBudget;
  if (plannedRequests > OPENAI_OVERLOAD_MAX_REQUESTS) {
    throw new Error(`compare plans up to ${plannedRequests} requests including recovery probes; hard cap is ${OPENAI_OVERLOAD_MAX_REQUESTS}`);
  }
  const recoverySample = recoveryProbeSampleRequest();
  const worstCaseUsd = traces.reduce(
    (sum, entry) => sum + conservativeTraceCostUsd({ trace: entry.trace, armCount: arms.length, runs: 1, pricing }),
    0,
  ) + recoveryProbeBudget * conservativeCallCostUsd({
    prompt: recoverySample.prompt,
    maxOutputTokens: recoverySample.maxOutputTokens,
    pricing,
  });
  const budget = {
    model,
    mode,
    arms,
    runs,
    plannedRequests,
    workloadRequests,
    recoveryProbeBudget,
    pricingUsdPerMillionTokens: pricing,
    worstCaseUsd: +worstCaseUsd.toFixed(6),
    hardRunCapUsd: maxUsd,
  };
  console.log("OpenAI overload compare spend guard:");
  console.table([budget]);
  if (worstCaseUsd > maxUsd) {
    throw new Error(
      `Refusing to run: conservative worst-case cost $${worstCaseUsd.toFixed(6)} exceeds --max-usd=$${maxUsd.toFixed(4)}.`,
    );
  }
  if (dryRun) {
    console.log("PASS dry-run: no API request was sent");
    return;
  }

  const identity = arms.includes("moflux") ? makeIdentityMaterial() : null;
  let jwksServer = null;
  let tyrConfigPath = null;
  let env = { ...process.env };
  if (arms.includes("moflux") && manageStack) {
    ensureDemoEnv(ENV_FILE, { quiet: true });
    env = { ...parseEnvFile(ENV_FILE), ...process.env };
  }

  const compose = (composeArgs, options = {}) => composeCommand({
    project: PROJECT,
    envFile: ENV_FILE,
    composeFile: COMPOSE_FILE,
    args: composeArgs,
    cwd: ROOT,
    env: {
      ...env,
      ...(tyrConfigPath ? { MOFLUX_OPENAI_TYR_CONFIG: tyrConfigPath } : {}),
    },
    ...options,
  });

  const allRunResults = [];
  const recoveryGates = [];
  let caughtError;
  try {
    if (arms.includes("moflux") && manageStack) {
      assertDockerAvailable();
      ensureRuntimeImage({
        root: ROOT,
        image: env.MOFLUX_TYR_IMAGE,
        envKey: "MOFLUX_TYR_SOURCE_DIR",
        sourceDir: env.MOFLUX_TYR_SOURCE_DIR,
        repoName: "tyr-admission-controller",
        version: TYR_VERSION,
        label: "Tyr",
      });
      jwksServer = await startJwksServer(identity.jwks, jwksPort);
      const configDir = runOutputDir ?? path.dirname(out);
      mkdirSync(configDir, { recursive: true });
      tyrConfigPath = path.resolve(configDir, "tyr-overload.yaml");
      writeFileSync(
        tyrConfigPath,
        renderTyrOverloadConfig({
          modelPrefix: model,
          maxConcurrent: mofluxMaxConcurrent,
          interactiveFloor,
          batchFloor,
          maxOutputTokens: Math.max(interactiveMaxOutputTokens, batchMaxOutputTokens),
          jwksPort,
          issuer: identity.issuer,
          audience: identity.audience,
        }),
        "utf8",
      );
      compose(["down", "--volumes", "--remove-orphans"], { allowFailure: true });
      compose(["up", "-d", "--force-recreate", "tyr-openai-overload"], { inherit: true });
      await waitForTyr();
    }

    for (let runIndex = 0; runIndex < runs; runIndex += 1) {
      const runNumber = runIndex + 1;
      const { trace, fingerprint } = traces[runIndex];
      const rotation = runIndex % arms.length;
      const order = [...arms.slice(rotation), ...arms.slice(0, rotation)];
      const armResults = {};
      const runResult = { run: runNumber, seed: seed + runIndex, fingerprint, armOrder: order, arms: armResults };
      allRunResults.push(runResult);
      console.log(`\nrun ${runNumber}/${runs} trace=${fingerprint.slice(0, 12)} order=${order.join(" -> ")}`);

      for (let orderIndex = 0; orderIndex < order.length; orderIndex += 1) {
        const arm = order[orderIndex];
        if (orderIndex > 0 && cooldownMs > 0) await sleep(cooldownMs);
        const startGate = await waitForRateLimitRecovery({
          label: `compare-run-${runNumber}-${arm}`,
          options: rateLimitIsolation,
        });
        recoveryGates.push({ run: runNumber, arm, ...startGate });
        if (!startGate.passed) {
          throw new Error(`rate-limit recovery failed before run ${runNumber} ${arm}: ${startGate.failureReason}`);
        }
        let staticInFlight = 0;
        const armStarted = performance.now();
        const promises = trace.map(async (request) => {
          const target = armStarted + request.offsetMs;
          const waitMs = target - performance.now();
          if (waitMs > 0) await sleep(waitMs);
          const dispatchDelayMs = Math.max(0, performance.now() - target);

          if (arm === "static") {
            if (staticInFlight >= staticCap) {
              return {
                run: runNumber,
                arm,
                requestId: request.requestId,
                workloadClass: request.workloadClass,
                scheduledOffsetMs: request.offsetMs,
                dispatchDelayMs: +dispatchDelayMs.toFixed(2),
                ok: false,
                status: 429,
                providerAttempted: false,
                rejectionOrigin: "static_local",
                failureOrigin: null,
                admissionReason: "concurrency_limit",
                admissionClass: null,
                error: "static local concurrency cap",
              };
            }
            staticInFlight += 1;
            try {
              return await providerRequest({
                arm,
                request,
                url: directUrl,
                identityToken: null,
                run: runNumber,
                scheduledOffsetMs: request.offsetMs,
                dispatchDelayMs,
              });
            } finally {
              staticInFlight -= 1;
            }
          }

          return providerRequest({
            arm,
            request,
            url: arm === "direct" ? directUrl : mofluxUrl,
            identityToken: arm === "moflux" ? identity.tokens[request.workloadClass] : null,
            run: runNumber,
            scheduledOffsetMs: request.offsetMs,
            dispatchDelayMs,
          });
        });
        const records = await Promise.all(promises);
        const elapsedMs = performance.now() - armStarted;
        armResults[arm] = {
          fingerprint,
          startHeadroom: startGate.startHeadroom,
          recoveryProbes: startGate.probes,
          recoveryWaitedMs: startGate.waitedMs,
          elapsedMs: +elapsedMs.toFixed(2),
          summary: summarizeArm(records, elapsedMs),
          records,
        };
        const interactive = armResults[arm].summary.classes.interactive;
        const batch = armResults[arm].summary.classes.batch;
        console.log(
          `${arm}: interactive ${interactive.success}/${interactive.offered} ` +
            `(${(interactive.successRate * 100).toFixed(1)}%), batch ${batch.success}/${batch.offered} ` +
            `(${(batch.successRate * 100).toFixed(1)}%), localRejects=${armResults[arm].summary.localRejects}, ` +
            `provider429=${armResults[arm].summary.provider429s}`,
        );
      }
    }
  } catch (error) {
    caughtError = error instanceof Error ? error : new Error(String(error));
  } finally {
    if (arms.includes("moflux") && manageStack && !keepStack) {
      try {
        compose(["down", "--volumes", "--remove-orphans"], { allowFailure: true });
      } catch {
        // Preserve the benchmark result/error below.
      }
    }
    await closeServer(jwksServer);
  }

  const aggregateByArm = {};
  for (const arm of arms) {
    const records = allRunResults.flatMap((run) => run.arms[arm]?.records ?? []);
    const elapsedMs = allRunResults.reduce((sum, run) => sum + (run.arms[arm]?.elapsedMs ?? 0), 0);
    aggregateByArm[arm] = summarizeArm(records, elapsedMs);
  }
  const mofluxClassProof = !arms.includes("moflux") || allRunResults.every((run) =>
    (run.arms.moflux?.records ?? []).every((record) =>
      record.admissionClass === record.workloadClass || record.failureOrigin === "transport" || record.failureOrigin === "moflux_gateway"
    ),
  );
  const directPressure = arms.includes("direct")
    ? aggregateByArm.direct.provider429s > 0 || aggregateByArm.direct.provider5xx > 0 || aggregateByArm.direct.transportFailures > 0
    : false;
  const localContention = arms.some((arm) => aggregateByArm[arm]?.localRejects > 0);
  const expectedRecoveryGates = runs * arms.length;
  const rateLimitIsolationPassed = recoveryGates.length === expectedRecoveryGates && recoveryGates.every((gate) => gate.passed);
  const inconclusiveReasons = [];
  if (arms.includes("direct") && !directPressure) inconclusiveReasons.push("no strict direct-provider overload signal (429, 5xx, or transport failure) was observed");
  if (!localContention) inconclusiveReasons.push("no local admission contention was observed");
  if (!mofluxClassProof) inconclusiveReasons.push("Tyr did not return the expected bounded admission class for every classified response");
  if (!rateLimitIsolationPassed) inconclusiveReasons.push("one or more comparison arms did not begin with verified recovered provider rate-limit headroom");

  const recoveryMeasuredUsd = recoveryGates
    .reduce((sum, gate) => sum + Number(gate.measuredSuccessfulUsageCostUsd ?? 0), 0);
  const measuredSuccessfulUsageCostUsd = +(recoveryMeasuredUsd + Object.values(aggregateByArm)
    .reduce((sum, arm) => sum + arm.measuredSuccessfulUsageCostUsd, 0))
    .toFixed(8);
  const summary = {
    schemaVersion: 1,
    benchmark: OPENAI_OVERLOAD_SWEEP_NAME,
    generatedAt: new Date().toISOString(),
    mode: "compare",
    purpose:
      "Matched real-OpenAI mixed-workload comparison of no control, an undifferentiated static cap, and Tyr protected admission classes. Single-node data-plane evidence; it does not exercise Latchflo fleet coordination.",
    runtime: {
      tyr: arms.includes("moflux") ? TYR_VERSION : null,
      model,
    },
    workload: {
      runs,
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
      traceFingerprints: traces.map((entry) => entry.fingerprint),
      retryPolicy: "none",
    },
    policies: {
      static: arms.includes("static") ? { maxConcurrent: staticCap, maxQueue: 0 } : null,
      moflux: arms.includes("moflux") ? {
        maxConcurrent: mofluxMaxConcurrent,
        maxQueue: 0,
        admissionClasses: {
          interactive: { protectedConcurrent: interactiveFloor, maxConcurrent: mofluxMaxConcurrent },
          batch: { protectedConcurrent: batchFloor, maxConcurrent: mofluxMaxConcurrent },
        },
        note: "This first live experiment isolates protected concurrency. It does not enable a Tyr in-flight token budget or Latchflo coordination.",
      } : null,
    },
    budget: {
      ...budget,
      measuredSuccessfulUsageCostUsd,
      note:
        "Measured cost includes recovery probes plus successful workload responses that returned final usage. The conservative pre-run guard reserves the maximum configured recovery probes and assumes every planned request reaches its configured maximum; it does not know account-wide spend.",
    },
    rateLimitIsolation: {
      ...rateLimitIsolation,
      expectedGates: expectedRecoveryGates,
      passed: rateLimitIsolationPassed,
      gates: recoveryGates,
    },
    aggregate: aggregateByArm,
    interpretation: {
      directProviderPressureObserved: directPressure,
      localAdmissionContentionObserved: localContention,
      mofluxAdmissionClassProof: mofluxClassProof,
      rateLimitIsolationPassed,
      conclusiveProviderOverloadComparison:
        caughtError === undefined && directPressure && localContention && mofluxClassProof && rateLimitIsolationPassed,
      inconclusiveReasons,
      warning:
        "Do not claim a provider-overload efficacy result unless conclusiveProviderOverloadComparison is true. A clean run with no direct-provider pressure is compatibility/load evidence, not proof that MoFlux improved behavior under OpenAI overload.",
    },
    runs: allRunResults,
    acceptance: {
      executionCompleted: caughtError === undefined,
      spendGuardPassed: worstCaseUsd <= maxUsd,
      matchedTraceByRun: allRunResults.every((run) =>
        Object.values(run.arms).every((arm) => arm.fingerprint === run.fingerprint),
      ),
      mofluxAdmissionClassProof: mofluxClassProof,
      rateLimitIsolationPassed,
    },
    ...(tyrConfigPath ? { generatedTyrConfig: repoRelative(tyrConfigPath, ROOT) } : {}),
    ...(caughtError ? { error: caughtError.message } : {}),
  };
  writeSummary(summary);
  if (caughtError) throw caughtError;
}

if (mode === "calibrate") await runCalibration();
else await runCompare();
