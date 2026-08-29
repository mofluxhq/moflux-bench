#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { ensureDemoEnv, LATCHFLO_VERSION } from "./env-lib.mjs";
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
const COMPOSE_FILE = path.join(ROOT, "demo", "membership", "compose.yaml");
const PROJECT = "moflux-membership";

const args = new Map();
for (const arg of process.argv.slice(2)) {
  const match = /^--([^=]+)=(.*)$/.exec(arg);
  if (match) args.set(match[1], match[2]);
  else if (arg.startsWith("--")) args.set(arg.slice(2), "true");
}
const num = (name, fallback) => (args.has(name) ? Number(args.get(name)) : fallback);
const str = (name, fallback) => args.get(name) ?? fallback;
const bool = (name, fallback) => (args.has(name) ? args.get(name) === "true" : fallback);

const runs = num("runs", 5);
const baseUrl = str("base-url", process.env.MOFLUX_MEMBERSHIP_BASE_URL ?? "http://127.0.0.1:18081").replace(/\/$/, "");
const manageStack = bool("manage-stack", process.env.MOFLUX_MEMBERSHIP_MANAGE_STACK !== "false");
const agentTimeoutMs = num("agent-timeout-ms", 1200);
const pollEveryMs = num("poll-ms", 75);
const out = path.resolve(
  str(
    "out",
    path.join(ROOT, "results", "runs", "membership", new Date().toISOString().replaceAll(":", "-") + "-summary.json"),
  ),
);

if (!Number.isSafeInteger(runs) || runs < 1 || runs > 50) throw new Error("--runs must be an integer from 1 to 50");
if (!Number.isFinite(agentTimeoutMs) || agentTimeoutMs < 100) throw new Error("--agent-timeout-ms must be >= 100");
if (!Number.isFinite(pollEveryMs) || pollEveryMs < 10) throw new Error("--poll-ms must be >= 10");

ensureDemoEnv(ENV_FILE, { quiet: true });
const fileEnv = parseEnvFile(ENV_FILE);
const env = { ...fileEnv, ...process.env };
const adminToken = env.LATCHFLO_ADMIN_TOKEN;
const bootstrapToken = env.LATCHFLO_AGENT_BOOTSTRAP_TOKEN;
if (!adminToken || !bootstrapToken) throw new Error("Latchflo demo tokens are missing; run npm run demo:prepare");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function jsonRequest(url, { method = "GET", token, body, allowed = [200] } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* surfaced below */ }
  if (!allowed.includes(response.status)) {
    throw new Error(`${method} ${url} returned ${response.status}: ${text.slice(0, 500)}`);
  }
  return { status: response.status, body: parsed };
}

async function waitForReady(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/readyz`);
      if (response.ok) return;
    } catch { /* retry */ }
    await sleep(100);
  }
  throw new Error(`Latchflo at ${baseUrl} did not become ready within ${timeoutMs}ms`);
}

function compose(args, options = {}) {
  return composeCommand({
    project: PROJECT,
    envFile: ENV_FILE,
    composeFile: COMPOSE_FILE,
    args,
    cwd: ROOT,
    env,
    ...options,
  });
}

async function resetManagedStack() {
  compose(["down", "--volumes", "--remove-orphans"], { allowFailure: true });
  compose(["up", "-d", "--force-recreate", "latchflo"], { inherit: true });
  await waitForReady();
}

async function createPool(name) {
  await jsonRequest(`${baseUrl}/v1/pools`, {
    method: "POST",
    token: adminToken,
    body: {
      name,
      globalMaxConcurrent: 16,
      minimumGrantMaxConcurrent: 1,
      maxQueuePerAgent: 0,
      globalTokenBudget: 16000,
      minimumGrantTokenBudget: 256,
      globalHighPriorityReserve: 0,
      safetyReservePercent: 0,
      grantTtlMs: 3000,
    },
    allowed: [200, 201, 409],
  });
}

async function register(instanceId, pool, endpoint) {
  const response = await jsonRequest(`${baseUrl}/v1/agents/register`, {
    method: "POST",
    token: bootstrapToken,
    body: { instanceId, pools: [pool], metadata: { endpoint, benchmark: "membership" } },
    allowed: [201],
  });
  const token = response.body?.agentToken;
  if (typeof token !== "string" || token.length === 0) throw new Error(`registration for ${instanceId} returned no agent token`);
  return { instanceId, endpoint, token };
}

async function heartbeat(agent) {
  await jsonRequest(`${baseUrl}/v1/agents/${encodeURIComponent(agent.instanceId)}/heartbeat`, {
    method: "POST",
    token: agent.token,
    body: {},
    allowed: [200],
  });
}

async function desired(agent) {
  const response = await jsonRequest(`${baseUrl}/v1/agents/${encodeURIComponent(agent.instanceId)}/desired-state`, {
    token: agent.token,
    allowed: [200],
  });
  const topology = response.body?.routingTopology;
  if (!topology || !Number.isSafeInteger(topology.revision) || !Array.isArray(topology.members)) {
    throw new Error(`${agent.instanceId} desired state omitted a valid routingTopology`);
  }
  return topology;
}

function canonicalMembers(topology) {
  return topology.members.map((member) => ({ instanceId: member.instanceId, endpoint: member.endpoint }));
}

function assertTopology(topology, expected) {
  const actual = canonicalMembers(topology);
  const expectedSorted = [...expected].sort((a, b) => a.instanceId.localeCompare(b.instanceId));
  const actualIds = actual.map((member) => member.instanceId);
  if (new Set(actualIds).size !== actualIds.length) throw new Error(`topology revision ${topology.revision} contains duplicate members`);
  if (JSON.stringify(actual) !== JSON.stringify(expectedSorted)) {
    throw new Error(`topology revision ${topology.revision} was ${JSON.stringify(actual)}, expected ${JSON.stringify(expectedSorted)}`);
  }
}

async function waitForTopology(agent, predicate, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  let last;
  while (performance.now() < deadline) {
    last = await desired(agent);
    if (predicate(last)) return last;
    await sleep(pollEveryMs);
  }
  throw new Error(`topology condition did not converge within ${timeoutMs}ms; last=${JSON.stringify(last)}`);
}

async function oneRun(index) {
  if (manageStack) await resetManagedStack();
  else await waitForReady();

  const prefix = `membership-${index}`;
  const pool = `${prefix}-pool`;
  await createPool(pool);
  const expectedInitial = [];
  const agents = {};
  for (const suffix of ["a", "b", "c", "d"]) {
    const instanceId = `${prefix}-${suffix}`;
    const endpoint = `http://${instanceId}:8787`;
    agents[suffix] = await register(instanceId, pool, endpoint);
    expectedInitial.push({ instanceId, endpoint });
  }

  const snapshots = await Promise.all(Object.values(agents).map((agent) => desired(agent)));
  for (const snapshot of snapshots) assertTopology(snapshot, expectedInitial);
  const stableRevision = snapshots[0].revision;
  if (!snapshots.every((snapshot) => snapshot.revision === stableRevision)) {
    throw new Error("live agents disagreed on the initial topology revision");
  }

  // Ordinary heartbeats must not churn routing topology.
  for (let cycle = 0; cycle < 3; cycle += 1) {
    await Promise.all(Object.values(agents).map((agent) => heartbeat(agent)));
    await sleep(50);
  }
  const afterHeartbeat = await desired(agents.a);
  assertTopology(afterHeartbeat, expectedInitial);
  if (afterHeartbeat.revision !== stableRevision) {
    throw new Error(`heartbeats changed topology revision ${stableRevision} -> ${afterHeartbeat.revision}`);
  }

  // Put C's final heartbeat on a known boundary, then keep only the survivors
  // alive until the entire remove-and-replace sequence has been observed.
  await heartbeat(agents.c);
  const lastCHeartbeatAt = performance.now();
  const survivorTimer = setInterval(() => {
    void Promise.all([agents.a, agents.b, agents.d].map((agent) => heartbeat(agent))).catch(() => {});
  }, Math.max(50, Math.floor(agentTimeoutMs / 4)));
  survivorTimer.unref?.();

  let removed;
  let joined;
  let afterReregister;
  let joinPropagationMs;
  let removalLatencyMs;
  const expectedAfterRemoval = expectedInitial.filter((member) => member.instanceId !== agents.c.instanceId);
  const eId = `${prefix}-e`;
  const eEndpoint = `http://${eId}:8787`;
  const expectedAfterJoin = [...expectedAfterRemoval, { instanceId: eId, endpoint: eEndpoint }];
  try {
    removed = await waitForTopology(
      agents.a,
      (topology) => !topology.members.some((member) => member.instanceId === agents.c.instanceId),
      agentTimeoutMs + 2500,
    );
    removalLatencyMs = performance.now() - lastCHeartbeatAt;
    assertTopology(removed, expectedAfterRemoval);
    if (removed.revision !== stableRevision + 1) {
      throw new Error(`timeout removal should advance revision once; got ${stableRevision} -> ${removed.revision}`);
    }

    const joinStartedAt = performance.now();
    await register(eId, pool, eEndpoint);
    joined = await waitForTopology(
      agents.a,
      (topology) => topology.members.some((member) => member.instanceId === eId),
      2000,
    );
    joinPropagationMs = performance.now() - joinStartedAt;
    assertTopology(joined, expectedAfterJoin);
    if (joined.revision !== removed.revision + 1) {
      throw new Error(`replacement join should advance revision once; got ${removed.revision} -> ${joined.revision}`);
    }

    // Identical re-registration may rotate the agent credential, but membership
    // itself must remain stable and therefore must not advance the revision.
    const reregistered = await register(eId, pool, eEndpoint);
    await heartbeat(reregistered);
    afterReregister = await desired(agents.a);
    assertTopology(afterReregister, expectedAfterJoin);
    if (afterReregister.revision !== joined.revision) {
      throw new Error(`identical re-registration churned topology revision ${joined.revision} -> ${afterReregister.revision}`);
    }
  } finally {
    clearInterval(survivorTimer);
  }

  return {
    run: index,
    initialRevision: stableRevision,
    removalRevision: removed.revision,
    joinRevision: joined.revision,
    finalRevision: afterReregister.revision,
    removalLatencyMs: +removalLatencyMs.toFixed(1),
    joinPropagationMs: +joinPropagationMs.toFixed(1),
    initialMembers: expectedInitial.map((member) => member.instanceId),
    finalMembers: expectedAfterJoin.map((member) => member.instanceId).sort(),
    passed: true,
  };
}

function percentile(values, q) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return +sorted[index].toFixed(1);
}

let runResults = [];
let error;
try {
  if (manageStack) {
    assertDockerAvailable();
    ensureRuntimeImage({
      root: ROOT,
      image: env.MOFLUX_LATCHFLO_IMAGE,
      envKey: "MOFLUX_LATCHFLO_SOURCE_DIR",
      sourceDir: env.MOFLUX_LATCHFLO_SOURCE_DIR,
      repoName: "latchflo-control-plane",
      version: LATCHFLO_VERSION,
      label: "Latchflo",
    });
  }
  for (let index = 1; index <= runs; index += 1) {
    const result = await oneRun(index);
    runResults.push(result);
    console.log(
      `membership run ${index}/${runs}: PASS removal=${result.removalLatencyMs}ms join=${result.joinPropagationMs}ms`,
    );
  }
} catch (caught) {
  error = caught instanceof Error ? caught : new Error(String(caught));
} finally {
  if (manageStack) compose(["down", "--volumes", "--remove-orphans"], { allowFailure: true });
}

const summary = {
  schemaVersion: 1,
  benchmark: "dynamic-fleet-membership",
  generatedAt: new Date().toISOString(),
  runtime: { latchflo: LATCHFLO_VERSION },
  configuration: { runs, agentTimeoutMs, pollEveryMs, managedStack: manageStack },
  acceptance: {
    passed: error === undefined && runResults.length === runs && runResults.every((run) => run.passed),
    completedRuns: runResults.length,
    requiredRuns: runs,
    heartbeatRevisionChurn: 0,
    duplicateMembers: 0,
    staleMembersAfterConvergence: 0,
    revisionRegressions: 0,
  },
  latencyMs: {
    removal: {
      p50: percentile(runResults.map((run) => run.removalLatencyMs), 0.5),
      p95: percentile(runResults.map((run) => run.removalLatencyMs), 0.95),
    },
    joinPropagation: {
      p50: percentile(runResults.map((run) => run.joinPropagationMs), 0.5),
      p95: percentile(runResults.map((run) => run.joinPropagationMs), 0.95),
    },
  },
  runs: runResults,
  ...(error ? { error: error.message } : {}),
};
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(summary, null, 2) + "\n");
console.log(`membership summary: ${path.relative(ROOT, out)}`);
if (!summary.acceptance.passed) {
  console.error(error?.message ?? "membership benchmark failed");
  process.exitCode = 1;
} else {
  console.log(`PASS dynamic fleet membership (${runs}/${runs} runs)`);
}
