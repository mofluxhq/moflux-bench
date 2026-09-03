#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTrace } from "../load/trace-lib.mjs";
import {
  ASYNC_BULKHEAD_LLM_VERSION,
  ASYNC_BULKHEAD_TS_VERSION,
  LATCHFLO_VERSION,
  TYR_VERSION,
  ensureDemoEnv,
  imageMatchesVersion,
} from "./env-lib.mjs";
import {
  assertHostPortFree,
  fetchWithTimeout,
  launchNode,
  sleep,
  stopHostChildren,
  terminateHostChild,
  waitFor,
  waitForChildOutput,
} from "./host-process-lib.mjs";
import { startIdentityFixture } from "./identity-fixture-lib.mjs";
import {
  compareTenantFairness,
  TENANT_FAIRNESS_POLICY,
  aggregateAdmissionClassGrants,
  summarizeAdaptiveClassHandoff,
  summarizeAdaptiveLendingSamples,
  tenantClassRestorationClaim,
  tenantFairnessProof,
  tenantPoolDefinition,
  validateAdmissionClassCeilings,
  validateAdmissionClassGrantSet,
  validateNoisyRequestFitsEveryGrant,
} from "./tenant-fairness-lib.mjs";
import {
  aggregateRestorationLadder,
  restorationEnforceabilityVerdict,
  summarizeBorrowedDeadlineCost,
  summarizeLatchfloRestorationEpisodes,
  summarizeTyrRestoration,
  summarizeUnlentFloorGauges,
} from "./restoration-enforceability-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_COMPOSE = path.join(ROOT, "demo", "compose.yaml");
const CLASSES_COMPOSE = path.join(ROOT, "demo", "classes", "compose.yaml");
const ENV_FILE = process.env.MOFLUX_BENCH_ENV_FILE
  ? path.resolve(process.env.MOFLUX_BENCH_ENV_FILE)
  : path.join(ROOT, "demo", "moflux", ".env");
const IDENTITY_RUNTIME = path.join(ROOT, "demo", "classes", "runtime");
const RESULTS_ROOT = process.env.MOFLUX_BENCH_RESULTS_DIR
  ? path.resolve(process.env.MOFLUX_BENCH_RESULTS_DIR)
  : path.join(ROOT, "results", "runs", "tenant-fairness");
const TYR_PORTS = [8101, 8102, 8103, 8104];
const TYR_SERVICES = ["tyr-r1", "tyr-r2", "tyr-r3", "tyr-r4"];
const PROVIDER_PORT = 9000;
const PROVIDER_IDENTITY_URL = `http://127.0.0.1:${PROVIDER_PORT}/admin/stats`;

/**
 * Confirms the provider simulator this run launched is the one its replicas
 * will reach. A bound socket is not the same as owning the address: on macOS a
 * listener bound to `127.0.0.1` coexists with the simulator's `0.0.0.0` bind and
 * wins loopback, so the run would otherwise proceed to a full measured phase in
 * which nothing succeeds and no admission decision is ever made.
 */
async function assertProviderIdentity(readyLine) {
  const expected = /instance=([0-9a-f-]{36})/.exec(readyLine ?? "")?.[1] ?? null;
  let payload;
  try {
    const response = await fetch(PROVIDER_IDENTITY_URL, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    payload = await response.json();
  } catch (error) {
    throw new Error(
      `provider simulator announced itself on port ${PROVIDER_PORT} but ${PROVIDER_IDENTITY_URL} did not ` +
        `answer as the simulator (${error instanceof Error ? error.message : String(error)}). ` +
        `Check \`lsof -nP -iTCP:${PROVIDER_PORT} -sTCP:LISTEN\` and HTTP_PROXY/HTTPS_PROXY/NO_PROXY.`,
    );
  }
  if (payload?.service !== "moflux-provider-sim") {
    throw new Error(`${PROVIDER_IDENTITY_URL} is answering, but it is not provider-sim`);
  }
  if (expected && payload.instance !== expected) {
    throw new Error(
      `${PROVIDER_IDENTITY_URL} is a provider simulator, but not the one this seed started ` +
        `(expected ${expected}, reached ${payload.instance})`,
    );
  }
}
const ENROLLMENT_TTL_MS = 3000;
const STEADY_TTL_MS = TENANT_FAIRNESS_POLICY.adaptive.grantTtlMs;

const args = new Map();
for (const arg of process.argv.slice(2)) {
  const match = /^--([^=]+)=(.*)$/.exec(arg);
  if (match) args.set(match[1], match[2]);
  else if (arg.startsWith("--")) args.set(arg.slice(2), "true");
}
const str = (name, fallback) => args.get(name) ?? fallback;
const num = (name, fallback) => args.has(name) ? Number(args.get(name)) : fallback;
const flag = (name) => args.get(name) === "true";

function parseSeeds(raw) {
  const values = [];
  for (const part of raw.split(",").map((value) => value.trim()).filter(Boolean)) {
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
  if (values.length === 0 || values.some((seed) => !Number.isSafeInteger(seed) || seed < 0)) {
    throw new Error("--seeds must contain non-negative integer seeds or ranges");
  }
  return [...new Set(values)];
}

const OPT = Object.freeze({
  seeds: parseSeeds(str("seeds", "1-5")),
  durationMs: num("duration-ms", 30000),
  pauseMs: num("pause-ms", 0),
  requireProof: flag("require-proof"),
  doctor: flag("doctor"),
  keepStack: flag("keep-stack"),
  /**
   * Adds the two restoration-enforceability arms introduced with Latchflo
   * 0.15.0 and Tyr 0.30.0.
   *
   * Off by default so the published four-arm comparison keeps running exactly
   * the arms it has always run. The ladder is additive: it replays the same
   * trace through `sim-unlent` (an allocation-enforced token slice) and
   * `sim-deadline` (that plus Tyr's bounded borrowed-slot deadline), so the
   * mechanism is the only variable against `sim-adaptive`.
   */
  restorationLadder: flag("restoration-ladder"),
});
if (!Number.isSafeInteger(OPT.durationMs) || OPT.durationMs < 15000) {
  throw new Error("--duration-ms must be an integer of at least 15000");
}

const WORKLOAD_BASE = Object.freeze({
  durationMs: OPT.durationMs,
  interactiveRps: 6,
  interactiveInputChars: 1200,
  interactiveMaxTokens: 400,
  batchStartMs: 5000,
  batchDurationMs: OPT.durationMs - 5000,
  batchRps: 5,
  batchInputChars: 15000,
  batchMaxTokens: 4000,
  maxAttempts: 3,
  backoffBaseMs: 250,
  sizeDistribution: "uniform",
  interactiveSizeSigma: 0.75,
  batchSizeSigma: 0,
  inFlightCeiling: 3000,
  windowMs: OPT.durationMs,
});

function parseEnv(file) {
  const values = {};
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index < 1) continue;
    values[line.slice(0, index).trim()] = line.slice(index + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return values;
}

function command(cmd, argv, { allowFailure = false, quiet = false } = {}) {
  const result = spawnSync(cmd, argv, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: quiet ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(
      `${cmd} ${argv.join(" ")} failed with exit code ${result.status}` +
        (quiet ? `: ${result.stderr || result.stdout || "<no output>"}` : ""),
    );
  }
  return result;
}

function composeArgs(...rest) {
  return [
    "compose", "--env-file", ENV_FILE,
    "-f", BASE_COMPOSE, "-f", CLASSES_COMPOSE,
    ...rest,
  ];
}
function compose(...rest) { return command("docker", composeArgs(...rest)); }

async function jsonRequest(url, { method = "GET", token = "", body, allowed = [200] } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetchWithTimeout(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }, 5000);
  const text = await response.text();
  let parsed = null;
  if (text.trim()) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  if (!allowed.includes(response.status)) {
    throw new Error(`${method} ${url} returned HTTP ${response.status}: ${text || "<empty>"}`);
  }
  return { status: response.status, body: parsed };
}

function sourceVersion(sourceDir) {
  try { return JSON.parse(readFileSync(path.join(sourceDir, "package.json"), "utf8")).version; }
  catch { return null; }
}

function discoverLocalSource(repoName, expectedVersion, explicit = "") {
  if (explicit) {
    const candidate = path.resolve(ROOT, explicit);
    if (!existsSync(path.join(candidate, "Dockerfile"))) {
      throw new Error(`${repoName} source ${candidate} does not contain a Dockerfile`);
    }
    const actualVersion = sourceVersion(candidate);
    if (actualVersion !== expectedVersion) {
      throw new Error(
        `${repoName} source ${candidate} must be version ${expectedVersion}; got ${actualVersion ?? "unknown"}`,
      );
    }
    return candidate;
  }
  const parent = path.resolve(ROOT, "..");
  const candidates = [path.join(parent, repoName)];
  try {
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(`${repoName}-`)) {
        candidates.push(path.join(parent, entry.name));
      }
    }
  } catch { /* packaged parent may be unreadable */ }
  const matches = [...new Set(candidates)].filter((candidate) =>
    existsSync(path.join(candidate, "Dockerfile")) && sourceVersion(candidate) === expectedVersion,
  );
  return matches.length === 1 ? matches[0] : null;
}

function validateImages(env) {
  const expected = [
    ["MOFLUX_TYR_IMAGE", "MOFLUX_TYR_SOURCE_DIR", "tyr-admission-controller", TYR_VERSION],
    ["MOFLUX_LATCHFLO_IMAGE", "MOFLUX_LATCHFLO_SOURCE_DIR", "latchflo-control-plane", LATCHFLO_VERSION],
  ];
  for (const [imageKey, sourceKey, repoName, version] of expected) {
    const image = env[imageKey];
    if (!image) throw new Error(`${imageKey} is missing from ${ENV_FILE}`);
    if (env.MOFLUX_ALLOW_UNPINNED_IMAGES !== "true" && !imageMatchesVersion(image, version)) {
      throw new Error(`${imageKey} must reference ${version}; got ${image}`);
    }
    if (command("docker", ["image", "inspect", image], { allowFailure: true, quiet: true }).status === 0) continue;
    const source = discoverLocalSource(repoName, version, env[sourceKey] ?? "");
    if (source) {
      command("docker", ["build", "-t", image, source]);
      continue;
    }
    const pull = command("docker", ["pull", image], { allowFailure: true, quiet: true });
    if (pull.status !== 0) {
      throw new Error(
        `${image} is unavailable; place ${repoName} ${version} beside the benchmark, ` +
          `set ${sourceKey}, or make the licensed image available`,
      );
    }
  }
}

function validatePrerequisites(env) {
  command("docker", ["--version"], { quiet: true });
  command("docker", ["compose", "version"], { quiet: true });
  command("docker", ["info"], { quiet: true });
  command("openssl", ["version"], { quiet: true });
  validateImages(env);
}

/**
 * The pools this run configures.
 *
 * Both restoration-ladder pools use the `unlent` class policy: the Latchflo
 * contract is identical for the two, and the only difference is that
 * `sim-deadline`'s Tyr config also gives the borrowing class a bounded
 * post-admission deadline. Keeping the control-plane side identical is what
 * isolates Tyr's mechanism from Latchflo's.
 */
function poolSpecs(ttlMs) {
  const specs = [
    tenantPoolDefinition("sim-shared", ttlMs),
    tenantPoolDefinition("sim-ceilings", ttlMs, { classPolicy: "ceilings" }),
    tenantPoolDefinition("sim-protected", ttlMs, { classPolicy: "protected" }),
    tenantPoolDefinition("sim-adaptive", ttlMs, { classPolicy: "adaptive" }),
  ];
  // Tyr's configuration lists all six pools unconditionally, and a managed Tyr
  // will not become ready until every pool it registers for has a grant. So
  // these are created even when the ladder arms are not measured.
  specs.push(
    tenantPoolDefinition("sim-unlent", ttlMs, { classPolicy: "unlent" }),
    tenantPoolDefinition("sim-deadline", ttlMs, { classPolicy: "unlent" }),
  );
  return specs;
}

async function configurePools(token, ttlMs, { allowCreate }) {
  for (const spec of poolSpecs(ttlMs)) {
    const { name, ...body } = spec;
    const update = await jsonRequest(`http://127.0.0.1:18080/v1/pools/${name}`, {
      method: "PUT", token, body, allowed: [200, 404, 405],
    });
    if (update.status === 200) continue;
    if (!allowCreate) throw new Error(`Latchflo could not update pool ${name}`);
    await jsonRequest("http://127.0.0.1:18080/v1/pools", {
      method: "POST", token, body: spec, allowed: [200, 201],
    });
  }
}

async function waitForAgents(token) {
  const deadline = Date.now() + 45000;
  let last = 0;
  while (Date.now() < deadline) {
    const response = await jsonRequest("http://127.0.0.1:18080/v1/agents", { token });
    const agents = Array.isArray(response.body?.agents) ? response.body.agents : [];
    last = agents.length;
    if (agents.length === TYR_PORTS.length) {
      for (const agent of agents) {
        if (agent?.capabilities?.admissionClasses !== true) {
          throw new Error(`${agent.instanceId ?? "unknown agent"} did not advertise admissionClasses capability`);
        }
        if (agent?.capabilities?.admissionClassDemand !== true) {
          throw new Error(`${agent.instanceId ?? "unknown agent"} did not advertise admissionClassDemand capability`);
        }
        if (agent?.capabilities?.admissionClassOccupancyAck !== true) {
          throw new Error(`${agent.instanceId ?? "unknown agent"} did not advertise admissionClassOccupancyAck capability`);
        }
      }
      return agents;
    }
    await sleep(500);
  }
  throw new Error(`Latchflo saw only ${last}/${TYR_PORTS.length} Tyr agents`);
}

async function readTyrStats() {
  return Promise.all(TYR_PORTS.map(async (port) => {
    const response = await fetchWithTimeout(
      `http://127.0.0.1:${port}/stats`,
      { headers: { "x-tyr-identity-token": `Bearer ${identity.tokens.operator}` } },
      2000,
    );
    if (!response.ok) throw new Error(`Tyr ${port} /stats returned HTTP ${response.status}`);
    return response.json();
  }));
}

function classGrantRows(statsRows, poolName) {
  return statsRows.map((row) => ({
    pool: poolName,
    limits: {
      admissionClasses: Object.fromEntries(
        Object.entries(row?.[poolName]?.admissionClasses?.classes ?? {}).map(([id, value]) => [
          id,
          {
            protectedConcurrent: Number(value?.limits?.protectedConcurrent ?? 0),
            maxConcurrent: Number(value?.limits?.maxConcurrent ?? 0),
            protectedInFlightTokens: Number(value?.limits?.protectedInFlightTokens ?? 0),
            maxInFlightTokens: Number(value?.limits?.maxInFlightTokens ?? 0),
          },
        ]),
      ),
    },
  }));
}


function compactAdaptiveStatus(status) {
  if (!status || typeof status !== "object") return null;
  return {
    pool: status.pool ?? "sim-adaptive",
    enabled: status.enabled === true,
    floorRestorationDeadline: status.floorRestorationDeadline ?? null,
    classes: Array.isArray(status.classes)
      ? status.classes.map((entry) => ({
          admissionClass: entry?.admissionClass ?? "",
          demand: {
            state: entry?.demand?.state ?? "unknown",
            inFlight: Number(entry?.demand?.inFlight ?? 0),
            recentAdmissions: Number(entry?.demand?.recentAdmissions ?? 0),
            recentRejections: Number(entry?.demand?.recentRejections ?? 0),
          },
          nominal: {
            protectedConcurrent: Number(entry?.nominal?.protectedConcurrent ?? 0),
            protectedInFlightTokens: Number(entry?.nominal?.protectedInFlightTokens ?? 0),
          },
          active: {
            protectedConcurrent: Number(entry?.active?.protectedConcurrent ?? 0),
            protectedInFlightTokens: Number(entry?.active?.protectedInFlightTokens ?? 0),
          },
          released: {
            protectedConcurrent: Number(entry?.released?.protectedConcurrent ?? 0),
            protectedInFlightTokens: Number(entry?.released?.protectedInFlightTokens ?? 0),
          },
          restorationPending: entry?.restorationPending === true,
        }))
      : [],
  };
}

async function readAdaptiveLendingSample(adminToken, startedAt = Date.now()) {
  const offsetMs = Date.now() - startedAt;
  const [controller, stats] = await Promise.all([
    jsonRequest(
      "http://127.0.0.1:18080/v1/admission-class-demand?pool=sim-adaptive",
      { token: adminToken },
    ),
    readTyrStats(),
  ]);
  const applied = aggregateAdmissionClassGrants(
    classGrantRows(stats, "sim-adaptive"),
    "sim-adaptive",
  );
  return {
    offsetMs,
    observedAtMs: Date.now(),
    controller: compactAdaptiveStatus(controller.body?.status),
    applied,
  };
}

async function waitForAdaptiveNoisyFloorLent(adminToken, timeoutMs = 15_000) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let last = null;
  while (Date.now() <= deadline) {
    await jsonRequest("http://127.0.0.1:18080/v1/pools/sim-adaptive/rebalance", {
      method: "POST", token: adminToken, allowed: [200, 202],
    }).catch(() => null);
    try {
      last = await readAdaptiveLendingSample(adminToken, startedAt);
      if (summarizeAdaptiveLendingSamples([last]).noisyFloorLent) return last;
    } catch (error) {
      last = { error: error instanceof Error ? error.message : String(error) };
    }
    await sleep(250);
  }
  throw new Error(
    `timed out waiting for sim-adaptive noisy floor to be lent before workload start: ${JSON.stringify(last)}`,
  );
}

async function observeAdaptiveLending(adminToken, startedAt, initialSample = null) {
  const samples = initialSample === null ? [] : [{ ...initialSample, offsetMs: 0 }];
  const intervalMs = TENANT_FAIRNESS_POLICY.adaptive.observeIntervalMs;
  const deadline = startedAt + WORKLOAD_BASE.durationMs +
    TENANT_FAIRNESS_POLICY.adaptive.postRunObserveMs;
  while (Date.now() <= deadline) {
    try {
      samples.push(await readAdaptiveLendingSample(adminToken, startedAt));
    } catch (error) {
      samples.push({
        offsetMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await sleep(intervalMs);
  }
  return {
    summary: summarizeAdaptiveLendingSamples(samples),
    samples,
  };
}

async function waitForAdaptiveNoisyFloorRestored(adminToken, startedAt, observation) {
  const samples = [...observation.samples];
  let summary = summarizeAdaptiveLendingSamples(samples);
  if (summary.noisyFloorRestored) {
    return { ...observation, summary, restorationWaitTimedOut: false, postRunRestorationWaitMs: 0 };
  }

  const waitStartedAt = Date.now();
  const deadline = waitStartedAt + TENANT_FAIRNESS_POLICY.adaptive.restorationObserveTimeoutMs;
  const intervalMs = TENANT_FAIRNESS_POLICY.adaptive.observeIntervalMs;
  while (Date.now() <= deadline && !summary.noisyFloorRestored) {
    await jsonRequest("http://127.0.0.1:18080/v1/pools/sim-adaptive/rebalance", {
      method: "POST", token: adminToken, allowed: [200, 202],
    }).catch(() => null);
    try {
      samples.push(await readAdaptiveLendingSample(adminToken, startedAt));
    } catch (error) {
      samples.push({
        offsetMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    summary = summarizeAdaptiveLendingSamples(samples);
    if (summary.noisyFloorRestored) break;
    await sleep(intervalMs);
  }
  return {
    summary,
    samples,
    restorationWaitTimedOut: !summary.noisyFloorRestored,
    postRunRestorationWaitMs: Date.now() - waitStartedAt,
  };
}

async function collectAdaptiveClassHandoff(adminToken, startedAt) {
  await jsonRequest("http://127.0.0.1:18080/v1/pools/sim-adaptive/rebalance", {
    method: "POST", token: adminToken, allowed: [200, 202],
  }).catch(() => null);
  await sleep(100);
  const [eventsResponse, grantsResponse] = await Promise.all([
    jsonRequest("http://127.0.0.1:18080/v1/events?limit=1000", { token: adminToken }),
    jsonRequest("http://127.0.0.1:18080/v1/grants?pool=sim-adaptive&limit=1000", { token: adminToken }),
  ]);
  const events = Array.isArray(eventsResponse.body?.events) ? eventsResponse.body.events : [];
  const grants = Array.isArray(grantsResponse.body?.grants) ? grantsResponse.body.grants : [];
  const summary = summarizeAdaptiveClassHandoff(events, grants, startedAt);
  const handoffEvents = events.filter((event) =>
    event?.payload?.handoffId === summary.handoffId ||
    (event?.entityId === "sim-adaptive" && String(event?.type ?? "").startsWith("admission_class.handoff_")),
  );
  const relevantGrantIds = new Set(
    handoffEvents.flatMap((event) =>
      Array.isArray(event?.payload?.grants)
        ? event.payload.grants.flatMap((entry) => [entry?.grantId, entry?.fromGrantId].filter(Boolean))
        : [event?.entityId].filter(Boolean),
    ),
  );
  return {
    summary,
    events: handoffEvents,
    grants: grants.filter((grant) => relevantGrantIds.has(grant?.grantId)),
  };
}

/**
 * Collects the evidence for one seed's restoration-enforceability ladder.
 *
 * Three independent sources, deliberately: Tyr's `/stats` says which slots it
 * took back and why, Latchflo's episodes and gauges say what it withheld and
 * whether each resource met its own objective, and the load generator says
 * what the caller lost. A verdict built from only the controller's side would
 * report an enforced restoration without ever pricing it.
 */
async function collectRestorationLadder(adminToken, arms) {
  const statsRows = await readTyrStats();
  const metrics = await fetchWithTimeout(
    "http://127.0.0.1:18080/metrics",
    { headers: { authorization: `Bearer ${adminToken}` } },
    3000,
  ).then((response) => (response.ok ? response.text() : ""), () => "");
  // Latchflo filters restoration episodes by protected pool server-side, which
  // is what keeps one arm's evidence out of the other's summary.
  const episodesForPool = async (pool) => {
    const response = await jsonRequest(
      `http://127.0.0.1:18080/v1/restoration-episodes?protectedPool=${encodeURIComponent(pool)}&limit=500`,
      { token: adminToken, allowed: [200, 404] },
    ).catch(() => null);
    return Array.isArray(response?.body?.restorationEpisodes)
      ? response.body.restorationEpisodes
      : [];
  };

  const ladder = {};
  for (const [key, pool, classPolicy] of [
    ["unlent", "sim-unlent", "unlent"],
    ["deadline", "sim-deadline", "unlent"],
  ]) {
    // Every replica reports its own view of the same pool; merging them gives
    // the fleet-wide totals the verdict is about.
    const statsByPool = Object.fromEntries(
      statsRows.map((row, index) => [`${pool}@r${index + 1}`, row?.[pool]]).filter(([, value]) => value !== undefined),
    );
    const tyrRestoration = summarizeTyrRestoration({ statsByPool, tyrVersion: TYR_VERSION });
    const unlentGauges = summarizeUnlentFloorGauges({
      metricsTexts: [metrics],
      latchfloVersion: LATCHFLO_VERSION,
      // Scoped to this arm's own pool: one Latchflo serves all six, and an
      // unscoped scrape would credit this arm with a neighbour's withheld tokens.
      pools: [pool],
    });
    const latchfloEpisodes = summarizeLatchfloRestorationEpisodes({
      episodes: await episodesForPool(pool),
      latchfloVersion: LATCHFLO_VERSION,
    });
    const deadlineCost = summarizeBorrowedDeadlineCost(arms[key]);
    ladder[key] = {
      pool,
      tyrRestoration,
      latchfloEpisodes,
      unlentGauges,
      deadlineCost,
      verdict: restorationEnforceabilityVerdict({
        arm: key === "unlent" ? "moflux-unlent-token-floor" : "moflux-unlent-plus-slot-deadline",
        restorationClaim: tenantClassRestorationClaim(classPolicy),
        tyrRestoration,
        latchfloEpisodes,
        unlentGauges,
        deadlineCost,
      }),
    };
  }
  return ladder;
}

async function waitForUsableFleet(adminToken) {
  const deadline = Date.now() + 60000;
  let last = "no observation";
  while (Date.now() < deadline) {
    try {
      const readiness = await Promise.all(TYR_PORTS.map(async (port) => {
        const response = await fetchWithTimeout(`http://127.0.0.1:${port}/readyz`, {}, 1500);
        return response.status;
      }));
      if (readiness.every((status) => status === 200)) {
        const stats = await readTyrStats();
        for (const row of stats) {
          for (const pool of ["sim-shared", "sim-ceilings", "sim-protected", "sim-adaptive"]) {
            const snapshot = row?.[pool];
            if (Number(snapshot?.limits?.maxConcurrent ?? 0) < 1) {
              throw new Error(`${pool} has no usable concurrency on one replica`);
            }
            if (Number(snapshot?.tokenBudget?.budget ?? 0) < 750) {
              throw new Error(`${pool} has no viable token grant on one replica`);
            }
          }
        }
        const ceilingsRows = classGrantRows(stats, "sim-ceilings");
        const protectedRows = classGrantRows(stats, "sim-protected");
        const adaptiveRows = classGrantRows(stats, "sim-adaptive");
        const adaptiveStatus = await jsonRequest(
          "http://127.0.0.1:18080/v1/admission-class-demand?pool=sim-adaptive",
          { token: adminToken },
        ).catch(() => null);
        const aggregate = {
          ceilings: validateAdmissionClassGrantSet(
            ceilingsRows,
            "sim-ceilings",
            "ceilings",
          ),
          protected: validateAdmissionClassGrantSet(
            protectedRows,
            "sim-protected",
            "protected",
          ),
          adaptive: validateAdmissionClassCeilings(
            adaptiveRows,
            "sim-adaptive",
            "adaptive",
          ),
          adaptiveDemandPolicy: TENANT_FAIRNESS_POLICY.adaptive,
        };
        validateNoisyRequestFitsEveryGrant(ceilingsRows, "sim-ceilings");
        validateNoisyRequestFitsEveryGrant(protectedRows, "sim-protected", {
          requireProtected: true,
        });
        validateNoisyRequestFitsEveryGrant(adaptiveRows, "sim-adaptive");
        return { stats, aggregate, adaptiveStatus: adaptiveStatus?.body?.status ?? null };
      }
      last = `readiness statuses ${readiness.join(",")}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for usable tenant-fairness fleet: ${last}`);
}

async function bootstrapTenantStack(adminToken) {
  compose("down", "--volumes", "--remove-orphans");
  compose("up", "-d", "--force-recreate", "latchflo");
  await waitFor("http://127.0.0.1:18080/readyz", { timeoutMs: 45000, label: "Latchflo readiness" });
  await configurePools(adminToken, ENROLLMENT_TTL_MS, { allowCreate: true });
  compose("up", "-d", "--force-recreate", ...TYR_SERVICES);
  for (const port of TYR_PORTS) {
    await waitFor(`http://127.0.0.1:${port}/healthz`, { timeoutMs: 45000, label: `Tyr ${port} health` });
  }
  await waitForAgents(adminToken);
  await configurePools(adminToken, STEADY_TTL_MS, { allowCreate: false });
  for (const pool of ["sim-shared", "sim-ceilings", "sim-protected", "sim-adaptive"]) {
    await jsonRequest(`http://127.0.0.1:18080/v1/pools/${pool}/rebalance`, {
      method: "POST", token: adminToken, allowed: [200, 202],
    });
  }
  return waitForUsableFleet(adminToken);
}

async function runLoadgen({ seed, model, arm, traceFile, outFile, tokens }) {
  rmSync(outFile, { force: true });
  const targets = TYR_PORTS.map((port) => `http://127.0.0.1:${port}`);
  const child = launchNode("loadgen", "load/loadgen.mjs", [
    `--targets=${targets.join(",")}`,
    `--interactive-targets=${targets.join(",")}`,
    `--batch-targets=${targets.join(",")}`,
    `--interactive-model=${model}`,
    `--batch-model=${model}`,
    `--interactive-identity-token=${tokens.premium}`,
    `--batch-identity-token=${tokens.noisy}`,
    `--arm-label=${arm}`,
    "--provider-api=anthropic",
    `--duration-ms=${WORKLOAD_BASE.durationMs}`,
    `--seed=${seed}`,
    `--interactive-rps=${WORKLOAD_BASE.interactiveRps}`,
    `--interactive-input-chars=${WORKLOAD_BASE.interactiveInputChars}`,
    `--interactive-max-tokens=${WORKLOAD_BASE.interactiveMaxTokens}`,
    `--batch-start-ms=${WORKLOAD_BASE.batchStartMs}`,
    `--batch-duration-ms=${WORKLOAD_BASE.batchDurationMs}`,
    `--batch-rps=${WORKLOAD_BASE.batchRps}`,
    `--batch-input-chars=${WORKLOAD_BASE.batchInputChars}`,
    `--batch-max-tokens=${WORKLOAD_BASE.batchMaxTokens}`,
    `--max-attempts=${WORKLOAD_BASE.maxAttempts}`,
    `--backoff-base-ms=${WORKLOAD_BASE.backoffBaseMs}`,
    `--size-distribution=${WORKLOAD_BASE.sizeDistribution}`,
    `--interactive-size-sigma=${WORKLOAD_BASE.interactiveSizeSigma}`,
    `--batch-size-sigma=${WORKLOAD_BASE.batchSizeSigma}`,
    `--in-flight-ceiling=${WORKLOAD_BASE.inFlightCeiling}`,
    `--window-ms=${WORKLOAD_BASE.windowMs}`,
    `--trace-file=${traceFile}`,
    "--metrics-port=0",
    `--out=${outFile}`,
  ]);
  const exit = await new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  if (exit.code !== 0) {
    throw new Error(`load generator failed for ${arm} (${exit.signal ?? `exit ${exit.code}`})`);
  }
  if (!existsSync(outFile)) throw new Error(`load generator did not write ${outFile}`);
  const summary = JSON.parse(readFileSync(outFile, "utf8"));
  summary.tenantWorkloads = { interactive: "premium", batch: "noisy" };
  summary.runtime = {
    tyr: TYR_VERSION,
    latchflo: LATCHFLO_VERSION,
    asyncBulkheadLlm: ASYNC_BULKHEAD_LLM_VERSION,
    asyncBulkheadTs: ASYNC_BULKHEAD_TS_VERSION,
  };
  writeFileSync(outFile, JSON.stringify(summary, null, 2));
  return summary;
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function aggregateResults(rows, outputDir, classGrants) {
  const comparisons = rows.map((row) => row.comparison);
  const lending = rows.map((row) => row.adaptiveLending);
  const handoffs = rows.map((row) => row.adaptiveHandoff);
  const numeric = (values) => values.filter(Number.isFinite);
  const summary = {
    schemaVersion: 4,
    benchmark: "tenant-fairness",
    generatedAt: new Date().toISOString(),
    runtime: {
      tyr: TYR_VERSION,
      latchflo: LATCHFLO_VERSION,
      asyncBulkheadLlm: ASYNC_BULKHEAD_LLM_VERSION,
      asyncBulkheadTs: ASYNC_BULKHEAD_TS_VERSION,
    },
    policy: classGrants,
    seeds: rows.map((row) => row.seed),
    passed: rows.every((row) => row.proof.passed),
    acceptance: rows.map((row) => ({ seed: row.seed, ...row.proof })),
    premium: {
      sharedSuccessRateMedian: percentile(comparisons.map((row) => row.premium.shared.successRate), 0.5),
      ceilingsSuccessRateMedian: percentile(comparisons.map((row) => row.premium.ceilings.successRate), 0.5),
      protectedSuccessRateMedian: percentile(comparisons.map((row) => row.premium.protected.successRate), 0.5),
      adaptiveSuccessRateMedian: percentile(comparisons.map((row) => row.premium.adaptive.successRate), 0.5),
      sharedContendedGoodputRpsMedian: percentile(comparisons.map((row) => row.premium.shared.contendedGoodputRps), 0.5),
      ceilingsContendedGoodputRpsMedian: percentile(comparisons.map((row) => row.premium.ceilings.contendedGoodputRps), 0.5),
      protectedContendedGoodputRpsMedian: percentile(comparisons.map((row) => row.premium.protected.contendedGoodputRps), 0.5),
      adaptiveContendedGoodputRpsMedian: percentile(comparisons.map((row) => row.premium.adaptive.contendedGoodputRps), 0.5),
      protectedVsSharedTtftRatioMedian: percentile(
        numeric(comparisons.map((row) => row.premium.protectedVsSharedTtftRatio)),
        0.5,
      ),
      protectedVsCeilingsTtftRatioMedian: percentile(
        numeric(comparisons.map((row) => row.premium.protectedVsCeilingsTtftRatio)),
        0.5,
      ),
      adaptiveVsProtectedTtftRatioMedian: percentile(
        numeric(comparisons.map((row) => row.premium.adaptiveVsProtectedTtftRatio)),
        0.5,
      ),
      adaptiveVsProtectedGoodputRatioMedian: percentile(
        numeric(comparisons.map((row) => row.premium.adaptiveVsProtectedGoodputRatio)),
        0.5,
      ),
      adaptiveVsSharedGoodputRatioMedian: percentile(
        numeric(comparisons.map((row) => row.premium.adaptiveVsSharedGoodputRatio)),
        0.5,
      ),
    },
    noisy: {
      sharedSuccessRateMedian: percentile(comparisons.map((row) => row.noisy.shared.successRate), 0.5),
      ceilingsSuccessRateMedian: percentile(comparisons.map((row) => row.noisy.ceilings.successRate), 0.5),
      protectedSuccessRateMedian: percentile(comparisons.map((row) => row.noisy.protected.successRate), 0.5),
      adaptiveSuccessRateMedian: percentile(comparisons.map((row) => row.noisy.adaptive.successRate), 0.5),
      protectedContendedCompletionsMedian: percentile(
        comparisons.map((row) => row.noisy.protected.contendedCompleted),
        0.5,
      ),
      adaptiveContendedCompletionsMedian: percentile(
        comparisons.map((row) => row.noisy.adaptive.contendedCompleted),
        0.5,
      ),
      ceilingsLocalRejectsTotal: comparisons.reduce(
        (sum, row) => sum + row.noisy.ceilings.localRejects,
        0,
      ),
      protectedLocalRejectsTotal: comparisons.reduce(
        (sum, row) => sum + row.noisy.protected.localRejects,
        0,
      ),
      adaptiveLocalRejectsTotal: comparisons.reduce(
        (sum, row) => sum + row.noisy.adaptive.localRejects,
        0,
      ),
    },
    classLending: {
      seedsWithNoisyFloorLent: lending.filter((row) => row.noisyFloorLent).length,
      seedsWithNoisyDemandAfterLending: lending.filter((row) => row.noisyDemandObservedAfterLending).length,
      seedsWithNoisyFloorRestored: lending.filter((row) => row.noisyFloorRestored).length,
      seedsWithHardCeilingsPreservedWhileLent: lending.filter((row) => row.hardCeilingsPreservedWhileLent).length,
      restorationLatencyMsMedian: percentile(
        numeric(lending.map((row) => row.restorationLatencyMs)),
        0.5,
      ),
      seedsWithPreExpiryClassHandoff: handoffs.filter((row) => row.committedBeforeLeaseExpiry).length,
      leaseAvoidedMsMedian: percentile(
        numeric(handoffs.map((row) => row.leaseAvoidedMs)),
        0.5,
      ),
      perSeed: rows.map((row) => ({
        seed: row.seed,
        ...row.adaptiveLending,
        handoff: row.adaptiveHandoff,
      })),
    },
    upstream429s: {
      sharedTotal: comparisons.reduce((sum, row) => sum + row.upstream429s.shared, 0),
      ceilingsTotal: comparisons.reduce((sum, row) => sum + row.upstream429s.ceilings, 0),
      protectedTotal: comparisons.reduce((sum, row) => sum + row.upstream429s.protected, 0),
      adaptiveTotal: comparisons.reduce((sum, row) => sum + row.upstream429s.adaptive, 0),
    },
    ...(rows.some((row) => row.restorationLadder !== undefined)
      ? { restorationLadder: aggregateRestorationLadder(rows) }
      : {}),
    results: rows.map((row) => ({
      seed: row.seed,
      comparison: row.comparison,
      adaptiveLending: row.adaptiveLending,
      adaptiveHandoff: row.adaptiveHandoff,
      ...(row.restorationLadder === undefined
        ? {}
        : { restorationLadder: row.restorationLadder }),
    })),
  };
  writeFileSync(path.join(outputDir, "summary.json"), JSON.stringify(summary, null, 2));
  return summary;
}

let identity = null;
let stackStarted = false;
try {
  ensureDemoEnv(ENV_FILE, { quiet: true });
  const env = parseEnv(ENV_FILE);
  validatePrerequisites(env);
  await assertHostPortFree(PROVIDER_PORT, { label: "provider simulator" });
  await assertHostPortFree(9010, { label: "identity fixture" });
  identity = await startIdentityFixture(IDENTITY_RUNTIME);
  if (OPT.doctor) {
    console.log(`PASS  tenant-fairness prerequisites (Tyr ${TYR_VERSION}, Latchflo ${LATCHFLO_VERSION})`);
    process.exitCode = 0;
  } else {
    const adminToken = env.LATCHFLO_ADMIN_TOKEN;
    const runId = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
    const outputDir = path.join(RESULTS_ROOT, runId);
    mkdirSync(outputDir, { recursive: true });
    const rows = [];
    let classGrants = null;

    for (const seed of OPT.seeds) {
      stackStarted = true;
      const fleet = await bootstrapTenantStack(adminToken);
      if (classGrants === null) {
        classGrants = fleet.aggregate;
      } else if (JSON.stringify(fleet.aggregate) !== JSON.stringify(classGrants)) {
        throw new Error(`tenant-fairness policy drifted across seed reset ${seed}`);
      }
      const workload = { ...WORKLOAD_BASE, seed };
      const trace = buildTrace(workload);
      const traceFile = path.join(outputDir, `trace-seed-${seed}.json`);
      writeFileSync(traceFile, JSON.stringify(trace, null, 2));
      const provider = launchNode("provider", "sim/provider-sim.mjs", [
        `--port=${PROVIDER_PORT}`,
        "--envelope=32", "--queue=8", "--sigma=0.25", "--kappa=0", "--r1=400",
        "--input-char-ratio=3.6", "--input-jitter=0.04", `--seed=${seed}`,
      ]);
      const providerReady = await waitForChildOutput(provider, `provider-sim :${PROVIDER_PORT}`, {
        timeoutMs: 15000, label: "provider simulator",
      });
      // The banner proves a socket bound, not that this address reaches this
      // process. See demo/present.mjs for the failure that motivated it.
      await assertProviderIdentity(providerReady.line);
      const shared = await runLoadgen({
        seed,
        model: "sim-model-shared",
        arm: "moflux-pool-only",
        traceFile,
        outFile: path.join(outputDir, `shared-seed-${seed}.json`),
        tokens: identity.tokens,
      });
      await sleep(1000);
      const ceilings = await runLoadgen({
        seed,
        model: "sim-model-ceilings",
        arm: "moflux-class-ceilings",
        traceFile,
        outFile: path.join(outputDir, `ceilings-seed-${seed}.json`),
        tokens: identity.tokens,
      });
      await sleep(1000);
      const protectedArm = await runLoadgen({
        seed,
        model: "sim-model-protected",
        arm: "moflux-protected-class-floors",
        traceFile,
        outFile: path.join(outputDir, `protected-seed-${seed}.json`),
        tokens: identity.tokens,
      });
      await sleep(1000);
      const adaptivePrecondition = await waitForAdaptiveNoisyFloorLent(adminToken);
      writeFileSync(
        path.join(outputDir, `adaptive-precondition-seed-${seed}.json`),
        JSON.stringify(adaptivePrecondition, null, 2),
      );
      const adaptiveStartedAt = Date.now();
      const [adaptiveArm, sampledAdaptiveObservation] = await Promise.all([
        runLoadgen({
          seed,
          model: "sim-model-adaptive",
          arm: "moflux-adaptive-class-floors",
          traceFile,
          outFile: path.join(outputDir, `adaptive-seed-${seed}.json`),
          tokens: identity.tokens,
        }),
        observeAdaptiveLending(adminToken, adaptiveStartedAt, adaptivePrecondition),
      ]);
      const adaptiveObservation = await waitForAdaptiveNoisyFloorRestored(
        adminToken,
        adaptiveStartedAt,
        sampledAdaptiveObservation,
      );
      writeFileSync(
        path.join(outputDir, `adaptive-lending-seed-${seed}.json`),
        JSON.stringify(adaptiveObservation, null, 2),
      );
      // Collected before the ladder runs, and deliberately so. Latchflo serves
      // `/v1/events` newest-first with a hard cap of 1000, so this evidence has
      // a limited shelf life: the adaptive arm's `admission_class.handoff_*`
      // events are dropped once enough newer events accumulate. Running the two
      // ladder arms first — roughly ninety seconds of load, against a fleet
      // whose event rate is now higher because two more pools have lending
      // enabled — pushed those events out of the window and silently emptied
      // the handoff proof. The ladder must not sit between the adaptive arm and
      // this read.
      const adaptiveHandoffEvidence = await collectAdaptiveClassHandoff(adminToken, adaptiveStartedAt);
      writeFileSync(
        path.join(outputDir, `adaptive-handoff-seed-${seed}.json`),
        JSON.stringify(adaptiveHandoffEvidence, null, 2),
      );
      // The restoration ladder replays the same trace through the two arms
      // whose only difference from `sim-adaptive` is which release mechanism
      // guards the protected floor.
      let ladder = null;
      if (OPT.restorationLadder) {
        const arms = {};
        for (const [key, model, arm] of [
          ["unlent", "sim-model-unlent", "moflux-unlent-token-floor"],
          ["deadline", "sim-model-deadline", "moflux-unlent-plus-slot-deadline"],
        ]) {
          await sleep(1000);
          arms[key] = await runLoadgen({
            seed,
            model,
            arm,
            traceFile,
            outFile: path.join(outputDir, `${key}-seed-${seed}.json`),
            tokens: identity.tokens,
          });
        }
        ladder = await collectRestorationLadder(adminToken, arms);
        writeFileSync(
          path.join(outputDir, `restoration-ladder-seed-${seed}.json`),
          JSON.stringify(ladder, null, 2),
        );
      }
      await terminateHostChild(provider);
      const comparison = compareTenantFairness(shared, ceilings, protectedArm, adaptiveArm);
      const adaptiveLending = adaptiveObservation.summary;
      const adaptiveHandoff = adaptiveHandoffEvidence.summary;
      const proof = tenantFairnessProof(comparison, adaptiveLending, adaptiveHandoff);
      const row = {
        seed, comparison, adaptiveLending, adaptiveHandoff, proof,
        ...(ladder === null ? {} : { restorationLadder: ladder }),
      };
      rows.push(row);
      writeFileSync(path.join(outputDir, `comparison-seed-${seed}.json`), JSON.stringify(row, null, 2));
      console.log(
        `seed ${seed}: premium contended goodput ` +
          `${comparison.premium.shared.contendedGoodputRps} / ` +
          `${comparison.premium.ceilings.contendedGoodputRps} / ` +
          `${comparison.premium.protected.contendedGoodputRps} / ` +
          `${comparison.premium.adaptive.contendedGoodputRps} rps; adaptive noisy floor ` +
          `lent=${adaptiveLending.noisyFloorLent} restored=${adaptiveLending.noisyFloorRestored}; ` +
          `class handoff=${adaptiveHandoff.handoffCommitted ? "committed" : "missing"} ` +
          `lease avoided=${adaptiveHandoff.leaseAvoidedMs ?? "n/a"}ms; ` +
          `proof=${proof.passed ? "pass" : "fail"}`,
      );
      if (ladder !== null) {
        for (const [key, entry] of Object.entries(ladder)) {
          const verdict = entry.verdict;
          console.log(
            `  ladder ${key.padEnd(8)} slots=${verdict.admissionSlots.effectiveEnforceability} ` +
              `tokens=${verdict.upstreamCapacity.effectiveEnforceability} ` +
              `withheld=${verdict.cost.tokensWithheldFromBorrowing} tokens ` +
              `shed=${verdict.cost.requestsShed} requests ` +
              `(upstream reclamation ${verdict.upstreamCapacity.reclamation})`,
          );
        }
      }
      if (OPT.requireProof && !proof.passed) {
        throw new Error(`tenant-fairness proof failed for seed ${seed}: ${JSON.stringify(proof.checks)}`);
      }
      if (OPT.pauseMs > 0) await sleep(OPT.pauseMs);
    }

    if (classGrants === null) throw new Error("tenant-fairness produced no seed policy");
    const summary = aggregateResults(rows, outputDir, classGrants);
    const scenarioId = createHash("sha256")
      .update(JSON.stringify({ workload: WORKLOAD_BASE, policy: classGrants, seeds: OPT.seeds }))
      .digest("hex").slice(0, 12);
    summary.scenarioId = scenarioId;
    writeFileSync(path.join(outputDir, "summary.json"), JSON.stringify(summary, null, 2));
    console.log(`wrote ${path.relative(ROOT, path.join(outputDir, "summary.json"))}`);
    if (OPT.requireProof && !summary.passed) process.exitCode = 1;
  }
} finally {
  await stopHostChildren();
  if (identity) await identity.close().catch(() => {});
  if (stackStarted && !OPT.keepStack) {
    command("docker", composeArgs("down", "--volumes", "--remove-orphans"), { allowFailure: true, quiet: true });
  }
  if (!OPT.keepStack) rmSync(IDENTITY_RUNTIME, { recursive: true, force: true });
}
