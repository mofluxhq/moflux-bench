#!/usr/bin/env node
/**
 * Tiny real-provider benchmark for OpenAI compatibility and proxy latency.
 *
 * This is intentionally NOT an overload benchmark. High-load admission-control
 * efficacy remains simulator-only so a benchmark run cannot turn into an API
 * bill. The default run uses a current cost-sensitive OpenAI model, alternates
 * direct and Tyr requests to balance provider drift, and refuses to start when
 * the conservative worst-case token bill exceeds --max-usd.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { ensureDemoEnv, TYR_VERSION } from "./env-lib.mjs";
import {
  buildOpenAIRequestBody,
  normalizeOpenAIApi,
  observeOpenAIStreamEvent,
  openAIPath,
} from "./openai-api-lib.mjs";
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = process.env.MOFLUX_BENCH_ENV_FILE
  ? path.resolve(process.env.MOFLUX_BENCH_ENV_FILE)
  : path.join(ROOT, "demo", "moflux", ".env");
const COMPOSE_FILE = path.join(ROOT, "demo", "openai", "compose.yaml");
const PROJECT = "moflux-openai";
const RESULTS = process.env.MOFLUX_BENCH_RESULTS_DIR
  ? path.resolve(process.env.MOFLUX_BENCH_RESULTS_DIR)
  : path.join(ROOT, "results");
const SWEEP_NAME = "openai-live-compatibility";

// Pricing source reviewed 2026-08-28:
// https://developers.openai.com/api/docs/models/gpt-5.6-luna
// Keep this table deliberately small: an unknown model must provide explicit
// pricing so the spend guard can never silently use the wrong rate.
const DEFAULT_MODEL = "gpt-5.6-luna";
const DEFAULT_MAX_USD = 0.01;
const MAX_RUN_CAP_USD = 1.00;

const MODEL_PRICING_USD_PER_MTOK = Object.freeze({
  "gpt-5.6-luna": Object.freeze({ input: 0.20, output: 1.20 }),
});

const args = new Map();
for (const arg of process.argv.slice(2)) {
  const match = /^--([^=]+)=(.*)$/.exec(arg);
  if (match) args.set(match[1], match[2]);
  else if (arg.startsWith("--")) args.set(arg.slice(2), "true");
}
const num = (name, fallback) => (args.has(name) ? Number(args.get(name)) : fallback);
const str = (name, fallback) => args.get(name) ?? fallback;
const bool = (name, fallback) => (args.has(name) ? args.get(name) === "true" : fallback);

const model = str("model", process.env.MOFLUX_OPENAI_MODEL ?? DEFAULT_MODEL);
const openaiApi = normalizeOpenAIApi(
  str("openai-api", process.env.MOFLUX_OPENAI_API ?? "responses"),
);
const openaiPath = openAIPath(openaiApi);
const requestsPerArm = num("requests-per-arm", 8);
const maxOutputTokens = num("max-output-tokens", 32);
const maxUsd = num("max-usd", Number(process.env.MOFLUX_OPENAI_MAX_USD ?? String(DEFAULT_MAX_USD)));
const requestTimeoutMs = num("request-timeout-ms", 90000);
const directUrl = str(
  "direct-url",
  process.env.MOFLUX_OPENAI_DIRECT_URL ?? `https://api.openai.com${openaiPath}`,
);
const mofluxUrl = str(
  "moflux-url",
  process.env.MOFLUX_OPENAI_TYR_URL ?? `http://127.0.0.1:18110${openaiPath}`,
);
const manageStack = bool("manage-stack", process.env.MOFLUX_OPENAI_MANAGE_STACK !== "false");
const keepStack = bool("keep-stack", false);
const dryRun = bool("dry-run", false);

const explicitOut = args.has("out") ? path.resolve(str("out", "")) : null;
const runId = str("run-id", newRunId());

let runOutputDir = null;
let pointerFile = null;
let out;

try {
  assertSafeResultsDir(RESULTS, ROOT, "OpenAI live results root");

  if (explicitOut) {
    out = assertSafeOutputFile(explicitOut, ROOT, "OpenAI live output file");
  } else {
    runOutputDir = assertSafeRunDir(
      runDirFor(RESULTS, SWEEP_NAME, runId),
      ROOT,
      "OpenAI live run directory",
    );
    out = path.join(runOutputDir, "summary.json");
    pointerFile = latestPointerFile(RESULTS, SWEEP_NAME);
  }
} catch (error) {
  console.error(
    `\nRefusing to run: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

if (!Number.isSafeInteger(requestsPerArm) || requestsPerArm < 1 || requestsPerArm > 1000) {
  throw new Error("--requests-per-arm must be an integer from 1 to 1000");
}
if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 1024) {
  throw new Error("--max-output-tokens must be an integer from 1 to 1024");
}
if (!Number.isFinite(maxUsd) || maxUsd <= 0 || maxUsd > MAX_RUN_CAP_USD) {
  throw new Error(`--max-usd must be greater than 0 and no more than ${MAX_RUN_CAP_USD}`);
}
if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs < 1000) {
  throw new Error("--request-timeout-ms must be >= 1000");
}

const configuredPricing = MODEL_PRICING_USD_PER_MTOK[model];
const customInputPrice = args.has("input-usd-per-mtok")
  ? num("input-usd-per-mtok", NaN)
  : undefined;
const customOutputPrice = args.has("output-usd-per-mtok")
  ? num("output-usd-per-mtok", NaN)
  : undefined;

const pricing = configuredPricing ?? (
  Number.isFinite(customInputPrice) &&
  customInputPrice >= 0 &&
  Number.isFinite(customOutputPrice) &&
  customOutputPrice >= 0
    ? { input: customInputPrice, output: customOutputPrice }
    : undefined
);

if (!pricing) {
  throw new Error(
    `No reviewed pricing is bundled for ${model}. Supply both --input-usd-per-mtok and --output-usd-per-mtok ` +
      "from the current OpenAI model page before running a live benchmark.",
  );
}

function promptFor(index) {
  // Same prompt is replayed through both arms. Arm order alternates by pair so
  // any provider-side prompt-cache benefit is balanced rather than assigned to
  // one arm systematically.
  return `MoFlux live benchmark pair ${index}. Reply with exactly: moflux-${index}-ok`;
}

const maxPromptBytes = Math.max(
  ...Array.from(
    { length: requestsPerArm },
    (_, index) => Buffer.byteLength(promptFor(index + 1), "utf8"),
  ),
);

// For ASCII benchmark prompts, token count cannot exceed UTF-8 bytes. Add a
// large fixed envelope for chat framing/special tokens so this stays a
// conservative spend guard instead of a tokenizer estimate.
const conservativeInputTokensPerCall = maxPromptBytes + 256;
const plannedCalls = requestsPerArm * 2;

const worstCaseUsd = plannedCalls * (
  (conservativeInputTokensPerCall * pricing.input) / 1_000_000 +
  (maxOutputTokens * pricing.output) / 1_000_000
);

const budgetPlan = {
  model,
  requestsPerArm,
  plannedCalls,
  conservativeInputTokensPerCall,
  maxOutputTokens,
  pricingUsdPerMillionTokens: pricing,
  worstCaseUsd: +worstCaseUsd.toFixed(6),
  hardRunCapUsd: maxUsd,
};

console.log("OpenAI live benchmark spend guard:");
console.table([budgetPlan]);

if (worstCaseUsd > maxUsd) {
  throw new Error(
    `Refusing to run: conservative worst-case cost $${worstCaseUsd.toFixed(6)} exceeds --max-usd=$${maxUsd.toFixed(4)}.`,
  );
}

if (dryRun) {
  console.log("PASS dry-run: no API request was sent");
  process.exit(0);
}

const apiKey = process.env.OPENAI_API_KEY;
if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
  throw new Error(
    "OPENAI_API_KEY is required for the live benchmark. The key is read only from the process environment.",
  );
}

ensureDemoEnv(ENV_FILE, { quiet: true });
const env = { ...parseEnvFile(ENV_FILE), ...process.env };

function compose(composeArgs, options = {}) {
  return composeCommand({
    project: PROJECT,
    envFile: ENV_FILE,
    composeFile: COMPOSE_FILE,
    args: composeArgs,
    cwd: ROOT,
    env,
    ...options,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTyr(timeoutMs = 30000) {
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

  throw new Error(
    `Tyr did not become ready at ${healthUrl} within ${timeoutMs}ms`,
  );
}

function authHeaders({ moflux }) {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
    ...(process.env.OPENAI_PROJECT
      ? { "openai-project": process.env.OPENAI_PROJECT }
      : {}),
    ...(process.env.OPENAI_ORGANIZATION
      ? { "openai-organization": process.env.OPENAI_ORGANIZATION }
      : {}),
    ...(moflux ? { "x-priority": "high" } : {}),
  };
}

async function parseStream(response, startedAt) {
  let ttftMs = null;
  let promptTokens = null;
  let completionTokens = null;
  let textChars = 0;

  if (!response.body) {
    return { ttftMs, promptTokens, completionTokens, textChars };
  }

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

        const observed = observeOpenAIStreamEvent(parsed, openaiApi);

        if (observed.text.length > 0) {
          if (ttftMs === null) {
            ttftMs = performance.now() - startedAt;
          }

          textChars += observed.text.length;
        }

        if (observed.usage) {
          promptTokens = observed.usage.input;
          completionTokens = observed.usage.output;
        }
      }
    }
  }

  return {
    ttftMs,
    promptTokens,
    completionTokens,
    textChars,
  };
}

async function runRequest({ arm, url, prompt, pair }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  const startedAt = performance.now();

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: authHeaders({ moflux: arm === "moflux" }),
      body: JSON.stringify(buildOpenAIRequestBody({
        api: openaiApi,
        model,
        prompt,
        maxOutputTokens,
        stream: true,
      })),
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

    const promptTokens = stream.promptTokens;
    const completionTokens = stream.completionTokens;

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
        error: "OpenAI stream omitted response text or final usage accounting",
      };
    }

    const actualCostUsd =
      (promptTokens * pricing.input + completionTokens * pricing.output) /
      1_000_000;

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
      actualCostUsd: +actualCostUsd.toFixed(8),
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

function percentile(values, q) {
  const finite = values
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (finite.length === 0) return null;

  const index = Math.min(
    finite.length - 1,
    Math.max(0, Math.ceil(q * finite.length) - 1),
  );

  return +finite[index].toFixed(2);
}

function summarizeArm(records) {
  const successes = records.filter((record) => record.ok);
  const actualCosts = successes
    .map((record) => record.actualCostUsd)
    .filter(Number.isFinite);

  return {
    requests: records.length,
    success: successes.length,
    failures: records.length - successes.length,
    successRate:
      records.length === 0
        ? 0
        : +(successes.length / records.length).toFixed(4),
    ttftMs: {
      p50: percentile(
        successes.map((record) => record.ttftMs),
        0.5,
      ),
      p95: percentile(
        successes.map((record) => record.ttftMs),
        0.95,
      ),
    },
    latencyMs: {
      p50: percentile(
        successes.map((record) => record.latencyMs),
        0.5,
      ),
      p95: percentile(
        successes.map((record) => record.latencyMs),
        0.95,
      ),
    },
    promptTokens: successes.reduce(
      (sum, record) => sum + (Number(record.promptTokens) || 0),
      0,
    ),
    completionTokens: successes.reduce(
      (sum, record) => sum + (Number(record.completionTokens) || 0),
      0,
    ),
    actualCostUsd:
      actualCosts.length === successes.length
        ? +actualCosts.reduce((sum, value) => sum + value, 0).toFixed(8)
        : null,
  };
}

const records = [];
let caughtError;

try {
  if (manageStack) {
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

    compose(
      ["down", "--volumes", "--remove-orphans"],
      { allowFailure: true },
    );

    compose(
      ["up", "-d", "--force-recreate", "tyr-openai"],
      { inherit: true },
    );

    await waitForTyr();
  }

  for (let pair = 1; pair <= requestsPerArm; pair += 1) {
    const prompt = promptFor(pair);

    const order =
      pair % 2 === 1
        ? ["direct", "moflux"]
        : ["moflux", "direct"];

    for (const arm of order) {
      const record = await runRequest({
        arm,
        url: arm === "direct" ? directUrl : mofluxUrl,
        prompt,
        pair,
      });

      records.push(record);

      const status = record.ok
        ? `ok ${record.latencyMs}ms`
        : `FAIL ${record.status ?? "transport"}`;

      console.log(
        `pair ${pair}/${requestsPerArm} ${arm}: ${status}`,
      );
    }
  }
} catch (error) {
  caughtError =
    error instanceof Error
      ? error
      : new Error(String(error));
} finally {
  if (manageStack && !keepStack) {
    compose(
      ["down", "--volumes", "--remove-orphans"],
      { allowFailure: true },
    );
  }
}

const direct = summarizeArm(
  records.filter((record) => record.arm === "direct"),
);

const moflux = summarizeArm(
  records.filter((record) => record.arm === "moflux"),
);

const knownActualCost =
  [direct.actualCostUsd, moflux.actualCostUsd].every(Number.isFinite)
    ? +(direct.actualCostUsd + moflux.actualCostUsd).toFixed(8)
    : null;

const summary = {
  schemaVersion: 1,
  benchmark: SWEEP_NAME,
  generatedAt: new Date().toISOString(),
  purpose:
    "Low-cost real-provider compatibility and latency baseline; not an overload-efficacy benchmark.",
  runtime: {
    tyr: TYR_VERSION,
    model,
    openaiApi,
    endpoint: openaiPath,
  },
  budget: {
    ...budgetPlan,
    actualMeasuredUsd: knownActualCost,
    note:
      "The per-run guard does not know or enforce API spend from other applications or earlier runs.",
  },
  arms: {
    direct,
    moflux,
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
  },
  acceptance: {
    passed:
      caughtError === undefined &&
      direct.failures === 0 &&
      moflux.failures === 0 &&
      direct.requests === requestsPerArm &&
      moflux.requests === requestsPerArm,
    directAllSucceeded:
      direct.failures === 0 &&
      direct.requests === requestsPerArm,
    mofluxAllSucceeded:
      moflux.failures === 0 &&
      moflux.requests === requestsPerArm,
    spendGuardPassed: worstCaseUsd <= maxUsd,
  },
  records,
  ...(caughtError
    ? {
        error: caughtError.message,
      }
    : {}),
};

mkdirSync(path.dirname(out), { recursive: true });

writeFileSync(
  out,
  JSON.stringify(summary, null, 2) + "\n",
);

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

console.log(
  `OpenAI summary: ${repoRelative(out, ROOT)}`,
);

if (pointerFile) {
  console.log(
    `OpenAI latest: ${repoRelative(pointerFile, ROOT)}`,
  );
}

console.table([
  {
    arm: "direct",
    success: `${direct.success}/${direct.requests}`,
    ttftP50Ms: direct.ttftMs.p50,
    latencyP50Ms: direct.latencyMs.p50,
    actualUsd: direct.actualCostUsd,
  },
  {
    arm: "moflux",
    success: `${moflux.success}/${moflux.requests}`,
    ttftP50Ms: moflux.ttftMs.p50,
    latencyP50Ms: moflux.latencyMs.p50,
    actualUsd: moflux.actualCostUsd,
  },
]);

if (!summary.acceptance.passed) {
  console.error(
    caughtError?.message ??
      "OpenAI live benchmark failed",
  );

  process.exitCode = 1;
} else {
  console.log(
    `PASS OpenAI ${openaiApi} live benchmark; conservative run ceiling $${worstCaseUsd.toFixed(6)} <= $${maxUsd.toFixed(4)}`,
  );

  if (runOutputDir) {
    console.log(
      `Promote deliberately with: npm run evidence:publish -- --as=${SWEEP_NAME}`,
    );
  }
}