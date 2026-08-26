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
import { RedisClient } from "../arms/redis-client.mjs";
import { lendingComparison, lendingMetrics } from "./lending-lib.mjs";
import { bootstrapCapacityGroup, findFreshDemandReport } from "./demand-bootstrap-lib.mjs";
import { summarizeAdmissionProvenance } from "./admission-provenance-lib.mjs";
import {
  DEFAULT_CAPACITY_GROUP_NAME,
  buildDemandAwareCapacityGroup,
  summarizeControllerLending,
} from "./lending-evidence-lib.mjs";
import {
  dividedStaticCap,
  partitionStaticCap,
  resolveControlArmNames,
} from "./control-arm-lib.mjs";
import { armHealth, assertArmProducedWork } from "./arm-health-lib.mjs";
import {
  ADMISSION_TIMING_FRAMING,
  measureAdmissionClockOverhead,
  prometheusSamples,
  summarizeTyrAdmissionTiming,
} from "./admission-timing-lib.mjs";
import { buildTrace } from "../load/trace-lib.mjs";
import { reservationBounds, validateCapacityPlan } from "./capacity-lib.mjs";
import {
  ASYNC_BULKHEAD_LLM_VERSION,
  ASYNC_BULKHEAD_TS_VERSION,
  LATCHFLO_VERSION,
  TYR_VERSION,
  ensureDemoEnv,
  imageMatchesVersion,
} from "./env-lib.mjs";
import { assertSafeResultsDir } from "./evidence-paths-lib.mjs";
import { maxQueuePerAgentForPool } from "./queue-policy.mjs";
import {
  assertHostPortFree,
  fetchWithTimeout,
  hostChildren,
  killChildTree,
  launchNode,
  sleep,
  stopHostChildren,
  stopHostChildrenSync,
  terminateHostChild,
  waitFor,
  waitForChildOutput,
} from "./host-process-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS = process.env.MOFLUX_BENCH_RESULTS_DIR
  ? path.resolve(process.env.MOFLUX_BENCH_RESULTS_DIR)
  : path.join(ROOT, "results");
const BASE_COMPOSE = path.join(ROOT, "demo", "compose.yaml");
const MOFLUX_COMPOSE = path.join(ROOT, "demo", "moflux", "compose.yaml");
const ENV_FILE = process.env.MOFLUX_BENCH_ENV_FILE
  ? path.resolve(process.env.MOFLUX_BENCH_ENV_FILE)
  : path.join(ROOT, "demo", "moflux", ".env");
// The provider simulator runs on the host, not in Compose. One constant so
// the preflight, the launch arguments, and the replica upstream cannot drift.
const PROVIDER_PORT = 9000;
const PROVIDER_BASE_URL = `http://127.0.0.1:${PROVIDER_PORT}`;
const TYR_PORTS = [8101, 8102, 8103, 8104];
const INTERACTIVE_PORTS = [8101, 8102, 8103, 8104];
const BATCH_PORTS = [8104];
const LOCAL_REPLICA_COUNT = TYR_PORTS.length;
const TYR_SERVICES = ["tyr-r1", "tyr-r2", "tyr-r3", "tyr-r4"];
const POOL_AGENT_COUNTS = Object.freeze({ "sim-interactive": 4, "sim-batch": 1 });
// The presenter writes fixed scratch filenames into whatever directory it is
// given. Pointed at a reviewed-evidence directory it would silently replace
// published results, so refuse before creating anything.
try {
  assertSafeResultsDir(RESULTS, ROOT, "presenter results directory");
} catch (error) {
  console.error(`\nRefusing to run: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
mkdirSync(RESULTS, { recursive: true });
const TRACE_FILE = path.join(RESULTS, "scenario-trace.json");

const rawArgs = new Map();
for (const arg of process.argv.slice(2)) {
  const match = /^--([^=]+)=(.*)$/.exec(arg);
  if (match) rawArgs.set(match[1], match[2]);
  else if (arg.startsWith("--")) rawArgs.set(arg.slice(2), "true");
}
const flag = (name) => rawArgs.get(name) === "true";
const bool = (name, fallback) => (rawArgs.has(name) ? rawArgs.get(name) === "true" : fallback);
const num = (name, fallback) => (rawArgs.has(name) ? Number(rawArgs.get(name)) : fallback);
const str = (name, fallback) => rawArgs.get(name) ?? fallback;

const legacyLendingRequested = str("lending", "false") !== "false";
const requestedCapacityProfile = str("capacity-profile", "").trim();
const CAPACITY_PROFILE_NAMES = new Set([
  "",
  "historical-31-1",
  "adaptive-28-4",
  "adaptive-headroom-28-4",
]);
if (!CAPACITY_PROFILE_NAMES.has(requestedCapacityProfile)) {
  throw new Error(
    `--capacity-profile must be historical-31-1, adaptive-28-4, or adaptive-headroom-28-4, got "${requestedCapacityProfile}"`,
  );
}
if (requestedCapacityProfile === "historical-31-1" && legacyLendingRequested) {
  throw new Error("--capacity-profile=historical-31-1 cannot be combined with --lending");
}
const baselineAdaptiveProfileRequested = requestedCapacityProfile === "adaptive-28-4";
const headroomAdaptiveProfileRequested = requestedCapacityProfile === "adaptive-headroom-28-4";
const adaptiveProfileRequested = baselineAdaptiveProfileRequested || headroomAdaptiveProfileRequested;
const lendingRequested = adaptiveProfileRequested || legacyLendingRequested;
const hasLegacyBatchFloor = rawArgs.has("batch-floor-percent");
const hasBatchConcurrencyPercent = rawArgs.has("batch-concurrency-percent");
const hasBatchConcurrencySlots = rawArgs.has("batch-concurrency-slots");
if (hasBatchConcurrencySlots && (hasLegacyBatchFloor || hasBatchConcurrencyPercent)) {
  throw new Error(
    "--batch-concurrency-slots cannot be combined with --batch-concurrency-percent or --batch-floor-percent",
  );
}

// Normal benchmark runs retain the historical 31/1, 40k-token policy. The
// dedicated lending scenario uses a meaningful 28/4 protected split. Four
// current batch requests can reserve up to 4 × 9,942 tokens, so that scenario
// needs a 64k-token group envelope with 24k/40k protected token guarantees.
// Without this adjustment the four-slot batch floor would be nominal: token
// admission could fund only one batch request at a time.
const defaultBatchConcurrencySlots = lendingRequested ? 4 : 1;
const defaultTokenBudget = lendingRequested ? 64_000 : 40_000;
const defaultBatchTokenPercent = lendingRequested ? 62.5 : 25;
const legacyBatchFloorPercent = hasLegacyBatchFloor ? num("batch-floor-percent", 25) : null;
const configuredBatchConcurrencyPercent = hasBatchConcurrencyPercent
  ? num("batch-concurrency-percent", 0)
  : legacyBatchFloorPercent;
const configuredBatchConcurrencySlots = hasBatchConcurrencySlots
  ? num("batch-concurrency-slots", defaultBatchConcurrencySlots)
  : configuredBatchConcurrencyPercent === null
    ? defaultBatchConcurrencySlots
    : null;
const configuredBatchTokenPercent = rawArgs.has("batch-token-percent")
  ? num("batch-token-percent", defaultBatchTokenPercent)
  : legacyBatchFloorPercent ?? defaultBatchTokenPercent;

if (adaptiveProfileRequested) {
  const conflicts = [];
  if (hasLegacyBatchFloor) conflicts.push("--batch-floor-percent");
  if (hasBatchConcurrencyPercent) conflicts.push("--batch-concurrency-percent");
  if (hasBatchConcurrencySlots && configuredBatchConcurrencySlots !== 4) {
    conflicts.push("--batch-concurrency-slots (must be 4)");
  }
  if (rawArgs.has("envelope") && num("envelope", 32) !== 32) {
    conflicts.push("--envelope (must be 32)");
  }
  if (rawArgs.has("token-budget") && num("token-budget", 64_000) !== 64_000) {
    conflicts.push("--token-budget (must be 64000)");
  }
  if (rawArgs.has("batch-token-percent") && configuredBatchTokenPercent !== 62.5) {
    conflicts.push("--batch-token-percent (must be 62.5)");
  }
  if (headroomAdaptiveProfileRequested) {
    if (rawArgs.has("headroom-min-concurrent") && num("headroom-min-concurrent", 4) !== 4) {
      conflicts.push("--headroom-min-concurrent (must be 4)");
    }
    if (rawArgs.has("headroom-min-tokens") && num("headroom-min-tokens", 4000) !== 4000) {
      conflicts.push("--headroom-min-tokens (must be 4000)");
    }
    if (rawArgs.has("headroom-demanding-sustain-ms") && num("headroom-demanding-sustain-ms", 3000) !== 3000) {
      conflicts.push("--headroom-demanding-sustain-ms (must be 3000)");
    }
    if (rawArgs.has("headroom-max-demanding-concurrent-lend") && num("headroom-max-demanding-concurrent-lend", 2) !== 2) {
      conflicts.push("--headroom-max-demanding-concurrent-lend (must be 2)");
    }
    if (rawArgs.has("headroom-max-demanding-token-lend") && num("headroom-max-demanding-token-lend", 10000) !== 10000) {
      conflicts.push("--headroom-max-demanding-token-lend (must be 10000)");
    }
  } else if ([
    "headroom-min-concurrent",
    "headroom-min-tokens",
    "headroom-demanding-sustain-ms",
    "headroom-max-demanding-concurrent-lend",
    "headroom-max-demanding-token-lend",
  ].some((name) => rawArgs.has(name))) {
    conflicts.push("headroom flags require --capacity-profile=adaptive-headroom-28-4");
  }
  if (conflicts.length > 0) {
    throw new Error(
      `--capacity-profile=${requestedCapacityProfile} fixes the protected 28/4, 24k/40k policy` +
        `${headroomAdaptiveProfileRequested ? " plus sustained/capped interactive headroom" : ""}; ` +
        `remove conflicting ${conflicts.join(", ")}`,
    );
  }
}

const OPT = Object.freeze({
  mode: str("mode", "compare"), // compare | baseline | moflux | doctor
  step: flag("step"),
  pauseMs: num("pause-ms", 0),
  phaseMs: num("phase-ms", 45000),
  interactiveRps: num("interactive-rps", 6),
  fault: flag("fault"),
  faultAtMs: num("fault-at-ms", 16000),
  keepStack: !flag("cleanup"),
  openGrafana: !flag("no-open"),
  resetState: !flag("reuse-state"),
  envelope: num("envelope", 32),
  tokenBudget: num("token-budget", defaultTokenBudget),
  batchFloorPercent: legacyBatchFloorPercent,
  batchConcurrencySlots: configuredBatchConcurrencySlots,
  batchConcurrencyPercent: configuredBatchConcurrencyPercent,
  batchTokenPercent: configuredBatchTokenPercent,
  grantTtlMs: num("grant-ttl-ms", 120000),
  enrollmentGrantTtlMs: num("enrollment-grant-ttl-ms", lendingRequested ? 2000 : 5000),
  seed: num("seed", 7),
  // Comma-separated control arms replayed on the same trace between the
  // baseline and MoFlux: "static-cap", "redis", or "all". These are the
  // buy-vs-build alternatives; without them the sweep only answers "is
  // admission control better than nothing", which nobody is choosing between.
  controlArms: str("control-arms", ""),
  /**
   * Lending scenario. Batch stays absent for the first 60% of the phase
   * instead of 35%, giving a wide idle window in which a lending policy can
   * demonstrably exceed the interactive pool's own ceiling. A static split
   * cannot, which is what makes the two distinguishable.
   */
  lending: lendingRequested,
  capacityProfile: headroomAdaptiveProfileRequested
    ? "adaptive-headroom-28-4"
    : baselineAdaptiveProfileRequested
      ? "adaptive-28-4"
      : legacyLendingRequested
        ? "custom-demand-aware"
        : requestedCapacityProfile || "historical-31-1",
  headroomMinConcurrent: headroomAdaptiveProfileRequested ? 4 : null,
  headroomMinTokens: headroomAdaptiveProfileRequested ? 4000 : null,
  headroomDemandingSustainMs: headroomAdaptiveProfileRequested ? 3000 : null,
  headroomMaxDemandingConcurrentLend: headroomAdaptiveProfileRequested ? 2 : null,
  headroomMaxDemandingTokenLend: headroomAdaptiveProfileRequested ? 10_000 : null,
  lendingReportStaleAfterMs: num("lending-report-stale-after-ms", 6000),
  lendingIdleAfterMs: num("lending-idle-after-ms", 3000),
  lendingMaxStarvationMs: num("lending-max-starvation-ms", 5000),
  handoffSampleIntervalMs: num("handoff-sample-interval-ms", 500),
  /**
   * "uniform" reproduces the version-1 trace exactly, so every result recorded
   * before this option existed stays reproducible. "lognormal" draws a size
   * per request.
   *
   * This is the difference between a benchmark that can distinguish token-aware
   * admission from a concurrency semaphore and one that cannot: with a single
   * fixed size per class, the two policies are the same algorithm and no
   * result can be attributed to token awareness.
   */
  /**
   * Simulated network distance to the coordination service, per round trip.
   *
   * Only the Redis control arm consults a coordinator on the admission path,
   * so only it pays this per request. Running Redis on loopback measures a
   * coordinator that is effectively free to consult — the most favourable
   * condition a per-request design can be given, and one that does not exist
   * in production.
   */
  coordinatorLatencyMs: num("coordinator-latency-ms", 0),
  /**
   * Honor `Retry-After` / `x-admission-retry-after-ms` from a local admission
   * rejection. Default true, matching the load generator.
   *
   * MoFlux is the only local-admission arm that emits these headers, so it is
   * the only arm whose measured TTFT includes hint-imposed waiting. Setting
   * this false forces blind exponential backoff everywhere; the trace is
   * identical either way, so the pair of runs is an exact A/B that separates
   * the hint's contribution from token-aware admission itself.
   *
   *   npm run demo:hetero
   *   npm run demo:hetero:blind
   */
  honorRetryHints: bool("honor-retry-hints", true),
  sizeDistribution: str("size-distribution", "uniform"),
  interactiveSizeSigma: num("interactive-size-sigma", 0.75),
  batchSizeSigma: num("batch-size-sigma", 0),
  sigma: num("sigma", 0.25),
  kappa: num("kappa", 0),
  r1: num("r1", 400),
  // Anthropic streams expose cumulative usage before completion, which is
  // required to exercise Tyr 0.20 progressive reconciliation. OpenAI remains
  // available for historical/conservative replay.
  providerApi: str("provider-api", "anthropic"),
});

if (!["openai", "anthropic"].includes(OPT.providerApi)) {
  throw new Error("--provider-api must be openai or anthropic");
}

const PROGRESSIVE_RECONCILIATION = Object.freeze({
  enabled: true,
  updateStepTokens: 256,
  outputSafetyMarginTokens: 256,
});

/**
 * Arms 2 and 4 from the harness README, run in the same request-path position
 * as the baseline and replaying the identical trace.
 *
 * These are local-admission policies: no Latchflo, no grants, no Tyr. They
 * exist so the published comparison is against the alternatives a reader would
 * otherwise build, not only against doing nothing.
 */
const CONTROL_ARM_SPECS = {
  "static-cap": {
    key: "staticCap",
    file: "static-cap.json",
    armLabel: "static-cap-divided",
    title: "Static cap",
    caption: "Arm 2 — local semaphore, envelope divided by replica count, no coordination",
    replicaArm: "static-cap",
    needsRedis: false,
    replicaFlags: (opt) => [
      `--max-concurrent=${dividedStaticCap({
        envelope: opt.envelope,
        replicaCount: LOCAL_REPLICA_COUNT,
      })}`,
      "--max-queue=4",
      "--token-budget=0",
    ],
  },
  "static-partition": {
    key: "staticPartition",
    file: "static-partition.json",
    armLabel: (opt) => `static-partition-${opt.envelope - opt.batchConcurrencySlots}-${opt.batchConcurrencySlots}`,
    title: (opt) => `Static ${opt.envelope - opt.batchConcurrencySlots}/${opt.batchConcurrencySlots} partition`,
    caption: (opt) =>
      `Lending control — the same protected ${opt.envelope - opt.batchConcurrencySlots}/${opt.batchConcurrencySlots} split, but idle batch capacity cannot be borrowed`,
    replicaArm: "static-partition",
    needsRedis: false,
    replicaFlags: (opt, index) => {
      const interactive = partitionStaticCap({
        envelope: opt.envelope - opt.batchConcurrencySlots,
        replicaCount: LOCAL_REPLICA_COUNT,
      });
      return [
        `--max-concurrent=${opt.envelope}`,
        `--interactive-max-concurrent=${interactive[index]}`,
        `--batch-max-concurrent=${opt.batchConcurrencySlots}`,
        "--max-queue=4",
        "--token-budget=0",
      ];
    },
  },
  redis: {
    key: "redis",
    file: "redis-coordinated.json",
    armLabel: "redis-coordinated",
    title: "Redis coordinated",
    caption: "Arm 4 — fleet-shared concurrency and token budget via atomic Lua reserve",
    replicaArm: "redis",
    needsRedis: true,
    replicaFlags: (opt) => [
      `--max-concurrent=${opt.envelope}`,
      "--max-queue=0",
      `--token-budget=${opt.tokenBudget}`,
      "--lease-ttl-ms=15000",
      `--coordinator-latency-ms=${opt.coordinatorLatencyMs}`,
    ],
  },
};

const CONTROL_ARMS = (() => {
  // "all" is resolved by control-arm-lib so the presenter and the sweep wrapper
  // cannot disagree about which arms a sweep contains.
  const names = resolveControlArmNames(OPT.controlArms, Object.keys(CONTROL_ARM_SPECS));
  return names.map((name) => {
    const spec = CONTROL_ARM_SPECS[name];
    const resolve = (value) => typeof value === "function" ? value(OPT) : value;
    return {
      ...spec,
      armLabel: resolve(spec.armLabel),
      title: resolve(spec.title),
      caption: resolve(spec.caption),
    };
  });
})();

if (CONTROL_ARMS.length > 0 && OPT.mode !== "compare") {
  throw new Error("--control-arms requires --mode=compare; they are only meaningful beside a baseline");
}

if (!new Set(["compare", "baseline", "moflux", "doctor"]).has(OPT.mode)) {
  throw new Error(`unsupported --mode=${OPT.mode}; expected compare, baseline, moflux, or doctor`);
}
if (!Number.isFinite(OPT.phaseMs) || OPT.phaseMs < 10000) {
  throw new Error("--phase-ms must be at least 10000");
}
const SIZE_DISTRIBUTION_VALUES = new Set(["uniform", "lognormal"]);
const SIZE_DISTRIBUTION = OPT.sizeDistribution;
if (!SIZE_DISTRIBUTION_VALUES.has(SIZE_DISTRIBUTION)) {
  throw new Error(
    `--size-distribution must be one of ${[...SIZE_DISTRIBUTION_VALUES].join(", ")}, got "${SIZE_DISTRIBUTION}"`,
  );
}
if (SIZE_DISTRIBUTION === "uniform" && (OPT.interactiveSizeSigma !== 0.75 || OPT.batchSizeSigma !== 0)) {
  // Silently ignoring a spread the operator asked for would make a uniform run
  // look heterogeneous in the command line and not in the data.
  throw new Error("size sigmas have no effect with --size-distribution=uniform; set --size-distribution=lognormal");
}
if (legacyLendingRequested && OPT.mode !== "compare") {
  throw new Error("--lending requires --mode=compare; the idle window is only meaningful against a control arm");
}
if (adaptiveProfileRequested && OPT.mode === "baseline") {
  throw new Error(`--capacity-profile=${requestedCapacityProfile} requires a MoFlux arm; use --mode=moflux or --mode=compare`);
}
if (OPT.lending && OPT.phaseMs < 30000) {
  // Below this the idle window is too short for occupancy to settle, and a
  // borrowed slot cannot be distinguished from scheduling noise.
  throw new Error("--lending requires --phase-ms of at least 30000 for a readable idle window");
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
for (const [flagName, value, minimum] of [
  ["--lending-report-stale-after-ms", OPT.lendingReportStaleAfterMs, 1000],
  ["--lending-idle-after-ms", OPT.lendingIdleAfterMs, 0],
  ["--lending-max-starvation-ms", OPT.lendingMaxStarvationMs, 1000],
  ["--handoff-sample-interval-ms", OPT.handoffSampleIntervalMs, 100],
]) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${flagName} must be an integer of at least ${minimum}`);
  }
}
const REQUIRED_GRANT_RUNWAY_MS = OPT.phaseMs + 10000;
const REQUIRED_INITIAL_GRANT_RUNWAY_MS = REQUIRED_GRANT_RUNWAY_MS;
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
  interactiveRps: OPT.interactiveRps,
  interactiveInputChars: 1200,
  interactiveMaxTokens: 400,
  batchStartMs: Math.round(OPT.phaseMs * (OPT.lending ? 0.6 : 0.35)),
  batchDurationMs: Math.round(OPT.phaseMs * (OPT.lending ? 0.35 : 0.5)),
  batchRps: 3,
  batchInputChars: 24000,
  batchMaxTokens: 3000,
  maxAttempts: 4,
  backoffBaseMs: 250,
  sizeDistribution: OPT.sizeDistribution,
  interactiveSizeSigma: OPT.interactiveSizeSigma,
  batchSizeSigma: OPT.batchSizeSigma,
  inFlightCeiling: 3000,
  windowMs: 30000,
  // Not part of traceWorkload(), so recording it here leaves every trace hash
  // bit-identical while making the run's retry-hint mode visible in the
  // scenario a result claims to have measured.
  honorRetryHints: OPT.honorRetryHints,
});

// Normal runs keep the historical one-slot batch guarantee. The lending run
// uses a 28/4 protected split and raises both pool ceilings to the full shared
// envelope, letting Latchflo 0.7 release only an actually idle member's
// guarantee. This is a real control-plane policy, not a benchmark-side
// simulation.
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
  const ceilingConcurrent = OPT.lending ? OPT.envelope : null;
  const ceilingTokens = OPT.lending ? OPT.tokenBudget : null;
  return Object.freeze({
    profile: OPT.capacityProfile,
    policy: headroomAdaptiveProfileRequested
      ? "interactive-first-headroom-aware"
      : OPT.lending
        ? "interactive-first-demand-aware"
        : "interactive-first-static",
    capacityGroup: OPT.lending ? DEFAULT_CAPACITY_GROUP_NAME : null,
    batchFloorPercent:
      OPT.batchFloorPercent !== null &&
      Math.abs(resolvedConcurrencyPercent - OPT.batchTokenPercent) < 1e-9
        ? OPT.batchFloorPercent
        : null,
    batchConcurrencySlots: batchConcurrent,
    interactiveConcurrencySlots: interactiveConcurrent,
    batchConcurrencyPercent: resolvedConcurrencyPercent,
    batchTokenPercent: OPT.batchTokenPercent,
    demandPolicy: OPT.lending
      ? Object.freeze({
          enabled: true,
          reportStaleAfterMs: OPT.lendingReportStaleAfterMs,
          idleAfterMs: OPT.lendingIdleAfterMs,
          maxStarvationMs: OPT.lendingMaxStarvationMs,
        })
      : null,
    pools: Object.freeze([
      Object.freeze({
        name: "sim-interactive",
        maxConcurrent: ceilingConcurrent ?? interactiveConcurrent,
        tokenBudget: ceilingTokens ?? interactiveTokens,
        guaranteedMaxConcurrent: interactiveConcurrent,
        guaranteedTokenBudget: interactiveTokens,
        ...(headroomAdaptiveProfileRequested
          ? {
              headroomLending: Object.freeze({
                minConcurrentHeadroom: OPT.headroomMinConcurrent,
                minTokenHeadroom: OPT.headroomMinTokens,
                demandingSustainMs: OPT.headroomDemandingSustainMs,
                maxDemandingConcurrentLend: OPT.headroomMaxDemandingConcurrentLend,
                maxDemandingTokenLend: OPT.headroomMaxDemandingTokenLend,
              }),
            }
          : {}),
        priority: 100,
        agentCount: POOL_AGENT_COUNTS["sim-interactive"],
      }),
      Object.freeze({
        name: "sim-batch",
        maxConcurrent: ceilingConcurrent ?? batchConcurrent,
        tokenBudget: ceilingTokens ?? batchTokens,
        guaranteedMaxConcurrent: batchConcurrent,
        guaranteedTokenBudget: batchTokens,
        priority: 10,
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
  validateCapacityPlan({
    pools: CAPACITY.pools.map((pool) => ({
      name: pool.name,
      maxConcurrent: pool.guaranteedMaxConcurrent,
      tokenBudget: pool.guaranteedTokenBudget,
      agentCount: pool.agentCount,
    })),
    requirements: RESERVATIONS,
    // Under heterogeneous sizes, sizing every concurrency slot for the largest
    // possible request is neither achievable nor desirable: it would provision
    // for a tail that most requests never reach. Tokens are expected to bind
    // sometimes, and that is the property being measured. The protected floor
    // still has to fund at least one worst-case request on every serving agent.
    requireFullyFundedConcurrency: SIZE_DISTRIBUTION === "uniform",
  }).map((floor) => {
    const configured = CAPACITY.pools.find((pool) => pool.name === floor.name);
    if (!configured) throw new Error(`missing configured capacity for ${floor.name}`);
    return Object.freeze({
      ...floor,
      guaranteedMaxConcurrent: floor.maxConcurrent,
      guaranteedTokenBudget: floor.tokenBudget,
      ceilingMaxConcurrent: configured.maxConcurrent,
      ceilingTokenBudget: configured.tokenBudget,
      priority: configured.priority,
    });
  }),
);

const CAPACITY_GROUP = OPT.lending
  ? Object.freeze(buildDemandAwareCapacityGroup({
      name: DEFAULT_CAPACITY_GROUP_NAME,
      envelope: OPT.envelope,
      tokenBudget: OPT.tokenBudget,
      reportStaleAfterMs: OPT.lendingReportStaleAfterMs,
      idleAfterMs: OPT.lendingIdleAfterMs,
      maxStarvationMs: OPT.lendingMaxStarvationMs,
      interactive: {
        pool: "sim-interactive",
        priority: 100,
        guaranteedMaxConcurrent: CAPACITY.interactiveConcurrencySlots,
        guaranteedTokenBudget: CAPACITY.pools.find((pool) => pool.name === "sim-interactive").guaranteedTokenBudget,
        ...(headroomAdaptiveProfileRequested
          ? {
              headroomLending: {
                minConcurrentHeadroom: OPT.headroomMinConcurrent,
                minTokenHeadroom: OPT.headroomMinTokens,
                demandingSustainMs: OPT.headroomDemandingSustainMs,
                maxDemandingConcurrentLend: OPT.headroomMaxDemandingConcurrentLend,
                maxDemandingTokenLend: OPT.headroomMaxDemandingTokenLend,
              },
            }
          : {}),
      },
      batch: {
        pool: "sim-batch",
        priority: 10,
        guaranteedMaxConcurrent: CAPACITY.batchConcurrencySlots,
        guaranteedTokenBudget: CAPACITY.pools.find((pool) => pool.name === "sim-batch").guaranteedTokenBudget,
      },
    }))
  : null;

// Pre-benchmark heartbeats correctly report no demand. If demand-aware lending
// is armed during Docker enrollment, a slow-starting replica can arrive after
// idleAfterMs and the controller can legally release the whole protected floor
// before measured traffic exists. Keep the exact capacity group installed but
// disable lending until fresh demand from this run is observed.
const BOOTSTRAP_CAPACITY_GROUP = bootstrapCapacityGroup(CAPACITY_GROUP);

const PROVIDER = Object.freeze({
  api: OPT.providerApi,
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
      globalMaxConcurrent: partition.ceilingMaxConcurrent,
      minimumGrantMaxConcurrent: 1,
      maxQueuePerAgent: maxQueuePerAgentForPool(partition.name),
      globalTokenBudget: partition.ceilingTokenBudget,
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

async function configureCapacityGroup(token, { allowCreate, capacityGroup = CAPACITY_GROUP } = {}) {
  if (!capacityGroup) return null;
  const base = "http://127.0.0.1:18080";
  const update = await jsonRequest(`${base}/v1/capacity-groups/${capacityGroup.name}`, {
    method: "PUT",
    token,
    body: capacityGroup,
    allowed: [200, 404, 405],
  });
  if (update.status === 200) return update.body;
  if (!allowCreate) {
    throw new Error(
      `Latchflo must support PUT /v1/capacity-groups/{name} for the demand-aware lending scenario`,
    );
  }
  const created = await jsonRequest(`${base}/v1/capacity-groups`, {
    method: "POST",
    token,
    body: capacityGroup,
    allowed: [200, 201, 409],
  });
  if (created.status === 409) {
    throw new Error(
      `${capacityGroup.name} already exists but could not be replaced safely; reset the demo state and retry`,
    );
  }
  return created.body;
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
  // Only the arms that were selected. Redis backs arm 4 and is not part of the
  // two-arm demo, so it stays down unless a control arm needs it.
  const supportServices = ["telemetry-relay", "prometheus", "grafana"];
  if (CONTROL_ARMS.some((spec) => spec.needsRedis)) supportServices.push("redis");
  compose("up", "-d", "--force-recreate", ...supportServices);
  // Force recreation guarantees the running controller uses the tokens from
  // the current .env instead of a stale value from an earlier recording.
  compose("up", "-d", "--force-recreate", "latchflo");
  if (CONTROL_ARMS.some((spec) => spec.needsRedis)) {
    await waitForRedis();
    console.log(`${GREEN}   ✓ Redis is ready for the coordinated arm${OFF}`);
  }
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
  await configureCapacityGroup(token, {
    allowCreate: true,
    capacityGroup: BOOTSTRAP_CAPACITY_GROUP,
  });
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
  if (CAPACITY_GROUP) {
    await configureCapacityGroup(env.LATCHFLO_ADMIN_TOKEN, {
      allowCreate: false,
      capacityGroup: BOOTSTRAP_CAPACITY_GROUP,
    });
    await jsonRequest(
      `http://127.0.0.1:18080/v1/capacity-groups/${CAPACITY_GROUP.name}/rebalance`,
      {
        method: "POST",
        token: env.LATCHFLO_ADMIN_TOKEN,
        allowed: [200, 202],
      },
    );
  } else {
    for (const partition of CAPACITY.pools) {
      await jsonRequest(`http://127.0.0.1:18080/v1/pools/${partition.name}/rebalance`, {
        method: "POST",
        token: env.LATCHFLO_ADMIN_TOKEN,
        allowed: [200, 202],
      });
    }
  }

  return waitForUsableTyrFleet();
}

async function activateDemandAwareLending(token, measuredRunStartedAtMs, loadgen) {
  if (!CAPACITY_GROUP) return null;
  const base = "http://127.0.0.1:18080";
  const deadline = Date.now() + Math.max(15_000, Math.min(30_000, WORKLOAD.batchStartMs));
  let last = "no fresh interactive demand report";

  while (Date.now() < deadline) {
    if (loadgen?.exitCode !== null || loadgen?.signalCode !== null) {
      throw new Error("load generator exited before demand-aware lending was armed");
    }
    try {
      const response = await jsonRequest(`${base}/v1/demand?pool=sim-interactive`, {
        token,
        allowed: [200],
      });
      const report = findFreshDemandReport(response.body?.demand, {
        pool: "sim-interactive",
        sinceMs: measuredRunStartedAtMs,
      });
      if (report) {
        const activatedAtMs = Date.now();
        await configureCapacityGroup(token, {
          allowCreate: false,
          capacityGroup: CAPACITY_GROUP,
        });
        await jsonRequest(
          `${base}/v1/capacity-groups/${CAPACITY_GROUP.name}/rebalance`,
          { method: "POST", token, allowed: [200, 202] },
        );
        return {
          observedDemandAt: report.receivedAt,
          activatedAt: new Date(activatedAtMs).toISOString(),
          activationDelayMs: activatedAtMs - measuredRunStartedAtMs,
        };
      }
      const reports = Array.isArray(response.body?.demand) ? response.body.demand : [];
      last = reports.length === 0
        ? "no interactive demand reports"
        : `latest reports haveDemand=${reports.map((entry) => entry?.hasDemand === true).join(",")}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }

  throw new Error(
    `timed out arming demand-aware lending after measured traffic started; last result: ${last}`,
  );
}

function providerArgs() {
  return [
    `--port=${PROVIDER_PORT}`,
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
    `--provider-api=${PROVIDER.api}`,
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
    // Not a trace-shaping option, but it changes what every arm measures, so
    // it has to reach the generator explicitly rather than relying on the two
    // defaults happening to agree.
    `--honor-retry-hints=${WORKLOAD.honorRetryHints}`,
    // Trace-shaping options must reach the generator or it will build its
    // config from different values than the trace it is handed, and reject a
    // trace this presenter just wrote. Anything included in traceWorkload()
    // has to be forwarded here; verify-loadgen-args.mjs enforces that.
    `--size-distribution=${WORKLOAD.sizeDistribution}`,
    `--interactive-size-sigma=${WORKLOAD.interactiveSizeSigma}`,
    `--batch-size-sigma=${WORKLOAD.batchSizeSigma}`,
    `--in-flight-ceiling=${WORKLOAD.inFlightCeiling}`,
    `--window-ms=${WORKLOAD.windowMs}`,
    `--trace-file=${TRACE_FILE}`,
    "--metrics-port=0",
    "--metrics-relay-url=http://127.0.0.1:8200/ingest",
    "--metrics-relay-required",
    `--out=${outFile}`,
  ];
}

/**
 * @param consultsCoordinator Whether this arm consults a coordination service
 *   while admitting. Only such an arm pays `--coordinator-latency-ms`, so only
 *   such an arm may record having paid it. Stamping the configured value on
 *   every arm made a 30ms ladder rung claim that the uncontrolled baseline,
 *   the static caps and MoFlux had all paid 30ms per admission to a service
 *   they never call.
 */
function attachScenario(summary, { consultsCoordinator = false } = {}) {
  summary.coordinatorLatencyMs = consultsCoordinator ? OPT.coordinatorLatencyMs : 0;
  summary.coordinatorOnAdmissionPath = consultsCoordinator;
  // The rung this file was produced at, recorded on every arm so a ladder can
  // prove which sweep a summary belongs to without inferring it from a metric
  // the arm never pays.
  summary.coordinatorLadderRungMs = OPT.coordinatorLatencyMs;
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
  // Checked first: when the request path is broken every other assertion here
  // still passes, because the right trace was offered — it just never produced
  // a measurement. Recorded on the summary either way so a run that stays under
  // the tolerance is still visible in the published evidence.
  summary.health = armHealth(summary);
  assertArmProducedWork(summary, label, { providerBaseUrl: PROVIDER_BASE_URL });
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

async function runLoadgen({ interactiveTargets, batchTargets, armLabel, outFile, whileRunning = null }) {
  rmSync(outFile, { force: true });
  const loadgen = launchNode("loadgen", "load/loadgen.mjs", loadgenArgs({ interactiveTargets, batchTargets, armLabel, outFile }));
  const measuredRunStartedAtMs = Date.now();
  let sideError = null;
  let sideResult = null;
  const sideTask = typeof whileRunning === "function"
    ? Promise.resolve()
        .then(() => whileRunning({ measuredRunStartedAtMs, loadgen }))
        .then((value) => { sideResult = value; })
        .catch(async (error) => {
          sideError = error;
          await terminateHostChild(loadgen);
        })
    : null;
  const exit = await new Promise((resolve) => {
    loadgen.on("close", (code, signal) => resolve({ code, signal }));
  });
  if (sideTask) await sideTask;
  if (sideError) throw sideError;
  if (exit.code !== 0) {
    throw new Error(
      `load generator failed (${exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code}`})`,
    );
  }
  if (!existsSync(outFile)) throw new Error(`load generator did not write ${outFile}`);
  const summary = JSON.parse(readFileSync(outFile, "utf8"));
  await verifyArmTelemetry(armLabel, summary);
  return { summary, sideResult };
}

/**
 * Provider occupancy for the arm that just ran.
 *
 * This used to swallow every error and return null, which the presenter
 * rendered as `peak active ?/32` and the sweep aggregate silently converted to
 * `peakActive: 0`. An unreadable provider means the arm's occupancy is unknown,
 * and unknown is not zero, so it fails instead.
 */
async function readProviderCounters() {
  let payload;
  try {
    const response = await fetchWithTimeout(`${PROVIDER_BASE_URL}/admin/stats`, {}, 2000);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    payload = await response.json();
  } catch (error) {
    throw new Error(
      `could not read provider occupancy from ${PROVIDER_BASE_URL}/admin/stats ` +
        `(${error instanceof Error ? error.message : String(error)}). ` +
        "Peak occupancy is part of every published arm, so the run is refused rather than " +
        "recorded with an unknown envelope.",
    );
  }
  const counters = payload?.counters;
  if (!counters) {
    throw new Error(
      `${PROVIDER_BASE_URL}/admin/stats answered without counters; it is not this run's provider simulator`,
    );
  }
  return counters;
}

/**
 * Proves that the provider the replicas will dial is the child just launched.
 *
 * A bound socket is not the same as owning the address a caller reaches.
 * provider-sim binds `0.0.0.0`, and on macOS a process bound specifically to
 * `127.0.0.1:9000` coexists with it and wins loopback — so the simulator starts
 * cleanly, prints its banner, and every replica request goes somewhere else.
 * Readiness by startup banner alone (0.19.0) cannot see this; the arm then runs
 * to completion reporting zero successes, zero rejects and unknown occupancy.
 *
 * The probe deliberately uses the same global fetch the load generator uses, on
 * the same base URL the replicas are given, so a proxy or connection-pool
 * problem that affects real traffic fails here rather than 45 seconds later.
 */
async function assertProviderIdentity(readyLine, { label = "provider simulator" } = {}) {
  const expected = /instance=([0-9a-f-]{36})/.exec(readyLine ?? "")?.[1] ?? null;
  let payload;
  try {
    const response = await fetchWithTimeout(`${PROVIDER_BASE_URL}/admin/stats`, {}, 3000);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    payload = await response.json();
  } catch (error) {
    throw new Error(
      `${label} announced itself on port ${PROVIDER_PORT} but ${PROVIDER_BASE_URL} did not answer ` +
        `as the simulator (${error instanceof Error ? error.message : String(error)}). ` +
        `Something else owns that address for loopback callers, or an HTTP proxy is intercepting it. ` +
        `Check \`lsof -nP -iTCP:${PROVIDER_PORT} -sTCP:LISTEN\` and HTTP_PROXY/HTTPS_PROXY/NO_PROXY.`,
    );
  }
  if (payload?.service !== "moflux-provider-sim") {
    throw new Error(
      `${PROVIDER_BASE_URL} is answering, but it is not provider-sim (service=${JSON.stringify(payload?.service ?? null)}). ` +
        `Another process owns ${PROVIDER_BASE_URL} for loopback callers.`,
    );
  }
  if (expected && payload.instance !== expected) {
    throw new Error(
      `${PROVIDER_BASE_URL} is a provider simulator, but not the one this arm started ` +
        `(expected instance ${expected}, reached ${payload.instance}). ` +
        "A simulator from an earlier arm or rung is still holding the port; its counters and seed are not this arm's.",
    );
  }
  return payload.instance ?? null;
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


function appliedCapacitySample(
  statsRows,
  pollStartedAtMs = Date.now(),
  pollCompletedAtMs = pollStartedAtMs,
) {
  const rowPoolCapacity = (row, poolName) => {
    const pool = row?.[poolName];
    if (!pool) {
      return {
        maxConcurrent: 0, tokenBudget: 0, inFlight: 0, inFlightTokens: 0, admitted: 0,
        grants: [], admissionProvenance: null,
      };
    }
    const provenance = pool?.tyr?.provenance?.current;
    const admissionProvenance = pool?.tyr?.admissionProvenance;
    return {
      maxConcurrent: Number(pool?.limits?.maxConcurrent ?? 0),
      tokenBudget: Number(pool?.tokenBudget?.budget ?? pool?.limits?.tokenBudget?.budget ?? 0),
      inFlight: Number(pool?.bulkhead?.inFlight ?? 0),
      inFlightTokens: Number(pool?.tokenBudget?.inFlightTokens ?? 0),
      admitted: Number(pool?.llm?.admitted ?? 0),
      grants: provenance?.grantId
        ? [{ grantId: provenance.grantId, revision: provenance.revision, expiresAt: provenance.expiresAt }]
        : [],
      admissionProvenance: admissionProvenance
        ? {
            capacity: Number(admissionProvenance.capacity ?? 0),
            retained: Number(admissionProvenance.retained ?? 0),
            dropped: Number(admissionProvenance.dropped ?? 0),
            captureFailures: Number(admissionProvenance.captureFailures ?? 0),
            nextSequence: Number(admissionProvenance.nextSequence ?? 0),
            events: Array.isArray(admissionProvenance.events)
              ? admissionProvenance.events.map((event) => ({ ...event }))
              : [],
          }
        : null,
    };
  };
  const replicas = statsRows.map((row, index) => ({
    port: TYR_PORTS[index] ?? null,
    interactive: rowPoolCapacity(row, "sim-interactive"),
    batch: rowPoolCapacity(row, "sim-batch"),
  }));
  const poolCapacity = (poolName) => replicas.reduce(
    (total, replica) => {
      const pool = replica[poolName];
      total.maxConcurrent += pool.maxConcurrent;
      total.tokenBudget += pool.tokenBudget;
      total.inFlight += pool.inFlight;
      total.inFlightTokens += pool.inFlightTokens;
      total.admitted += pool.admitted;
      total.grants.push(...pool.grants);
      return total;
    },
    { maxConcurrent: 0, tokenBudget: 0, inFlight: 0, inFlightTokens: 0, admitted: 0, grants: [] },
  );
  const interactive = poolCapacity("interactive");
  const batch = poolCapacity("batch");
  return {
    pollStartedAt: new Date(pollStartedAtMs).toISOString(),
    observedAt: new Date(pollCompletedAtMs).toISOString(),
    pollDurationMs: Math.max(0, pollCompletedAtMs - pollStartedAtMs),
    replicas,
    interactive,
    batch,
    total: {
      maxConcurrent: interactive.maxConcurrent + batch.maxConcurrent,
      tokenBudget: interactive.tokenBudget + batch.tokenBudget,
      inFlight: interactive.inFlight + batch.inFlight,
      inFlightTokens: interactive.inFlightTokens + batch.inFlightTokens,
    },
  };
}

function compactAdmissionProvenancePool(pool) {
  if (!pool || typeof pool !== "object") return pool;
  const provenance = pool.admissionProvenance;
  if (!provenance || typeof provenance !== "object") return pool;
  const { events: _events, ...counters } = provenance;
  return { ...pool, admissionProvenance: counters };
}

function summarizeAppliedCapacity(samples, errors = []) {
  const overConcurrent = samples.filter(
    (sample) => sample.total.maxConcurrent > OPT.envelope,
  );
  const overTokens = samples.filter(
    (sample) => sample.total.tokenBudget > OPT.tokenBudget,
  );
  const interactiveFloor = CAPACITY.pools.find((pool) => pool.name === "sim-interactive");
  const batchFloor = CAPACITY.pools.find((pool) => pool.name === "sim-batch");
  const lentIndex = samples.findIndex(
    (sample) =>
      (sample.interactive.maxConcurrent > Number(interactiveFloor?.guaranteedMaxConcurrent ?? 0) ||
        sample.interactive.tokenBudget > Number(interactiveFloor?.guaranteedTokenBudget ?? 0)) &&
      (sample.batch.maxConcurrent < Number(batchFloor?.guaranteedMaxConcurrent ?? 0) ||
        sample.batch.tokenBudget < Number(batchFloor?.guaranteedTokenBudget ?? 0)),
  );
  const restoredIndex = lentIndex < 0
    ? -1
    : samples.findIndex(
        (sample, index) =>
          index > lentIndex &&
          sample.interactive.maxConcurrent <= Number(interactiveFloor?.guaranteedMaxConcurrent ?? 0) &&
          sample.interactive.tokenBudget <= Number(interactiveFloor?.guaranteedTokenBudget ?? 0) &&
          sample.batch.maxConcurrent >= Number(batchFloor?.guaranteedMaxConcurrent ?? 0) &&
          sample.batch.tokenBudget >= Number(batchFloor?.guaranteedTokenBudget ?? 0),
      );
  const firstRestoredSample = restoredIndex >= 0 ? samples[restoredIndex] : null;
  const headroomTransferIndex = samples.findIndex((sample) => {
    const batchExpanded =
      sample.batch.maxConcurrent > Number(batchFloor?.guaranteedMaxConcurrent ?? 0) ||
      sample.batch.tokenBudget > Number(batchFloor?.guaranteedTokenBudget ?? 0);
    const interactiveReleased =
      sample.interactive.maxConcurrent < Number(interactiveFloor?.guaranteedMaxConcurrent ?? 0) ||
      sample.interactive.tokenBudget < Number(interactiveFloor?.guaranteedTokenBudget ?? 0);
    return batchExpanded && interactiveReleased;
  });
  const firstHeadroomTransferSample = headroomTransferIndex >= 0 ? samples[headroomTransferIndex] : null;
  const batchAdmissionBaseline = samples[0]?.batch?.admitted ?? null;
  const firstBatchAdmissionSample = batchAdmissionBaseline === null
    ? null
    : samples.find((sample) => Number(sample?.batch?.admitted ?? 0) > batchAdmissionBaseline) ?? null;
  const firstBatchAdmissionIndex = firstBatchAdmissionSample === null
    ? -1
    : samples.indexOf(firstBatchAdmissionSample);
  const previousBatchAdmissionSample = firstBatchAdmissionIndex > 0
    ? samples[firstBatchAdmissionIndex - 1]
    : null;
  const admissionProvenance = {
    batch: summarizeAdmissionProvenance(samples, { pool: "batch" }),
    interactive: summarizeAdmissionProvenance(samples, { pool: "interactive" }),
  };
  // Provenance events are cumulative ring snapshots, so persisting the complete
  // event array in every 500ms timeline sample would duplicate the same records
  // dozens of times. Keep exact events once above and retain only bounded ring
  // counters in the diagnostic timeline.
  const compactTimeline = samples.map((sample) => ({
    ...sample,
    replicas: sample.replicas.map((replica) => ({
      ...replica,
      interactive: compactAdmissionProvenancePool(replica.interactive),
      batch: compactAdmissionProvenancePool(replica.batch),
    })),
  }));
  return {
    sampleIntervalMs: OPT.handoffSampleIntervalMs,
    samples: samples.length,
    readErrors: errors.length,
    errors: errors.slice(0, 20),
    samplingComplete: samples.length > 0 && errors.length === 0,
    noAppliedOverallocation:
      samples.length > 0 && errors.length === 0 && overConcurrent.length === 0 && overTokens.length === 0,
    maxObservedTotalConcurrent: samples.reduce(
      (max, sample) => Math.max(max, sample.total.maxConcurrent),
      0,
    ),
    maxObservedTotalTokens: samples.reduce(
      (max, sample) => Math.max(max, sample.total.tokenBudget),
      0,
    ),
    observedLentPartition: lentIndex >= 0,
    observedHeadroomTransfer: headroomTransferIndex >= 0,
    headroomTransferObservation: firstHeadroomTransferSample
      ? {
          source: "tyr.stats.applied_limits",
          firstObservedAt: firstHeadroomTransferSample.observedAt,
          interactive: firstHeadroomTransferSample.interactive,
          batch: firstHeadroomTransferSample.batch,
        }
      : null,
    observedRestoredPartition: restoredIndex >= 0,
    admissionProvenance,
    restorationObservation: {
      source: "tyr.stats.applied_limits",
      sampleIntervalMs: OPT.handoffSampleIntervalMs,
      firstObservedPollStartedAt: firstRestoredSample?.pollStartedAt ?? null,
      firstObservedAt: firstRestoredSample?.observedAt ?? null,
      interactive: firstRestoredSample?.interactive ?? null,
      batch: firstRestoredSample?.batch ?? null,
    },
    admissionObservation: {
      source: "tyr.stats.llm.admitted",
      sampleIntervalMs: OPT.handoffSampleIntervalMs,
      baselineBatchAdmissions: batchAdmissionBaseline,
      firstBatchAdmissionObserved: firstBatchAdmissionSample !== null,
      previousPollStartedAt: previousBatchAdmissionSample?.pollStartedAt ?? null,
      previousObservedAt: previousBatchAdmissionSample?.observedAt ?? null,
      firstObservedPollStartedAt: firstBatchAdmissionSample?.pollStartedAt ?? null,
      firstObservedAt: firstBatchAdmissionSample?.observedAt ?? null,
      admittedCountAtFirstObservation: firstBatchAdmissionSample?.batch?.admitted ?? null,
      inFlightAtFirstObservation: firstBatchAdmissionSample?.batch?.inFlight ?? null,
    },
    violations: [
      ...overConcurrent.map((sample) => ({
        kind: "concurrency",
        observedAt: sample.observedAt,
        allocated: sample.total.maxConcurrent,
        envelope: OPT.envelope,
      })),
      ...overTokens.map((sample) => ({
        kind: "tokens",
        observedAt: sample.observedAt,
        allocated: sample.total.tokenBudget,
        envelope: OPT.tokenBudget,
      })),
    ],
    timeline: compactTimeline,
  };
}

async function startAppliedCapacityObserver() {
  if (!OPT.lending) {
    return { stop: async () => null };
  }
  let stopping = false;
  const samples = [];
  const errors = [];

  const capture = async () => {
    const pollStartedAtMs = Date.now();
    try {
      const statsRows = await readTyrStats();
      const pollCompletedAtMs = Date.now();
      samples.push(appliedCapacitySample(statsRows, pollStartedAtMs, pollCompletedAtMs));
    } catch (error) {
      errors.push({
        observedAt: new Date(pollStartedAtMs).toISOString(),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // Establish the admitted-counter baseline before the load generator starts.
  // Without this synchronous first sample, a fast first admission can happen
  // before the observer's async loop gets scheduled and disappear into the
  // baseline as though it predated the run.
  await capture();

  const done = (async () => {
    while (!stopping) {
      await sleep(OPT.handoffSampleIntervalMs);
      if (!stopping) await capture();
    }
  })();
  return {
    stop: async () => {
      stopping = true;
      await done;
      return summarizeAppliedCapacity(samples, errors);
    },
  };
}

async function readControllerLendingEvidence(
  token,
  loadSummary,
  appliedCapacity = null,
  providerCounters = null,
) {
  if (!CAPACITY_GROUP) return null;
  const base = "http://127.0.0.1:18080";
  // Reconcile first, then fetch evidence. In 0.16.0 these three requests were
  // concurrent, so a handoff committed by the final rebalance could race the
  // event read and disappear from the published proof record.
  const rebalanceResponse = await jsonRequest(
    `${base}/v1/capacity-groups/${CAPACITY_GROUP.name}/rebalance`,
    { method: "POST", token, allowed: [200, 202] },
  );
  const [eventsResponse, demandResponse, grantsResponse] = await Promise.all([
    jsonRequest(`${base}/v1/events?limit=1000`, { token, allowed: [200] }),
    jsonRequest(`${base}/v1/demand`, { token, allowed: [200] }),
    jsonRequest(`${base}/v1/grants?limit=1000`, { token, allowed: [200] }),
  ]);
  const batch = CAPACITY_GROUP.members.find((member) => member.pool === "sim-batch");
  const interactive = CAPACITY_GROUP.members.find((member) => member.pool === "sim-interactive");
  if (!batch) throw new Error("demand-aware capacity group is missing sim-batch");
  if (!interactive) throw new Error("demand-aware capacity group is missing sim-interactive");
  return summarizeControllerLending({
    groupName: CAPACITY_GROUP.name,
    events: eventsResponse.body?.events ?? [],
    demand: demandResponse.body?.demand ?? [],
    grants: grantsResponse.body?.grants ?? [],
    finalRebalance: rebalanceResponse.body?.rebalance ?? rebalanceResponse.body,
    batchPool: batch.pool,
    batchGuaranteedMaxConcurrent: batch.guaranteedMaxConcurrent,
    batchGuaranteedTokenBudget: batch.guaranteedTokenBudget,
    interactiveGuaranteedMaxConcurrent: interactive.guaranteedMaxConcurrent,
    interactiveGuaranteedTokenBudget: interactive.guaranteedTokenBudget,
    interactiveHeadroomLending: interactive.headroomLending ?? null,
    loadgenStartedAtEpochMs: loadSummary?.startedAtEpochMs ?? null,
    measuredRunDurationMs: loadSummary?.config?.durationMs ?? WORKLOAD.durationMs,
    batchFirstAttemptAtMs: loadSummary?.classes?.batch?.firstAttemptAtMs ?? null,
    batchFirstResponseHeadersAtMs:
      loadSummary?.classes?.batch?.firstResponseHeadersAtMs ??
      loadSummary?.classes?.batch?.firstAdmissionAtMs ?? null,
    providerCounters,
    appliedCapacity,
  });
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
      const progressive = stats?.tyr?.progressiveReconciliation;
      if (progressive?.enabled !== true) {
        throw new Error(`${pool.name} on Tyr ${port} does not have progressive reconciliation enabled`);
      }
      if (Number(progressive.updateStepTokens) !== PROGRESSIVE_RECONCILIATION.updateStepTokens) {
        throw new Error(
          `${pool.name} on Tyr ${port} reports progressive updateStepTokens=${progressive.updateStepTokens}; ` +
            `expected ${PROGRESSIVE_RECONCILIATION.updateStepTokens}`,
        );
      }
      if (
        Number(progressive.outputSafetyMarginTokens) !==
        PROGRESSIVE_RECONCILIATION.outputSafetyMarginTokens
      ) {
        throw new Error(
          `${pool.name} on Tyr ${port} reports progressive outputSafetyMarginTokens=` +
            `${progressive.outputSafetyMarginTokens}; expected ` +
            `${PROGRESSIVE_RECONCILIATION.outputSafetyMarginTokens}`,
        );
      }
      if (!Number.isFinite(remainingMs)) {
        throw new Error(`${pool.name} on Tyr ${port} has no current Latchflo grant expiration`);
      }
      if (remainingMs < REQUIRED_INITIAL_GRANT_RUNWAY_MS) {
        throw new Error(
          `${pool.name} on Tyr ${port} grant has only ${Math.max(0, Math.floor(remainingMs))}ms ` +
            `remaining; ${REQUIRED_INITIAL_GRANT_RUNWAY_MS}ms is required for a stable start`,
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
    progressiveReports: 0,
    progressiveUpdates: 0,
    progressiveCoalesced: 0,
    progressiveEarlyReleasedTokens: 0,
  };
  for (const row of statsRows) {
    for (const partition of CAPACITY.pools) {
      const pool = row?.[partition.name] ?? {};
      const token = pool.tokenBudget ?? {};
      for (const key of ["totalReserved", "totalConsumed", "totalRefunded", "totalOverrun"]) {
        total[key] += Number(token[key] ?? 0);
      }
      const progressive = pool.tyr?.progressiveReconciliation ?? {};
      total.progressiveReports += Number(progressive.reports ?? 0);
      total.progressiveUpdates += Number(progressive.updates ?? 0);
      total.progressiveCoalesced += Number(progressive.coalesced ?? 0);
      total.progressiveEarlyReleasedTokens += Number(progressive.earlyReleasedTokens ?? 0);
    }
  }
  return total;
}

function subtractAccounting(after, before) {
  const delta = {};
  for (const key of Object.keys(after)) delta[key] = Math.max(0, after[key] - before[key]);
  return delta;
}

function prometheusMetric(text, name) {
  const samples = prometheusSamples(text, name);
  return samples.length > 0 ? samples[0].value : null;
}

function localOutcomeMetric(text, metricName, outcome) {
  const row = prometheusSamples(text, metricName).find((sample) => sample.labels.outcome === outcome);
  return row?.value ?? 0;
}

/**
 * Direct measurement of the local Redis arm's admission decision cost.
 *
 * Redis has no queue-wait split: the atomic Lua reserve grants or refuses in
 * one coordinator round trip, so that entire timed round trip is decision
 * cost. Results are kept per outcome; a pooled mean would mix different
 * admitted/rejected populations and is not a headline metric.
 */
async function readLocalAdmissionDecision(ports) {
  let totalMs = 0;
  let decisions = 0;
  const outcomes = {
    admitted: { decisionSecondsSum: 0, decisions: 0 },
    rejected: { decisionSecondsSum: 0, decisions: 0 },
  };
  const perReplica = [];
  for (const port of ports) {
    const response = await fetchWithTimeout(`http://127.0.0.1:${port}/metrics`, {}, 2000);
    if (!response.ok) throw new Error(`replica ${port} metrics returned HTTP ${response.status}`);
    const text = await response.text();
    const sumMs = prometheusMetric(text, "replica_admission_overhead_ms_sum");
    const count = prometheusMetric(text, "replica_admission_overhead_decisions_total");
    if (sumMs === null || count === null) {
      throw new Error(`replica ${port} did not expose admission overhead sum/count metrics`);
    }
    totalMs += sumMs;
    decisions += count;

    const admittedCount = localOutcomeMetric(text, "replica_admission_decision_seconds_count", "admitted");
    const rejectedCount = localOutcomeMetric(text, "replica_admission_decision_seconds_count", "rejected");
    const admittedSum = localOutcomeMetric(text, "replica_admission_decision_seconds_sum", "admitted");
    const rejectedSum = localOutcomeMetric(text, "replica_admission_decision_seconds_sum", "rejected");
    const locallyAdmitted = prometheusMetric(text, "replica_admitted_total") ?? 0;
    const locallyRejected =
      (prometheusMetric(text, "replica_rejected_concurrency_total") ?? 0) +
      (prometheusMetric(text, "replica_rejected_budget_total") ?? 0) +
      (prometheusMetric(text, "replica_rejected_queue_timeout_total") ?? 0);
    if (count > 0 && (admittedCount !== locallyAdmitted || rejectedCount !== locallyRejected)) {
      throw new Error(
        `replica ${port} Redis decision population mismatch: ` +
          `timed admitted/rejected=${admittedCount}/${rejectedCount}, counters=${locallyAdmitted}/${locallyRejected}`,
      );
    }
    outcomes.admitted.decisionSecondsSum += admittedSum;
    outcomes.admitted.decisions += admittedCount;
    outcomes.rejected.decisionSecondsSum += rejectedSum;
    outcomes.rejected.decisions += rejectedCount;
    perReplica.push({ port, sumMs, decisions: count, admitted: admittedCount, rejected: rejectedCount });
  }
  const finish = (entry) => ({
    decisions: entry.decisions,
    decisionSecondsSum: +entry.decisionSecondsSum.toFixed(9),
    decisionMsAvg:
      entry.decisions > 0 ? +((entry.decisionSecondsSum * 1000) / entry.decisions).toFixed(6) : null,
    queueWaitCount: null,
    queueWaitSecondsSum: null,
    queueWaitMsAvg: null,
  });
  return {
    status: decisions > 0 ? "measured" : "no-coordinator-calls",
    source: "redis-atomic-lua-reserve-round-trip",
    framing: ADMISSION_TIMING_FRAMING,
    outcomes: { admitted: finish(outcomes.admitted), rejected: finish(outcomes.rejected) },
    totalDecisions: decisions,
    // Legacy fields retained so historical tooling can still read this arm.
    overheadMsAvg: decisions > 0 ? +(totalMs / decisions).toFixed(4) : null,
    totalMs: +totalMs.toFixed(4),
    decisions,
    perReplica,
  };
}

async function readTyrMetricsTexts() {
  return Promise.all(TYR_PORTS.map(async (port) => {
    const response = await fetchWithTimeout(`http://127.0.0.1:${port}/metrics`, {}, 2000);
    if (!response.ok) throw new Error(`Tyr ${port} metrics returned HTTP ${response.status}`);
    return response.text();
  }));
}

function assertTyrEnforceMode(statsRows) {
  let pools = 0;
  for (const [index, row] of statsRows.entries()) {
    for (const partition of CAPACITY.pools) {
      const stats = row?.[partition.name];
      if (!stats) continue;
      pools += 1;
      if (stats?.tyr?.admissionMode !== "enforce") {
        throw new Error(
          `Tyr ${TYR_PORTS[index]} pool ${partition.name} ran admissionMode=${stats?.tyr?.admissionMode ?? "unknown"}; ` +
            `admission-decision comparison requires enforce mode`,
        );
      }
    }
  }
  if (pools === 0) throw new Error("could not verify enforce mode for any Tyr benchmark pool");
}

/**
 * Runs one locally-admitted arm: same four-replica hop, same provider, same
 * immutable trace. Only the replica's admission policy changes.
 *
 * Tyr is stopped for the duration so no grant or admission decision from the
 * managed path can leak into a control measurement.
 */
async function runLocalArm({ name, replicaArm, replicaFlags, armLabel, file, needsRedis }) {
  command("docker", composeArgs("stop", ...TYR_SERVICES), { allowFailure: true, quiet: true });
  if (needsRedis) await flushRedis();

  const provider = launchNode("provider", "sim/provider-sim.mjs", providerArgs());
  const ready = await waitForChildOutput(provider, `provider-sim :${PROVIDER_PORT}`, {
    timeoutMs: 15000,
    label: "provider simulator",
  });
  await assertProviderIdentity(ready.line);

  const replicas = [];
  try {
    for (let index = 0; index < TYR_PORTS.length; index += 1) {
      const port = TYR_PORTS[index];
      const replica = launchNode(`${name}-r${index + 1}`, "arms/replica.mjs", [
        `--port=${port}`,
        `--id=r${index + 1}`,
        `--arm=${replicaArm}`,
        `--upstream=${PROVIDER_BASE_URL}`,
        ...(typeof replicaFlags === "function" ? replicaFlags(index) : replicaFlags),
      ]);
      replicas.push(replica);
      await waitFor(`http://127.0.0.1:${port}/healthz`, {
        timeoutMs: 10000,
        label: `${name} replica ${index + 1}`,
        child: replica,
      });
    }

    const outFile = path.join(RESULTS, file);
    rmSync(outFile, { force: true });
    const { summary } = await runLoadgen({
      interactiveTargets: INTERACTIVE_PORTS.map((port) => `http://127.0.0.1:${port}`),
      batchTargets: BATCH_PORTS.map((port) => `http://127.0.0.1:${port}`),
      armLabel,
      outFile,
    });
    summary.simCounters = await readProviderCounters();
    summary.admissionDecision = await readLocalAdmissionDecision(TYR_PORTS);
    attachScenario(summary, { consultsCoordinator: Boolean(needsRedis) });
    attachLending(summary);
    writeFileSync(outFile, JSON.stringify(summary, null, 2));
    return summary;
  } finally {
    await Promise.all([...replicas, provider].map((child) => terminateHostChild(child)));
  }
}

/**
 * Splits a completed run at the configured batch arrival and records what
 * occupancy reached on each side.
 *
 * The interactive ceiling is what the interactive pool owns outright, so
 * occupancy above it during the idle window is capacity that came from
 * somewhere else. For an uncontrolled or locally-capped arm there is no pool
 * structure at all, so the ceiling is the whole envelope and nothing can be
 * reported as borrowed — which is the correct answer for those arms.
 */
function attachLending(summary, { interactiveCeiling, controlPlane = null } = {}) {
  if (!OPT.lending) return;
  const metrics = lendingMetrics({
    summary,
    peakActiveBySecond: summary.simCounters?.peakActiveBySecond ?? [],
    batchArrivalMs: WORKLOAD.batchStartMs,
    runEndMs: WORKLOAD.durationMs,
    interactiveCeiling: interactiveCeiling ?? OPT.envelope,
    envelope: OPT.envelope,
  });
  const handoff = controlPlane?.handoff ?? null;
  if (handoff !== null) {
    metrics.floorReassertion = {
      ...metrics.floorReassertion,
      batchFirstAdmissionWindow: handoff.firstBatchAdmissionWindow ?? null,
      admissionGapMinMs: handoff.attemptToFirstBatchAdmissionMinMs ?? null,
      admissionGapMaxMs: handoff.attemptToFirstBatchAdmissionMaxMs ?? null,
      admissionObserved: handoff.firstBatchAdmissionWindow?.notAfterAt !== null &&
        handoff.firstBatchAdmissionWindow?.notAfterAt !== undefined,
    };
  }
  summary.lending = {
    ...metrics,
    controlPlane,
  };
}

/**
 * Polls Redis until it answers, because a freshly created container accepts
 * TCP before it is serving commands. Called once during startup so a missing
 * or slow Redis fails with an actionable message before any arm has run,
 * rather than mid-sweep after several minutes of work.
 */
async function waitForRedis({ timeoutMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    const redis = new RedisClient();
    try {
      await redis.connect();
      await redis.command("PING");
      redis.close();
      return;
    } catch (error) {
      lastError = error;
      redis.close();
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(
    "Redis never became ready for the coordinated arm (arm 4). It is defined in demo/compose.yaml " +
      "and started automatically when --control-arms includes redis. Check " +
      "`docker compose -f demo/compose.yaml ps redis` and its logs, and that port 6379 is free. " +
      `Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

/**
 * Arm 4 keeps concurrency and token state in Redis. Leaked leases from an
 * earlier seed would silently shrink the capacity this seed sees, so the keys
 * are cleared before every run rather than relying on TTL expiry.
 */
async function flushRedis() {
  const redis = new RedisClient();
  try {
    await redis.connect();
    await redis.command("DEL", "bench:leases", "bench:tokens", "bench:inflight");
  } catch (error) {
    throw new Error(
      `Could not clear Redis state before the coordinated arm: ${
        error instanceof Error ? error.message : String(error)
      }. Running without a flush would carry leases from the previous seed into this one.`,
    );
  } finally {
    redis.close();
  }
}

async function runBaseline() {
  // The control arm keeps the same four-replica hop and the same provider.
  // Its replica policy is passthrough: every request is forwarded and no
  // Latchflo/Tyr admission decision exists anywhere in the request path.
  return runLocalArm({
    name: "baseline",
    replicaArm: "passthrough",
    replicaFlags: [],
    armLabel: "baseline-no-control",
    file: "baseline.json",
    needsRedis: false,
  });
}

async function runMoflux(env) {
  const sim = launchNode("provider", "sim/provider-sim.mjs", providerArgs());
  const ready = await waitForChildOutput(sim, `provider-sim :${PROVIDER_PORT}`, {
    timeoutMs: 15000,
    label: "provider simulator",
  });
  await assertProviderIdentity(ready.line);

  const liveGrants = await startTyr(env);
  const beforeStats = await readTyrStats();
  assertTyrEnforceMode(beforeStats);
  const before = aggregateTokenAccounting(beforeStats);
  const admissionTimingBefore = await readTyrMetricsTexts();
  const admissionTimingOverhead = measureAdmissionClockOverhead();
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

  const capacityObserver = await startAppliedCapacityObserver();
  let summary;
  let appliedCapacity;
  let demandPolicyActivation = null;
  try {
    const run = await runLoadgen({
      interactiveTargets: INTERACTIVE_PORTS.map((port) => `http://127.0.0.1:${port}`),
      batchTargets: BATCH_PORTS.map((port) => `http://127.0.0.1:${port}`),
      armLabel: OPT.fault ? "moflux-enforce-fault" : "moflux-enforce",
      outFile,
      whileRunning: CAPACITY_GROUP
        ? ({ measuredRunStartedAtMs, loadgen }) =>
            activateDemandAwareLending(env.LATCHFLO_ADMIN_TOKEN, measuredRunStartedAtMs, loadgen)
        : null,
    });
    summary = run.summary;
    demandPolicyActivation = run.sideResult;
  } finally {
    appliedCapacity = await capacityObserver.stop();
  }
  const simCounters = await readProviderCounters();
  let admissionDecision = null;
  if (!OPT.fault) {
    const admissionTimingAfter = await readTyrMetricsTexts();
    admissionDecision = summarizeTyrAdmissionTiming({
      beforeTexts: admissionTimingBefore,
      afterTexts: admissionTimingAfter,
      tyrVersion: TYR_VERSION,
    });
    admissionDecision.instrumentationOverhead = admissionTimingOverhead;
  }

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
  const controlPlaneLending = await readControllerLendingEvidence(
    env.LATCHFLO_ADMIN_TOKEN,
    summary,
    appliedCapacity,
    simCounters,
  );
  const tokenAccounting = subtractAccounting(after, before);
  const grossRecoveryRate =
    tokenAccounting.totalReserved > 0
      ? tokenAccounting.totalRefunded / tokenAccounting.totalReserved
      : 0;
  const netRecovered = tokenAccounting.totalRefunded - tokenAccounting.totalOverrun;
  const netRecoveryRate =
    tokenAccounting.totalReserved > 0 ? netRecovered / tokenAccounting.totalReserved : 0;

  summary.simCounters = simCounters;
  summary.admissionDecision = admissionDecision;
  // MoFlux holds a grant and decides locally, so it never consults a
  // coordinator while admitting however far away Latchflo is.
  attachScenario(summary, { consultsCoordinator: false });
  // MoFlux is the only arm with a real pool structure, so it is the only arm
  // whose interactive ceiling is narrower than the envelope — and therefore
  // the only one where borrowing is even expressible.
  attachLending(summary, {
    interactiveCeiling: CAPACITY.interactiveConcurrencySlots,
    controlPlane: controlPlaneLending,
  });
  summary.runtime = {
    tyr: { version: TYR_VERSION, image: env.MOFLUX_TYR_IMAGE },
    latchflo: { version: LATCHFLO_VERSION, image: env.MOFLUX_LATCHFLO_IMAGE },
    asyncBulkheadLlm: { version: ASYNC_BULKHEAD_LLM_VERSION },
    asyncBulkheadTs: { version: ASYNC_BULKHEAD_TS_VERSION },
  };
  summary.capacity = {
    profile: CAPACITY.profile,
    policy: CAPACITY.policy,
    batchFloorPercent: CAPACITY.batchFloorPercent,
    batchConcurrencySlots: CAPACITY.batchConcurrencySlots,
    interactiveConcurrencySlots: CAPACITY.interactiveConcurrencySlots,
    batchConcurrencyPercent: CAPACITY.batchConcurrencyPercent,
    batchTokenPercent: CAPACITY.batchTokenPercent,
    envelope: OPT.envelope,
    tokenBudget: OPT.tokenBudget,
    capacityGroup: CAPACITY_GROUP,
    demandPolicy: CAPACITY.demandPolicy,
    demandPolicyActivation,
    pools: RESOLVED_CAPACITY,
    liveGrants,
  };
  const progressiveEarlyReleaseRate =
    tokenAccounting.totalRefunded > 0
      ? tokenAccounting.progressiveEarlyReleasedTokens / tokenAccounting.totalRefunded
      : 0;
  summary.tokenAccounting = {
    ...tokenAccounting,
    grossRecoveryRate: +grossRecoveryRate.toFixed(4),
    netRecovered,
    netRecoveryRate: +netRecoveryRate.toFixed(4),
    progressiveEarlyReleaseRate: +progressiveEarlyReleaseRate.toFixed(4),
    progressiveConfiguration: PROGRESSIVE_RECONCILIATION,
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

/** Scene index for the nth control arm, after the baseline. */
function controlScene(spec) {
  return 3 + CONTROL_ARMS.indexOf(spec);
}

/** MoFlux runs after the baseline and every control arm. */
function mofluxScene() {
  if (OPT.mode !== "compare") return 2;
  return 3 + CONTROL_ARMS.length;
}

/**
 * Generic arm-vs-arm deltas for every arm in the run.
 *
 * `video-comparison.json` keeps its exact baseline-versus-MoFlux shape for
 * existing consumers. This file is additive and answers the question that one
 * cannot: how does MoFlux compare against the alternatives a reader would
 * build, rather than against doing nothing.
 */
function armDelta(reference, candidate) {
  const base = reference.classes.interactive;
  const cand = candidate.classes.interactive;
  const baseGoodput = interactiveGoodput(reference);
  const candGoodput = interactiveGoodput(candidate);
  const pct = (from, to) => (from > 0 ? +(((to / from) - 1) * 100).toFixed(2) : null);
  return {
    interactiveSuccessPercentagePointChange: +((cand.successRate - base.successRate) * 100).toFixed(2),
    interactiveGoodputChangePercent: pct(baseGoodput, candGoodput),
    interactiveP50LatencyChangePercent: pct(base.latencyMs.p50, cand.latencyMs.p50),
    interactiveP95LatencyChangePercent: pct(base.latencyMs.p95, cand.latencyMs.p95),
    interactiveTtftP50ChangePercent: pct(base.ttftMs.p50, cand.ttftMs.p50),
    interactiveTtftP95ChangePercent: pct(base.ttftMs.p95, cand.ttftMs.p95),
    batchSuccessPercentagePointChange: +(
      (candidate.classes.batch.successRate - reference.classes.batch.successRate) * 100
    ).toFixed(2),
    retryAmplificationChangePercent: pct(base.retryAmplification, cand.retryAmplification),
    upstream429Reference:
      reference.classes.interactive.upstreamReject + reference.classes.batch.upstreamReject,
    upstream429Candidate:
      candidate.classes.interactive.upstreamReject + candidate.classes.batch.upstreamReject,
  };
}

function armRecord(summary) {
  const interactive = summary.classes.interactive;
  const batch = summary.classes.batch;
  return {
    interactiveSuccessRate: interactive.successRate,
    interactiveGoodputRps: +interactiveGoodput(summary).toFixed(3),
    interactiveP50Ms: interactive.latencyMs.p50,
    interactiveP95Ms: interactive.latencyMs.p95,
    interactiveTtftP50Ms: interactive.ttftMs.p50,
    interactiveTtftP95Ms: interactive.ttftMs.p95,
    interactiveRetryAmplification: interactive.retryAmplification,
    batchSuccessRate: batch.successRate,
    localRejects: interactive.localReject + batch.localReject,
    upstream429s: interactive.upstreamReject + batch.upstreamReject,
    peakActive: Number(summary.simCounters?.peakActive ?? 0),
  };
}

/**
 * Reports whether lending actually happened, rather than whether it was
 * configured. The static control arm is the reference: it cannot exceed its
 * ceiling while batch is idle, so any gain over it is observed borrowing.
 */
function printLending(baseline, controlResults, moflux) {
  const reference = controlResults.get("staticPartition") ?? controlResults.get("staticCap") ?? baseline;
  if (!reference?.lending || !moflux?.lending) return;
  const comparison = lendingComparison(reference.lending, moflux.lending);
  console.log(`\n${BOLD}   Capacity lending — idle batch window, then batch arrival${OFF}`);
  console.table([
    {
      window: `idle (0–${(WORKLOAD.batchStartMs / 1000).toFixed(1)}s)`,
      "reference peak": `${reference.lending.idleWindow.peakActive}/${OPT.envelope}`,
      "MoFlux peak": `${moflux.lending.idleWindow.peakActive}/${OPT.envelope}`,
      borrowed: moflux.lending.idleWindow.borrowedSlots ?? "n/a",
    },
    {
      window: `contended (${(WORKLOAD.batchStartMs / 1000).toFixed(1)}s+)`,
      "reference peak": `${reference.lending.contendedWindow.peakActive}/${OPT.envelope}`,
      "MoFlux peak": `${moflux.lending.contendedWindow.peakActive}/${OPT.envelope}`,
      borrowed: "—",
    },
  ]);
  const controller = moflux.lending.controlPlane;
  const lendingProven = comparison.lendingObserved && controller?.lendingObserved === true;
  console.log(
    lendingProven
      ? `${GREEN}   Lending proven twice: idle occupancy gained ${comparison.idlePeakActiveGain} slot(s), and Latchflo recorded capacity_group.lending_observed.${OFF}`
      : comparison.lendingObserved
        ? `${YELLOW}   Occupancy suggests lending, but no matching Latchflo lending event was captured. Treat the run as inconclusive.${OFF}`
        : `${YELLOW}   No lending observed: idle occupancy did not exceed the static reference.${OFF}`,
  );
  const batchServed = moflux.lending.floorReassertion.reasserted;
  const controllerRestored = controller?.floorRestored === true;
  const admissionMin = moflux.lending.floorReassertion.admissionGapMinMs;
  const admissionMax = moflux.lending.floorReassertion.admissionGapMaxMs;
  const admissionText = admissionMin !== null && admissionMax !== null
    ? ` first Tyr admission was bounded to ${admissionMin.toFixed(0)}-${admissionMax.toFixed(0)}ms after the first batch attempt.`
    : " admission timing was not fully bounded.";
  console.log(
    batchServed && controllerRestored
      ? `${GREEN}   Floor restored: Latchflo restored the batch guarantee;${admissionText}${OFF}`
      : batchServed
        ? `${YELLOW}   Batch completed work, but the Latchflo event stream did not prove floor restoration.${OFF}`
        : `${RED}   Floor NOT restored: batch was never served.${OFF}`,
  );
  const outFile = path.join(RESULTS, "lending.json");
  writeFileSync(
    outFile,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        scenario: moflux.scenario,
        batchArrivalMs: WORKLOAD.batchStartMs,
        referenceArm: controlResults.has("staticPartition")
          ? "staticPartition"
          : controlResults.has("staticCap")
            ? "staticCap"
            : "baseline",
        reference: reference.lending,
        moflux: moflux.lending,
        comparison,
      },
      null,
      2,
    ),
  );
  console.log(`   lending: ${path.relative(ROOT, outFile)}`);
}

function writeArmComparisons(baseline, controls, moflux) {
  const arms = { baseline, ...Object.fromEntries(controls), moflux };
  const comparisons = {
    generatedAt: new Date().toISOString(),
    scenario: baseline.scenario,
    envelope: OPT.envelope,
    arms: Object.fromEntries(Object.entries(arms).map(([key, s]) => [key, armRecord(s)])),
    // Against no control: does this policy help at all?
    versusBaseline: Object.fromEntries(
      Object.entries(arms)
        .filter(([key]) => key !== "baseline")
        .map(([key, s]) => [key, armDelta(baseline, s)]),
    ),
    // Against each alternative: is MoFlux worth deploying over it?
    mofluxVersus: Object.fromEntries(
      controls.map(([key, s]) => [key, armDelta(s, moflux)]),
    ),
  };
  const outFile = path.join(RESULTS, "arm-comparisons.json");
  writeFileSync(outFile, JSON.stringify(comparisons, null, 2));
  return { comparisons, outFile };
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
  if (t.progressiveConfiguration?.enabled !== false) {
    console.log(
      `   early release ${Number(t.progressiveEarlyReleasedTokens ?? 0).toLocaleString("en-US")} ` +
        `(${percent(t.progressiveEarlyReleaseRate ?? 0)} of refunds)`,
    );
    console.log(
      `   live reports  ${Number(t.progressiveReports ?? 0).toLocaleString("en-US")} ` +
        `(${Number(t.progressiveUpdates ?? 0).toLocaleString("en-US")} applied, ` +
        `${Number(t.progressiveCoalesced ?? 0).toLocaleString("en-US")} coalesced)`,
    );
  }
  say(
    "Recovery means unused safety reservation was returned to the pool for reuse;",
    "early release is the portion returned while a stream was still active.",
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
  // The provider simulator is a host process, so nothing in Compose can free
  // this port and `npm run demo:down` will not either. Checking it here turns
  // an orphan from an interrupted run into a preflight failure with a fix in
  // it, instead of a startup timeout in the middle of an arm.
  //
  // Only the simulator port is checked. Tyr publishes 8101-8104 from
  // containers that legitimately survive between seeds when the stack is kept
  // up, so asserting those free would fail correct runs.
  await assertHostPortFree(PROVIDER_PORT, { label: "provider simulator port" });
  console.log(`${GREEN}   ✓ Host port ${PROVIDER_PORT} is free for the provider simulator${OFF}`);
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
    `Both arms use scenario ${SCENARIO_ID}: ${PROVIDER.api} streaming, seed ${WORKLOAD.seed}, ${WORKLOAD.interactiveRps} interactive RPS, then ${WORKLOAD.batchRps} batch RPS.`,
    `Capacity is partitioned by tier: ${RESOLVED_CAPACITY
      .map((pool) => `${pool.name} ${pool.maxConcurrent}/${pool.tokenFundedConcurrency} configured/funded slots, ${pool.tokenBudget.toLocaleString("en-US")} tokens across ${pool.agentCount} agent${pool.agentCount === 1 ? "" : "s"}`)
      .join(", ")}.`,
    `Capacity profile ${CAPACITY.profile}: ${CAPACITY.interactiveConcurrencySlots}/${CAPACITY.batchConcurrencySlots} protected slots; all ${OPT.envelope} slots are token-funded.`,
    `The immutable trace is ${TRACE.hash.slice(0, 12)} with ${TRACE.planned.interactive} interactive and ${TRACE.planned.batch} batch requests.`,
  );
  await startControlPlane(env);
  openBrowser("http://127.0.0.1:3000");
  console.log(`${GREEN}   ✓ Latchflo, telemetry relay, Prometheus, and Grafana are ready${OFF}`);
  const startsWithBaseline = OPT.mode === "compare" || OPT.mode === "baseline";
  await cue(startsWithBaseline ? "run the uncontrolled baseline" : "start Tyr and run MoFlux");

  const controlResults = new Map();
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
    await cue(CONTROL_ARMS.length > 0 ? "run the buy-vs-build control arms" : "transition to Tyr + Latchflo");
  }

  // Arms 2 and 4: the alternatives a reader would otherwise build. Same
  // trace, same replicas, same provider — only the admission policy differs.
  for (const spec of CONTROL_ARMS) {
    scene(controlScene(spec), spec.title);
    say(spec.caption);
    await annotate(spec.title, [spec.key]);
    const summary = await runLocalArm({
      name: spec.key,
      replicaArm: spec.replicaArm,
      replicaFlags: (index) => spec.replicaFlags(OPT, index),
      armLabel: spec.armLabel,
      file: spec.file,
      needsRedis: spec.needsRedis,
    });
    assertValidRun(summary, spec.title);
    controlResults.set(spec.key, summary);
    console.table([experienceRow(spec.title, summary)]);
    console.table([protectionRow(spec.title, summary)]);
    await cue("continue");
  }

  scene(mofluxScene(), OPT.fault ? "MoFlux with a replica failure" : "MoFlux enforce");
  say(
    `Latchflo allocates ${OPT.envelope} concurrent slots and ${OPT.tokenBudget.toLocaleString("en-US")} in-flight tokens`,
    "across four interactive Tyr paths, with replica 4 also carrying the batch pool. Tyr makes each admission decision locally.",
    PROVIDER.api === "anthropic"
      ? "Tyr progressively returns processed input and generated-output reservation while each Anthropic stream is still active."
      : "This OpenAI compatibility run settles usage at completion; progressive early release is expected to remain zero.",
  );
  const moflux = await runMoflux(env);
  assertValidRun(moflux, "MoFlux run");

  scene(mofluxScene() + 1, "Result");
  const experienceRows = [];
  const protectionRows = [];
  if (baseline) {
    experienceRows.push(experienceRow("No control", baseline));
    protectionRows.push(protectionRow("No control", baseline));
  }
  for (const spec of CONTROL_ARMS) {
    const summary = controlResults.get(spec.key);
    if (!summary) continue;
    experienceRows.push(experienceRow(spec.title, summary));
    protectionRows.push(protectionRow(spec.title, summary));
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
    if (OPT.lending) printLending(baseline, controlResults, moflux);
    if (CONTROL_ARMS.length > 0) {
      const controls = CONTROL_ARMS.map((spec) => [spec.key, controlResults.get(spec.key)]).filter(
        ([, summary]) => Boolean(summary),
      );
      const { outFile } = writeArmComparisons(baseline, controls, moflux);
      console.log(`   arm comparisons: ${path.relative(ROOT, outFile)}`);
    }
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
