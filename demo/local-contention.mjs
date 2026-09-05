#!/usr/bin/env node
/**
 * Local inference contention benchmark: workload isolation on a self-hosted
 * server that both workload classes have to share.
 *
 * This is not `demo/local-inference.mjs` with more requests. That benchmark
 * measures compatibility against an unsaturated server and its latency deltas
 * are explicitly not quotable. This one deliberately offers more work than the
 * machine can decode and asks whether admission control keeps interactive
 * traffic served while batch traffic still gets to use capacity nobody else
 * wants.
 *
 * Three arms replay one immutable trace:
 *
 *   direct   straight to Ollama. Its own FIFO queue is the only control.
 *   static   fixed per-class protected floors. Rigid, and priced accordingly:
 *            batch cannot touch an interactive slot even while it sits empty.
 *   moflux   identical floors, but Latchflo may lend an idle one and must
 *            restore it when its owner comes back.
 *
 * Safety, unchanged from 0.32.0 and for the same reason: there is no spend
 * guard because a self-hosted server has no price, so there is a locality guard
 * instead, it covers every arm's endpoint, and no flag turns it off.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { buildTrace } from "../load/trace-lib.mjs";
import {
  ASYNC_BULKHEAD_LLM_VERSION,
  ASYNC_BULKHEAD_TS_VERSION,
  DEFAULT_LOCAL_MODEL,
  LATCHFLO_VERSION,
  OLLAMA_VERSION,
  TYR_VERSION,
  ensureDemoEnv,
} from "./env-lib.mjs";
import {
  assertSafeResultsDir,
  assertSafeRunDir,
  latestPointerFile,
  repoRelative,
  runDir as runDirFor,
  runId as newRunId,
} from "./evidence-paths-lib.mjs";
import {
  assertHostPortFree,
  childOutputTail,
  fetchWithTimeout,
  launchNode,
  sleep,
  stopHostChildren,
  waitFor,
} from "./host-process-lib.mjs";
import { startIdentityFixture } from "./identity-fixture-lib.mjs";
import {
  CONTENTION_ARMS,
  CONTENTION_ARM_IDS,
  CONTENTION_ENDPOINT,
  CONTENTION_IDENTITY_PORT,
  CONTENTION_LATCHFLO_PORT,
  CONTENTION_OLLAMA_PORT,
  CONTENTION_POLICY,
  CONTENTION_WORKLOAD,
  EVIDENCE_LIMITS,
  LOCAL_CONTENTION_SWEEP_NAME,
  PUBLICATION_SEED_COUNT,
  WARMUP_REQUESTS_PER_CLASS,
  aggregateArmClass,
  armOrderIsCounterbalanced,
  armOrderPlan,
  capacityInvariantViolations,
  compareLocalContention,
  contentionArm,
  contentionPoolDefinition,
  contentionRestorationClaim,
  criticalWindowDigest,
  localContentionProof,
  localContentionSeedProof,
  median,
  nominalClassGrant,
  scenarioId,
  summarizeArmClasses,
  summarizeClassHandoffSafety,
  summarizeDemandTransitions,
  summarizeLendingEpisodes,
} from "./local-contention-lib.mjs";
import { assertLocalUpstream, buildLocalChatBody } from "./local-inference-lib.mjs";
import { observeOpenAIStreamEvent } from "./openai-api-lib.mjs";
import {
  ENFORCEABILITY_FRAMING,
  summarizeBorrowedDeadlineCost,
  summarizeLatchfloRestorationEpisodes,
  summarizeTyrRestoration,
  summarizeUnlentFloorGauges,
} from "./restoration-enforceability-lib.mjs";
import { assertDockerAvailable, composeCommand, parseEnvFile } from "./runtime-image-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = process.env.MOFLUX_BENCH_ENV_FILE
  ? path.resolve(process.env.MOFLUX_BENCH_ENV_FILE)
  : path.join(ROOT, "demo", "moflux", ".env");
const COMPOSE_FILE = path.join(ROOT, "demo", "ollama", "compose-contention.yaml");
const IDENTITY_RUNTIME = path.join(ROOT, "demo", "ollama", "runtime");
const PROJECT = "moflux-local-contention";
const RESULTS = process.env.MOFLUX_BENCH_RESULTS_DIR
  ? path.resolve(process.env.MOFLUX_BENCH_RESULTS_DIR)
  : path.join(ROOT, "results");
const LATCHFLO = `http://127.0.0.1:${CONTENTION_LATCHFLO_PORT}`;
const MANAGED_ARMS = CONTENTION_ARMS.filter((arm) => arm.managed);
/** Matches the external volume named in demo/ollama/compose-contention.yaml. */
const OLLAMA_MODELS_VOLUME = "moflux-bench-ollama-models";

// ── arguments ────────────────────────────────────────────────────────

const args = new Map();
for (const arg of process.argv.slice(2)) {
  const match = /^--([^=]+)=(.*)$/.exec(arg);
  if (match) args.set(match[1], match[2]);
  else if (arg.startsWith("--")) args.set(arg.slice(2), "true");
}
const str = (name, fallback) => args.get(name) ?? fallback;
const num = (name, fallback) => (args.has(name) ? Number(args.get(name)) : fallback);
const flag = (name) => args.get(name) === "true";

function parseSeeds(raw) {
  const values = [];
  for (const part of String(raw).split(",").map((value) => value.trim()).filter(Boolean)) {
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (end < start) throw new Error(`invalid seed range ${part}`);
      for (let seed = start; seed <= end; seed += 1) values.push(seed);
    } else {
      values.push(Number(part));
    }
  }
  const unique = [...new Set(values)];
  if (unique.length === 0 || unique.some((seed) => !Number.isSafeInteger(seed) || seed < 0)) {
    throw new Error("--seeds must contain non-negative integer seeds or ranges");
  }
  return unique;
}

function parseArms(raw) {
  const requested = String(raw).split(",").map((value) => value.trim()).filter(Boolean);
  for (const id of requested) contentionArm(id);
  const unique = [...new Set(requested)];
  if (unique.length < 2) throw new Error("--arms must name at least two arms to compare");
  return unique;
}

let OPT;
try {
  OPT = Object.freeze({
    seeds: parseSeeds(str("seeds", `1-${PUBLICATION_SEED_COUNT}`)),
    arms: parseArms(str("arms", CONTENTION_ARM_IDS.join(","))),
    model: str("model", process.env.MOFLUX_LOCAL_MODEL ?? DEFAULT_LOCAL_MODEL),
    durationMs: num("duration-ms", CONTENTION_WORKLOAD.durationMs),
    warmupRequestsPerClass: num("warmup-requests-per-class", WARMUP_REQUESTS_PER_CLASS),
    pauseMs: num("pause-ms", 2_000),
    requireProof: flag("require-proof"),
    keepStack: flag("keep-stack"),
    dryRun: flag("dry-run"),
    doctor: flag("doctor"),
    pullModel: args.has("pull") ? args.get("pull") === "true" : true,
    pullTimeoutMs: num("pull-timeout-ms", 1_800_000),
    runId: str("run-id", newRunId()),
    out: args.has("out") ? path.resolve(str("out", "")) : null,
  });
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

if (!Number.isSafeInteger(OPT.durationMs) || OPT.durationMs < 30_000) {
  console.error("\n--duration-ms must be an integer of at least 30000; the workload has five phases");
  process.exit(1);
}
if (
  !Number.isSafeInteger(OPT.warmupRequestsPerClass) ||
  OPT.warmupRequestsPerClass < 1 ||
  OPT.warmupRequestsPerClass > 50
) {
  console.error("\n--warmup-requests-per-class must be an integer from 1 to 50");
  process.exit(1);
}

/**
 * Every endpoint this run may send a byte to, resolved before anything else.
 *
 * The guard is on the address rather than the amount because a self-hosted
 * server has no bill to cap, and it covers every arm rather than a designated
 * "upstream" one: an arm list is data, and a benchmark that checked only the
 * arms it expected would be trivially bypassed by naming another.
 */
const ARM_URLS = Object.fromEntries(
  CONTENTION_ARMS.map((arm) => [arm.id, `http://127.0.0.1:${arm.port}${CONTENTION_ENDPOINT}`]),
);
const OLLAMA_URL = `http://127.0.0.1:${CONTENTION_OLLAMA_PORT}${CONTENTION_ENDPOINT}`;

let runOutputDir = null;
let pointerFile = null;
let summaryFile;
try {
  for (const [id, url] of Object.entries(ARM_URLS)) {
    assertLocalUpstream(url, `--arms ${id} endpoint`);
  }
  assertLocalUpstream(OLLAMA_URL, "ollama upstream");
  assertLocalUpstream(LATCHFLO, "control plane");

  assertSafeResultsDir(RESULTS, ROOT, "local contention results root");
  if (OPT.out) {
    runOutputDir = assertSafeRunDir(OPT.out, ROOT, "local contention run directory");
  } else {
    runOutputDir = assertSafeRunDir(
      runDirFor(RESULTS, LOCAL_CONTENTION_SWEEP_NAME, OPT.runId),
      ROOT,
      "local contention run directory",
    );
    pointerFile = latestPointerFile(RESULTS, LOCAL_CONTENTION_SWEEP_NAME);
  }
  summaryFile = path.join(runOutputDir, "summary.json");
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

/** Process-relative origin for the `elapsedBenchmarkMs` field in diagnostics. */
const BENCHMARK_STARTED_AT = performance.now();

const WORKLOAD = Object.freeze({ ...CONTENTION_WORKLOAD, durationMs: OPT.durationMs });
const ORDER_PLAN = armOrderPlan(OPT.seeds, OPT.arms);

const plan = {
  benchmark: LOCAL_CONTENTION_SWEEP_NAME,
  model: OPT.model,
  arms: OPT.arms.join(","),
  seeds: OPT.seeds.join(","),
  durationMs: WORKLOAD.durationMs,
  warmupPerClassPerArm: OPT.warmupRequestsPerClass,
  counterbalanced: armOrderIsCounterbalanced(ORDER_PLAN, OPT.arms),
  publicationSeedCount: OPT.seeds.length >= PUBLICATION_SEED_COUNT,
  meteredProviderReachable: false,
  costUsd: 0,
};

console.log("Local contention benchmark plan (no metered provider is reachable):");
console.table([plan]);
console.table(ORDER_PLAN.map(({ seed, order }) => ({ seed, order: order.join(" -> ") })));

if (OPT.dryRun) {
  console.log("PASS dry-run: no inference request was sent");
  process.exit(0);
}

// ── stack plumbing ───────────────────────────────────────────────────

// Populated only for a real benchmark run. `--dry-run` and `--doctor` must
// leave the working tree untouched; in particular they must not create the
// gitignored demo/moflux/.env that verify:publication intentionally rejects.
let env = { ...process.env };
let ADMIN_TOKEN = process.env.LATCHFLO_ADMIN_TOKEN ?? null;

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

async function jsonRequest(url, { method = "GET", token = ADMIN_TOKEN, body, allowed = [200] } = {}) {
  const response = await fetchWithTimeout(
    url,
    {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    8_000,
  );
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  if (!allowed.includes(response.status)) {
    throw new Error(`${method} ${url} -> HTTP ${response.status}: ${String(text).slice(0, 300)}`);
  }
  return { status: response.status, body: parsed };
}

/**
 * Pulls the weights into the stack's named volume, streaming progress.
 *
 * Separate from the compose step for the same reason as in the compatibility
 * benchmark: the image is pinned and small, the weights are neither, and a
 * failure here has to name the model rather than surface as a request timeout
 * on the first warm-up call.
 */
async function ensureModelPulled() {
  const pullUrl = new URL(OLLAMA_URL);
  pullUrl.pathname = "/api/pull";
  pullUrl.search = "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPT.pullTimeoutMs);
  try {
    const response = await fetch(pullUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: OPT.model, stream: true }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`pull of ${OPT.model} failed with HTTP ${response.status}`);
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
        if (parsed.error) throw new Error(`pull of ${OPT.model} failed: ${parsed.error}`);
        if (typeof parsed.status === "string" && parsed.status !== lastStatus) {
          lastStatus = parsed.status;
          console.log(`pull ${OPT.model}: ${parsed.status}`);
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

async function configurePools(grantTtlMs, { allowCreate }) {
  for (const arm of MANAGED_ARMS) {
    const spec = contentionPoolDefinition(arm.pool, grantTtlMs, { lending: arm.lending });
    const { name, ...body } = spec;
    const update = await jsonRequest(`${LATCHFLO}/v1/pools/${name}`, {
      method: "PUT",
      body,
      allowed: [200, 404, 405],
    });
    if (update.status === 200) continue;
    if (!allowCreate) throw new Error(`Latchflo could not update pool ${name}`);
    await jsonRequest(`${LATCHFLO}/v1/pools`, { method: "POST", body: spec, allowed: [200, 201] });
  }
}

async function waitForAgents() {
  const deadline = Date.now() + 60_000;
  let seen = 0;
  while (Date.now() < deadline) {
    const response = await jsonRequest(`${LATCHFLO}/v1/agents`);
    const agents = Array.isArray(response.body?.agents) ? response.body.agents : [];
    seen = agents.length;
    if (agents.length >= MANAGED_ARMS.length) {
      for (const agent of agents) {
        // A Tyr that cannot report per-class demand cannot participate in
        // lending, and a run that discovered that after measuring five seeds
        // would have measured a static partition and called it adaptive.
        for (const capability of [
          "admissionClasses",
          "admissionClassDemand",
          "admissionClassOccupancyAck",
        ]) {
          if (agent?.capabilities?.[capability] !== true) {
            throw new Error(
              `${agent.instanceId ?? "unknown agent"} did not advertise the ${capability} capability`,
            );
          }
        }
      }
      return agents;
    }
    await sleep(500);
  }
  throw new Error(`Latchflo saw only ${seen}/${MANAGED_ARMS.length} Tyr agents`);
}

async function readPoolStats(arm) {
  const response = await fetchWithTimeout(
    `http://127.0.0.1:${arm.port}/stats`,
    { headers: { "x-tyr-identity-token": `Bearer ${identity.tokens.operator}` } },
    3_000,
  );
  if (!response.ok) throw new Error(`Tyr ${arm.id} /stats returned HTTP ${response.status}`);
  const body = await response.json();
  const pool = body?.[arm.pool];
  if (pool === undefined) throw new Error(`Tyr ${arm.id} /stats has no ${arm.pool} pool`);
  return pool;
}

/** Latchflo's own view of per-class demand and what it has released. */
async function readControllerDemand(arm) {
  if (!arm.lending) return null;
  const response = await jsonRequest(
    `${LATCHFLO}/v1/admission-class-demand?pool=${encodeURIComponent(arm.pool)}`,
    { allowed: [200, 404] },
  ).catch(() => null);
  return response?.body?.status ?? null;
}

/**
 * One observation of an arm's applied capacity.
 *
 * Deliberately merges two sources. Tyr's `/stats` is the authority on what the
 * data plane is actually enforcing; Latchflo's demand endpoint is the only
 * place the controller's own intent — what it released, whether a restoration
 * is pending, whether it thinks a class is idle — is visible. A summary built
 * from either alone can describe a lending episode that the other end never
 * agreed happened.
 */
async function sampleArm(arm, startedAt) {
  const [pool, controller] = await Promise.all([readPoolStats(arm), readControllerDemand(arm)]);
  const controllerClasses = new Map(
    (controller?.classes ?? []).map((entry) => [entry?.admissionClass, entry]),
  );
  const classes = Object.fromEntries(
    Object.entries(pool?.admissionClasses?.classes ?? {}).map(([id, value]) => {
      const demand = controllerClasses.get(id);
      return [
        id,
        {
          limits: {
            protectedConcurrent: Number(value?.limits?.protectedConcurrent ?? 0),
            maxConcurrent: Number(value?.limits?.maxConcurrent ?? 0),
            protectedInFlightTokens: Number(value?.limits?.protectedInFlightTokens ?? 0),
            maxInFlightTokens: Number(value?.limits?.maxInFlightTokens ?? 0),
          },
          inFlight: Number(value?.inFlight ?? 0),
          inFlightTokens: Number(value?.inFlightTokens ?? 0),
          protectedConcurrentInUse: Number(value?.protectedConcurrentInUse ?? 0),
          borrowedConcurrent: Number(value?.borrowedConcurrent ?? 0),
          borrowedInFlightTokens: Number(value?.borrowedInFlightTokens ?? 0),
          admitted: Number(value?.admitted ?? 0),
          rejected: Number(value?.rejected ?? 0),
          demandState: demand?.demand?.state ?? null,
          recentAdmissions: Number(demand?.demand?.recentAdmissions ?? 0),
          recentRejections: Number(demand?.demand?.recentRejections ?? 0),
          releasedConcurrent: Number(demand?.released?.protectedConcurrent ?? 0),
          releasedTokens: Number(demand?.released?.protectedInFlightTokens ?? 0),
          restorationPending: demand?.restorationPending === true,
        },
      ];
    }),
  );
  return {
    offsetMs: +(Date.now() - startedAt),
    pool: {
      maxConcurrent: Number(pool?.limits?.maxConcurrent ?? 0),
      tokenBudget: Number(pool?.tokenBudget?.budget ?? 0),
      inFlight: Number(pool?.bulkhead?.inFlight ?? pool?.llm?.inFlight ?? 0),
      sharedMaxConcurrent: Number(pool?.admissionClasses?.shared?.maxConcurrent ?? 0),
    },
    classes,
  };
}

/** Background sampler; resolves to the collected series when stopped. */
function startSampler(arm, startedAt) {
  const samples = [];
  const errors = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      try {
        samples.push(await sampleArm(arm, startedAt));
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
      await sleep(CONTENTION_POLICY.lending.observeIntervalMs);
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
      return { samples, errors };
    },
  };
}

/** Applied ceilings equal to nominal on every class. Floors legitimately vary. */
function ceilingsAreNominal(sample) {
  const nominal = nominalClassGrant();
  return Object.entries(nominal).every(([id, expected]) => {
    const applied = sample?.classes?.[id]?.limits;
    return (
      applied !== undefined &&
      applied.maxConcurrent === expected.maxConcurrent &&
      applied.maxInFlightTokens === expected.maxInFlightTokens
    );
  });
}

/**
 * Waits until an arm holds a grant it can actually admit against.
 *
 * Deliberately not "waits for the nominal partition". Under the lending policy
 * the resting state with both classes idle is both floors released, not the
 * nominal split, so demanding nominal here would hang until something happened
 * to make a class demanding — and the thing that would eventually satisfy it is
 * the warm-up traffic, which is exactly what must not be shaped by the
 * precondition.
 *
 * What must hold is that the pool has capacity and that no ceiling has drifted:
 * lending moves floors between classes and may never raise a ceiling. The
 * starting floors are recorded per arm instead of being required, because they
 * are an observation about the control plane rather than a knob this benchmark
 * is entitled to set.
 */
async function waitForUsableGrant(arm, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await sampleArm(arm, Date.now()).catch(() => null);
    if (last !== null && last.pool.maxConcurrent >= 1 && ceilingsAreNominal(last)) return last;
    await sleep(250);
  }
  throw new Error(
    `${arm.id} did not reach a usable grant with nominal ceilings within ${timeoutMs}ms: ` +
      JSON.stringify(last?.classes ?? null),
  );
}

/**
 * Establishes a clean measured start state after warm-up.
 *
 * Warm-up intentionally finishes with interactive traffic. The lending arm may
 * have released that floor earlier while interactive was idle, so merely
 * waiting for any usable grant can start the measured trace with
 * `protectedConcurrent: 0`. The experiment claims a nominal protected floor at
 * t=0, therefore measurement does not start until Tyr is actually enforcing it.
 */
async function waitForInteractiveFloor(arm, timeoutMs = 60_000) {
  if (!arm.managed) return null;
  const nominal = nominalClassGrant().interactive;
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await sampleArm(arm, Date.now()).catch(() => null);
    const interactive = last?.classes?.interactive?.limits;
    if (
      last !== null &&
      last.pool.maxConcurrent >= 1 &&
      ceilingsAreNominal(last) &&
      Number(interactive?.protectedConcurrent ?? 0) >= nominal.protectedConcurrent &&
      Number(interactive?.protectedInFlightTokens ?? 0) >= nominal.protectedInFlightTokens
    ) {
      return last;
    }
    await sleep(250);
  }
  throw new Error(
    `${arm.id} did not restore the nominal interactive floor before measurement within ${timeoutMs}ms: ` +
      JSON.stringify(last?.classes?.interactive ?? null),
  );
}

// ── warm-up ──────────────────────────────────────────────────────────

const FILLER = "The quick brown fox jumps over the lazy dog. ";
function warmupPrompt(chars) {
  let text = "";
  while (text.length < chars) text += FILLER;
  return text.slice(0, chars);
}

/**
 * Requests issued before the measured trace and never recorded in it.
 *
 * Three separate costs are paid here rather than by the first measured request:
 * loading the weights, filling Ollama's prompt-prefix cache for both request
 * shapes, and giving Tyr's adaptive estimator its `minSamples` observations so
 * the pool stops reserving against an untuned GPT-4o proxy. Sequential on
 * purpose — a warm-up that itself contends would be measuring the thing it
 * exists to remove.
 */
/**
 * Everything a warm-up failure has to be able to say, and nothing it may.
 *
 * 0.33.2's five-seed sweep died in seed 5 on `moflux warm-up could not complete
 * batch 1/5 (last HTTP 401)` and that string is the whole of what it recorded.
 * It named neither the credential, nor its age, nor what the server said, so
 * the failure was indistinguishable between an expired benchmark token, a Tyr
 * that had lost its JWKS, a control plane that had rotated its agent identity,
 * and a genuine authorization bug — and the sweep had to be re-run to find out.
 * It was in fact the first: the fixture minted once at t=0 with a one-hour
 * expiry, and seed 5's warm-up ran at 64 minutes.
 *
 * The token is never included. A fingerprint and an expiry answer every
 * question a diagnostic needs to ask about a credential, and a benchmark
 * summary is a publishable artifact.
 */
function warmupDiagnostic({
  seed,
  arm,
  workload,
  index,
  attempt,
  status,
  body,
  error,
  identityName,
  credentialBefore,
  credentialRefreshed,
  elapsedBenchmarkMs,
  latencyMs,
}) {
  return {
    seed,
    arm: arm.id,
    pool: arm.pool,
    workloadClass: workload,
    warmupRequestIndex: index + 1,
    warmupRequestsPerClass: OPT.warmupRequestsPerClass,
    attempt,
    httpStatus: status ?? null,
    // Bounded: a provider error body is evidence, an unbounded one is a log bomb.
    responseBody: typeof body === "string" && body.length > 0 ? body.slice(0, 500) : null,
    transportError: error ?? null,
    authTokenPresent: arm.managed,
    identity: identityName,
    credential: credentialBefore,
    credentialRefreshedForThisAttempt: credentialRefreshed === true,
    elapsedBenchmarkMs: Math.round(elapsedBenchmarkMs),
    latencyMs: latencyMs ?? null,
  };
}

async function warmupRequest(arm, seed, workload, index, { attempt = 1, refreshed = false } = {}) {
  const url = ARM_URLS[arm.id];
  const isBatch = workload === "batch";
  const identityName = isBatch ? "noisy" : "premium";
  // Read through the accessor at request time. The fixture re-mints when a
  // token is approaching expiry, which is what a sweep longer than one token
  // lifetime needs and what 0.33.2 did not have.
  const bearer = arm.managed ? identity.tokens[identityName] : null;
  const credentialBefore = arm.managed ? identity.credentialState(identityName) : null;
  const startedAt = performance.now();
  let response;
  try {
    response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(arm.managed ? { "x-tyr-identity-token": `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(
      buildLocalChatBody({
        model: OPT.model,
        prompt: warmupPrompt(
          isBatch ? WORKLOAD.batchInputChars : WORKLOAD.interactiveInputChars,
        ),
        maxOutputTokens: isBatch ? WORKLOAD.batchMaxTokens : WORKLOAD.interactiveMaxTokens,
        seed: 10_000 + seed * 100 + index,
        stream: true,
      }),
    ),
    });
  } catch (error) {
    return {
      arm: arm.id,
      workload,
      index,
      status: null,
      ok: false,
      latencyMs: +(performance.now() - startedAt).toFixed(1),
      promptTokens: null,
      completionTokens: null,
      diagnostic: warmupDiagnostic({
        seed,
        arm,
        workload,
        index,
        attempt,
        status: null,
        body: null,
        error: error instanceof Error ? error.message : String(error),
        identityName,
        credentialBefore,
        credentialRefreshed: refreshed,
        elapsedBenchmarkMs: performance.now() - BENCHMARK_STARTED_AT,
        latencyMs: +(performance.now() - startedAt).toFixed(1),
      }),
    };
  }
  let usage = null;
  let chars = 0;
  let failureBody = null;
  if (response.ok && response.body) {
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
          chars += observed.text.length;
          if (observed.usage) usage = observed.usage;
        }
      }
    }
  } else if (!response.ok) {
    // Kept rather than discarded: the body is where Tyr says whether the token
    // was expired, unverifiable, or simply not entitled to the pool.
    failureBody = await response.text().catch(() => "");
  }
  const ok = response.ok && chars > 0;
  const latencyMs = +(performance.now() - startedAt).toFixed(1);
  return {
    arm: arm.id,
    workload,
    index,
    status: response.status,
    ok,
    latencyMs,
    promptTokens: usage?.input ?? null,
    completionTokens: usage?.output ?? null,
    diagnostic: ok
      ? null
      : warmupDiagnostic({
          seed,
          arm,
          workload,
          index,
          attempt,
          status: response.status,
          body:
            failureBody ??
            (response.ok ? "streamed 0 characters with HTTP 200" : null),
          error: null,
          identityName,
          credentialBefore,
          credentialRefreshed: refreshed,
          elapsedBenchmarkMs: performance.now() - BENCHMARK_STARTED_AT,
          latencyMs,
        }),
  };
}

/**
 * Every warm-up attempt that did not succeed, across the whole sweep.
 *
 * Carried into the summary whether or not the run went on to finish, because a
 * sweep that recovered from an authentication failure and one that never had
 * one are different runs and the evidence has to say which this was.
 */
const warmupDiagnostics = [];

async function warmupArm(arm, seed) {
  const results = [];
  // Interactive runs last so the adaptive arm enters the measured trace with
  // its owner visibly demanding the floor rather than inheriting a batch-last
  // warm-up state that has already released it.
  for (const workload of ["batch", "interactive"]) {
    for (let index = 0; index < OPT.warmupRequestsPerClass; index += 1) {
      let result = null;
      let refreshed = false;
      for (let attempt = 1; attempt <= 8; attempt += 1) {
        result = await warmupRequest(arm, seed, workload, index, { attempt, refreshed });
        if (result.ok) {
          results.push({ ...result, attempts: attempt, credentialRefreshed: refreshed });
          break;
        }
        if (result.diagnostic) warmupDiagnostics.push(result.diagnostic);
        // A managed arm can land exactly in the deliberate grant-expiry gap.
        // Warm-up is a precondition, not offered load, so retry that local 429
        // after a usable grant rather than letting lease timing decide whether
        // the experiment starts.
        if (arm.managed && result.status === 429 && attempt < 8) {
          await waitForUsableGrant(arm);
          await sleep(250);
          continue;
        }
        // A 401 is retried exactly once, and only after forcing a new
        // credential, so the retry is a hypothesis being tested rather than a
        // loop that papers over the failure: if a freshly minted token is also
        // refused, the problem is not credential lifetime and the run must say
        // so rather than keep trying. Both attempts are already recorded.
        if (arm.managed && (result.status === 401 || result.status === 403) && !refreshed) {
          const before = identity.credentialState(
            workload === "batch" ? "noisy" : "premium",
          );
          const after = identity.refresh(
            workload === "batch" ? "noisy" : "premium",
            `http-${result.status}-during-warmup`,
          );
          console.warn(
            `${arm.id} warm-up ${workload} ${index + 1} got HTTP ${result.status}; ` +
              `credential ${before.fingerprint} (expired=${before.expired}) replaced by ` +
              `${after.fingerprint}, retrying once`,
          );
          refreshed = true;
          continue;
        }
        break;
      }
      if (!result?.ok) {
        const diagnostic = result?.diagnostic ?? null;
        throw new Error(
          `${arm.id} warm-up could not complete ${workload} ${index + 1}/${OPT.warmupRequestsPerClass} ` +
            `(last HTTP ${result?.status ?? "unknown"})\n` +
            `warm-up diagnostic: ${JSON.stringify(diagnostic, null, 2)}`,
        );
      }
    }
  }
  return results;
}

// ── one measured arm ─────────────────────────────────────────────────

function runLoadgen({ seed, arm, traceFile, outFile }) {
  rmSync(outFile, { force: true });
  const diagnosticsFile = outFile.replace(/\.json$/u, ".loadgen.log");
  rmSync(diagnosticsFile, { force: true });
  const target = `http://127.0.0.1:${arm.port}`;
  const child = launchNode("loadgen", "load/loadgen.mjs", [
    `--targets=${target}`,
    `--interactive-targets=${target}`,
    `--batch-targets=${target}`,
    `--interactive-model=${OPT.model}`,
    `--batch-model=${OPT.model}`,
    // The direct arm has nothing to authenticate to, so it is sent no identity.
    // Ollama would ignore the header, but a benchmark that sends a credential
    // to a server with no notion of one is describing a topology it does not have.
    ...(arm.managed
      ? [
          `--interactive-identity-token=${identity.tokens.premium}`,
          `--batch-identity-token=${identity.tokens.noisy}`,
        ]
      : []),
    `--arm-label=local-contention-${arm.id}`,
    "--provider-api=openai",
    `--duration-ms=${WORKLOAD.durationMs}`,
    `--seed=${seed}`,
    `--interactive-rps=${WORKLOAD.interactiveRps}`,
    `--interactive-start-ms=${WORKLOAD.interactiveStartMs}`,
    `--interactive-duration-ms=${WORKLOAD.interactiveDurationMs}`,
    `--interactive-input-chars=${WORKLOAD.interactiveInputChars}`,
    `--interactive-max-tokens=${WORKLOAD.interactiveMaxTokens}`,
    `--interactive-resume-start-ms=${WORKLOAD.interactiveResumeStartMs}`,
    `--interactive-resume-duration-ms=${WORKLOAD.interactiveResumeDurationMs}`,
    `--interactive-resume-rps=${WORKLOAD.interactiveResumeRps}`,
    `--batch-start-ms=${WORKLOAD.batchStartMs}`,
    `--batch-duration-ms=${WORKLOAD.batchDurationMs}`,
    `--batch-rps=${WORKLOAD.batchRps}`,
    `--batch-input-chars=${WORKLOAD.batchInputChars}`,
    `--batch-max-tokens=${WORKLOAD.batchMaxTokens}`,
    `--max-attempts=${WORKLOAD.maxAttempts}`,
    `--backoff-base-ms=${WORKLOAD.backoffBaseMs}`,
    `--size-distribution=${WORKLOAD.sizeDistribution}`,
    `--interactive-size-sigma=${WORKLOAD.interactiveSizeSigma}`,
    `--batch-size-sigma=${WORKLOAD.batchSizeSigma}`,
    `--in-flight-ceiling=${WORKLOAD.inFlightCeiling}`,
    `--window-ms=${WORKLOAD.windowMs}`,
    `--temperature=${WORKLOAD.temperature}`,
    // Whole-run TTFT and latency distributions are computed from these; the
    // pre-cut phase windows alone cannot produce a per-class p95 over the run.
    "--emit-phase-samples=true",
    `--drain-idle-ms=${WORKLOAD.drainIdleMs}`,
    `--drain-max-ms=${WORKLOAD.drainMaxMs}`,
    `--trace-file=${traceFile}`,
    "--metrics-port=0",
    `--out=${outFile}`,
  ], { logFile: diagnosticsFile });
  return new Promise((resolve, reject) => {
    child.once("close", (code, signal) => {
      if (code !== 0) {
        const persisted = repoRelative(diagnosticsFile, ROOT);
        const logError = child.outputLogError ? `; diagnostic log error: ${child.outputLogError}` : "";
        reject(
          new Error(
            `load generator failed for ${arm.id} (${signal ?? `exit ${code}`})` +
              `${childOutputTail(child)}; full output: ${persisted}${logError}`,
          ),
        );
        return;
      }
      if (!existsSync(outFile)) {
        reject(new Error(`load generator did not write ${outFile}`));
        return;
      }
      resolve(JSON.parse(readFileSync(outFile, "utf8")));
    });
  });
}

/**
 * Control-plane evidence for one lending arm, collected after its measured run.
 *
 * Three independent sources, deliberately, exactly as the restoration ladder
 * does it: Tyr says what it enforced, Latchflo says what it withheld and
 * whether each resource met its objective, and the load generator says what the
 * caller lost. A verdict from the controller alone would report a restoration
 * without ever pricing it.
 */
async function collectControlPlaneEvidence(arm, loadgenSummary, startedAtMs) {
  const statsByPool = { [arm.pool]: await readPoolStats(arm) };
  const metrics = await fetchWithTimeout(
    `${LATCHFLO}/metrics`,
    { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } },
    5_000,
  ).then(
    (response) => (response.ok ? response.text() : ""),
    () => "",
  );
  const episodesResponse = await jsonRequest(
    `${LATCHFLO}/v1/restoration-episodes?protectedPool=${encodeURIComponent(arm.pool)}&limit=500`,
    { allowed: [200, 404] },
  ).catch(() => null);
  const eventsResponse = await jsonRequest(`${LATCHFLO}/v1/events?limit=500`, {
    allowed: [200, 404],
  }).catch(() => null);
  const events = (Array.isArray(eventsResponse?.body?.events) ? eventsResponse.body.events : [])
    .filter((event) => {
      const at = Date.parse(String(event?.createdAt ?? ""));
      return !Number.isFinite(at) || at >= startedAtMs;
    });

  return {
    pool: arm.pool,
    restorationClaim: contentionRestorationClaim(arm.id),
    tyrRestoration: summarizeTyrRestoration({ statsByPool, tyrVersion: TYR_VERSION }),
    latchfloEpisodes: summarizeLatchfloRestorationEpisodes({
      episodes: Array.isArray(episodesResponse?.body?.restorationEpisodes)
        ? episodesResponse.body.restorationEpisodes
        : [],
      latchfloVersion: LATCHFLO_VERSION,
    }),
    // Scoped to this arm's own pool: one Latchflo serves both managed arms and
    // an unscoped scrape would credit this arm with the other's withheld tokens.
    unlentGauges: summarizeUnlentFloorGauges({
      metricsTexts: [metrics],
      latchfloVersion: LATCHFLO_VERSION,
      pools: [arm.pool],
    }),
    deadlineCost: summarizeBorrowedDeadlineCost(loadgenSummary),
    handoff: summarizeClassHandoffSafety(events, arm.pool),
  };
}

// ── run ──────────────────────────────────────────────────────────────

let identity = null;
let stackStarted = false;
let caughtError;
const rows = [];

try {
  assertDockerAvailable();
  spawnSync("openssl", ["version"], { encoding: "utf8" });

  await assertHostPortFree(CONTENTION_IDENTITY_PORT, { label: "identity fixture" });
  // The fixture re-mints on access rather than handing out one token for the
  // life of the process. A five-seed sweep takes over an hour and 0.33.2's did
  // not finish because of exactly that: see identity-fixture-lib.mjs.
  identity = await startIdentityFixture(IDENTITY_RUNTIME, { port: CONTENTION_IDENTITY_PORT });

  if (OPT.doctor) {
    console.log(
      `PASS  local contention prerequisites (Tyr ${TYR_VERSION}, Latchflo ${LATCHFLO_VERSION}, ` +
        `Ollama ${OLLAMA_VERSION}, model ${OPT.model})`,
    );
  } else {
    ensureDemoEnv(ENV_FILE, { quiet: true });
    env = { ...parseEnvFile(ENV_FILE), ...process.env };
    ADMIN_TOKEN = env.LATCHFLO_ADMIN_TOKEN ?? null;
    if (!env.MOFLUX_TYR_IMAGE) throw new Error("MOFLUX_TYR_IMAGE is not configured");
    if (!env.MOFLUX_LATCHFLO_IMAGE) throw new Error("MOFLUX_LATCHFLO_IMAGE is not configured");
    if (!env.MOFLUX_OLLAMA_IMAGE) throw new Error("MOFLUX_OLLAMA_IMAGE is not configured");
    if (!ADMIN_TOKEN) throw new Error("LATCHFLO_ADMIN_TOKEN is not configured");

    mkdirSync(runOutputDir, { recursive: true });

    stackStarted = true;
    // The weights volume is declared external precisely so the teardown below
    // can take `--volumes` — a clean control plane every run, with no grant,
    // agent token, or pool row inherited — without collecting half a gigabyte
    // of weights along with it. Creating it here is idempotent.
    spawnSync("docker", ["volume", "create", OLLAMA_MODELS_VOLUME], { encoding: "utf8" });
    compose(["down", "--volumes", "--remove-orphans"], { allowFailure: true });
    compose(["up", "-d", "--force-recreate", "--wait", "ollama", "latchflo"], { inherit: true });
    await waitFor(`${LATCHFLO}/readyz`, { timeoutMs: 60_000, label: "Latchflo readiness" });
    if (OPT.pullModel) await ensureModelPulled();

    // Enrollment uses a short TTL so a stale grant from a previous run expires
    // rather than being inherited, then the steady TTL is applied once the
    // agents are known to be present.
    await configurePools(CONTENTION_POLICY.lending.enrollmentTtlMs, { allowCreate: true });
    compose(["up", "-d", "--force-recreate", ...MANAGED_ARMS.map((arm) => `tyr-${arm.id}`)], {
      inherit: true,
    });
    for (const arm of MANAGED_ARMS) {
      await waitFor(`http://127.0.0.1:${arm.port}/healthz`, {
        timeoutMs: 60_000,
        label: `Tyr ${arm.id} health`,
      });
    }
    await waitForAgents();
    await configurePools(CONTENTION_POLICY.lending.grantTtlMs, { allowCreate: false });
    for (const arm of MANAGED_ARMS) {
      await jsonRequest(`${LATCHFLO}/v1/pools/${arm.pool}/rebalance`, {
        method: "POST",
        allowed: [200, 202],
      });
    }
    for (const arm of MANAGED_ARMS) {
      await waitFor(`http://127.0.0.1:${arm.port}/readyz`, {
        timeoutMs: 60_000,
        label: `Tyr ${arm.id} readiness`,
      });
      await waitForUsableGrant(arm);
    }
    console.log(`stack ready: ${OPT.arms.join(", ")}`);

    for (const [index, seed] of OPT.seeds.entries()) {
      const order = ORDER_PLAN[index].order;
      const trace = buildTrace({ ...WORKLOAD, seed });
      const traceFile = path.join(runOutputDir, `trace-seed-${seed}.json`);
      writeFileSync(traceFile, `${JSON.stringify(trace, null, 2)}\n`);

      const arms = {};
      const evidence = {};
      for (const armId of order) {
        const arm = contentionArm(armId);
        console.log(`\nseed ${seed} arm ${armId}: warm-up (${OPT.warmupRequestsPerClass}/class)`);
        const warmup = await warmupArm(arm, seed);
        // Measurement starts from the nominal interactive floor. This prevents
        // warm-up ordering from becoming a hidden fourth arm variable.
        const startingGrant = arm.managed ? await waitForInteractiveFloor(arm) : null;

        const startedAt = Date.now();
        const sampler = arm.managed ? startSampler(arm, startedAt) : null;
        console.log(`seed ${seed} arm ${armId}: measured run`);
        const loadgenSummary = await runLoadgen({
          seed,
          arm,
          traceFile,
          outFile: path.join(runOutputDir, `${armId}-seed-${seed}.json`),
        });
        // Sampling continues past the offered-load window: a floor lent late in
        // the run may only come back during the drain, and stopping at the last
        // arrival would record that as a floor that never returned.
        if (arm.managed) await sleep(CONTENTION_POLICY.lending.postRunObserveMs);
        const sampled = sampler === null ? { samples: [], errors: [] } : await sampler.stop();

        arms[armId] = {
          arm: armId,
          managed: arm.managed,
          pool: arm.pool,
          trace: { hash: loadgenSummary?.trace?.hash ?? trace.hash },
          startingGrant: startingGrant?.classes ?? null,
          warmup: {
            requestsPerClass: OPT.warmupRequestsPerClass,
            requests: warmup.length,
            excludedFromMeasurement: true,
            latencyMsMedian: median(warmup.map((entry) => entry.latencyMs)),
          },
          classes: summarizeArmClasses(loadgenSummary),
          bindingConstraint: {
            interactive: loadgenSummary?.classes?.interactive?.bindingConstraint ?? null,
            batch: loadgenSummary?.classes?.batch?.bindingConstraint ?? null,
          },
          generatorSaturated: loadgenSummary?.generatorSaturated ?? 0,
          samples: sampled.samples.length,
          sampleErrors: sampled.errors.length,
        };

        if (arm.managed) {
          const invariants = capacityInvariantViolations(sampled.samples);
          const lending = summarizeLendingEpisodes(sampled.samples);
          const controlPlane = await collectControlPlaneEvidence(arm, loadgenSummary, startedAt);
          // The cross-source timeline of the 60 s demand return, reconciled
          // onto the sampler's clock. This is what makes the run diagnosable
          // from the summary rather than from a 600 KB per-seed capacity file.
          const demandReturn = summarizeDemandTransitions({
            samples: sampled.samples,
            trace,
            loadgenSummary,
            workload: WORKLOAD,
            startedAtEpochMs: startedAt,
          });
          const criticalWindow = criticalWindowDigest(sampled.samples, {
            fromMs: WORKLOAD.interactiveResumeStartMs - 10_000,
            toMs: WORKLOAD.interactiveResumeStartMs + 10_000,
          });
          // `demandTransitions` is lifted out of `invariants` rather than
          // copied: it is evidence about demand rather than a violation list,
          // and carrying it twice would roughly double the summary for no
          // additional information.
          const { demandTransitions, ...invariantViolations } = invariants;
          evidence[armId] = {
            invariants: invariantViolations,
            demandTransitions,
            lending,
            demandReturn,
            criticalWindow,
            ...controlPlane,
          };
          writeFileSync(
            path.join(runOutputDir, `${armId}-capacity-seed-${seed}.json`),
            `${JSON.stringify({ seed, arm: armId, samples: sampled.samples, invariants, lending, demandReturn, criticalWindow, controlPlane }, null, 2)}\n`,
          );
        }

        const classes = arms[armId].classes;
        console.log(
          `seed ${seed} arm ${armId}: interactive ${classes.interactive.success}/${classes.interactive.logical} ` +
            `(ttft p95 ${classes.interactive.ttftMs.p95 ?? "no samples"}${classes.interactive.ttftMs.p95 === null ? "" : "ms"}), ` +
            `batch ${classes.batch.success}/${classes.batch.logical}, ` +
            `rejections ${classes.interactive.rejectedAdmissions + classes.batch.rejectedAdmissions}`,
        );
        if (OPT.pauseMs > 0) await sleep(OPT.pauseMs);
      }

      const comparison = compareLocalContention(arms);
      const mofluxEvidence = evidence.moflux ?? {
        invariants: capacityInvariantViolations([]),
        lending: summarizeLendingEpisodes([]),
        handoff: summarizeClassHandoffSafety([], "local-moflux"),
      };
      const proof = localContentionSeedProof({
        comparison,
        arms,
        lending: mofluxEvidence.lending,
        invariants: mofluxEvidence.invariants,
        handoff: mofluxEvidence.handoff,
        warmupRequestsPerClass: OPT.warmupRequestsPerClass,
      });
      const row = { seed, order, comparison, arms, evidence, proof };
      rows.push(row);
      writeFileSync(
        path.join(runOutputDir, `comparison-seed-${seed}.json`),
        `${JSON.stringify(row, null, 2)}\n`,
      );
      console.log(
        `seed ${seed}: interactive contention ttft p95 ratio ${comparison.interactiveTtftP95RatioVsDirect} ` +
          `(moflux/direct), batch borrow ratio ${comparison.batchBorrowWindowRatioVsStatic} (moflux/static), ` +
          `lend=${mofluxEvidence.lending.lendingEpisodes} needRestore=${mofluxEvidence.lending.restorationRequiredEpisodes} ` +
          `restored=${mofluxEvidence.lending.restorationEpisodes} ` +
          `occupancyRestoreMs=${mofluxEvidence.lending.occupancyRestorationLatencyMsMedian}, ` +
          `seed proof=${proof.passed ? "pass" : "FAIL"}`,
      );
      if (!proof.passed) {
        for (const failure of proof.failed) {
          console.warn(`  gate ${failure.gate}: observed ${JSON.stringify(failure.observed)} vs ${JSON.stringify(failure.threshold)} — ${failure.reason}`);
        }
      }
    }
  }
} catch (error) {
  caughtError = error instanceof Error ? error : new Error(String(error));
  console.error(`\n${caughtError.message}`);
} finally {
  await stopHostChildren();
  if (identity) await identity.close().catch(() => {});
  if (stackStarted && !OPT.keepStack) {
    compose(["down", "--volumes", "--remove-orphans"], { allowFailure: true });
  }
  if (!OPT.keepStack) rmSync(IDENTITY_RUNTIME, { recursive: true, force: true });
}

if (OPT.doctor) {
  process.exitCode = caughtError ? 1 : 0;
} else {
  const proof = localContentionProof({
    seeds: rows.map((row) => row.seed),
    seedProofs: rows.map((row) => row.proof),
    comparisons: rows.map((row) => row.comparison),
    requiredSeeds: Math.min(OPT.seeds.length, PUBLICATION_SEED_COUNT),
  });

  const armAggregate = Object.fromEntries(
    OPT.arms.map((armId) => [
      armId,
      Object.fromEntries(
        ["interactive", "batch"].map((workload) => [
          workload,
          aggregateArmClass(
            rows.map((row) => row.arms[armId]?.classes?.[workload]).filter(Boolean),
          ),
        ]),
      ),
    ]),
  );

  const lendingRows = rows.map((row) => row.evidence?.moflux?.lending).filter(Boolean);
  const summary = {
    schemaVersion: 1,
    benchmark: LOCAL_CONTENTION_SWEEP_NAME,
    generatedAt: new Date().toISOString(),
    question:
      "When interactive and batch requests contend for one self-hosted inference server, does " +
      "MoFlux preserve interactive service while still letting batch use otherwise-idle capacity?",
    runtime: {
      mofluxBench: JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version,
      tyr: TYR_VERSION,
      latchflo: LATCHFLO_VERSION,
      asyncBulkheadLlm: ASYNC_BULKHEAD_LLM_VERSION,
      asyncBulkheadTs: ASYNC_BULKHEAD_TS_VERSION,
      ollama: OLLAMA_VERSION,
      model: OPT.model,
      node: process.version,
      openaiApi: "chat-completions",
      endpoint: CONTENTION_ENDPOINT,
    },
    locality: {
      guard: "non-overridable",
      checkedEndpoints: Object.values(ARM_URLS).map((url) => new URL(url).host),
      meteredProviderReachable: false,
      providerCredentialSent: false,
      note:
        "This benchmark has no spend guard because no upstream it is permitted to reach can bill. " +
        "Every arm endpoint, the Ollama upstream, and the control plane are checked against the " +
        "locality rule before the first request, and no flag disables the check.",
    },
    experiment: {
      arms: OPT.arms,
      armDescriptions: Object.fromEntries(
        OPT.arms.map((id) => [id, contentionArm(id).summary]),
      ),
      seeds: OPT.seeds,
      armOrder: ORDER_PLAN,
      counterbalanced: armOrderIsCounterbalanced(ORDER_PLAN, OPT.arms),
      publicationSeedCount: OPT.seeds.length >= PUBLICATION_SEED_COUNT,
      workload: WORKLOAD,
      phases: [
        { name: "warm-up", measured: false, note: `${OPT.warmupRequestsPerClass} requests per class per arm, excluded from every distribution` },
        { name: "interactive-with-spare-capacity", fromMs: 0, toMs: WORKLOAD.batchStartMs },
        { name: "batch-uses-idle-capacity", fromMs: WORKLOAD.batchStartMs, toMs: WORKLOAD.interactiveResumeStartMs },
        { name: "interactive-contention", fromMs: WORKLOAD.interactiveResumeStartMs, toMs: WORKLOAD.batchStartMs + WORKLOAD.batchDurationMs },
        { name: "recovery-drain", fromMs: WORKLOAD.batchStartMs + WORKLOAD.batchDurationMs, toMs: WORKLOAD.durationMs },
      ],
      policy: CONTENTION_POLICY,
      nominalClassGrant: nominalClassGrant(),
      warmupRequestsPerClassPerArm: OPT.warmupRequestsPerClass,
      traceHashes: rows.map((row) => ({ seed: row.seed, hash: row.comparison.traceHash })),
    },
    arms: armAggregate,
    lending: {
      framing: ENFORCEABILITY_FRAMING,
      restorationClaim: contentionRestorationClaim("moflux"),
      /**
       * The measured behaviour of the two directions, restated with the numbers
       * so the asymmetry is not something a reader has to take on trust.
       *
       * Lending waits for a grant issuance and therefore for the lease;
       * restoration takes the acknowledged-handoff path and does not. The short
       * lease this benchmark runs is what makes a lend observable inside a
       * hundred-second run, and `leaseGap` is what that costs.
       */
      grantTtlMs: CONTENTION_POLICY.lending.grantTtlMs,
      mechanism: {
        lend: "deferred to the next grant issuance, which happens only after the current lease expires",
        restore: "accelerated acknowledged handoff; commits without waiting for the lease",
        upstreamReclamation: "not-claimed",
      },
      leaseGap: {
        note:
          "Latchflo issues a replacement grant only after the previous lease has expired, so the " +
          "pool briefly holds no grant and Tyr admits nothing. Both managed arms carry the same " +
          "lease, so this is never a variable between them.",
        sampleShareMedian: median(
          rows
            .map((row) => row.evidence?.moflux?.invariants?.leaseGapShare)
            .filter(Number.isFinite),
        ),
        maxShareAccepted: CONTENTION_POLICY.lending.maxLeaseGapShare,
      },
      handoff: {
        abortedTotal: rows.reduce(
          (sum, row) => sum + (row.evidence?.moflux?.handoff?.aborted ?? 0),
          0,
        ),
        committedTotal: rows.reduce(
          (sum, row) => sum + (row.evidence?.moflux?.handoff?.committed ?? 0),
          0,
        ),
        unsafeTotal: rows.reduce(
          (sum, row) => sum + (row.evidence?.moflux?.handoff?.unsafeHandoffs ?? 0),
          0,
        ),
        note:
          "An aborted handoff is the control plane declining a reallocation whose preconditions " +
          "lapsed. It is the safe outcome and is priced as slower restoration, not counted as unsafe.",
      },
      seedsWithLending: lendingRows.filter((row) => row.lendingEpisodes > 0).length,
      seedsWithRestoration: lendingRows.filter((row) => row.restorationEpisodes > 0).length,
      lendingEpisodesTotal: lendingRows.reduce((sum, row) => sum + row.lendingEpisodes, 0),
      /**
       * The four categories a lending episode can end in, kept apart.
       *
       * 0.33.2 reported eight lending episodes, zero restoration-required
       * episodes and a null restoration latency, which read as "lending never
       * needed restoring" and was an artifact of detecting demand return
       * through admissions the returning class was never granted. These four
       * counts must always sum to `lendingEpisodesTotal`.
       */
      restorationRequiredEpisodesTotal: lendingRows.reduce(
        (sum, row) => sum + row.restorationRequiredEpisodes,
        0,
      ),
      restorationEpisodesTotal: lendingRows.reduce((sum, row) => sum + row.restorationEpisodes, 0),
      unrestoredEpisodesTotal: lendingRows.reduce((sum, row) => sum + row.unrestoredEpisodes, 0),
      /** A floor that came back with nobody asking for it. Not a restoration. */
      passiveReturnEpisodesTotal: lendingRows.reduce(
        (sum, row) => sum + row.passiveReturnEpisodes,
        0,
      ),
      openAtEndOfRunEpisodesTotal: lendingRows.reduce(
        (sum, row) => sum + row.openAtEndOfRunEpisodes,
        0,
      ),
      restorationSloMs: CONTENTION_POLICY.lending.restorationSloMs,
      /** How long the controller took to reissue the grant. */
      restorationLatencyMsMedian: median(
        lendingRows.map((row) => row.restorationLatencyMsMedian).filter(Number.isFinite),
      ),
      restorationSloBreachesTotal: lendingRows.reduce(
        (sum, row) => sum + row.restorationSloBreaches,
        0,
      ),
      /**
       * How long the protected class waited before it could actually use the
       * restored floor. On a non-preemptive policy this is bounded by the
       * borrowers' remaining decode, not by the controller, and quoting only
       * the grant-side number above would price restoration at nothing.
       */
      occupancyRestorationLatencyMsMedian: median(
        lendingRows
          .map((row) => row.occupancyRestorationLatencyMsMedian)
          .filter(Number.isFinite),
      ),
      occupancyRestorationSloBreachesTotal: lendingRows.reduce(
        (sum, row) => sum + row.occupancyRestorationSloBreaches,
        0,
      ),
      restorationLatencyNote:
        "restorationLatencyMsMedian is the grant coming back. " +
        "occupancyRestorationLatencyMsMedian is the protected class being able to use it. " +
        "The two differ by however long the borrowers already in flight take to finish, " +
        "because no arm here preempts an admitted upstream request.",
      /** The cross-source 60 s timeline, per seed, in the sampler's timebase. */
      demandReturn: rows.map((row) => ({
        seed: row.seed,
        ...(row.evidence?.moflux?.demandReturn ?? {}),
      })),
      peakLentConcurrent: lendingRows.reduce(
        (peak, row) => Math.max(peak, row.peakLentConcurrent ?? 0),
        0,
      ),
      peakBorrowedConcurrent: lendingRows.reduce(
        (peak, row) => Math.max(peak, row.peakBorrowedConcurrent ?? 0),
        0,
      ),
      unlentTokensObserved: median(
        rows
          .map((row) => row.evidence?.moflux?.unlentGauges?.totalUnlentTokens)
          .filter(Number.isFinite),
      ),
    },
    comparisons: {
      interactiveTtftP95RatioVsDirectMedian: median(
        rows.map((row) => row.comparison.interactiveTtftP95RatioVsDirect).filter(Number.isFinite),
      ),
      interactiveGoodputRatioVsDirectMedian: median(
        rows.map((row) => row.comparison.interactiveGoodputRatioVsDirect).filter(Number.isFinite),
      ),
      batchBorrowWindowRatioVsStaticMedian: median(
        rows.map((row) => row.comparison.batchBorrowWindowRatioVsStatic).filter(Number.isFinite),
      ),
      perSeed: rows.map((row) => ({ seed: row.seed, ...row.comparison, interactive: undefined, batch: undefined })),
    },
    /**
     * Managed-arm warm-up failures, whether or not the run recovered.
     *
     * Empty is the expected value and is itself evidence. A non-empty list with
     * `credentialRefreshedForThisAttempt` set on the succeeding attempt says
     * the sweep hit a credential problem and recovered from it, which is a
     * different run from one that never hit it, and the summary has to be able
     * to tell them apart.
     */
    diagnostics: {
      managedArmWarmupFailures: warmupDiagnostics,
      warmupFailureCount: warmupDiagnostics.length,
      identityCredentialTtlSeconds: identity?.tokenTtlSeconds ?? null,
      identityCredentialRefreshSkewSeconds: identity?.refreshSkewSeconds ?? null,
      identityCredentials: identity
        ? Object.fromEntries(
            ["premium", "noisy", "operator"].map((name) => [name, identity.credentialState(name)]),
          )
        : null,
      note:
        "Credentials are minted by demo/identity-fixture-lib.mjs and re-minted on access as " +
        "they approach expiry. Fingerprints and expiries are recorded; bearer tokens never are.",
    },
    localContentionProof: proof,
    // Mirrors this benchmark's own proof and nothing else. A shared `passed`
    // across unrelated benchmarks is how a regression in one becomes a silent
    // pass in another; that has happened in this repository before.
    passed: proof.passed,
    evidenceLimits: EVIDENCE_LIMITS,
    results: rows.map((row) => ({
      seed: row.seed,
      order: row.order,
      proof: row.proof,
      arms: row.arms,
      evidence: row.evidence,
    })),
    ...(caughtError ? { error: caughtError.message } : {}),
  };

  mkdirSync(path.dirname(summaryFile), { recursive: true });
  summary.scenarioId = scenarioId({
    workload: WORKLOAD,
    policy: CONTENTION_POLICY,
    seeds: OPT.seeds,
    arms: OPT.arms,
    model: OPT.model,
  });
  writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);

  if (pointerFile) {
    mkdirSync(path.dirname(pointerFile), { recursive: true });
    writeFileSync(
      pointerFile,
      `${JSON.stringify(
        {
          sweep: LOCAL_CONTENTION_SWEEP_NAME,
          runId: OPT.runId,
          generatedAt: summary.generatedAt,
          run: repoRelative(runOutputDir, ROOT),
          summary: repoRelative(summaryFile, ROOT),
        },
        null,
        2,
      )}\n`,
    );
  }

  console.log(`\nLocal contention summary: ${repoRelative(summaryFile, ROOT)}`);
  console.table(
    OPT.arms.map((armId) => ({
      arm: armId,
      interactiveSuccess: `${armAggregate[armId].interactive.successTotal}/${armAggregate[armId].interactive.logicalTotal}`,
      interactiveTtftP95Ms: armAggregate[armId].interactive.contentionWindowTtftP95Ms.median,
      interactiveGoodputRps: armAggregate[armId].interactive.contentionWindowGoodputRps.median,
      batchSuccess: `${armAggregate[armId].batch.successTotal}/${armAggregate[armId].batch.logicalTotal}`,
      batchBorrowCompleted: armAggregate[armId].batch.borrowWindowCompleted.median,
      rejections:
        armAggregate[armId].interactive.rejectedAdmissionsTotal +
        armAggregate[armId].batch.rejectedAdmissionsTotal,
    })),
  );

  if (caughtError) {
    process.exitCode = 1;
  } else if (!proof.passed) {
    console.error("\nlocalContentionProof FAILED:");
    for (const failure of proof.failed) {
      console.error(
        `- ${failure.gate}: observed ${JSON.stringify(failure.observed)}, ` +
          `threshold ${JSON.stringify(failure.threshold)} — ${failure.reason}`,
      );
    }
    if (OPT.requireProof) process.exitCode = 1;
  } else {
    console.log(
      `PASS localContentionProof over ${OPT.seeds.length} seeds against ${OPT.model}; ` +
        "no metered provider was reachable",
    );
    console.log(
      `Promote deliberately with: npm run evidence:publish -- --as=${LOCAL_CONTENTION_SWEEP_NAME}`,
    );
  }
}
