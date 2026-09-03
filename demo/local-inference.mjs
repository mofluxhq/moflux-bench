#!/usr/bin/env node
/**
 * Local inference benchmark: proxy overhead in front of a self-hosted server.
 *
 * The same paired, alternating-order design as demo/openai-live.mjs, pointed at
 * an Ollama server this stack starts itself. Two properties differ and both
 * matter for how the result should be read:
 *
 *   1. There is no bill, so there is no spend guard. What replaces it is a
 *      non-overridable locality guard on both upstream URLs — see
 *      local-inference-lib.mjs for why that substitution is the safe one.
 *   2. The server is the machine running the benchmark. Against a hosted
 *      provider the proxy and the model compete for nothing; here they compete
 *      for the same cores, so a latency delta includes contention that a
 *      hosted run would never show. That is the point of running it, and it is
 *      also why this is not a lower-cost substitute for the OpenAI arm.
 *
 * Like the OpenAI compatibility benchmark, this is NOT an overload benchmark.
 * It measures a proxy against an unsaturated server; admission-control efficacy
 * under load remains simulator-only.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { DEFAULT_LOCAL_MODEL, OLLAMA_VERSION, TYR_VERSION, ensureDemoEnv } from "./env-lib.mjs";
import { observeOpenAIStreamEvent } from "./openai-api-lib.mjs";
import {
  LOCAL_ENDPOINT,
  LOCAL_INFERENCE_SWEEP_NAME,
  LOCAL_OLLAMA_PORT,
  LOCAL_TYR_PORT,
  assertLocalUpstream,
  buildLocalChatBody,
  decodeTokensPerSecond,
  summarizeArm,
  warmupPairs,
} from "./local-inference-lib.mjs";
import {
  assertSafeOutputFile,
  assertSafeResultsDir,
  assertSafeRunDir,
  latestPointerFile,
  repoRelative,
  runDir as runDirFor,
  runId as newRunId,
} from "./evidence-paths-lib.mjs";
import { assertDockerAvailable, composeCommand, parseEnvFile } from "./runtime-image-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = process.env.MOFLUX_BENCH_ENV_FILE
  ? path.resolve(process.env.MOFLUX_BENCH_ENV_FILE)
  : path.join(ROOT, "demo", "moflux", ".env");
const COMPOSE_FILE = path.join(ROOT, "demo", "ollama", "compose.yaml");
const PROJECT = "moflux-local-inference";
const RESULTS = process.env.MOFLUX_BENCH_RESULTS_DIR
  ? path.resolve(process.env.MOFLUX_BENCH_RESULTS_DIR)
  : path.join(ROOT, "results");
const SWEEP_NAME = LOCAL_INFERENCE_SWEEP_NAME;

const args = new Map();
for (const arg of process.argv.slice(2)) {
  const match = /^--([^=]+)=(.*)$/.exec(arg);
  if (match) args.set(match[1], match[2]);
  else if (arg.startsWith("--")) args.set(arg.slice(2), "true");
}
const num = (name, fallback) => (args.has(name) ? Number(args.get(name)) : fallback);
const str = (name, fallback) => args.get(name) ?? fallback;
const bool = (name, fallback) => (args.has(name) ? args.get(name) === "true" : fallback);

const model = str("model", process.env.MOFLUX_LOCAL_MODEL ?? DEFAULT_LOCAL_MODEL);
const requestsPerArm = num("requests-per-arm", 8);
const maxOutputTokens = num("max-output-tokens", 64);
const requestTimeoutMs = num("request-timeout-ms", 300_000);
const directUrl = str(
  "direct-url",
  process.env.MOFLUX_LOCAL_DIRECT_URL ?? `http://127.0.0.1:${LOCAL_OLLAMA_PORT}${LOCAL_ENDPOINT}`,
);
const mofluxUrl = str(
  "moflux-url",
  process.env.MOFLUX_LOCAL_TYR_URL ?? `http://127.0.0.1:${LOCAL_TYR_PORT}${LOCAL_ENDPOINT}`,
);
const manageStack = bool("manage-stack", process.env.MOFLUX_LOCAL_MANAGE_STACK !== "false");
const keepStack = bool("keep-stack", false);
const pullModel = bool("pull", true);
const pullTimeoutMs = num("pull-timeout-ms", 1_800_000);
const dryRun = bool("dry-run", false);
const runId = str("run-id", newRunId());
const explicitOut = args.has("out") ? path.resolve(str("out", "")) : null;

// There is no /v1/responses on Ollama. Accepting the flag and quietly serving
// chat-completions would make a summary claim an API surface it never touched.
if (args.has("openai-api") && args.get("openai-api") !== "chat-completions") {
  console.error(
    `\nRefusing to run: --openai-api=${args.get("openai-api")} is not available locally. ` +
      "Ollama implements only the OpenAI Chat Completions surface; the Responses API arm exists " +
      "in npm run demo:openai:responses against a provider that serves it.",
  );
  process.exit(1);
}

let runOutputDir = null;
let pointerFile = null;
let out;

try {
  // The locality guard runs before anything else can send a byte, including
  // before the results path is chosen, so a misdirected URL cannot even create
  // a run directory implying the benchmark started.
  assertLocalUpstream(directUrl, "--direct-url");
  assertLocalUpstream(mofluxUrl, "--moflux-url");

  assertSafeResultsDir(RESULTS, ROOT, "local inference results root");
  if (explicitOut) {
    out = assertSafeOutputFile(explicitOut, ROOT, "local inference output file");
  } else {
    runOutputDir = assertSafeRunDir(
      runDirFor(RESULTS, SWEEP_NAME, runId),
      ROOT,
      "local inference run directory",
    );
    out = path.join(runOutputDir, "summary.json");
    pointerFile = latestPointerFile(RESULTS, SWEEP_NAME);
  }
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

if (!Number.isSafeInteger(requestsPerArm) || requestsPerArm < 1 || requestsPerArm > 1000) {
  throw new Error("--requests-per-arm must be an integer from 1 to 1000");
}
if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 1024) {
  throw new Error("--max-output-tokens must be an integer from 1 to 1024");
}
if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs < 1000) {
  throw new Error("--request-timeout-ms must be >= 1000");
}

function promptFor(index) {
  return `MoFlux local benchmark pair ${index}. Reply with exactly: moflux-${index}-ok`;
}

const plan = {
  model,
  requestsPerArm,
  plannedCalls: requestsPerArm * 2,
  maxOutputTokens,
  directUpstream: new URL(directUrl).host,
  mofluxUpstream: new URL(mofluxUrl).host,
  warmupPairsExcludedFromSteadyState: warmupPairs(),
  costUsd: 0,
};

console.log("Local inference benchmark plan (no metered provider is reachable):");
console.table([plan]);

if (dryRun) {
  console.log("PASS dry-run: no inference request was sent");
  process.exit(0);
}

// Only a run that starts containers needs the pinned image tags, and only such
// a run may create the local .env as a side effect. A --manage-stack=false run
// against an already-running server writes nothing into the working tree.
const env = manageStack
  ? (ensureDemoEnv(ENV_FILE, { quiet: true }), { ...parseEnvFile(ENV_FILE), ...process.env })
  : { ...process.env };

function compose(composeArgs, options = {}) {
  return composeCommand({
    project: PROJECT,
    envFile: ENV_FILE,
    composeFile: COMPOSE_FILE,
    args: composeArgs,
    cwd: path.dirname(COMPOSE_FILE),
    env,
    ...options,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReady(url, label, timeoutMs = 120_000) {
  const healthUrl = new URL(url);
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
  throw new Error(`${label} did not become ready at ${healthUrl} within ${timeoutMs}ms`);
}

/**
 * Pulls the weights into the Ollama named volume, streaming progress.
 *
 * Separate from the compose step on purpose: the image is pinned and small, the
 * weights are neither, and a first run on a cold volume can take many minutes.
 * Failing here has to name the model rather than surface as a request timeout
 * on pair 1.
 */
async function ensureModelPulled() {
  const pullUrl = new URL(directUrl);
  pullUrl.pathname = "/api/pull";
  pullUrl.search = "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), pullTimeoutMs);
  try {
    const response = await fetch(pullUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, stream: true }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`pull of ${model} failed with HTTP ${response.status}`);
    }
    const decoder = new TextDecoder();
    let buffer = "";
    let lastStatus = "";
    for await (const chunk of response.body ?? []) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (parsed.error) throw new Error(`pull of ${model} failed: ${parsed.error}`);
        if (typeof parsed.status === "string" && parsed.status !== lastStatus) {
          lastStatus = parsed.status;
          console.log(`pull ${model}: ${parsed.status}`);
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

async function parseStream(response, startedAt) {
  let ttftMs = null;
  let promptTokens = null;
  let completionTokens = null;
  let textChars = 0;
  if (!response.body) return { ttftMs, promptTokens, completionTokens, textChars };

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
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
        const observed = observeOpenAIStreamEvent(parsed, "chat-completions");
        if (observed.text.length > 0) {
          if (ttftMs === null) ttftMs = performance.now() - startedAt;
          textChars += observed.text.length;
        }
        if (observed.usage) {
          promptTokens = observed.usage.input;
          completionTokens = observed.usage.output;
        }
      }
    }
  }
  return { ttftMs, promptTokens, completionTokens, textChars };
}

async function runRequest({ arm, url, prompt, pair }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  const startedAt = performance.now();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // No credential is sent in either arm: a self-hosted server has none,
        // and inventing one would put a bearer token in a benchmark that has
        // no secret to protect.
        ...(arm === "moflux" ? { "x-priority": "high" } : {}),
      },
      body: JSON.stringify(
        buildLocalChatBody({ model, prompt, maxOutputTokens, seed: pair, stream: true }),
      ),
      signal: controller.signal,
    });
    const headersMs = performance.now() - startedAt;

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        arm,
        pair,
        ok: false,
        status: response.status,
        headersMs: +headersMs.toFixed(2),
        error: body.slice(0, 300),
      };
    }

    const stream = await parseStream(response, startedAt);
    const latencyMs = performance.now() - startedAt;
    const { promptTokens, completionTokens } = stream;

    if (
      !(stream.textChars > 0) ||
      !Number.isFinite(promptTokens) ||
      !Number.isFinite(completionTokens)
    ) {
      return {
        arm,
        pair,
        ok: false,
        status: response.status,
        headersMs: +headersMs.toFixed(2),
        latencyMs: +latencyMs.toFixed(2),
        error: "local stream omitted response text or final usage accounting",
      };
    }

    return {
      arm,
      pair,
      ok: true,
      status: response.status,
      headersMs: +headersMs.toFixed(2),
      ttftMs: +(stream.ttftMs ?? latencyMs).toFixed(2),
      latencyMs: +latencyMs.toFixed(2),
      promptTokens,
      completionTokens,
      outputChars: stream.textChars,
    };
  } catch (error) {
    return {
      arm,
      pair,
      ok: false,
      status: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

const records = [];
let caughtError;

try {
  if (manageStack) {
    assertDockerAvailable();
    if (!env.MOFLUX_TYR_IMAGE) throw new Error("MOFLUX_TYR_IMAGE is not configured");
    if (!env.MOFLUX_OLLAMA_IMAGE) throw new Error("MOFLUX_OLLAMA_IMAGE is not configured");

    // Only the model volume survives, so repeated runs do not re-download the
    // weights while still starting from a clean controller.
    compose(["down", "--remove-orphans"], { allowFailure: true });
    compose(["up", "-d", "--force-recreate", "--wait"], { inherit: true });

    if (pullModel) await ensureModelPulled();
    await waitForReady(mofluxUrl, "Tyr");
  }

  for (let pair = 1; pair <= requestsPerArm; pair += 1) {
    const prompt = promptFor(pair);
    const order = pair % 2 === 1 ? ["direct", "moflux"] : ["moflux", "direct"];
    for (const arm of order) {
      const record = await runRequest({
        arm,
        url: arm === "direct" ? directUrl : mofluxUrl,
        prompt,
        pair,
      });
      records.push(record);
      const status = record.ok ? `ok ${record.latencyMs}ms` : `FAIL ${record.status ?? "transport"}`;
      console.log(`pair ${pair}/${requestsPerArm} ${arm}: ${status}`);
    }
  }
} catch (error) {
  caughtError = error instanceof Error ? error : new Error(String(error));
} finally {
  if (manageStack && !keepStack) {
    compose(["down", "--remove-orphans"], { allowFailure: true });
  }
}

const directRecords = records.filter((record) => record.arm === "direct");
const mofluxRecords = records.filter((record) => record.arm === "moflux");
const direct = summarizeArm(directRecords);
const moflux = summarizeArm(mofluxRecords);

// Warm-up is per arm, and each pair contributes one request to each, so a run
// only leaves warm-up once it has more pairs than the warm-up count.
const steadyStateMeasured = requestsPerArm > warmupPairs();

const summary = {
  schemaVersion: 1,
  benchmark: SWEEP_NAME,
  generatedAt: new Date().toISOString(),
  purpose:
    "Self-hosted compatibility and proxy-overhead baseline against a local inference server; " +
    "not an overload-efficacy benchmark.",
  runtime: {
    tyr: TYR_VERSION,
    ollama: OLLAMA_VERSION,
    model,
    openaiApi: "chat-completions",
    endpoint: LOCAL_ENDPOINT,
  },
  locality: {
    guard: "non-overridable",
    directUpstream: new URL(directUrl).host,
    mofluxUpstream: new URL(mofluxUrl).host,
    meteredProviderReachable: false,
    note:
      "This benchmark has no spend guard because no upstream it is permitted to reach can bill. " +
      "Both URLs are checked against the locality rule before the first request.",
  },
  arms: {
    direct: { ...direct, decodeTokensPerSecondP50: decodeTokensPerSecond(directRecords) },
    moflux: { ...moflux, decodeTokensPerSecondP50: decodeTokensPerSecond(mofluxRecords) },
  },
  deltas: {
    ttftP50Ms:
      direct.ttftMs.p50 !== null && moflux.ttftMs.p50 !== null
        ? +(moflux.ttftMs.p50 - direct.ttftMs.p50).toFixed(2)
        : null,
    latencyP50Ms:
      direct.latencyMs.p50 !== null && moflux.latencyMs.p50 !== null
        ? +(moflux.latencyMs.p50 - direct.latencyMs.p50).toFixed(2)
        : null,
    // Carried on the deltas themselves rather than left to a reader to
    // cross-check against caveats.warmupPairs. A run shorter than warm-up
    // routinely produces a negative delta -- the proxied arm "beating" the
    // direct one -- because whichever arm went first paid to load the weights.
    // That is not a measurement of proxy overhead, and the number must not be
    // quotable without the flag that says so.
    steadyState: steadyStateMeasured,
  },
  caveats: {
    warmupPairs: warmupPairs(),
    note:
      "Weight loading and Tyr's adaptive token estimator both inflate the earliest pairs. " +
      "Alternating arm order balances that across arms rather than removing it; a run with " +
      "requestsPerArm near warmupPairs is measuring warm-up. The proxy and the model also " +
      "share this machine's cores, so latencyP50Ms includes contention a hosted run would not.",
  },
  acceptance: {
    passed:
      caughtError === undefined &&
      direct.failures === 0 &&
      moflux.failures === 0 &&
      direct.requests === requestsPerArm &&
      moflux.requests === requestsPerArm,
    directAllSucceeded: direct.failures === 0 && direct.requests === requestsPerArm,
    mofluxAllSucceeded: moflux.failures === 0 && moflux.requests === requestsPerArm,
    localityGuardPassed: true,
    // Deliberately not folded into `passed`. Every request succeeding is a real
    // compatibility result and stays one; it just is not an overhead result.
    // Failing the run would discard the half that is valid, and passing it
    // silently would publish the half that is not.
    steadyStateMeasured,
  },
  records,
  ...(caughtError ? { error: caughtError.message } : {}),
};

mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(summary, null, 2) + "\n");

if (pointerFile && runOutputDir) {
  mkdirSync(path.dirname(pointerFile), { recursive: true });
  writeFileSync(
    pointerFile,
    `${JSON.stringify(
      {
        sweep: SWEEP_NAME,
        runId,
        generatedAt: summary.generatedAt,
        run: repoRelative(runOutputDir, ROOT),
        summary: repoRelative(out, ROOT),
      },
      null,
      2,
    )}\n`,
  );
}

console.log(`Local inference summary: ${repoRelative(out, ROOT)}`);
if (pointerFile) console.log(`Local inference latest: ${repoRelative(pointerFile, ROOT)}`);

console.table([
  {
    arm: "direct",
    success: `${direct.success}/${direct.requests}`,
    ttftP50Ms: direct.ttftMs.p50,
    latencyP50Ms: direct.latencyMs.p50,
    decodeTokPerSec: summary.arms.direct.decodeTokensPerSecondP50,
  },
  {
    arm: "moflux",
    success: `${moflux.success}/${moflux.requests}`,
    ttftP50Ms: moflux.ttftMs.p50,
    latencyP50Ms: moflux.latencyMs.p50,
    decodeTokPerSec: summary.arms.moflux.decodeTokensPerSecondP50,
  },
]);

if (!summary.acceptance.passed) {
  console.error(caughtError?.message ?? "local inference benchmark failed");
  process.exitCode = 1;
} else {
  if (steadyStateMeasured) {
    console.log(
      `PASS local inference benchmark against ${model}; no metered provider was reachable`,
    );
  } else {
    console.log(
      `PASS local inference compatibility against ${model}; no metered provider was reachable`,
    );
    console.warn(
      `\nNOTE: --requests-per-arm=${requestsPerArm} does not exceed the ${warmupPairs()} warm-up ` +
        "pairs, so every request in this run paid some part of weight loading or adaptive-estimator " +
        "convergence. Compatibility is measured; proxy overhead is not. `deltas.steadyState` is " +
        `false and the deltas above must not be quoted. Re-run with --requests-per-arm=${warmupPairs() * 4} ` +
        "or more for an overhead figure.",
    );
  }
  if (runOutputDir) {
    console.log(`Promote deliberately with: npm run evidence:publish -- --as=${SWEEP_NAME}`);
  }
}
