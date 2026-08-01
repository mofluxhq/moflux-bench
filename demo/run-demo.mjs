#!/usr/bin/env node
/**
 * run-demo.mjs — the narrated benchmark walkthrough.
 *
 * Built to be screen-recorded. Every phase prints what it is about to do and
 * why, runs it, then prints the result, so the terminal alone tells the story
 * while Grafana shows it happening. Phases are separated by a pause you can
 * talk over (--pause-ms) or step through manually (--step).
 *
 * The arc is deliberate. It opens by testing the measuring instrument against
 * its own model, because a benchmark whose simulator is unvalidated is just an
 * assertion with extra steps. It then walks from the naive baseline up through
 * the good hand-rolled alternative, ending at the coordinated arm — and it
 * shows where each one breaks, including the last.
 *
 * Usage:
 *   node demo/run-demo.mjs --step                  # starts the stack and opens Grafana
 *
 * Pass --no-open-grafana for headless runs.
 *
 * Pass --no-stack-start only when the observability and Redis services are
 * already managed externally.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { RedisClient } from "../arms/redis-client.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS = path.resolve(process.env.MOFLUX_BENCH_RESULTS_DIR ?? path.join(ROOT, "results"));
const SUPPORT_COMPOSE_FILE = path.join(ROOT, "demo", "compose.yaml");
const TELEMETRY_RELAY_URL = "http://127.0.0.1:8200";
const GRAFANA_DASHBOARD_UID = "moflux-bench";
const GRAFANA_DASHBOARD_PATH = `/d/${GRAFANA_DASHBOARD_UID}/moflux-benchmark-harness?orgId=1&refresh=5s`;
mkdirSync(RESULTS, { recursive: true });

// ── args ─────────────────────────────────────────────────────────────

const args = new Map();
for (const arg of process.argv.slice(2)) {
  const m = /^--([^=]+)=(.*)$/.exec(arg);
  if (m) args.set(m[1], m[2]);
  else if (arg.startsWith("--")) args.set(arg.slice(2), "true");
}
const num = (n, d) => (args.has(n) ? Number(args.get(n)) : d);
const flag = (n) => args.get(n) === "true";

const OPT = {
  step: flag("step"),
  pauseMs: num("pause-ms", 4000),
  phaseMs: num("phase-ms", 45000), // per-arm measurement window
  replicas: num("replicas", 4),
  envelope: num("envelope", 32),
  sigma: num("sigma", 0.25),
  kappa: num("kappa", 0),
  r1: num("r1", 400),
  tokenBudget: num("token-budget", 40000),
  seed: num("seed", 7),
  grafana: args.get("grafana") ?? "http://localhost:3000",
  grafanaAuth: args.get("grafana-auth") ?? "admin:admin",
  openGrafana: !flag("no-open-grafana"),
  skipVerify: flag("skip-verify"),
  onlyPhase: args.get("only") ?? "",
  startSupportStack: !flag("no-stack-start"),
  supportStackTimeoutMs: num("stack-timeout-ms", 45000),
};

// The workload. Interactive traffic runs the whole time; batch arrives as a
// step function partway through, which is the moment everything interesting
// happens.
const WORKLOAD = {
  interactiveRps: 6,
  interactiveInputChars: 1200,
  interactiveMaxTokens: 400,
  batchStartMs: Math.round(OPT.phaseMs * 0.35),
  batchDurationMs: Math.round(OPT.phaseMs * 0.5),
  batchRps: 3,
  batchInputChars: 24000,
  batchMaxTokens: 3000,
};

// ── presentation helpers ─────────────────────────────────────────────

const BOLD = "\u001b[1m";
const DIM = "\u001b[2m";
const CYAN = "\u001b[36m";
const YELLOW = "\u001b[33m";
const GREEN = "\u001b[32m";
const RED = "\u001b[31m";
const OFF = "\u001b[0m";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function banner(number, title) {
  const bar = "─".repeat(Math.max(0, 72 - title.length - 6));
  console.log(`\n${CYAN}${BOLD}── ${number}. ${title} ${bar}${OFF}`);
}

/** Narration: what the viewer should be watching for. */
function note(...lines) {
  for (const line of lines) console.log(`${DIM}   ${line}${OFF}`);
}

async function pause(prompt = "next phase") {
  if (OPT.step) {
    await new Promise((resolve) => rl.question(`\n${YELLOW}   [enter] ${prompt}${OFF}`, resolve));
  } else {
    await sleep(OPT.pauseMs);
  }
}

/**
 * Drops a marker on the Grafana timeline so the recording lines phases up with
 * the graphs. Best-effort: the demo runs fine without Grafana.
 */
async function annotate(text, tags = []) {
  try {
    await fetch(`${OPT.grafana}/api/annotations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: grafanaAuthHeader(),
      },
      body: JSON.stringify({ text, tags: ["moflux-bench", ...tags], time: Date.now() }),
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    /* Grafana not running; the terminal narration still stands alone. */
  }
}

// ── process management ───────────────────────────────────────────────

const children = new Set();

/**
 * Spawns a child and ALWAYS drains its stdout. A piped stdout that nobody
 * reads fills its 64KB buffer and blocks the child forever — the load
 * generator prints a full JSON summary at exit, so this is not hypothetical.
 * `echo` opts a child's output into the transcript for the recording.
 */
function launch(label, script, argv, { echo = false } = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, script), ...argv], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
  child.label = label;
  child.stdout.setEncoding("utf8");
  let carry = "";
  child.stdout.on("data", (chunk) => {
    if (!echo) return; // still consumed: the handler drains regardless
    carry += chunk;
    const lines = carry.split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim() !== "") console.log(`${DIM}   [${label}] ${line}${OFF}`);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => process.stderr.write(`${RED}[${label}] ${d}${OFF}`));
  children.add(child);
  child.on("exit", () => children.delete(child));
  return child;
}

function stopAll() {
  for (const child of [...children]) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  children.clear();
}

process.on("exit", stopAll);
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    stopAll();
    process.exit(1);
  });
}

async function waitForUrl(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      lastStatus = res.status;
      if (res.ok) return true;
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  const detail = lastStatus != null
    ? `last HTTP status ${lastStatus}`
    : lastError?.message ?? "connection failed";
  throw new Error(`${url} never became healthy (${detail})`);
}

async function waitForHealth(url, timeoutMs = 10000) {
  return waitForUrl(`${url}/healthz`, timeoutMs);
}

function grafanaAuthHeader() {
  return `Basic ${Buffer.from(OPT.grafanaAuth).toString("base64")}`;
}

async function waitForGrafanaDashboard(timeoutMs = 10000) {
  const url = `${OPT.grafana}/api/dashboards/uid/${GRAFANA_DASHBOARD_UID}`;
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        headers: { authorization: grafanaAuthHeader() },
        signal: AbortSignal.timeout(1000),
      });
      lastStatus = res.status;
      if (res.ok) return true;
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  const detail = lastStatus != null
    ? `last HTTP status ${lastStatus}`
    : lastError?.message ?? "connection failed";
  throw new Error(`Grafana dashboard ${GRAFANA_DASHBOARD_UID} was not provisioned (${detail})`);
}

function grafanaDashboardUrl() {
  return new URL(GRAFANA_DASHBOARD_PATH, `${OPT.grafana}/`).toString();
}

function openGrafanaDashboard() {
  if (!OPT.openGrafana) return;

  const url = grafanaDashboardUrl();
  const override = process.env.MOFLUX_BENCH_BROWSER?.trim();
  let command;
  let argv;
  if (override) {
    command = override;
    argv = [url];
  } else if (process.platform === "darwin") {
    command = "open";
    argv = [url];
  } else if (process.platform === "win32") {
    command = "cmd";
    argv = ["/c", "start", "", `"${url}"`];
  } else {
    command = "xdg-open";
    argv = [url];
  }

  const result = spawnSync(command, argv, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`;
    console.warn(`${YELLOW}   ! Could not open Grafana automatically (${detail})${OFF}`);
    console.warn(`${YELLOW}     Open ${url}${OFF}`);
    return;
  }
  console.log(`${GREEN}   ✓ Opened Grafana dashboard: ${url}${OFF}`);
}

function runDocker(args, { allowFailure = false } = {}) {
  const result = spawnSync("docker", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error && !allowFailure) {
    throw new Error(`failed to execute docker: ${result.error.message}`, { cause: result.error });
  }
  if (result.status !== 0 && !allowFailure) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`docker ${args.join(" ")} failed${output ? `:\n${output}` : ""}`);
  }
  return result;
}

function compose(args, options = {}) {
  return runDocker(["compose", "-f", SUPPORT_COMPOSE_FILE, ...args], options);
}

function supportStackDiagnostics() {
  const sections = [];
  for (const [title, args] of [
    ["docker compose ps", ["ps"]],
    ["telemetry-relay logs", ["logs", "--no-color", "--tail=100", "telemetry-relay"]],
    ["grafana logs", ["logs", "--no-color", "--tail=100", "grafana"]],
  ]) {
    const result = compose(args, { allowFailure: true });
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    if (output) sections.push(`${title}:\n${output}`);
  }
  return sections.join("\n\n");
}

let supportStackReady = false;
async function ensureSupportStack() {
  if (supportStackReady) return;

  if (OPT.startSupportStack) {
    runDocker(["info"]);
    runDocker(["compose", "version"]);
    compose([
      "up",
      "-d",
      "--force-recreate",
      "telemetry-relay",
      "prometheus",
      "grafana",
      "redis",
    ]);
  }

  try {
    await waitForUrl(`${TELEMETRY_RELAY_URL}/healthz`, OPT.supportStackTimeoutMs);
    await waitForUrl("http://127.0.0.1:9090/-/ready", OPT.supportStackTimeoutMs);
    await waitForUrl("http://127.0.0.1:3000/api/health", OPT.supportStackTimeoutMs);
    await waitForGrafanaDashboard(OPT.supportStackTimeoutMs);
  } catch (error) {
    const diagnostics = supportStackDiagnostics();
    const hint = OPT.startSupportStack
      ? "The demo attempted to start the support stack automatically."
      : "Automatic stack startup was disabled with --no-stack-start.";
    throw new Error(
      `The public demo support stack did not become ready. ${hint}` +
        `${diagnostics ? `\n\n${diagnostics}` : ""}`,
      { cause: error },
    );
  }

  supportStackReady = true;
  console.log(`${GREEN}   ✓ Telemetry relay, Prometheus, Grafana, and Redis are ready${OFF}`);
  openGrafanaDashboard();
}

async function flushRedis() {
  const redis = new RedisClient();
  try {
    await redis.connect();
    await redis.command("DEL", "bench:leases", "bench:tokens", "bench:inflight");
  } catch (error) {
    throw new Error(
      "Redis was not reachable after the support stack started. Run `docker compose -f demo/compose.yaml ps` and inspect the Redis container logs.",
      { cause: error },
    );
  } finally {
    redis.close();
  }
}

// ── an arm run ───────────────────────────────────────────────────────

/**
 * Starts the simulator and `replicas` replicas on the given arm, runs the
 * workload, and returns the load generator's summary.
 *
 * Every arm gets the same simulator settings, the same seed, and the same
 * arrival schedule. The admission policy is the only variable.
 */
async function runArm({ label, arm, maxConcurrent, tokenBudget = 0, maxQueue = 0, killReplicaAtMs = 0 }) {
  await ensureSupportStack();
  if (arm === "redis") await flushRedis();

  const sim = launch("sim", "sim/provider-sim.mjs", [
    "--port=9000",
    `--envelope=${OPT.envelope}`,
    "--queue=8",
    `--sigma=${OPT.sigma}`,
    `--kappa=${OPT.kappa}`,
    `--r1=${OPT.r1}`,
    `--seed=${OPT.seed}`,
  ]);
  await waitForHealth("http://127.0.0.1:9000");

  const replicas = [];
  for (let i = 1; i <= OPT.replicas; i += 1) {
    const port = 8100 + i;
    replicas.push(
      launch(
        `r${i}`,
        "arms/replica.mjs",
        [
          `--port=${port}`,
          `--id=r${i}`,
          `--arm=${arm}`,
          "--upstream=http://127.0.0.1:9000",
          `--max-concurrent=${maxConcurrent}`,
          `--max-queue=${maxQueue}`,
          `--token-budget=${tokenBudget}`,
          "--lease-ttl-ms=15000",
        ],
      ),
    );
    await waitForHealth(`http://127.0.0.1:${port}`);
  }

  const targets = replicas.map((_, i) => `http://127.0.0.1:${8101 + i}`).join(",");
  const outFile = path.join(RESULTS, `${label}.json`);
  // Never allow a failed arm to fall back to a result left by an earlier run
  // or included as sample data in the repository.
  rmSync(outFile, { force: true });

  await annotate(`arm: ${label}`, [label]);

  // Optionally kill a replica mid-run to expose how each arm handles a lost
  // member of the fleet.
  if (killReplicaAtMs > 0) {
    setTimeout(async () => {
      const victim = replicas.at(-1);
      console.log(`\n${RED}   >> killing replica ${victim.label} (SIGKILL, no clean shutdown)${OFF}`);
      await annotate(`replica killed (${label})`, [label, "fault"]);
      try {
        victim.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, killReplicaAtMs);
  }

  // Re-check the relay immediately before launching the ephemeral load generator.
  await waitForUrl(`${TELEMETRY_RELAY_URL}/healthz`, 5000);

  const gen = launch(
    "loadgen",
    "load/loadgen.mjs",
    [
    `--targets=${targets}`,
    `--arm-label=${label}`,
    `--duration-ms=${OPT.phaseMs}`,
    `--seed=${OPT.seed}`,
    `--interactive-rps=${WORKLOAD.interactiveRps}`,
    `--interactive-input-chars=${WORKLOAD.interactiveInputChars}`,
    `--interactive-max-tokens=${WORKLOAD.interactiveMaxTokens}`,
    `--batch-start-ms=${WORKLOAD.batchStartMs}`,
    `--batch-duration-ms=${WORKLOAD.batchDurationMs}`,
    `--batch-rps=${WORKLOAD.batchRps}`,
    `--batch-input-chars=${WORKLOAD.batchInputChars}`,
    `--batch-max-tokens=${WORKLOAD.batchMaxTokens}`,
    "--metrics-port=0",
    `--metrics-relay-url=${TELEMETRY_RELAY_URL}/ingest`,
    "--metrics-relay-required",
      `--out=${outFile}`,
    ],
    // Show the generator's own start line in the recording; the rest of its
    // output is drained and replaced by this script's formatted report.
    { echo: false },
  );

  const genExit = await new Promise((resolve) => {
    gen.on("exit", (code, signal) => resolve({ code, signal }));
  });
  if (genExit.code !== 0) {
    stopAll();
    const reason = genExit.signal ? `signal ${genExit.signal}` : `exit code ${genExit.code}`;
    throw new Error(`load generator failed for ${label} (${reason}); no result will be reported`);
  }
  if (!existsSync(outFile)) {
    stopAll();
    throw new Error(`load generator exited successfully but did not write ${outFile}`);
  }

  // Capture the simulator's own view before tearing it down: this is ground
  // truth for how much provider capacity each arm actually burned.
  let simStats = null;
  try {
    simStats = await (await fetch("http://127.0.0.1:9000/admin/stats")).json();
  } catch {
    /* sim already gone */
  }

  let overhead = 0;
  try {
    const text = await (await fetch("http://127.0.0.1:8101/metrics")).text();
    const m = /replica_admission_overhead_ms_avg\{[^}]*\}\s+([\d.]+)/.exec(text);
    if (m) overhead = Number(m[1]);
  } catch {
    /* replica already gone */
  }

  stopAll();
  await sleep(500);

  const summary = JSON.parse(readFileSync(outFile, "utf8"));
  summary.simCounters = simStats?.counters ?? null;
  summary.admissionOverheadMs = overhead;
  writeFileSync(outFile, JSON.stringify(summary, null, 2));
  return summary;
}

function reportArm(summary) {
  const i = summary.classes.interactive;
  const b = summary.classes.batch;
  const sim = summary.simCounters ?? {};
  console.log(
    `\n   ${BOLD}interactive${OFF}  success ${(i.successRate * 100).toFixed(0)}%  ` +
      `p99 ${(i.latencyMs.p99 / 1000).toFixed(1)}s  ttft-p99 ${(i.ttftMs.p99 / 1000).toFixed(2)}s  ` +
      `retries ${i.retryAmplification}x`,
  );
  console.log(
    `   ${BOLD}batch${OFF}        success ${(b.successRate * 100).toFixed(0)}%  ` +
      `p99 ${(b.latencyMs.p99 / 1000).toFixed(1)}s  retries ${b.retryAmplification}x`,
  );
  console.log(
    `   ${BOLD}rejects${OFF}      cheap/local ${i.localReject + b.localReject}  ` +
      `expensive/upstream-429 ${i.upstreamReject + b.upstreamReject}`,
  );
  console.log(
    `   ${BOLD}provider${OFF}     peak in-flight ${sim.peakActive ?? "?"}/${OPT.envelope}  ` +
      `429s issued ${sim.rejected429 ?? "?"}  output tokens ${sim.trueOutputTokens ?? "?"}`,
  );
  if (summary.admissionOverheadMs > 0) {
    console.log(`   ${BOLD}admission${OFF}    ${summary.admissionOverheadMs.toFixed(2)}ms per decision`);
  }
  if (summary.generatorSaturated > 0) {
    console.log(`   ${RED}${BOLD}INVALID${OFF} generator saturated ${summary.generatorSaturated}x — discard`);
  }
}

// ── phases ───────────────────────────────────────────────────────────

const results = {};
const want = (name) => OPT.onlyPhase === "" || OPT.onlyPhase === name;

// Start observability before the first narrated pause so the dashboard is
// already visible while the instrument-validation and contention-sweep phases
// run. `runArm` keeps the same guard for direct phase-only invocations.
await ensureSupportStack();

console.log(`${BOLD}MoFlux benchmark harness — narrated walkthrough${OFF}`);
note(
  `provider envelope ${OPT.envelope} concurrent, USL sigma=${OPT.sigma} kappa=${OPT.kappa}, r1=${OPT.r1} tok/s`,
  `${OPT.replicas} application replicas, seed ${OPT.seed}, ${OPT.phaseMs / 1000}s per arm`,
  `Grafana: ${OPT.grafana}  (phase markers are pushed as annotations)`,
);

// ── 0 ────────────────────────────────────────────────────────────────
if (want("verify") && !OPT.skipVerify) {
  banner(0, "Validate the instrument before trusting it");
  note(
    "The simulator claims per-stream token rate degrades with concurrency along",
    "the Universal Scalability Law. Before measuring anything, check that its",
    "observed throughput actually matches that model — plus that it enforces its",
    "envelope and produces a heavy-tailed output distribution.",
    "A benchmark with an unvalidated simulator is an assertion with extra steps.",
  );
  await pause("run the simulator self-test");
  const verify = spawnSync(process.execPath, [path.join(ROOT, "sim/verify-sim.mjs")], {
    stdio: "inherit",
  });
  if (verify.status !== 0) {
    console.error(`\n${RED}Simulator self-test FAILED — stopping. Do not present these numbers.${OFF}`);
    process.exit(1);
  }
  await pause();
}

// ── 1 ────────────────────────────────────────────────────────────────
if (want("sweep")) {
  banner(1, "The contention curve is a parameter, not an assumption");
  note(
    "sigma is the one number a skeptic will attack: 'you tuned the sim to win.'",
    "So it is swept rather than chosen. sigma=0 means capacity is effectively",
    "free and admission control should show little benefit — that is the null",
    "hypothesis. Larger sigma is a pool where concurrency genuinely costs",
    "throughput. Results must hold across the range, not at one flattering point.",
  );
  await pause("sweep sigma");
  const sweep = spawnSync(process.execPath, [path.join(ROOT, "sim/sweep.mjs")], { stdio: "inherit" });
  if (sweep.status !== 0) console.error(`${YELLOW}   sweep exited non-zero${OFF}`);
  await pause();
}

// ── 2 ────────────────────────────────────────────────────────────────
if (want("baseline")) {
  banner(2, "Arm 1 — baseline: no admission control");
  note(
    `${OPT.replicas} replicas send straight to the provider and retry on failure.`,
    "Watch for the batch step function: interactive latency should collapse, and",
    "every rejection here is an expensive one — a 429 earned only after provider",
    "capacity was already spent on the request.",
  );
  await pause("run the baseline");
  results.baseline = await runArm({ label: "baseline", arm: "passthrough", maxConcurrent: 0 });
  reportArm(results.baseline);
  await pause();
}

// ── 3 ────────────────────────────────────────────────────────────────
if (want("percapped")) {
  banner(3, "Arm 3 — the pathology: every replica caps at the full envelope");
  note(
    `Each replica limits itself to ${OPT.envelope} concurrent — the pool's full`,
    "envelope. In isolation that reads as correct, and on a single process it is.",
    `With ${OPT.replicas} replicas the fleet can hold ${OPT.replicas}x the pool's capacity.`,
    "",
    "Predict the result before running it: this arm should come out close to",
    "indistinguishable from Arm 1. A cap that never binds is not protection, it",
    "is configuration that looks like protection. If the two arms match, that is",
    "the finding — not a bug in the harness.",
  );
  await pause("run the pathological cap");
  results.percapped = await runArm({
    label: "static-cap-per-replica",
    arm: "static-cap",
    maxConcurrent: OPT.envelope,
  });
  reportArm(results.percapped);
  await pause();
}

// ── 4 ────────────────────────────────────────────────────────────────
if (want("static")) {
  banner(4, "Arm 2 — static cap, envelope divided by replica count");
  note(
    `Each replica caps at ${Math.floor(OPT.envelope / OPT.replicas)} = envelope/replicas.`,
    "This is the competent hand-rolled answer and it works well — while the",
    "replica count is exactly what you assumed when you set the number.",
  );
  await pause("run the static cap");
  results.static = await runArm({
    label: "static-cap-divided",
    arm: "static-cap",
    maxConcurrent: Math.floor(OPT.envelope / OPT.replicas),
    maxQueue: 4,
  });
  reportArm(results.static);
  await pause();
}

// ── 5 ────────────────────────────────────────────────────────────────
if (want("static-fault")) {
  banner(5, "Arm 2 under a fault — a replica dies mid-run");
  note(
    "Same static cap, but one replica is SIGKILLed partway through. Its share of",
    "the envelope is now stranded: no surviving replica may use it, because the",
    "divisor is baked into config. The pool sits underutilised while callers are",
    "refused. Watch peak in-flight fall below the envelope.",
  );
  await pause("run the static cap with a replica failure");
  results.staticFault = await runArm({
    label: "static-cap-divided-fault",
    arm: "static-cap",
    maxConcurrent: Math.floor(OPT.envelope / OPT.replicas),
    maxQueue: 4,
    killReplicaAtMs: Math.round(OPT.phaseMs * 0.45),
  });
  reportArm(results.staticFault);
  await pause();
}

// ── 6 ────────────────────────────────────────────────────────────────
if (want("redis")) {
  banner(6, "Arm 4 — Redis: shared concurrency and token budget");
  note(
    "The real buy-vs-build competitor, built properly: an atomic Lua reserve of",
    "both a concurrency slot and a token reservation, with TTL leak recovery.",
    "Expect it to do well — that is the honest result. What to watch instead:",
    "the per-decision Redis round trip, and that batch and interactive traffic",
    "compete on equal terms because there is no priority reserve.",
  );
  await pause("run the coordinated Redis arm");
  results.redis = await runArm({
    label: "redis-coordinated",
    arm: "redis",
    maxConcurrent: OPT.envelope,
    tokenBudget: OPT.tokenBudget,
  });
  reportArm(results.redis);
  await pause();
}

// ── 7 ────────────────────────────────────────────────────────────────
if (want("redis-fault")) {
  banner(7, "Arm 4 under the same fault");
  note(
    "A replica dies holding leases. Coordination means survivors can reclaim the",
    "capacity — but only once the leases expire. The TTL is the recovery window,",
    "and shortening it to recover faster raises the risk of revoking capacity",
    "from a replica that was merely slow. That trade-off is the point.",
  );
  await pause("run the Redis arm with a replica failure");
  results.redisFault = await runArm({
    label: "redis-coordinated-fault",
    arm: "redis",
    maxConcurrent: OPT.envelope,
    tokenBudget: OPT.tokenBudget,
    killReplicaAtMs: Math.round(OPT.phaseMs * 0.45),
  });
  reportArm(results.redisFault);
  await pause();
}

// ── 8 ────────────────────────────────────────────────────────────────
if (want("moflux")) {
  banner(8, "Arms 5 and 6 — Tyr observe and enforce");
  note(
    "Not runnable from this repository. Tyr and Latchflo are proprietary and are",
    "not redistributed here, so these two arms require a licensed image.",
    "",
    "This is stated plainly rather than hidden: arms 1-4 above are fully",
    "reproducible by anyone who clones this repo, and the MoFlux numbers",
    "published in results/ are not. A reader can reproduce the baselines,",
    "confirm the simulator matches its own model, and judge whether the",
    "published MoFlux figures are plausible against the arm-4 result they ran",
    "themselves. That is a weaker claim than full reproducibility and it should",
    "be read as such.",
    "",
    "Licensed users should run `npm run demo:moflux`; the one-command presenter",
    "initializes Latchflo, starts Tyr, runs the workload, and reports recovery.",
  );
  if (process.env.MOFLUX_TYR_IMAGE) {
    note("", `MOFLUX_TYR_IMAGE is set (${process.env.MOFLUX_TYR_IMAGE}).`, "Run `npm run demo:moflux` for the integrated licensed arm.");
  }
  await pause();
}

// ── 9 ────────────────────────────────────────────────────────────────
banner(9, "Comparison");

const order = [
  ["baseline", "Arm 1  no control"],
  ["percapped", "Arm 3  cap = envelope (each)"],
  ["static", "Arm 2  cap = envelope/N"],
  ["staticFault", "Arm 2  + replica killed"],
  ["redis", "Arm 4  redis coordinated"],
  ["redisFault", "Arm 4  + replica killed"],
];

const rows = [];
for (const [key, name] of order) {
  const s = results[key];
  if (!s) continue;
  const i = s.classes.interactive;
  const b = s.classes.batch;
  rows.push({
    arm: name,
    "int success": `${(i.successRate * 100).toFixed(0)}%`,
    "int p99 s": (i.latencyMs.p99 / 1000).toFixed(1),
    "int ttft p99 s": (i.ttftMs.p99 / 1000).toFixed(2),
    "batch success": `${(b.successRate * 100).toFixed(0)}%`,
    retries: `${i.retryAmplification}x`,
    "cheap rejects": i.localReject + b.localReject,
    "upstream 429": i.upstreamReject + b.upstreamReject,
    "peak/env": `${s.simCounters?.peakActive ?? "?"}/${OPT.envelope}`,
  });
}
console.table(rows);

writeFileSync(path.join(RESULTS, "comparison.json"), JSON.stringify({ options: OPT, workload: WORKLOAD, results }, null, 2));
console.log(`\n${GREEN}   wrote results/comparison.json${OFF}`);
note(
  "",
  "One run of one seed is an anecdote. For anything published, run at least five",
  "seeds per arm and report medians with spread — see scripts/replicate.sh.",
);

rl.close();
stopAll();
process.exit(0);
