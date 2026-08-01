#!/usr/bin/env node
/**
 * present.mjs — one-command, screen-recording-friendly MoFlux demo.
 *
 * The old narrated runner is intentionally comprehensive. This presenter path
 * is intentionally short: validate the stack, run one uncontrolled baseline,
 * transition to real Tyr + Latchflo, run the same workload, and summarize the
 * business-relevant differences plus token-capacity recovery.
 *
 * Usage:
 *   npm run demo                    # fully automatic five-seed comparison
 *   npm run demo:auto               # same flow with timed transitions
 *   npm run demo:baseline           # no-control workload only
 *   npm run demo:moflux             # MoFlux only
 *   npm run demo:doctor             # prerequisites and wiring only
 *   npm run demo:fault              # MoFlux run with one Tyr container killed
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildTrace } from "../load/trace-lib.mjs";
import { reservationBounds, validateCapacityPlan } from "./capacity-lib.mjs";
import {
  LATCHFLO_VERSION,
  TYR_VERSION,
  ensureDemoEnv,
  imageMatchesVersion,
} from "./env-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS = process.env.MOFLUX_BENCH_RESULTS_DIR
  ? path.resolve(process.env.MOFLUX_BENCH_RESULTS_DIR)
  : path.join(ROOT, "results");
const BASE_COMPOSE = path.join(ROOT, "demo", "compose.yaml");
const MOFLUX_COMPOSE = path.join(ROOT, "demo", "moflux", "compose.yaml");
const ENV_FILE = process.env.MOFLUX_BENCH_ENV_FILE
  ? path.resolve(process.env.MOFLUX_BENCH_ENV_FILE)
  : path.join(ROOT, "demo", "moflux", ".env");
const TYR_PORTS = [8101, 8102, 8103, 8104];
const INTERACTIVE_PORTS = [8101, 8102, 8103, 8104];
const BATCH_PORTS = [8104];
const TYR_SERVICES = ["tyr-r1", "tyr-r2", "tyr-r3", "tyr-r4"];
const POOL_AGENT_COUNTS = Object.freeze({ "sim-interactive": 4, "sim-batch": 1 });
mkdirSync(RESULTS, { recursive: true });
const TRACE_FILE = path.join(RESULTS, "scenario-trace.json");

const rawArgs = new Map();
for (const arg of process.argv.slice(2)) {
  const match = /^--([^=]+)=(.*)$/.exec(arg);
  if (match) rawArgs.set(match[1], match[2]);
  else if (arg.startsWith("--")) rawArgs.set(arg.slice(2), "true");
}
const flag = (name) => rawArgs.get(name) === "true";
const num = (name, fallback) => (rawArgs.has(name) ? Number(rawArgs.get(name)) : fallback);
const str = (name, fallback) => rawArgs.get(name) ?? fallback;

const hasLegacyBatchFloor = rawArgs.has("batch-floor-percent");
const hasBatchConcurrencyPercent = rawArgs.has("batch-concurrency-percent");
const hasBatchConcurrencySlots = rawArgs.has("batch-concurrency-slots");
if (hasBatchConcurrencySlots && (hasLegacyBatchFloor || hasBatchConcurrencyPercent)) {
  throw new Error(
    "--batch-concurrency-slots cannot be combined with --batch-concurrency-percent or --batch-floor-percent",
  );
}
const legacyBatchFloorPercent = hasLegacyBatchFloor ? num("batch-floor-percent", 25) : null;
const configuredBatchConcurrencyPercent = hasBatchConcurrencyPercent
  ? num("batch-concurrency-percent", 0)
  : legacyBatchFloorPercent;
const configuredBatchConcurrencySlots = hasBatchConcurrencySlots
  ? num("batch-concurrency-slots", 1)
  : configuredBatchConcurrencyPercent === null
    ? 1
    : null;
const configuredBatchTokenPercent = rawArgs.has("batch-token-percent")
  ? num("batch-token-percent", 25)
  : legacyBatchFloorPercent ?? 25;

const OPT = Object.freeze({
  mode: str("mode", "compare"), // compare | baseline | moflux | doctor
  step: flag("step"),
  pauseMs: num("pause-ms", 0),
  phaseMs: num("phase-ms", 45000),
  fault: flag("fault"),
  faultAtMs: num("fault-at-ms", 16000),
  keepStack: !flag("cleanup"),
  openGrafana: !flag("no-open"),
  resetState: !flag("reuse-state"),
  envelope: num("envelope", 32),
  tokenBudget: num("token-budget", 40000),
  batchFloorPercent: legacyBatchFloorPercent,
  batchConcurrencySlots: configuredBatchConcurrencySlots,
  batchConcurrencyPercent: configuredBatchConcurrencyPercent,
  batchTokenPercent: configuredBatchTokenPercent,
  grantTtlMs: num("grant-ttl-ms", 120000),
  enrollmentGrantTtlMs: num("enrollment-grant-ttl-ms", 5000),
  seed: num("seed", 7),
  sigma: num("sigma", 0.25),
  kappa: num("kappa", 0),
  r1: num("r1", 400),
});

if (!new Set(["compare", "baseline", "moflux", "doctor"]).has(OPT.mode)) {
  throw new Error(`unsupported --mode=${OPT.mode}; expected compare, baseline, moflux, or doctor`);
}
if (!Number.isFinite(OPT.phaseMs) || OPT.phaseMs < 10000) {
  throw new Error("--phase-ms must be at least 10000");
}
if (OPT.fault && OPT.phaseMs <= OPT.faultAtMs + 5000) {
  throw new Error("fault run must continue at least 5 seconds after --fault-at-ms");
}
for (const [flagName, value] of [
  ["--batch-floor-percent", OPT.batchFloorPercent],
  ["--batch-concurrency-percent", OPT.batchConcurrencyPercent],
  ["--batch-token-percent", OPT.batchTokenPercent],
]) {
  if (value === null) continue;
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${flagName} must be between 0 and 100`);
  }
}
if (
  OPT.batchConcurrencySlots !== null &&
  (!Number.isSafeInteger(OPT.batchConcurrencySlots) ||
    OPT.batchConcurrencySlots < 1 ||
    OPT.batchConcurrencySlots >= OPT.envelope)
) {
  throw new Error("--batch-concurrency-slots must be an integer from 1 to envelope - 1");
}
if (!Number.isSafeInteger(OPT.enrollmentGrantTtlMs) || OPT.enrollmentGrantTtlMs < 1000) {
  throw new Error("--enrollment-grant-ttl-ms must be an integer of at least 1000");
}
if (!Number.isSafeInteger(OPT.grantTtlMs) || OPT.grantTtlMs <= OPT.enrollmentGrantTtlMs) {
  throw new Error("--grant-ttl-ms must be an integer greater than --enrollment-grant-ttl-ms");
}
const REQUIRED_GRANT_RUNWAY_MS = OPT.phaseMs + 10000;
if (OPT.mode !== "baseline" && OPT.grantTtlMs < REQUIRED_GRANT_RUNWAY_MS + 5000) {
  throw new Error(
    `--grant-ttl-ms must be at least ${REQUIRED_GRANT_RUNWAY_MS + 5000} for a ` +
      `${OPT.phaseMs}ms MoFlux phase`,
  );
}

// One scenario definition feeds both arms. Keeping every workload knob here
// prevents a presentation edit from accidentally making the baseline and
// MoFlux runs incomparable.
const WORKLOAD = Object.freeze({
  durationMs: OPT.phaseMs,
  seed: OPT.seed,
  interactiveRps: 6,
  interactiveInputChars: 1200,
  interactiveMaxTokens: 400,
  batchStartMs: Math.round(OPT.phaseMs * 0.35),
  batchDurationMs: Math.round(OPT.phaseMs * 0.5),
  batchRps: 3,
  batchInputChars: 24000,
  batchMaxTokens: 3000,
  maxAttempts: 4,
  backoffBaseMs: 250,
  inFlightCeiling: 3000,
  windowMs: 30000,
});

// The canonical benchmark policy is intentionally interactive-first: one
// batch slot is guaranteed and funded, while the remaining 31 provider slots
// remain available to interactive traffic. This is still a static partition,
// not Latchflo's future borrowable-capacity policy; the benchmark must never
// simulate a product capability that the running control plane does not expose.
const CAPACITY = (() => {
  const batchConcurrent = OPT.batchConcurrencySlots ?? Math.max(
    OPT.batchConcurrencyPercent > 0 ? 1 : 0,
    Math.round((OPT.envelope * OPT.batchConcurrencyPercent) / 100),
  );
  const batchTokens = Math.max(
    OPT.batchTokenPercent > 0 ? 1 : 0,
    Math.round((OPT.tokenBudget * OPT.batchTokenPercent) / 100),
  );
  const interactiveConcurrent = OPT.envelope - batchConcurrent;
  const interactiveTokens = OPT.tokenBudget - batchTokens;
  if (interactiveConcurrent < 1 || interactiveTokens < 1) {
    throw new Error(
      `batch capacity leaves the interactive pool with no capacity ` +
        `(concurrency=${batchConcurrent} slots, tokens=${OPT.batchTokenPercent}%)`,
    );
  }
  const resolvedConcurrencyPercent = (batchConcurrent / OPT.envelope) * 100;
  return Object.freeze({
    policy: "interactive-first-static",
    batchFloorPercent:
      OPT.batchFloorPercent !== null &&
      Math.abs(resolvedConcurrencyPercent - OPT.batchTokenPercent) < 1e-9
        ? OPT.batchFloorPercent
        : null,
    batchConcurrencySlots: batchConcurrent,
    interactiveConcurrencySlots: interactiveConcurrent,
    batchConcurrencyPercent: resolvedConcurrencyPercent,
    batchTokenPercent: OPT.batchTokenPercent,
    pools: Object.freeze([
      Object.freeze({
        name: "sim-interactive",
        maxConcurrent: interactiveConcurrent,
        tokenBudget: interactiveTokens,
        agentCount: POOL_AGENT_COUNTS["sim-interactive"],
      }),
      Object.freeze({
        name: "sim-batch",
        maxConcurrent: batchConcurrent,
        tokenBudget: batchTokens,
        agentCount: POOL_AGENT_COUNTS["sim-batch"],
      }),
    ]),
  });
})();

// Validate the floor against the smallest grant that any agent in the pool
// can receive. The simulator's true input-token ratio and jitter bound the
// adaptive estimator's steady-state correction for this fixed request shape.
const RESERVATIONS = Object.freeze({
  "sim-interactive": Object.freeze(
    reservationBounds({
      inputChars: WORKLOAD.interactiveInputChars,
      maxTokens: WORKLOAD.interactiveMaxTokens,
    }),
  ),
  "sim-batch": Object.freeze(
    reservationBounds({
      inputChars: WORKLOAD.batchInputChars,
      maxTokens: WORKLOAD.batchMaxTokens,
    }),
  ),
});
const RESOLVED_CAPACITY = Object.freeze(
  validateCapacityPlan({ pools: CAPACITY.pools, requirements: RESERVATIONS }).map(Object.freeze),
);

const PROVIDER = Object.freeze({
  envelope: OPT.envelope,
  queue: 8,
  sigma: OPT.sigma,
  kappa: OPT.kappa,
  r1: OPT.r1,
  inputCharRatio: 3.6,
  inputJitter: 0.04,
  seed: OPT.seed,
});

const TRACE = buildTrace(WORKLOAD);
writeFileSync(TRACE_FILE, JSON.stringify(TRACE, null, 2));

const SCENARIO_ID = createHash("sha256")
  .update(
    JSON.stringify({
      workload: WORKLOAD,
      provider: PROVIDER,
      traceHash: TRACE.hash,
      routing: { interactivePorts: INTERACTIVE_PORTS, batchPorts: BATCH_PORTS },
    }),
  )
  .digest("hex")
  .slice(0, 12);

const BOLD = "\u001b[1m";
const DIM = "\u001b[2m";
const CYAN = "\u001b[36m";
const YELLOW = "\u001b[33m";
const GREEN = "\u001b[32m";
const RED = "\u001b[31m";
const OFF = "\u001b[0m";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rl = createInterface({ input: process.stdin, output: process.stdout });

function scene(number, title) {
  console.log(`\n${CYAN}${BOLD}── SCENE ${number}: ${title}${OFF}`);
}

function say(...lines) {
  for (const line of lines) console.log(`${DIM}   ${line}${OFF}`);
}

async function cue(text) {
  if (OPT.step) {
    await new Promise((resolve) => rl.question(`\n${YELLOW}   [enter] ${text}${OFF}`, resolve));
  } else {
    await sleep(OPT.pauseMs);
  }
}

function parseEnv(file) {
  const values = {};
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function command(cmd, argv, { allowFailure = false, quiet = false, env = process.env } = {}) {
  const result = spawnSync(cmd, argv, {
    cwd: ROOT,
    env,
    encoding: "utf8",
    stdio: quiet ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    const detail = quiet ? `\n${result.stderr || result.stdout}` : "";
    throw new Error(`${cmd} ${argv.join(" ")} failed with exit code ${result.status}${detail}`);
  }
  return result;
}

function composeArgs(...args) {
  return [
    "compose",
    "--env-file",
    ENV_FILE,
    "-f",
    BASE_COMPOSE,
    "-f",
    MOFLUX_COMPOSE,
    ...args,
  ];
}

function compose(...args) {
  return command("docker", composeArgs(...args));
}

function composeQuiet(...args) {
  return command("docker", composeArgs(...args), { quiet: true });
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 1500) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

async function waitFor(url, {
  timeoutMs = 30000,
  statuses = [200],
  label = url,
  child = null,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = "no response";
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(`${label} process exited early with code ${child.exitCode}`);
    }
    try {
      const response = await fetchWithTimeout(url, {}, 1200);
      last = `HTTP ${response.status}`;
      if (statuses.includes(response.status)) return response;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${label}; last result: ${last}`);
}

async function jsonRequest(url, {
  method = "GET",
  token = "",
  body,
  allowed = [200],
} = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetchWithTimeout(
    url,
    {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    5000,
  );
  const text = await response.text();
  let parsed = null;
  if (text.trim()) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!allowed.includes(response.status)) {
    throw new Error(`${method} ${url} returned HTTP ${response.status}: ${text || "<empty>"}`);
  }
  return { status: response.status, body: parsed };
}

async function prometheusQuery(expression) {
  const url = new URL("http://127.0.0.1:9090/api/v1/query");
  url.searchParams.set("query", expression);
  const response = await fetchWithTimeout(url, {}, 3000);
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.status !== "success") {
    throw new Error(`Prometheus query failed for ${expression}: HTTP ${response.status}`);
  }
  return Array.isArray(body?.data?.result) ? body.data.result : [];
}

function prometheusSampleValues(result) {
  return result
    .map((row) => Number(row?.value?.[1]))
    .filter((value) => Number.isFinite(value));
}

async function waitForPrometheusValue(expression, predicate, { label = expression, timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    try {
      last = prometheusSampleValues(await prometheusQuery(expression));
      if (last.some(predicate)) return last;
    } catch {
      // Prometheus may be ready before its first scrape or query evaluation.
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for Prometheus ${label}; last values: ${JSON.stringify(last)}`);
}

async function verifyArmTelemetry(armLabel, summary) {
  const arm = JSON.stringify(armLabel);
  const seed = JSON.stringify(String(WORKLOAD.seed));
  await waitForPrometheusValue(
    `bench_run_info{arm=${arm},seed=${seed}}`,
    (value) => value === 1,
    { label: `${armLabel} run identity` },
  );

  if (Number(summary?.classes?.interactive?.success ?? 0) <= 0) return;
  for (const [metric, label] of [
    ["bench_latency_p99_ms", "interactive p99 latency"],
    ["bench_ttft_p99_ms", "interactive p99 TTFT"],
  ]) {
    await waitForPrometheusValue(
      `max_over_time(${metric}{arm=${arm},seed=${seed},class="interactive"}[5m])`,
      (value) => value > 0,
      { label: `${armLabel} ${label}` },
    );
  }
}

async function annotate(text, tags = []) {
  try {
    await fetchWithTimeout(
      "http://127.0.0.1:3000/api/annotations",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Basic ${Buffer.from("admin:admin").toString("base64")}`,
        },
        body: JSON.stringify({ text, tags: ["moflux-video", ...tags], time: Date.now() }),
      },
      1500,
    );
  } catch {
    // The terminal remains authoritative if Grafana annotations are unavailable.
  }
}

function openBrowser(url) {
  if (!OPT.openGrafana) return;
  const candidate =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(candidate[0], candidate[1], { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // Printing the URL is sufficient fallback.
  }
}

const hostChildren = new Set();

function killChildTree(child, signal = "SIGTERM") {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

function launchNode(label, script, argv, { echo = false } = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, script), ...argv], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  child.label = label;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    if (echo) process.stdout.write(`${DIM}[${label}] ${chunk}${OFF}`);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => process.stderr.write(`${RED}[${label}] ${chunk}${OFF}`));
  hostChildren.add(child);
  child.on("close", () => hostChildren.delete(child));
  return child;
}

async function terminateHostChild(child, graceMs = 1500) {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) killChildTree(child, "SIGTERM");
  const closed = await Promise.race([
    new Promise((resolve) => child.once("close", () => resolve(true))),
    sleep(graceMs).then(() => false),
  ]);
  if (!closed && child.exitCode === null) {
    killChildTree(child, "SIGKILL");
    await Promise.race([
      new Promise((resolve) => child.once("close", resolve)),
      sleep(500),
    ]);
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
  hostChildren.delete(child);
}

async function stopHostChildren() {
  await Promise.all([...hostChildren].map((child) => terminateHostChild(child)));
}

function stopHostChildrenSync() {
  for (const child of [...hostChildren]) killChildTree(child, "SIGTERM");
}

let interrupting = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    if (interrupting) return;
    interrupting = true;
    await stopHostChildren();
    console.error(`\n${RED}Demo interrupted. Docker services were left running for inspection.${OFF}`);
    process.exit(1);
  });
}
process.on("exit", stopHostChildrenSync);

function validateFiles() {
  for (const file of [BASE_COMPOSE, MOFLUX_COMPOSE]) {
    if (!existsSync(file)) throw new Error(`missing ${path.relative(ROOT, file)}`);
  }
  ensureDemoEnv(ENV_FILE);
}

function validateTools() {
  command("docker", ["--version"], { quiet: true });
  command("docker", ["compose", "version"], { quiet: true });
  command("docker", ["info"], { quiet: true });
}

function sourceVersion(sourceDir) {
  const packageFile = path.join(sourceDir, "package.json");
  if (!existsSync(packageFile)) return null;
  try {
    return JSON.parse(readFileSync(packageFile, "utf8")).version ?? null;
  } catch {
    return null;
  }
}

function discoverLocalSource(env, sourceKey, repoName, expectedVersion) {
  const explicit = env[sourceKey]?.trim();
  if (explicit) {
    const resolved = path.resolve(ROOT, explicit);
    if (!existsSync(resolved)) {
      throw new Error(`${sourceKey} points to a missing directory: ${resolved}`);
    }
    return resolved;
  }

  const parent = path.resolve(ROOT, "..");
  const direct = path.join(parent, repoName);
  const candidates = [];
  if (existsSync(direct)) candidates.push(direct);
  try {
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(`${repoName}-`)) continue;
      candidates.push(path.join(parent, entry.name));
    }
  } catch {
    // Parent directory may not be readable in a packaged or sandboxed run.
  }
  const matching = [...new Set(candidates)].filter(
    (candidate) => existsSync(path.join(candidate, "Dockerfile")) && sourceVersion(candidate) === expectedVersion,
  );
  return matching.length === 1 ? matching[0] : null;
}

function buildLocalImage(image, sourceDir, expectedVersion, label) {
  const actualVersion = sourceVersion(sourceDir);
  if (actualVersion !== expectedVersion) {
    throw new Error(
      `${label} source at ${sourceDir} reports version ${actualVersion ?? "unknown"}; ` +
        `expected ${expectedVersion}`,
    );
  }
  if (!existsSync(path.join(sourceDir, "Dockerfile"))) {
    throw new Error(`${label} source at ${sourceDir} does not contain a Dockerfile`);
  }
  console.log(`${YELLOW}   Building missing local image ${image} from ${sourceDir}${OFF}`);
  command("docker", ["build", "-t", image, sourceDir]);
}

function validateImages(env) {
  const expected = [
    {
      imageKey: "MOFLUX_TYR_IMAGE",
      sourceKey: "MOFLUX_TYR_SOURCE_DIR",
      repoName: "tyr-admission-controller",
      version: TYR_VERSION,
      label: "Tyr",
    },
    {
      imageKey: "MOFLUX_LATCHFLO_IMAGE",
      sourceKey: "MOFLUX_LATCHFLO_SOURCE_DIR",
      repoName: "latchflo-control-plane",
      version: LATCHFLO_VERSION,
      label: "Latchflo",
    },
  ];
  for (const item of expected) {
    const image = env[item.imageKey];
    if (!image) throw new Error(`${item.imageKey} is missing from ${path.relative(ROOT, ENV_FILE)}`);
    if (env.MOFLUX_ALLOW_UNPINNED_IMAGES !== "true" && !imageMatchesVersion(image, item.version)) {
      throw new Error(
        `${item.imageKey} must reference version ${item.version}; got ${image}. ` +
          `Update ${path.relative(ROOT, ENV_FILE)} or set MOFLUX_ALLOW_UNPINNED_IMAGES=true ` +
          `only when the image digest is independently pinned to that version.`,
      );
    }
    let inspect = command("docker", ["image", "inspect", image], { allowFailure: true, quiet: true });
    if (inspect.status === 0) continue;

    const sourceDir = discoverLocalSource(
      env,
      item.sourceKey,
      item.repoName,
      item.version,
    );
    if (sourceDir) {
      buildLocalImage(image, sourceDir, item.version, item.label);
      inspect = command("docker", ["image", "inspect", image], { allowFailure: true, quiet: true });
      if (inspect.status === 0) continue;
    }

    console.log(`${YELLOW}   Pulling missing image ${image}${OFF}`);
    const pull = command("docker", ["pull", image], { allowFailure: true, quiet: true });
    if (pull.status !== 0) {
      throw new Error(
        `Docker image ${image} is unavailable. Place ${item.repoName} ${item.version} beside ` +
          `moflux-bench, set ${item.sourceKey} to its directory, or pull the licensed image, ` +
          `then rerun npm run demo.`,
      );
    }
  }
}



async function configurePools(token, grantTtlMs, { allowCreate }) {
  const base = "http://127.0.0.1:18080";
  for (const partition of RESOLVED_CAPACITY) {
    const pool = {
      globalMaxConcurrent: partition.maxConcurrent,
      minimumGrantMaxConcurrent: 1,
      maxQueuePerAgent: 0,
      globalTokenBudget: partition.tokenBudget,
      minimumGrantTokenBudget: partition.reservation.requiredLocalGrant,
      globalHighPriorityReserve: 0,
      safetyReservePercent: 0,
      grantTtlMs,
    };
    const update = await jsonRequest(`${base}/v1/pools/${partition.name}`, {
      method: "PUT",
      token,
      body: pool,
      allowed: [200, 404, 405],
    });
    if (update.status === 200) continue;
    if (!allowCreate) {
      throw new Error(
        `Latchflo must support PUT /v1/pools/{name} to promote enrollment grants ` +
          `from ${OPT.enrollmentGrantTtlMs}ms to ${OPT.grantTtlMs}ms safely`,
      );
    }
    const created = await jsonRequest(`${base}/v1/pools`, {
      method: "POST",
      token,
      body: { name: partition.name, ...pool },
      allowed: [200, 201, 409],
    });
    if (created.status === 409) {
      throw new Error(
        `${partition.name} already exists but this Latchflo build cannot update it; ` +
          "use a build that supports PUT /v1/pools/{name}",
      );
    }
  }
}

async function startControlPlane(env) {
  // A video run must not inherit active grants from an earlier recording.
  // With a 120-second TTL, stale durable grants can safely block successor
  // grants longer than the presenter's readiness timeout. The benchmark-local
  // control-plane and Tyr volumes are disposable, so reset them by default.
  if (OPT.resetState) {
    command("docker", composeArgs("down", "--volumes", "--remove-orphans"), {
      allowFailure: true,
      quiet: true,
    });
    console.log(`${GREEN}   ✓ Reset stale Latchflo grants and Tyr credentials${OFF}`);
  }

  // Recreate observability services so every recording uses the checked-in
  // scrape configuration and dashboard rather than a container created by an
  // older repo version.
  compose("up", "-d", "--force-recreate", "telemetry-relay", "prometheus", "grafana");
  // Force recreation guarantees the running controller uses the tokens from
  // the current .env instead of a stale value from an earlier recording.
  compose("up", "-d", "--force-recreate", "latchflo");
  await waitFor("http://127.0.0.1:18080/readyz", {
    timeoutMs: 45000,
    label: "Latchflo readiness",
  });
  await waitFor("http://127.0.0.1:8200/healthz", {
    timeoutMs: 30000,
    label: "benchmark telemetry relay",
  });
  await waitFor("http://127.0.0.1:9090/-/ready", {
    timeoutMs: 30000,
    label: "Prometheus readiness",
  });
  await waitFor("http://127.0.0.1:3000/api/health", {
    timeoutMs: 45000,
    label: "Grafana health",
  });
  await waitForPrometheusValue(
    'up{job="loadgen-telemetry"}',
    (value) => value === 1,
    { label: "loadgen-telemetry target health", timeoutMs: 30000 },
  );

  const token = env.LATCHFLO_ADMIN_TOKEN;
  if (!token) throw new Error("LATCHFLO_ADMIN_TOKEN is missing from demo/moflux/.env");

  // Latchflo never duplicates unexpired capacity. If the steady-state lease
  // were installed before the fleet enrolled, the first registering Tyr would
  // temporarily own the whole pool and later registrations would wait for that
  // long lease to expire. Use a short enrollment lease, then promote the pool
  // definition after all expected agents are visible.
  await configurePools(token, OPT.enrollmentGrantTtlMs, { allowCreate: true });
}

async function waitForAgents(token) {
  const deadline = Date.now() + 45000;
  let count = 0;
  while (Date.now() < deadline) {
    const response = await jsonRequest("http://127.0.0.1:18080/v1/agents", {
      token,
      allowed: [200],
    });
    const agents = Array.isArray(response.body?.agents) ? response.body.agents : [];
    count = agents.length;
    if (count >= TYR_PORTS.length) return agents;
    await sleep(750);
  }
  throw new Error(`Latchflo saw only ${count}/${TYR_PORTS.length} Tyr agents`);
}

async function startTyr(env) {
  compose("stop", ...TYR_SERVICES);
  // A copied demo directory may contain an agent credential issued by a
  // different Latchflo database or bootstrap token. Remove only the local
  // demo credential before each recording so registration is deterministic.
  for (const service of TYR_SERVICES) {
    compose(
      "run",
      "--rm",
      "--no-deps",
      "--user",
      "0:0",
      "--entrypoint",
      "sh",
      service,
      "-lc",
      "rm -f /var/lib/tyr/latchflo-agent.token /var/lib/tyr/latchflo-agent.token.*.tmp",
    );
  }
  // Recreate to guarantee the current env/config is loaded. The demo overlay
  // deliberately runs Tyr as root by default so a fresh named volume is
  // writable during a local presentation; production deployments should use
  // an image-owned non-root volume.
  compose("up", "-d", "--force-recreate", ...TYR_SERVICES);

  for (const port of TYR_PORTS) {
    await waitFor(`http://127.0.0.1:${port}/healthz`, {
      timeoutMs: 45000,
      label: `Tyr ${port} health`,
    });
  }

  await waitForAgents(env.LATCHFLO_ADMIN_TOKEN);

  // Promote the pool definitions only after every expected replica is known.
  // Existing enrollment leases remain authoritative until they expire; the
  // next safe rebalance then partitions one long-lived grant set across the
  // complete fleet.
  await configurePools(env.LATCHFLO_ADMIN_TOKEN, OPT.grantTtlMs, {
    allowCreate: false,
  });
  for (const partition of CAPACITY.pools) {
    await jsonRequest(`http://127.0.0.1:18080/v1/pools/${partition.name}/rebalance`, {
      method: "POST",
      token: env.LATCHFLO_ADMIN_TOKEN,
      allowed: [200, 202],
    });
  }

  return waitForUsableTyrFleet();
}

function providerArgs() {
  return [
    "--port=9000",
    `--envelope=${PROVIDER.envelope}`,
    `--queue=${PROVIDER.queue}`,
    `--sigma=${PROVIDER.sigma}`,
    `--kappa=${PROVIDER.kappa}`,
    `--r1=${PROVIDER.r1}`,
    `--input-char-ratio=${PROVIDER.inputCharRatio}`,
    `--input-jitter=${PROVIDER.inputJitter}`,
    `--seed=${PROVIDER.seed}`,
  ];
}

function loadgenArgs({ interactiveTargets, batchTargets, armLabel, outFile }) {
  return [
    `--targets=${[...new Set([...interactiveTargets, ...batchTargets])].join(",")}`,
    `--interactive-targets=${interactiveTargets.join(",")}`,
    `--batch-targets=${batchTargets.join(",")}`,
    `--arm-label=${armLabel}`,
    `--duration-ms=${WORKLOAD.durationMs}`,
    `--seed=${WORKLOAD.seed}`,
    `--interactive-rps=${WORKLOAD.interactiveRps}`,
    `--interactive-input-chars=${WORKLOAD.interactiveInputChars}`,
    `--interactive-max-tokens=${WORKLOAD.interactiveMaxTokens}`,
    `--batch-start-ms=${WORKLOAD.batchStartMs}`,
    `--batch-duration-ms=${WORKLOAD.batchDurationMs}`,
    `--batch-rps=${WORKLOAD.batchRps}`,
    `--batch-input-chars=${WORKLOAD.batchInputChars}`,
    `--batch-max-tokens=${WORKLOAD.batchMaxTokens}`,
    `--max-attempts=${WORKLOAD.maxAttempts}`,
    `--backoff-base-ms=${WORKLOAD.backoffBaseMs}`,
    `--in-flight-ceiling=${WORKLOAD.inFlightCeiling}`,
    `--window-ms=${WORKLOAD.windowMs}`,
    `--trace-file=${TRACE_FILE}`,
    "--metrics-port=0",
    "--metrics-relay-url=http://127.0.0.1:8200/ingest",
    "--metrics-relay-required",
    `--out=${outFile}`,
  ];
}

function attachScenario(summary) {
  summary.scenario = {
    id: SCENARIO_ID,
    workload: WORKLOAD,
    provider: PROVIDER,
    trace: {
      version: TRACE.version,
      hash: TRACE.hash,
      planned: TRACE.planned,
      evidence: path.relative(ROOT, TRACE_FILE).split(path.sep).join("/"),
    },
    routing: {
      interactiveReplicas: INTERACTIVE_PORTS.map((port) => `http://127.0.0.1:${port}`),
      batchReplicas: BATCH_PORTS.map((port) => `http://127.0.0.1:${port}`),
    },
  };
  return summary;
}

function assertSameScenario(baseline, moflux) {
  if (baseline?.scenario?.id !== moflux?.scenario?.id || baseline?.scenario?.trace?.hash !== moflux?.scenario?.trace?.hash) {
    throw new Error(
      `comparison invalid: scenario mismatch (${baseline?.scenario?.id ?? "missing"} vs ${moflux?.scenario?.id ?? "missing"})`,
    );
  }
}

function assertValidRun(summary, label) {
  if (summary.generatorSaturated > 0) {
    throw new Error(
      `${label} is invalid: the load generator saturated ${summary.generatorSaturated} times`,
    );
  }
  if (summary.trace?.hash !== TRACE.hash) {
    throw new Error(`${label} did not replay trace ${TRACE.hash}`);
  }
  for (const cls of ["interactive", "batch"]) {
    const planned = Number(TRACE.planned[cls]);
    const observed = Number(summary.classes?.[cls]?.logical);
    if (observed !== planned) {
      throw new Error(`${label} issued ${observed} ${cls} requests; trace requires ${planned}`);
    }
  }
}

function assertNoControlSemantics(summary) {
  const localRejects =
    summary.classes.interactive.localReject + summary.classes.batch.localReject;
  if (localRejects !== 0) {
    throw new Error(
      `baseline is not a no-control arm: it reported ${localRejects} local admission rejects`,
    );
  }
}

async function runLoadgen({ interactiveTargets, batchTargets, armLabel, outFile }) {
  rmSync(outFile, { force: true });
  const loadgen = launchNode("loadgen", "load/loadgen.mjs", loadgenArgs({ interactiveTargets, batchTargets, armLabel, outFile }));
  const exit = await new Promise((resolve) => {
    loadgen.on("close", (code, signal) => resolve({ code, signal }));
  });
  if (exit.code !== 0) {
    throw new Error(
      `load generator failed (${exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code}`})`,
    );
  }
  if (!existsSync(outFile)) throw new Error(`load generator did not write ${outFile}`);
  const summary = JSON.parse(readFileSync(outFile, "utf8"));
  await verifyArmTelemetry(armLabel, summary);
  return summary;
}

async function readProviderCounters() {
  try {
    const response = await fetchWithTimeout("http://127.0.0.1:9000/admin/stats", {}, 2000);
    return (await response.json())?.counters ?? null;
  } catch {
    return null;
  }
}

async function readTyrStats() {
  return Promise.all(
    TYR_PORTS.map(async (port) => {
      const response = await fetchWithTimeout(`http://127.0.0.1:${port}/stats`, {}, 2000);
      if (!response.ok) throw new Error(`Tyr ${port} /stats returned HTTP ${response.status}`);
      return response.json();
    }),
  );
}

function validateLiveGrantCapacity(statsRows) {
  const grants = [];
  for (let index = 0; index < statsRows.length; index += 1) {
    const row = statsRows[index];
    const port = TYR_PORTS[index];
    for (const pool of RESOLVED_CAPACITY) {
      const stats = row?.[pool.name];
      if (!stats) continue;
      const tokenBudget = Number(stats?.tokenBudget?.budget ?? stats?.limits?.tokenBudget?.budget ?? 0);
      const maxConcurrent = Number(stats?.limits?.maxConcurrent ?? 0);
      const expiresAt = stats?.tyr?.provenance?.current?.expiresAt;
      const expiresAtMs = typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
      const remainingMs = Number.isFinite(expiresAtMs) ? expiresAtMs - Date.now() : Number.NaN;
      grants.push({
        port,
        pool: pool.name,
        tokenBudget,
        maxConcurrent,
        expiresAt: typeof expiresAt === "string" ? expiresAt : null,
        remainingMs: Number.isFinite(remainingMs) ? Math.max(0, Math.floor(remainingMs)) : null,
      });
      if (tokenBudget < pool.reservation.requiredLocalGrant) {
        throw new Error(
          `${pool.name} on Tyr ${port} received ${tokenBudget} tokens, below one request's ` +
            `${pool.reservation.requiredLocalGrant}-token requirement`,
        );
      }
      if (maxConcurrent < 1) {
        throw new Error(`${pool.name} on Tyr ${port} received no usable concurrency`);
      }
      if (!Number.isFinite(remainingMs)) {
        throw new Error(`${pool.name} on Tyr ${port} has no current Latchflo grant expiration`);
      }
      if (remainingMs < REQUIRED_GRANT_RUNWAY_MS) {
        throw new Error(
          `${pool.name} on Tyr ${port} grant has only ${Math.max(0, Math.floor(remainingMs))}ms ` +
            `remaining; ${REQUIRED_GRANT_RUNWAY_MS}ms is required to finish the benchmark phase`,
        );
      }
    }
  }
  for (const pool of RESOLVED_CAPACITY) {
    const actual = grants.filter((grant) => grant.pool === pool.name).length;
    if (actual !== pool.agentCount) {
      throw new Error(`${pool.name} registered on ${actual} agents; expected ${pool.agentCount}`);
    }
  }
  return grants;
}


async function waitForUsableTyrFleet() {
  const timeoutMs = Math.max(
    45000,
    OPT.enrollmentGrantTtlMs * 4 + 15000,
    OPT.resetState ? 0 : OPT.grantTtlMs + 30000,
  );
  const deadline = Date.now() + timeoutMs;
  let last = "no fleet observation";

  while (Date.now() < deadline) {
    try {
      const readiness = await Promise.all(
        TYR_PORTS.map(async (port) => {
          const response = await fetchWithTimeout(`http://127.0.0.1:${port}/readyz`, {}, 1500);
          return { port, status: response.status };
        }),
      );
      const notReady = readiness.filter(({ status }) => status !== 200);
      if (notReady.length === 0) {
        const stats = await readTyrStats();
        const grants = validateLiveGrantCapacity(stats);
        // Recheck readiness after reading all stats. This closes the race where
        // an early replica expires while later replicas are still becoming ready.
        const confirmation = await Promise.all(
          TYR_PORTS.map(async (port) => {
            const response = await fetchWithTimeout(`http://127.0.0.1:${port}/readyz`, {}, 1500);
            return { port, status: response.status };
          }),
        );
        if (confirmation.every(({ status }) => status === 200)) return grants;
        last = `readiness changed during validation: ${JSON.stringify(confirmation)}`;
      } else {
        last = `not ready: ${notReady.map(({ port, status }) => `${port}=HTTP ${status}`).join(", ")}`;
      }
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }

  throw new Error(
    `timed out waiting for one simultaneous, usable Tyr grant set after enrollment; last result: ${last}`,
  );
}

function aggregateTokenAccounting(statsRows) {
  const total = {
    totalReserved: 0,
    totalConsumed: 0,
    totalRefunded: 0,
    totalOverrun: 0,
  };
  for (const row of statsRows) {
    for (const partition of CAPACITY.pools) {
      const token = row?.[partition.name]?.tokenBudget ?? {};
      for (const key of Object.keys(total)) total[key] += Number(token[key] ?? 0);
    }
  }
  return total;
}

function subtractAccounting(after, before) {
  const delta = {};
  for (const key of Object.keys(after)) delta[key] = Math.max(0, after[key] - before[key]);
  return delta;
}

async function runBaseline() {
  // The control arm keeps the same four-replica hop and the same provider.
  // Its replica policy is passthrough: every request is forwarded and no
  // Latchflo/Tyr admission decision exists anywhere in the request path.
  command("docker", composeArgs("stop", ...TYR_SERVICES), { allowFailure: true, quiet: true });

  const provider = launchNode("provider", "sim/provider-sim.mjs", providerArgs());
  await waitFor("http://127.0.0.1:9000/healthz", {
    timeoutMs: 15000,
    label: "provider simulator",
    child: provider,
  });

  const replicas = [];
  try {
    for (let index = 0; index < TYR_PORTS.length; index += 1) {
      const port = TYR_PORTS[index];
      const replica = launchNode(`baseline-r${index + 1}`, "arms/replica.mjs", [
        `--port=${port}`,
        `--id=r${index + 1}`,
        "--arm=passthrough",
        "--upstream=http://127.0.0.1:9000",
      ]);
      replicas.push(replica);
      await waitFor(`http://127.0.0.1:${port}/healthz`, {
        timeoutMs: 10000,
        label: `baseline replica ${index + 1}`,
        child: replica,
      });
    }

    const outFile = path.join(RESULTS, "baseline.json");
    const summary = await runLoadgen({
      interactiveTargets: INTERACTIVE_PORTS.map((port) => `http://127.0.0.1:${port}`),
      batchTargets: BATCH_PORTS.map((port) => `http://127.0.0.1:${port}`),
      armLabel: "baseline-no-control",
      outFile,
    });
    summary.simCounters = await readProviderCounters();
    attachScenario(summary);
    writeFileSync(outFile, JSON.stringify(summary, null, 2));
    return summary;
  } finally {
    await Promise.all([...replicas, provider].map((child) => terminateHostChild(child)));
  }
}

async function runMoflux(env) {
  const sim = launchNode("provider", "sim/provider-sim.mjs", providerArgs());
  await waitFor("http://127.0.0.1:9000/healthz", {
    timeoutMs: 15000,
    label: "provider simulator",
    child: sim,
  });

  const liveGrants = await startTyr(env);
  const before = aggregateTokenAccounting(await readTyrStats());
  const outFile = path.join(RESULTS, OPT.fault ? "moflux-enforce-fault.json" : "moflux-enforce.json");
  rmSync(outFile, { force: true });

  await annotate(OPT.fault ? "MoFlux enforce + replica fault" : "MoFlux enforce", ["moflux"]);

  if (OPT.fault) {
    setTimeout(() => {
      console.log(`\n${RED}${BOLD}   FAULT: killing bench-tyr-r3 without a clean shutdown${OFF}`);
      command("docker", ["kill", "bench-tyr-r3"], { allowFailure: true, quiet: true });
      void annotate("Tyr r3 killed", ["moflux", "fault"]);
    }, OPT.faultAtMs);
  }

  const summary = await runLoadgen({
    interactiveTargets: INTERACTIVE_PORTS.map((port) => `http://127.0.0.1:${port}`),
    batchTargets: BATCH_PORTS.map((port) => `http://127.0.0.1:${port}`),
    armLabel: OPT.fault ? "moflux-enforce-fault" : "moflux-enforce",
    outFile,
  });
  const simCounters = await readProviderCounters();

  // In a fault run r4 may be gone. Aggregate all remaining stats and preserve
  // the pre-run fleet baseline so deltas remain honest.
  const afterRows = [];
  for (const port of TYR_PORTS) {
    try {
      const response = await fetchWithTimeout(`http://127.0.0.1:${port}/stats`, {}, 1500);
      if (response.ok) afterRows.push(await response.json());
    } catch {
      // expected for the killed replica
    }
  }
  const after = aggregateTokenAccounting(afterRows);
  const tokenAccounting = subtractAccounting(after, before);
  const grossRecoveryRate =
    tokenAccounting.totalReserved > 0
      ? tokenAccounting.totalRefunded / tokenAccounting.totalReserved
      : 0;
  const netRecovered = tokenAccounting.totalRefunded - tokenAccounting.totalOverrun;
  const netRecoveryRate =
    tokenAccounting.totalReserved > 0 ? netRecovered / tokenAccounting.totalReserved : 0;

  summary.simCounters = simCounters;
  attachScenario(summary);
  summary.runtime = {
    tyr: { version: TYR_VERSION, image: env.MOFLUX_TYR_IMAGE },
    latchflo: { version: LATCHFLO_VERSION, image: env.MOFLUX_LATCHFLO_IMAGE },
  };
  summary.capacity = {
    policy: CAPACITY.policy,
    batchFloorPercent: CAPACITY.batchFloorPercent,
    batchConcurrencySlots: CAPACITY.batchConcurrencySlots,
    interactiveConcurrencySlots: CAPACITY.interactiveConcurrencySlots,
    batchConcurrencyPercent: CAPACITY.batchConcurrencyPercent,
    batchTokenPercent: CAPACITY.batchTokenPercent,
    envelope: OPT.envelope,
    tokenBudget: OPT.tokenBudget,
    pools: RESOLVED_CAPACITY,
    liveGrants,
  };
  summary.tokenAccounting = {
    ...tokenAccounting,
    grossRecoveryRate: +grossRecoveryRate.toFixed(4),
    netRecovered,
    netRecoveryRate: +netRecoveryRate.toFixed(4),
  };
  writeFileSync(outFile, JSON.stringify(summary, null, 2));

  await terminateHostChild(sim);
  return summary;
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

function tailRatio(summary) {
  const { p50, p95 } = summary.classes.interactive.latencyMs;
  return p50 > 0 ? p95 / p50 : 0;
}

function interactiveGoodput(summary) {
  const durationMs = Number(summary.config?.durationMs ?? WORKLOAD.durationMs);
  return durationMs > 0 ? summary.classes.interactive.success / (durationMs / 1000) : 0;
}

function experienceRow(name, summary) {
  const interactive = summary.classes.interactive;
  return {
    arm: name,
    success: percent(interactive.successRate),
    goodput: `${interactiveGoodput(summary).toFixed(2)} req/s`,
    p50: seconds(interactive.latencyMs.p50),
    p95: seconds(interactive.latencyMs.p95),
    "p95/p50": `${tailRatio(summary).toFixed(2)}x`,
    "TTFT p50": seconds(interactive.ttftMs.p50),
    "TTFT p95": seconds(interactive.ttftMs.p95),
  };
}

function protectionRow(name, summary) {
  const interactive = summary.classes.interactive;
  const batch = summary.classes.batch;
  return {
    arm: name,
    "local rejects": interactive.localReject + batch.localReject,
    "upstream 429": interactive.upstreamReject + batch.upstreamReject,
    "peak active": `${summary.simCounters?.peakActive ?? "?"}/${OPT.envelope}`,
    "batch success": percent(batch.successRate),
    "interactive retries": `${interactive.retryAmplification.toFixed(2)}x`,
  };
}

function comparisonMetrics(baseline, moflux) {
  const base = baseline.classes.interactive;
  const managed = moflux.classes.interactive;
  const baselineGoodput = interactiveGoodput(baseline);
  const mofluxGoodput = interactiveGoodput(moflux);
  const baselineTail = tailRatio(baseline);
  const mofluxTail = tailRatio(moflux);
  return {
    interactiveSuccessPercentagePointChange: +((managed.successRate - base.successRate) * 100).toFixed(2),
    interactiveGoodputChangePercent:
      baselineGoodput > 0 ? +(((mofluxGoodput / baselineGoodput) - 1) * 100).toFixed(2) : null,
    interactiveP95LatencyChangePercent:
      base.latencyMs.p95 > 0 ? +(((managed.latencyMs.p95 / base.latencyMs.p95) - 1) * 100).toFixed(2) : null,
    interactiveTailRatioBaseline: +baselineTail.toFixed(4),
    interactiveTailRatioMoflux: +mofluxTail.toFixed(4),
    interactiveTailInflationChangePercent:
      baselineTail > 0 ? +(((mofluxTail / baselineTail) - 1) * 100).toFixed(2) : null,
    upstream429Baseline: baseline.classes.interactive.upstreamReject + baseline.classes.batch.upstreamReject,
    upstream429Moflux: moflux.classes.interactive.upstreamReject + moflux.classes.batch.upstreamReject,
  };
}

function writeComparison(baseline, moflux) {
  assertSameScenario(baseline, moflux);
  const comparison = {
    generatedAt: new Date().toISOString(),
    scenario: baseline.scenario,
    arms: {
      baseline: "results/baseline.json",
      moflux: OPT.fault ? "results/moflux-enforce-fault.json" : "results/moflux-enforce.json",
    },
    metrics: comparisonMetrics(baseline, moflux),
  };
  const outFile = path.join(RESULTS, OPT.fault ? "video-comparison-fault.json" : "video-comparison.json");
  writeFileSync(outFile, JSON.stringify(comparison, null, 2));
  return { comparison, outFile };
}

function signedPercent(value) {
  if (value === null || !Number.isFinite(value)) return "n/a";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function printObservedComparison(baseline, moflux) {
  const metrics = comparisonMetrics(baseline, moflux);
  console.log(`
${GREEN}${BOLD}   Observed comparison for this run${OFF}`);
  console.log(`   interactive success   ${metrics.interactiveSuccessPercentagePointChange >= 0 ? "+" : ""}${metrics.interactiveSuccessPercentagePointChange.toFixed(2)} percentage points`);
  console.log(`   interactive goodput   ${signedPercent(metrics.interactiveGoodputChangePercent)}`);
  console.log(`   interactive p95       ${signedPercent(metrics.interactiveP95LatencyChangePercent)}`);
  console.log(`   p95/p50 tail ratio    ${metrics.interactiveTailRatioBaseline.toFixed(2)}x -> ${metrics.interactiveTailRatioMoflux.toFixed(2)}x`);
  console.log(`   upstream 429s         ${metrics.upstream429Baseline} -> ${metrics.upstream429Moflux}`);
  say("These are same-scenario observations, not a universal performance claim; repeat across seeds before publishing aggregate percentages.");
}

function printRecovery(summary) {
  const t = summary.tokenAccounting;
  if (!t || t.totalReserved <= 0) return;
  console.log(`\n${GREEN}${BOLD}   Token capacity reconciliation${OFF}`);
  console.log(`   reserved     ${t.totalReserved.toLocaleString("en-US")}`);
  console.log(`   consumed     ${t.totalConsumed.toLocaleString("en-US")}`);
  console.log(`   refunded     ${t.totalRefunded.toLocaleString("en-US")} (${percent(t.grossRecoveryRate)})`);
  console.log(`   overrun      ${t.totalOverrun.toLocaleString("en-US")}`);
  console.log(`   net recovered ${t.netRecovered.toLocaleString("en-US")} (${percent(t.netRecoveryRate)})`);
  say(
    "Recovery means unused safety reservation was returned to the pool for reuse;",
    "it is not newly created capacity.",
  );
}

async function doctor(env) {
  scene(0, "Preflight");
  validateTools();
  validateImages(env);
  composeQuiet("config");
  console.log(`${GREEN}   ✓ Docker daemon and Compose${OFF}`);
  console.log(`${GREEN}   ✓ Tyr image: ${env.MOFLUX_TYR_IMAGE}${OFF}`);
  console.log(`${GREEN}   ✓ Latchflo image: ${env.MOFLUX_LATCHFLO_IMAGE}${OFF}`);
  console.log(`${GREEN}   ✓ Compose configuration resolves${OFF}`);
}

let env;
try {
  validateFiles();
  env = { ...parseEnv(ENV_FILE), ...process.env };
  await doctor(env);

  if (OPT.mode === "doctor") {
    rl.close();
    process.exit(0);
  }

  scene(1, "Start the control plane and dashboard");
  say(
    "Latchflo coordinates fleet capacity outside the request path.",
    "Grafana will open automatically; keep it visible beside this terminal.",
    "Workload panels populate automatically; the telemetry pipeline health panel should already read 1.",
    `Both arms use scenario ${SCENARIO_ID}: seed ${WORKLOAD.seed}, ${WORKLOAD.interactiveRps} interactive RPS, then ${WORKLOAD.batchRps} batch RPS.`,
    `Capacity is partitioned by tier: ${RESOLVED_CAPACITY
      .map((pool) => `${pool.name} ${pool.maxConcurrent}/${pool.tokenFundedConcurrency} configured/funded slots, ${pool.tokenBudget.toLocaleString("en-US")} tokens across ${pool.agentCount} agent${pool.agentCount === 1 ? "" : "s"}`)
      .join(", ")}.`,
    `The canonical interactive-first policy is ${CAPACITY.interactiveConcurrencySlots}/${CAPACITY.batchConcurrencySlots}; all ${OPT.envelope} slots are token-funded.`,
    `The immutable trace is ${TRACE.hash.slice(0, 12)} with ${TRACE.planned.interactive} interactive and ${TRACE.planned.batch} batch requests.`,
  );
  await startControlPlane(env);
  openBrowser("http://127.0.0.1:3000");
  console.log(`${GREEN}   ✓ Latchflo, telemetry relay, Prometheus, and Grafana are ready${OFF}`);
  const startsWithBaseline = OPT.mode === "compare" || OPT.mode === "baseline";
  await cue(startsWithBaseline ? "run the uncontrolled baseline" : "start Tyr and run MoFlux");

  let baseline = null;
  if (startsWithBaseline) {
    scene(2, "Uncontrolled baseline");
    say(
      "Four application replicas forward transparently to the provider.",
      "Watch interactive latency and upstream 429s when batch traffic begins.",
    );
    await annotate("Uncontrolled baseline", ["baseline"]);
    baseline = await runBaseline();
    assertValidRun(baseline, "baseline");
    assertNoControlSemantics(baseline);
    console.table([experienceRow("No control", baseline)]);
    console.table([protectionRow("No control", baseline)]);
    if (OPT.mode === "baseline") {
      console.log(`
${GREEN}${BOLD}   Baseline complete.${OFF}`);
      console.log("   result: results/baseline.json");
      say("Run the full comparison later with: npm run demo");
      if (!OPT.keepStack) compose("down");
      rl.close();
      process.exit(0);
    }
    await cue("transition to Tyr + Latchflo");
  }

  scene(OPT.mode === "compare" ? 3 : 2, OPT.fault ? "MoFlux with a replica failure" : "MoFlux enforce");
  say(
    `Latchflo allocates ${OPT.envelope} concurrent slots and ${OPT.tokenBudget.toLocaleString("en-US")} in-flight tokens`,
    "across four interactive Tyr paths, with replica 4 also carrying the batch pool. Tyr makes each admission decision locally.",
    "Unused token reservation is reconciled and returned after actual usage is known.",
  );
  const moflux = await runMoflux(env);
  assertValidRun(moflux, "MoFlux run");

  scene(OPT.mode === "compare" ? 4 : 3, "Result");
  const experienceRows = [];
  const protectionRows = [];
  if (baseline) {
    experienceRows.push(experienceRow("No control", baseline));
    protectionRows.push(protectionRow("No control", baseline));
  }
  experienceRows.push(experienceRow(OPT.fault ? "MoFlux + fault" : "MoFlux", moflux));
  protectionRows.push(protectionRow(OPT.fault ? "MoFlux + fault" : "MoFlux", moflux));
  console.log(`
${BOLD}   Interactive experience${OFF}`);
  console.table(experienceRows);
  console.log(`${BOLD}   Overload handling${OFF}`);
  console.table(protectionRows);
  printRecovery(moflux);
  let comparisonFile = null;
  if (baseline) {
    printObservedComparison(baseline, moflux);
    comparisonFile = writeComparison(baseline, moflux).outFile;
  }

  console.log(`\n${GREEN}${BOLD}   Demo complete. Grafana remains open for the closing explanation.${OFF}`);
  console.log(`   result: results/${OPT.fault ? "moflux-enforce-fault.json" : "moflux-enforce.json"}`);
  if (comparisonFile) console.log(`   comparison: ${path.relative(ROOT, comparisonFile)}`);

  if (!OPT.keepStack) {
    compose("down");
  } else {
    say("Stop the demo later with: npm run demo:down");
  }
} catch (error) {
  console.error(`\n${RED}${BOLD}Demo failed:${OFF} ${error instanceof Error ? error.message : String(error)}`);
  try {
    const logs = composeQuiet("logs", "--tail=60", "latchflo", ...TYR_SERVICES);
    if (logs.stdout?.trim()) console.error(`\n${DIM}${logs.stdout}${OFF}`);
    if (logs.stderr?.trim()) console.error(`\n${DIM}${logs.stderr}${OFF}`);
  } catch {
    // Preflight may have failed before Compose was usable.
  }
  process.exitCode = 1;
} finally {
  rl.close();
  await stopHostChildren();
}
