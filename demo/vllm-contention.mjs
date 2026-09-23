#!/usr/bin/env node
/**
 * Four-arm vLLM contention experiment with NVIDIA and Apple-Silicon backends.
 *
 *   vllm-fcfs      direct vLLM, FCFS scheduling
 *   vllm-priority  direct vLLM, native priority scheduling
 *   static         fixed 3/1 admission partition + vLLM priority
 *   moflux         adaptive lending admission + vLLM priority
 *
 * Every arm gets a freshly recreated vLLM process on the same hardware,
 * immutable model revision, and engine limits. Warm-up is excluded. NVIDIA and
 * Metal runs use distinct results/runs namespaces and reviewed targets.
 */

import { execFile, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { retainDiagnostics } from "./diagnostics-lib.mjs";
import { buildTrace } from "../load/trace-lib.mjs";
import {
  DEFAULT_VLLM_IMAGE,
  DEFAULT_VLLM_MODEL,
  DEFAULT_VLLM_MODEL_REVISION,
  DEFAULT_VLLM_LATCHFLO_IMAGE,
  DEFAULT_VLLM_TYR_IMAGE,
  DEFAULT_VLLM_SERVED_MODEL,
  VLLM_LATCHFLO_VERSION,
  VLLM_TYR_VERSION,
  VLLM_VERSION,
  ensureDemoEnv,
  imageMatchesVersion,
} from "./env-lib.mjs";
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
  assertHostPortFree,
  childOutputTail,
  fetchTextFresh,
  fetchWithTimeout,
  launchCommand,
  launchNode,
  sleep,
  stopHostChildren,
  terminateHostChild,
  waitFor,
} from "./host-process-lib.mjs";
import { startIdentityFixture } from "./identity-fixture-lib.mjs";
import {
  criticalWindowDigest,
  summarizeClassHandoffSafety,
  summarizeArmClasses,
  summarizeDemandTransitions,
  summarizeLendingEpisodes,
} from "./local-contention-lib.mjs";
import { assertLocalUpstream } from "./local-inference-lib.mjs";
import {
  summarizeLatchfloRestorationEpisodes,
  summarizeTyrRestoration,
  summarizeUnlentFloorGauges,
} from "./restoration-enforceability-lib.mjs";
import {
  assertDockerAvailable,
  composeCommand,
  ensureRuntimeImage,
  parseEnvFile,
} from "./runtime-image-lib.mjs";
import {
  VLLM_ARM_IDS,
  VLLM_ARMS,
  VLLM_ENDPOINT,
  VLLM_EVIDENCE_LIMITS,
  VLLM_METAL_EVIDENCE_LIMITS,
  VLLM_METAL_RUNTIME_PROBE_PREFIX,
  VLLM_METAL_SWEEP_NAME,
  VLLM_HYPOTHESIS_THRESHOLDS,
  VLLM_IDENTITY_PORT,
  VLLM_LATCHFLO_PORT,
  VLLM_MAX_NUM_SEQS,
  VLLM_PORT,
  VLLM_PUBLICATION_SEED_COUNT,
  VLLM_SWEEP_NAME,
  VLLM_WARMUP_REQUESTS_PER_CLASS,
  armOrderIsCounterbalanced,
  armOrderPlan,
  compareVllmArms,
  parseMetalRuntimeProbeOutput,
  parseNvidiaSmiRow,
  parseMemorySysctl,
  parsePmsetTherm,
  parseProcessTreeSnapshot,
  parseVmStat,
  parsePrometheus,
  snapshotVllmMetrics,
  summarizeGpuTelemetry,
  summarizeHostPressure,
  summarizeProcessTelemetry,
  summarizeManagedRecovery,
  summarizeVllmTelemetry,
  vllmApiKeyArgument,
  vllmArm,
  vllmFixedOutputFields,
  vllmNominalClassGrant,
  vllmPolicyForBackend,
  vllmPoolDefinition,
  vllmGpuMemoryUtilizationForBackend,
  vllmSamplingForBackend,
  vllmSeedProof,
  vllmSweepProof,
  vllmWorkloadForBackend,
} from "./vllm-contention-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const ENV_FILE = process.env.MOFLUX_BENCH_ENV_FILE
  ? path.resolve(process.env.MOFLUX_BENCH_ENV_FILE)
  : path.join(ROOT, "demo", "moflux", ".env");
const ENV_EXAMPLE = path.join(ROOT, "demo", "moflux", ".env.example");
const NVIDIA_COMPOSE_FILE = path.join(ROOT, "demo", "vllm", "compose.yaml");
const METAL_COMPOSE_FILE = path.join(ROOT, "demo", "vllm", "compose-metal.yaml");
const IDENTITY_RUNTIME = path.join(ROOT, "demo", "vllm", "runtime");
const RESULTS = process.env.MOFLUX_BENCH_RESULTS_DIR
  ? path.resolve(process.env.MOFLUX_BENCH_RESULTS_DIR)
  : path.join(ROOT, "results");
const LATCHFLO = `http://127.0.0.1:${VLLM_LATCHFLO_PORT}`;
const VLLM_ORIGIN = `http://127.0.0.1:${VLLM_PORT}`;
const VLLM_METRICS_URL = `${VLLM_ORIGIN}/metrics`;
const HF_CACHE_VOLUME = "moflux-bench-vllm-hf-cache";
const MANAGED_ARMS = VLLM_ARMS.filter(({ managed }) => managed);

const args = new Map();
for (const arg of process.argv.slice(2)) {
  const match = /^--([^=]+)=(.*)$/u.exec(arg);
  if (match) args.set(match[1], match[2]);
  else if (arg.startsWith("--")) args.set(arg.slice(2), "true");
}
const str = (name, fallback) => args.get(name) ?? fallback;
const num = (name, fallback) => (args.has(name) ? Number(args.get(name)) : fallback);
const flag = (name) => args.get(name) === "true";

function parseSeeds(raw) {
  const values = [];
  for (const part of String(raw).split(",").map((value) => value.trim()).filter(Boolean)) {
    const range = /^(\d+)-(\d+)$/u.exec(part);
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
  const unique = [...new Set(String(raw).split(",").map((value) => value.trim()).filter(Boolean))];
  for (const id of unique) vllmArm(id);
  if (unique.length < 2) throw new Error("--arms must name at least two arms");
  return unique;
}

let OPT;
let DEFAULT_WORKLOAD;
let DEFAULT_SAMPLING;
try {
  const backend = str("backend", "nvidia");
  DEFAULT_WORKLOAD = vllmWorkloadForBackend(backend);
  DEFAULT_SAMPLING = vllmSamplingForBackend(backend);
  OPT = Object.freeze({
    seeds: parseSeeds(str("seeds", `1-${VLLM_PUBLICATION_SEED_COUNT}`)),
    arms: parseArms(str("arms", VLLM_ARM_IDS.join(","))),
    backend,
    image: str("image", process.env.MOFLUX_VLLM_IMAGE ?? DEFAULT_VLLM_IMAGE),
    model: str("model", process.env.MOFLUX_VLLM_MODEL ?? DEFAULT_VLLM_MODEL),
    modelRevision: str(
      "model-revision",
      process.env.MOFLUX_VLLM_MODEL_REVISION ?? DEFAULT_VLLM_MODEL_REVISION,
    ),
    servedModel: str(
      "served-model",
      process.env.MOFLUX_VLLM_SERVED_MODEL ?? DEFAULT_VLLM_SERVED_MODEL,
    ),
    durationMs: num("duration-ms", DEFAULT_WORKLOAD.durationMs),
    warmupRequestsPerClass: num(
      "warmup-requests-per-class",
      VLLM_WARMUP_REQUESTS_PER_CLASS,
    ),
    gpuIndex: str("gpu-index", "0"),
    metalBin: str(
      "metal-bin",
      process.env.MOFLUX_VLLM_METAL_BIN ?? path.join(homedir(), ".venv-vllm-metal/bin/vllm"),
    ),
    metalPython: str(
      "metal-python",
      process.env.MOFLUX_VLLM_METAL_PYTHON ?? path.join(homedir(), ".venv-vllm-metal/bin/python"),
    ),
    dcgmUrl: str("dcgm-url", ""),
    telemetryIntervalMs: num("telemetry-interval-ms", DEFAULT_SAMPLING.vllmIntervalMs),
    managedTelemetryIntervalMs: num(
      "managed-telemetry-interval-ms",
      DEFAULT_SAMPLING.managedIntervalMs,
    ),
    platformTelemetryIntervalMs: num(
      "platform-telemetry-interval-ms",
      DEFAULT_SAMPLING.platformIntervalMs,
    ),
    pauseMs: num("pause-ms", 2_000),
    gpuMemoryUtilization: num(
      "gpu-memory-utilization",
      vllmGpuMemoryUtilizationForBackend(backend),
    ),
    requireProof: flag("require-proof"),
    keepStack: flag("keep-stack"),
    dryRun: flag("dry-run"),
    doctor: flag("doctor"),
    runId: str("run-id", newRunId()),
    out: args.has("out") ? path.resolve(str("out", "")) : null,
  });
  if (!["nvidia", "metal"].includes(OPT.backend)) {
    throw new Error("--backend must be nvidia or metal");
  }
  if (OPT.backend === "metal" && OPT.dcgmUrl) {
    throw new Error("--dcgm-url is NVIDIA-specific and cannot be used with --backend=metal");
  }
  if (OPT.servedModel !== DEFAULT_VLLM_SERVED_MODEL) {
    throw new Error(
      `--served-model must remain ${DEFAULT_VLLM_SERVED_MODEL}; both Tyr configs route that exact alias`,
    );
  }
  if (
    !Number.isFinite(OPT.gpuMemoryUtilization) ||
    OPT.gpuMemoryUtilization < 0.05 ||
    OPT.gpuMemoryUtilization > 0.95
  ) {
    throw new Error("--gpu-memory-utilization must be a number from 0.05 to 0.95");
  }
  if (!Number.isSafeInteger(OPT.durationMs) || OPT.durationMs < 85_000) {
    throw new Error("--duration-ms must be an integer of at least 85000");
  }
  if (!Number.isSafeInteger(OPT.warmupRequestsPerClass) || OPT.warmupRequestsPerClass < 5) {
    throw new Error("--warmup-requests-per-class must be at least 5 for Tyr adaptive estimation");
  }
  if (!Number.isSafeInteger(OPT.telemetryIntervalMs) || OPT.telemetryIntervalMs < 100) {
    throw new Error("--telemetry-interval-ms must be an integer of at least 100");
  }
  if (!Number.isSafeInteger(OPT.managedTelemetryIntervalMs) ||
      OPT.managedTelemetryIntervalMs < 100) {
    throw new Error("--managed-telemetry-interval-ms must be an integer of at least 100");
  }
  if (!Number.isSafeInteger(OPT.platformTelemetryIntervalMs) ||
      OPT.platformTelemetryIntervalMs < 250) {
    throw new Error("--platform-telemetry-interval-ms must be an integer of at least 250");
  }
  if (!OPT.out && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(OPT.runId)) {
    throw new Error("--run-id must be a filesystem-safe name without path separators");
  }
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const WORKLOAD = Object.freeze({
  ...DEFAULT_WORKLOAD,
  durationMs: OPT.durationMs,
  windowMs: OPT.durationMs,
});
const POLICY = vllmPolicyForBackend(OPT.backend);
const NOMINAL_CLASS_GRANT = vllmNominalClassGrant(POLICY);
const SAMPLING = Object.freeze({
  ...DEFAULT_SAMPLING,
  vllmIntervalMs: OPT.telemetryIntervalMs,
  managedIntervalMs: OPT.managedTelemetryIntervalMs,
  platformIntervalMs: OPT.platformTelemetryIntervalMs,
});
const IS_METAL = OPT.backend === "metal";
const SWEEP_NAME = IS_METAL ? VLLM_METAL_SWEEP_NAME : VLLM_SWEEP_NAME;
const EVIDENCE_LIMITS = IS_METAL ? VLLM_METAL_EVIDENCE_LIMITS : VLLM_EVIDENCE_LIMITS;
const COMPOSE_FILE = IS_METAL ? METAL_COMPOSE_FILE : NVIDIA_COMPOSE_FILE;
const PROJECT = IS_METAL ? "moflux-vllm-metal-contention" : "moflux-vllm-contention";
const ORDER_PLAN = armOrderPlan(OPT.seeds, OPT.arms);
const ARM_URLS = Object.fromEntries(
  VLLM_ARMS.map((arm) => [arm.id, `http://127.0.0.1:${arm.port}${VLLM_ENDPOINT}`]),
);
let runOutputDir;
let summaryFile;
let pointerFile = null;
try {
  for (const [id, url] of Object.entries(ARM_URLS)) assertLocalUpstream(url, `${id} endpoint`);
  assertLocalUpstream(LATCHFLO, "Latchflo endpoint");
  if (OPT.dcgmUrl) assertLocalUpstream(OPT.dcgmUrl, "DCGM exporter endpoint");
  assertSafeResultsDir(RESULTS, ROOT, "vLLM contention results root");
  runOutputDir = assertSafeRunDir(
    OPT.out ?? runDirFor(RESULTS, SWEEP_NAME, OPT.runId),
    ROOT,
    "vLLM contention run directory",
  );
  summaryFile = assertSafeOutputFile(path.join(runOutputDir, "summary.json"), ROOT);
  if (!OPT.out) pointerFile = latestPointerFile(RESULTS, SWEEP_NAME);
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

/** Overridable for a differently tagged build, but it must be the pinned release. */
const LATCHFLO_IMAGE = process.env.MOFLUX_VLLM_LATCHFLO_IMAGE ?? DEFAULT_VLLM_LATCHFLO_IMAGE;
if (
  !imageMatchesVersion(LATCHFLO_IMAGE, VLLM_LATCHFLO_VERSION) &&
  process.env.MOFLUX_ALLOW_UNPINNED_IMAGES !== "true"
) {
  console.error(
    `\nMOFLUX_VLLM_LATCHFLO_IMAGE must reference Latchflo ${VLLM_LATCHFLO_VERSION}, ` +
      `which renews live leases before expiry; got ${LATCHFLO_IMAGE}`,
  );
  process.exit(1);
}
const TYR_IMAGE = process.env.MOFLUX_VLLM_TYR_IMAGE ?? DEFAULT_VLLM_TYR_IMAGE;
if (
  !imageMatchesVersion(TYR_IMAGE, VLLM_TYR_VERSION) &&
  process.env.MOFLUX_ALLOW_UNPINNED_IMAGES !== "true"
) {
  console.error(
    `\nMOFLUX_VLLM_TYR_IMAGE must reference Tyr ${VLLM_TYR_VERSION}, ` +
      `which names the transport cause of upstream failures; got ${TYR_IMAGE}`,
  );
  process.exit(1);
}

const plan = {
  benchmark: SWEEP_NAME,
  backend: OPT.backend,
  image: IS_METAL ? "native vllm-metal" : OPT.image,
  latchfloImage: LATCHFLO_IMAGE,
  tyrImage: TYR_IMAGE,
  model: OPT.model,
  requestedRevision: OPT.modelRevision,
  servedModel: OPT.servedModel,
  gpuIndex: IS_METAL ? "not-applicable" : OPT.gpuIndex,
  arms: OPT.arms.join(","),
  seeds: OPT.seeds.join(","),
  workloadProfile: WORKLOAD.profile,
  durationMs: WORKLOAD.durationMs,
  fixedOutputLength: true,
  minTokensSent: !IS_METAL,
  maxNumSeqs: VLLM_MAX_NUM_SEQS,
  tokenBudget: POLICY.physical.tokenBudget,
  gpuMemoryUtilization: OPT.gpuMemoryUtilization,
  samplingMs:
    `vllm=${SAMPLING.vllmIntervalMs},managed=${SAMPLING.managedIntervalMs},` +
    `platform=${SAMPLING.platformIntervalMs}`,
  counterbalanced: armOrderIsCounterbalanced(ORDER_PLAN, OPT.arms),
  output: repoRelative(runOutputDir, ROOT),
  reviewedEvidenceWritable: false,
  hostedInferenceCredentialSent: false,
  localInferenceCredentialConfigured: IS_METAL,
  modelRegistryCredentialConfigured: Boolean(
    process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN,
  ),
};
console.log(`${IS_METAL ? "Apple-Silicon" : "GPU-backed"} vLLM contention plan (local endpoints only):`);
console.table([plan]);
console.table(ORDER_PLAN.map(({ seed, order }) => ({ seed, order: order.join(" -> ") })));
if (OPT.dryRun) {
  console.log("PASS dry-run: no directory was created and no model or inference request was sent");
  process.exit(0);
}

let env = { ...process.env };
let ADMIN_TOKEN = process.env.LATCHFLO_ADMIN_TOKEN ?? null;
let identity = null;
let metalProcess = null;
let metalRuntime = null;
let dockerVmMemoryBytes = null;
let metalLaunchCount = 0;
const VLLM_API_KEY = IS_METAL ? `moflux-${randomBytes(32).toString("base64url")}` : "";

function compose(composeArgs, { inherit = false, allowFailure = false, doctor = false } = {}) {
  return composeCommand({
    project: PROJECT,
    envFile: doctor ? ENV_EXAMPLE : ENV_FILE,
    composeFile: COMPOSE_FILE,
    args: composeArgs,
    cwd: path.dirname(COMPOSE_FILE),
    env,
    inherit,
    allowFailure,
  });
}

async function captureDiagnostics(label) {
  const collectors = {
    "compose.log": async () => {
      const { stdout, stderr } = await execFileAsync("docker", [
        "compose", "-p", PROJECT, "--env-file", ENV_FILE, "-f", COMPOSE_FILE,
        "logs", "--no-color", "--timestamps",
      ], { cwd: ROOT, env, encoding: "utf8", timeout: 20_000, maxBuffer: 32 * 1024 * 1024 });
      return stdout + stderr;
    },
    "grants.json": async () => (await jsonRequest(`${LATCHFLO}/v1/grants?limit=1000`)).body,
    "events.json": async () => (await jsonRequest(`${LATCHFLO}/v1/events?limit=1000`)).body,
  };
  for (const arm of MANAGED_ARMS) collectors[`${arm.id}-stats.json`] = () => readPoolStats(arm);
  const secrets = [VLLM_API_KEY, ADMIN_TOKEN, ...Object.values(identity?.tokens ?? {}),
    ...Object.entries(env).filter(([key]) => /TOKEN|SECRET|PASSWORD|API_KEY/iu.test(key)).map(([, value]) => value)];
  const manifest = await retainDiagnostics({
    directory: path.join(runOutputDir, "diagnostics", label), collectors, secrets,
  });
  for (const entry of manifest.entries) {
    if (entry.status === "failed") console.warn(`diagnostics ${label}/${entry.file}: ${entry.error}`);
  }
}

function runCommand(command, commandArgs, { allowFailure = false, timeoutMs = 30_000 } = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(
      `${command} ${commandArgs.join(" ")} failed: ${(result.stderr || result.stdout || "<no output>").trim()}`,
    );
  }
  return result;
}

function inspectMetalRuntime() {
  const script = [
    "import json, platform, vllm",
    "from importlib.metadata import version",
    `print(${JSON.stringify(VLLM_METAL_RUNTIME_PROBE_PREFIX)} + json.dumps({'engineVersion': vllm.__version__, 'pluginVersion': version('vllm-metal'), 'machine': platform.machine()}))`,
  ].join("; ");
  const observed = parseMetalRuntimeProbeOutput(
    runCommand(OPT.metalPython, ["-c", script], { timeoutMs: 60_000 }).stdout,
  );
  const macosVersion = runCommand("sw_vers", ["-productVersion"]).stdout.trim();
  let appleChip = runCommand("sysctl", ["-n", "machdep.cpu.brand_string"], { allowFailure: true }).stdout.trim();
  let systemMemoryBytes = Number(runCommand("sysctl", ["-n", "hw.memsize"], { allowFailure: true }).stdout.trim());
  if (!appleChip || !systemMemoryBytes) {
    const hardware = JSON.parse(runCommand("system_profiler", ["SPHardwareDataType", "-json"]).stdout)
      .SPHardwareDataType?.[0];
    const memory = /^(\d+(?:\.\d+)?)\s*(GB|TB)$/u.exec(hardware?.physical_memory ?? "");
    appleChip ||= hardware?.chip_type ?? "";
    systemMemoryBytes ||= memory ? Number(memory[1]) * 1024 ** (memory[2] === "TB" ? 4 : 3) : 0;
  }
  if (!observed.engineVersion || !observed.pluginVersion || !appleChip || !systemMemoryBytes) {
    throw new Error("could not identify the native vLLM Metal runtime and Apple hardware");
  }
  return Object.freeze({
    engineVersion: String(observed.engineVersion),
    pluginVersion: String(observed.pluginVersion),
    platform: process.platform,
    arch: process.arch,
    pythonMachine: String(observed.machine ?? ""),
    macosVersion,
    appleChip,
    systemMemoryBytes,
  });
}

function assertMetalPrerequisites() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("the Metal backend requires native arm64 Node.js on Apple Silicon macOS");
  }
  const macosVersion = runCommand("sw_vers", ["-productVersion"]).stdout.trim();
  if (Number(macosVersion.split(".")[0]) < 15) {
    throw new Error(`vLLM Metal requires macOS 15 or newer; found ${macosVersion}`);
  }
  // Recent vLLM releases group the default help and omit most engine options.
  // Capability checks must use the exhaustive form documented by the vLLM CLI.
  const help = runCommand(OPT.metalBin, ["serve", "--help=all"], { timeoutMs: 60_000 }).stdout;
  for (const option of [
    "--scheduling-policy",
    "--api-key",
    "--no-enable-prefix-caching",
    "--revision",
    "--gpu-memory-utilization",
  ]) {
    if (!help.includes(option)) throw new Error(`native vLLM serve is missing required option ${option}`);
  }
  metalRuntime = inspectMetalRuntime();
  if (metalRuntime.pythonMachine !== "arm64") {
    throw new Error(`vLLM Metal Python must be native arm64; found ${metalRuntime.pythonMachine}`);
  }
}

function metalServerArgs(arm) {
  return [
    "serve",
    OPT.model,
    "--served-model-name", OPT.servedModel,
    "--revision", resolvedRevision,
    "--host", "0.0.0.0",
    "--port", String(VLLM_PORT),
    "--max-num-seqs", String(VLLM_MAX_NUM_SEQS),
    "--max-model-len", "4096",
    "--gpu-memory-utilization", String(OPT.gpuMemoryUtilization),
    "--scheduling-policy", arm.schedulingPolicy,
    "--no-enable-prefix-caching",
    vllmApiKeyArgument(VLLM_API_KEY),
  ];
}

async function resolveModelRevision(model, requested) {
  if (/^[0-9a-f]{40,64}$/iu.test(requested)) return requested.toLowerCase();
  const modelPath = model.split("/").map(encodeURIComponent).join("/");
  const revisionPath = requested.split("/").map(encodeURIComponent).join("/");
  const registryToken = env.HF_TOKEN || env.HUGGING_FACE_HUB_TOKEN;
  const response = await fetchWithTimeout(
    `https://huggingface.co/api/models/${modelPath}/revision/${revisionPath}`,
    {
      headers: registryToken
        ? { authorization: `Bearer ${registryToken}` }
        : {},
    },
    30_000,
  );
  if (!response.ok) {
    throw new Error(
      `could not resolve model revision ${model}@${requested}: HTTP ${response.status}; ` +
        "supply --model-revision=<immutable commit> for offline/restricted runs",
    );
  }
  const body = await response.json();
  if (typeof body?.sha !== "string" || !/^[0-9a-f]{40,64}$/iu.test(body.sha)) {
    throw new Error(`Hugging Face did not return an immutable commit for ${model}@${requested}`);
  }
  return body.sha.toLowerCase();
}

async function jsonRequest(url, { method = "GET", body, token = ADMIN_TOKEN, allowed = [200] } = {}) {
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
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* retain bounded text below */ }
  if (!allowed.includes(response.status)) {
    throw new Error(`${method} ${url} -> HTTP ${response.status}: ${String(text).slice(0, 400)}`);
  }
  return { status: response.status, body: parsed };
}

async function configurePools(grantTtlMs, { allowCreate }) {
  for (const arm of MANAGED_ARMS) {
    const spec = vllmPoolDefinition(arm.pool, grantTtlMs, {
      lending: arm.lending,
      policy: POLICY,
    });
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
  let last = [];
  while (Date.now() < deadline) {
    const response = await jsonRequest(`${LATCHFLO}/v1/agents`);
    last = Array.isArray(response.body?.agents) ? response.body.agents : [];
    if (last.length >= MANAGED_ARMS.length) {
      for (const agent of last) {
        for (const capability of ["admissionClasses", "admissionClassDemand", "admissionClassOccupancyAck"]) {
          if (agent?.capabilities?.[capability] !== true) {
            throw new Error(`${agent.instanceId ?? "unknown agent"} lacks ${capability}`);
          }
        }
      }
      return last;
    }
    await sleep(500);
  }
  throw new Error(`Latchflo saw only ${last.length}/${MANAGED_ARMS.length} Tyr agents`);
}

async function readPoolStats(arm) {
  const response = await fetchWithTimeout(
    `http://127.0.0.1:${arm.port}/stats`,
    { headers: { "x-tyr-identity-token": `Bearer ${identity.tokens.operator}` } },
    SAMPLING.managedTimeoutMs,
  );
  if (!response.ok) throw new Error(`Tyr ${arm.id} /stats returned HTTP ${response.status}`);
  const body = await response.json();
  if (!body?.[arm.pool]) throw new Error(`Tyr ${arm.id} /stats has no ${arm.pool} pool`);
  return body[arm.pool];
}

async function readControllerDemand(arm) {
  if (!arm.lending) return null;
  const response = await jsonRequest(
    `${LATCHFLO}/v1/admission-class-demand?pool=${encodeURIComponent(arm.pool)}`,
    { allowed: [200, 404] },
  ).catch(() => null);
  return response?.body?.status ?? null;
}

async function collectControlPlaneEvidence(arm, startedAtMs) {
  const statsByPool = { [arm.pool]: await readPoolStats(arm) };
  const metrics = await fetchWithTimeout(
    `${LATCHFLO}/metrics`,
    { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } },
    5_000,
  ).then(
    async (response) => response.ok ? response.text() : "",
    () => "",
  );
  const episodesResponse = await jsonRequest(
    `${LATCHFLO}/v1/restoration-episodes?protectedPool=${encodeURIComponent(arm.pool)}&limit=500`,
    { allowed: [200, 404] },
  ).catch(() => null);
  const eventLimit = 1_000;
  const eventsResponse = await jsonRequest(`${LATCHFLO}/v1/events?limit=${eventLimit}`, {
    allowed: [200, 404],
  }).catch(() => null);
  const rawEvents = Array.isArray(eventsResponse?.body?.events) ? eventsResponse.body.events : [];
  const eventTimes = rawEvents
    .map((event) => Date.parse(String(event?.createdAt ?? "")))
    .filter(Number.isFinite);
  const earliestEventAtMs = eventTimes.length > 0 ? Math.min(...eventTimes) : null;
  const latestEventAtMs = eventTimes.length > 0 ? Math.max(...eventTimes) : null;
  const eventWindow = {
    limit: eventLimit,
    returned: rawEvents.length,
    earliestEventAt: earliestEventAtMs === null ? null : new Date(earliestEventAtMs).toISOString(),
    latestEventAt: latestEventAtMs === null ? null : new Date(latestEventAtMs).toISOString(),
    startedAt: new Date(startedAtMs).toISOString(),
    completeForArm:
      rawEvents.length < eventLimit ||
      (earliestEventAtMs !== null && earliestEventAtMs <= startedAtMs),
  };
  const events = rawEvents.filter((event) => {
    const at = Date.parse(String(event?.createdAt ?? ""));
    return !Number.isFinite(at) || at >= startedAtMs;
  });
  return {
    tyrRestoration: summarizeTyrRestoration({ statsByPool, tyrVersion: VLLM_TYR_VERSION }),
    latchfloEpisodes: summarizeLatchfloRestorationEpisodes({
      episodes: Array.isArray(episodesResponse?.body?.restorationEpisodes)
        ? episodesResponse.body.restorationEpisodes
        : [],
      latchfloVersion: VLLM_LATCHFLO_VERSION,
    }),
    unlentGauges: summarizeUnlentFloorGauges({
      metricsTexts: [metrics],
      latchfloVersion: VLLM_LATCHFLO_VERSION,
      pools: [arm.pool],
    }),
    handoff: summarizeClassHandoffSafety(events, arm.pool, { eventWindow, startedAtMs }),
  };
}

async function sampleManagedArm(arm, startedAt) {
  const [pool, controller] = await Promise.all([readPoolStats(arm), readControllerDemand(arm)]);
  const at = Date.now();
  const controllerClasses = new Map(
    (controller?.classes ?? []).map((entry) => [entry?.admissionClass, entry]),
  );
  const classes = Object.fromEntries(
    Object.entries(pool?.admissionClasses?.classes ?? {}).map(([id, value]) => {
      const demand = controllerClasses.get(id);
      return [id, {
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
        demandStateSince: demand?.demand?.stateSince ?? demand?.stateSince ?? null,
        recentAdmissions: Number(demand?.demand?.recentAdmissions ?? 0),
        recentRejections: Number(demand?.demand?.recentRejections ?? 0),
        releasedConcurrent: Number(demand?.released?.protectedConcurrent ?? 0),
        releasedTokens: Number(demand?.released?.protectedInFlightTokens ?? 0),
        restorationPending: demand?.restorationPending === true,
      }];
    }),
  );
  return {
    offsetMs: +(at - startedAt),
    observedAt: new Date(at).toISOString(),
    pool: {
      maxConcurrent: Number(pool?.limits?.maxConcurrent ?? 0),
      tokenBudget: Number(pool?.tokenBudget?.budget ?? 0),
      inFlight: Number(pool?.bulkhead?.inFlight ?? pool?.llm?.inFlight ?? 0),
      sharedMaxConcurrent: Number(pool?.admissionClasses?.shared?.maxConcurrent ?? 0),
      limitsRevision: pool?.limits?.revision ?? null,
      grant: pool?.tyr?.provenance?.current ?? null,
    },
    classes,
  };
}

function nominalCeilings(sample) {
  return Object.entries(POLICY.classes).every(([id, expected]) => {
    const limits = sample?.classes?.[id]?.limits;
    return limits?.maxConcurrent === expected.globalMaxConcurrent &&
      limits?.maxInFlightTokens === expected.globalMaxInFlightTokens;
  });
}

async function waitForUsableGrant(arm, { interactiveFloor = false, timeoutMs = 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await sampleManagedArm(arm, Date.now()).catch(() => null);
    const interactive = last?.classes?.interactive?.limits;
    if (
      last?.pool?.maxConcurrent >= 1 &&
      nominalCeilings(last) &&
      (!interactiveFloor ||
        (Number(interactive?.protectedConcurrent ?? 0) >=
            POLICY.classes.interactive.globalProtectedConcurrent &&
          Number(interactive?.protectedInFlightTokens ?? 0) >=
            POLICY.classes.interactive.globalProtectedInFlightTokens))
    ) return last;
    await sleep(250);
  }
  throw new Error(`${arm.id} did not reach the required grant: ${JSON.stringify(last?.classes ?? null)}`);
}

function startManagedSampler(arm, startedAt, initial = null) {
  const samples = initial ? [initial] : [];
  const errors = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      try { samples.push(await sampleManagedArm(arm, startedAt)); }
      catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
      await sleep(SAMPLING.managedIntervalMs);
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

async function scrapeVllm() {
  const response = await fetchTextFresh(
    VLLM_METRICS_URL,
    SAMPLING.vllmTimeoutMs,
    VLLM_API_KEY ? { authorization: `Bearer ${VLLM_API_KEY}` } : {},
  );
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`vLLM /metrics returned HTTP ${response.status}`);
  }
  return snapshotVllmMetrics(response.text);
}

function readGpu() {
  const result = runCommand(
    "nvidia-smi",
    [
      "-i", OPT.gpuIndex,
      "--query-gpu=uuid,name,utilization.gpu,memory.used,memory.total,power.draw,temperature.gpu",
      "--format=csv,noheader,nounits",
    ],
    { timeoutMs: 5_000 },
  );
  return parseNvidiaSmiRow(result.stdout.split(/\r?\n/u).find((line) => line.trim()) ?? "");
}

async function readMetalProcessTree() {
  if (!metalProcess?.pid) throw new Error("native vLLM process is not running");
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,%cpu=,rss="], {
    cwd: ROOT,
    env,
    encoding: "utf8",
    timeout: SAMPLING.platformTimeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  return parseProcessTreeSnapshot(stdout, metalProcess.pid);
}

async function readHostPressure() {
  const run = async (command, args) => (await execFileAsync(command, args, {
    cwd: ROOT,
    env,
    encoding: "utf8",
    timeout: SAMPLING.platformTimeoutMs,
    maxBuffer: 1024 * 1024,
  })).stdout;
  const [memory, vm, therm] = await Promise.all([
    run("sysctl", ["kern.memorystatus_vm_pressure_level", "vm.swapusage"]),
    run("vm_stat", []),
    run("pmset", ["-g", "therm"]),
  ]);
  return {
    memory: parseMemorySysctl(memory),
    vm: parseVmStat(vm),
    therm: parsePmsetTherm(therm),
  };
}

function dcgmSnapshot(text) {
  const selected = new Set([
    "DCGM_FI_DEV_GPU_UTIL",
    "DCGM_FI_DEV_FB_USED",
    "DCGM_FI_DEV_FB_FREE",
    "DCGM_FI_DEV_POWER_USAGE",
    "DCGM_FI_DEV_GPU_TEMP",
    "DCGM_FI_PROF_PIPE_TENSOR_ACTIVE",
    "DCGM_FI_PROF_DRAM_ACTIVE",
  ]);
  return Object.fromEntries(
    parsePrometheus(text)
      .filter(({ name, value }) => selected.has(name) && Number.isFinite(value))
      .map(({ name, labels, value }) => [`${name}{gpu=${labels.gpu ?? labels.GPU_I_ID ?? "unknown"}}`, value]),
  );
}

async function startTelemetry(startedAt) {
  const start = await scrapeVllm();
  const vllmSamples = [];
  const vllmErrors = [];
  const gpuSamples = [];
  const gpuErrors = [];
  const processSamples = [];
  const processErrors = [];
  const hostPressureSamples = [];
  const hostPressureErrors = [];
  const dcgmSamples = [];
  const dcgmErrors = [];
  let running = true;
  let lastGpuAt = -Infinity;
  const loop = (async () => {
    while (running) {
      const loopStarted = performance.now();
      const atMs = +(Date.now() - startedAt);
      try { vllmSamples.push({ atMs, snapshot: await scrapeVllm() }); }
      catch (error) { vllmErrors.push(error instanceof Error ? error.message : String(error)); }
      if (atMs - lastGpuAt >= SAMPLING.platformIntervalMs) {
        lastGpuAt = atMs;
        if (IS_METAL) {
          try { processSamples.push({ atMs, ...(await readMetalProcessTree()) }); }
          catch (error) { processErrors.push(error instanceof Error ? error.message : String(error)); }
          // Diagnostic only: unified-memory pressure, swap and thermal state
          // are shared with the Docker VM running Tyr and Latchflo.
          try { hostPressureSamples.push({ atMs, ...(await readHostPressure()) }); }
          catch (error) { hostPressureErrors.push(error instanceof Error ? error.message : String(error)); }
        } else {
          try { gpuSamples.push({ atMs, ...readGpu() }); }
          catch (error) { gpuErrors.push(error instanceof Error ? error.message : String(error)); }
        }
        if (!IS_METAL && OPT.dcgmUrl) {
          try {
            const response = await fetchWithTimeout(OPT.dcgmUrl, {}, 3_000);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            dcgmSamples.push({ atMs, values: dcgmSnapshot(await response.text()) });
          } catch (error) {
            dcgmErrors.push(error instanceof Error ? error.message : String(error));
          }
        }
      }
      const remaining = Math.max(0, SAMPLING.vllmIntervalMs - (performance.now() - loopStarted));
      if (running) await sleep(remaining);
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
      const end = await scrapeVllm();
      return {
        raw: {
          start,
          end,
          vllmSamples,
          vllmErrors,
          gpuSamples,
          gpuErrors,
          processSamples,
          processErrors,
          hostPressureSamples,
          hostPressureErrors,
          dcgmSamples,
          dcgmErrors,
        },
        vllm: summarizeVllmTelemetry({ samples: vllmSamples, start, end, errors: vllmErrors }),
        gpu: IS_METAL ? null : summarizeGpuTelemetry(gpuSamples, gpuErrors),
        hostProcess: IS_METAL ? summarizeProcessTelemetry(processSamples, processErrors) : null,
        hostPressure: IS_METAL ? summarizeHostPressure(hostPressureSamples, hostPressureErrors) : null,
        dcgm: {
          configured: !IS_METAL && Boolean(OPT.dcgmUrl),
          sampleCount: dcgmSamples.length,
          errors: dcgmErrors,
        },
      };
    },
  };
}

function commandOption(command, flag) {
  const index = command.indexOf(flag);
  return index >= 0 && index + 1 < command.length ? command[index + 1] : null;
}

function runtimeIdentity(arm, gpu) {
  if (IS_METAL) {
    if (!metalRuntime) throw new Error("native vLLM Metal runtime identity was not inspected");
    return {
      backend: "metal",
      engineVersion: metalRuntime.engineVersion,
      pluginVersion: metalRuntime.pluginVersion,
      model: OPT.model,
      modelRevision: resolvedRevision,
      servedModel: OPT.servedModel,
      appleChip: metalRuntime.appleChip,
      systemMemoryBytes: metalRuntime.systemMemoryBytes,
      platform: metalRuntime.platform,
      arch: metalRuntime.arch,
      macosVersion: metalRuntime.macosVersion,
      schedulingPolicy: arm.schedulingPolicy,
      maxNumSeqs: VLLM_MAX_NUM_SEQS,
      maxModelLen: 4_096,
      gpuMemoryUtilization: OPT.gpuMemoryUtilization,
      prefixCaching: false,
      pagedAttention: true,
      authenticatedHostBridge: true,
    };
  }
  const service = compose(["ps", "-q", "vllm"]);
  const containerId = service.stdout.trim();
  if (!containerId) throw new Error("could not identify the vLLM container");
  const inspected = JSON.parse(runCommand("docker", ["inspect", containerId]).stdout)[0];
  const command = Array.isArray(inspected?.Config?.Cmd) ? inspected.Config.Cmd : [];
  const engineVersion = runCommand(
    "docker",
    ["exec", containerId, "python", "-c", "import vllm; print(vllm.__version__)"],
  ).stdout.trim();
  if (engineVersion !== VLLM_VERSION) {
    throw new Error(`vLLM image reports ${engineVersion || "no version"}; expected ${VLLM_VERSION}`);
  }
  const requestedDevices = (inspected?.HostConfig?.DeviceRequests ?? [])
    .flatMap((request) => request?.DeviceIDs ?? [])
    .map(String);
  return {
    backend: "nvidia",
    image: OPT.image,
    imageId: inspected?.Image ?? null,
    engineVersion,
    model: commandOption(command, "--model"),
    modelRevision: commandOption(command, "--revision"),
    servedModel: commandOption(command, "--served-model-name"),
    gpuUuid: gpu?.gpu?.uuid ?? null,
    gpuName: gpu?.gpu?.name ?? null,
    requestedGpuDevice: OPT.gpuIndex,
    containerGpuDeviceIds: requestedDevices,
    gpuSelectionMatches: requestedDevices.includes(String(OPT.gpuIndex)),
    schedulingPolicy: commandOption(command, "--scheduling-policy"),
    maxNumSeqs: Number(commandOption(command, "--max-num-seqs")),
    maxModelLen: Number(commandOption(command, "--max-model-len")),
    gpuMemoryUtilization: Number(commandOption(command, "--gpu-memory-utilization")),
    prefixCaching: !command.includes("--no-enable-prefix-caching"),
    containerCommand: command,
  };
}

const FILLER = "The quick brown fox jumps over the lazy dog. ";
function prompt(chars) {
  let text = "";
  while (text.length < chars) text += FILLER;
  return text.slice(0, chars);
}

function parseWarmupStream(raw) {
  let done = false;
  let contentChars = 0;
  let completionTokens = null;
  let promptTokens = null;
  let streamError = null;
  for (const frame of String(raw).split(/\r?\n\r?\n/u)) {
    const dataLine = frame.split(/\r?\n/u).find((line) => line.startsWith("data:"));
    if (!dataLine) continue;
    const payload = dataLine.slice(5).trim();
    if (payload === "[DONE]") {
      done = true;
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    if (parsed?.error) {
      streamError = parsed.error;
      continue;
    }
    const content = parsed?.choices?.[0]?.delta?.content;
    if (typeof content === "string") contentChars += content.length;
    if (Number.isFinite(parsed?.usage?.completion_tokens)) {
      completionTokens = parsed.usage.completion_tokens;
    }
    if (Number.isFinite(parsed?.usage?.prompt_tokens)) {
      promptTokens = parsed.usage.prompt_tokens;
    }
  }
  return { done, contentChars, completionTokens, promptTokens, streamError };
}

async function warmupRequest(arm, seed, workload, index) {
  const isBatch = workload === "batch";
  const body = {
    model: OPT.servedModel,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 16,
    ...vllmFixedOutputFields(OPT.backend, 16),
    temperature: 0,
    seed: 100_000 + seed * 100 + index,
    ...(arm.requestPriorities ? { priority: isBatch ? 10 : 0 } : {}),
    messages: [{ role: "user", content: prompt(isBatch ? 1_600 : 400) }],
  };
  const response = await fetch(ARM_URLS[arm.id], {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(VLLM_API_KEY ? { authorization: `Bearer ${VLLM_API_KEY}` } : {}),
      ...(arm.managed
        ? { "x-tyr-identity-token": `Bearer ${isBatch ? identity.tokens.noisy : identity.tokens.premium}` }
        : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });
  const raw = await response.text();
  const bytes = Buffer.byteLength(raw);
  if (!response.ok) {
    throw new Error(
      `${arm.id} warm-up ${workload} ${index + 1} returned HTTP ${response.status}: ` +
      raw.slice(0, 2_048),
    );
  }
  const stream = parseWarmupStream(raw);
  if (stream.streamError) {
    throw new Error(
      `${arm.id} warm-up ${workload} ${index + 1} returned a streamed vLLM error: ` +
      JSON.stringify(stream.streamError).slice(0, 2_048),
    );
  }
  if (!stream.done || !(Number(stream.completionTokens ?? 0) > 0 || stream.contentChars > 0)) {
    throw new Error(
      `${arm.id} warm-up ${workload} ${index + 1} produced no complete token stream ` +
      `(HTTP ${response.status}, ${bytes} bytes)`,
    );
  }
  return {
    workload,
    index,
    status: response.status,
    bytes,
    completionTokens: stream.completionTokens,
    promptTokens: stream.promptTokens,
  };
}

async function warmupArm(arm, seed) {
  const results = [];
  for (const workload of ["batch", "interactive"]) {
    for (let index = 0; index < OPT.warmupRequestsPerClass; index += 1) {
      let lastError = null;
      for (let attempt = 1; attempt <= 8; attempt += 1) {
        try {
          results.push({ ...(await warmupRequest(arm, seed, workload, index)), attempts: attempt });
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          if (!arm.managed || attempt === 8) break;
          await waitForUsableGrant(arm);
          await sleep(250);
        }
      }
      if (lastError) throw lastError;
    }
  }
  return results;
}

function runLoadgen({ arm, seed, traceFile, outFile }) {
  const target = `http://127.0.0.1:${arm.port}`;
  const diagnosticsFile = outFile.replace(/\.json$/u, ".loadgen.log");
  const child = launchNode("loadgen", "load/loadgen.mjs", [
    `--targets=${target}`,
    `--interactive-targets=${target}`,
    `--batch-targets=${target}`,
    `--interactive-model=${OPT.servedModel}`,
    `--batch-model=${OPT.servedModel}`,
    ...(arm.managed
      ? [
          `--interactive-identity-token=${identity.tokens.premium}`,
          `--batch-identity-token=${identity.tokens.noisy}`,
        ]
      : []),
    `--arm-label=${SWEEP_NAME}-${arm.id}`,
    "--provider-api=openai",
    ...(VLLM_API_KEY ? [`--provider-api-key=${VLLM_API_KEY}`] : []),
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
    `--in-flight-ceiling=${WORKLOAD.inFlightCeiling}`,
    `--window-ms=${WORKLOAD.windowMs}`,
    `--temperature=${WORKLOAD.temperature}`,
    "--force-output-length=true",
    `--fixed-output-min-tokens=${IS_METAL ? "false" : "true"}`,
    ...(arm.requestPriorities
      ? [
          `--interactive-priority=${WORKLOAD.interactivePriority}`,
          `--batch-priority=${WORKLOAD.batchPriority}`,
        ]
      : []),
    "--emit-phase-samples=true",
    `--drain-idle-ms=${WORKLOAD.drainIdleMs}`,
    `--drain-max-ms=${WORKLOAD.drainMaxMs}`,
    `--drain-timeout-mode=${arm.managed ? "fail" : "censor"}`,
    `--trace-file=${traceFile}`,
    "--metrics-port=0",
    `--out=${outFile}`,
  ], { logFile: diagnosticsFile, redactions: VLLM_API_KEY ? [VLLM_API_KEY] : [] });
  return new Promise((resolve, reject) => {
    child.once("close", (code, signal) => {
      if (code !== 0) {
        reject(new Error(
          `load generator failed for ${arm.id} (${signal ?? `exit ${code}`})${childOutputTail(child)}; ` +
            `full output: ${repoRelative(diagnosticsFile, ROOT)}`,
        ));
      } else if (!existsSync(outFile)) {
        reject(new Error(`load generator did not write ${outFile}`));
      } else {
        resolve(JSON.parse(readFileSync(outFile, "utf8")));
      }
    });
  });
}

async function recreateVllm(arm) {
  if (!IS_METAL) {
    env = { ...env, MOFLUX_VLLM_SCHEDULING_POLICY: arm.schedulingPolicy };
    compose(["up", "-d", "--force-recreate", "--wait", "vllm"], { inherit: true });
    return;
  }
  if (metalProcess) await terminateHostChild(metalProcess, 10_000);
  metalLaunchCount += 1;
  const logFile = path.join(
    runOutputDir,
    `vllm-metal-${String(metalLaunchCount).padStart(2, "0")}-${arm.id}.log`,
  );
  metalProcess = launchCommand(
    `vllm-metal-${arm.id}`,
    OPT.metalBin,
    metalServerArgs(arm),
    {
      cwd: ROOT,
      env: {
        ...env,
        VLLM_METAL_USE_PAGED_ATTENTION: "1",
        VLLM_METAL_MEMORY_FRACTION: "auto",
      },
      logFile,
      redactions: [VLLM_API_KEY],
    },
  );
}

function createFreshRunDirectory() {
  if (existsSync(runOutputDir)) {
    throw new Error(
      `refusing to reuse existing run directory ${repoRelative(runOutputDir, ROOT)}; choose a new --run-id`,
    );
  }
  mkdirSync(path.dirname(runOutputDir), { recursive: true });
  mkdirSync(runOutputDir);
}

let stackStarted = false;
let caughtError = null;
let resolvedRevision = null;
const rows = [];

try {
  assertDockerAvailable();
  const openssl = runCommand("openssl", ["version"], { allowFailure: true });
  if (openssl.status !== 0) throw new Error("OpenSSL is required for the local identity fixture");
  if (IS_METAL) {
    assertMetalPrerequisites();
  } else {
    const gpu = runCommand("nvidia-smi", ["-i", OPT.gpuIndex, "-L"], { allowFailure: true });
    if (gpu.status !== 0) throw new Error(`nvidia-smi cannot access GPU ${OPT.gpuIndex}`);
  }

  if (OPT.doctor) {
    env = {
      ...parseEnvFile(ENV_EXAMPLE),
      ...process.env,
      MOFLUX_LATCHFLO_IMAGE: LATCHFLO_IMAGE,
      MOFLUX_TYR_IMAGE: TYR_IMAGE,
      MOFLUX_VLLM_GPU_DEVICE: OPT.gpuIndex,
      MOFLUX_VLLM_SCHEDULING_POLICY: "priority",
      MOFLUX_VLLM_GPU_MEMORY_UTILIZATION: String(OPT.gpuMemoryUtilization),
    };
    compose(["config", "--quiet"], { doctor: true });
    console.log(
      IS_METAL
        ? `PASS vLLM Metal prerequisites: macOS ${metalRuntime.macosVersion}, native arm64 ` +
          `${metalRuntime.engineVersion}/${metalRuntime.pluginVersion}, Docker, Compose, and OpenSSL`
        : `PASS vLLM prerequisites: Docker, Compose config, OpenSSL, and GPU ${OPT.gpuIndex} are available`,
    );
  } else {
    ensureDemoEnv(ENV_FILE, { quiet: true });
    if (IS_METAL) {
      const info = runCommand("docker", ["info", "--format", "{{.MemTotal}}"], { allowFailure: true });
      const bytes = Number(info.stdout.trim());
      dockerVmMemoryBytes = Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
      console.log(
        `unified memory: Docker VM ${dockerVmMemoryBytes === null ? "unknown" : `${(dockerVmMemoryBytes / 2 ** 30).toFixed(1)} GiB`}, ` +
          `vLLM --gpu-memory-utilization=${OPT.gpuMemoryUtilization}`,
      );
    }
    env = {
      ...parseEnvFile(ENV_FILE),
      ...process.env,
      MOFLUX_LATCHFLO_IMAGE: LATCHFLO_IMAGE,
      MOFLUX_TYR_IMAGE: TYR_IMAGE,
      MOFLUX_VLLM_IMAGE: OPT.image,
      MOFLUX_VLLM_MODEL: OPT.model,
      MOFLUX_VLLM_SERVED_MODEL: OPT.servedModel,
      MOFLUX_VLLM_GPU_DEVICE: OPT.gpuIndex,
      MOFLUX_VLLM_SCHEDULING_POLICY: "priority",
      MOFLUX_VLLM_GPU_MEMORY_UTILIZATION: String(OPT.gpuMemoryUtilization),
    };
    ADMIN_TOKEN = env.LATCHFLO_ADMIN_TOKEN ?? null;
    if (!ADMIN_TOKEN) throw new Error("LATCHFLO_ADMIN_TOKEN is not configured");
    resolvedRevision = await resolveModelRevision(OPT.model, OPT.modelRevision);
    env = { ...env, MOFLUX_VLLM_MODEL_REVISION: resolvedRevision };
    console.log(`resolved model revision: ${OPT.model}@${resolvedRevision}`);

    createFreshRunDirectory();
    if (!IS_METAL) runCommand("docker", ["volume", "create", HF_CACHE_VOLUME]);
    compose(["down", "--volumes", "--remove-orphans"], { allowFailure: true });
    for (const [port, label] of [
      [VLLM_IDENTITY_PORT, "identity fixture"],
      [VLLM_PORT, "vLLM"],
      [VLLM_LATCHFLO_PORT, "Latchflo"],
      [18125, "Tyr static"],
      [18126, "Tyr MoFlux"],
    ]) await assertHostPortFree(port, { label });

    ensureRuntimeImage({
      root: ROOT,
      image: LATCHFLO_IMAGE,
      envKey: "MOFLUX_LATCHFLO_SOURCE_DIR",
      repoName: "latchflo-control-plane",
      version: VLLM_LATCHFLO_VERSION,
      label: "Latchflo",
    });
    ensureRuntimeImage({
      root: ROOT,
      image: TYR_IMAGE,
      envKey: "MOFLUX_TYR_SOURCE_DIR",
      repoName: "tyr-admission-controller",
      version: VLLM_TYR_VERSION,
      label: "Tyr",
    });
    identity = await startIdentityFixture(IDENTITY_RUNTIME, { port: VLLM_IDENTITY_PORT });
    stackStarted = true;
    compose(["up", "-d", "--force-recreate", "--wait", "latchflo"], { inherit: true });
    await waitFor(`${LATCHFLO}/readyz`, { timeoutMs: 60_000, label: "Latchflo readiness" });
    await configurePools(POLICY.lending.enrollmentTtlMs, { allowCreate: true });

    // Tyrs enroll once against a priority-scheduled vLLM. The engine is then
    // recreated before every measured arm, including the first one.
    await recreateVllm(vllmArm("vllm-priority"));
    await waitFor(`${VLLM_ORIGIN}/health`, {
      timeoutMs: 360_000,
      label: "vLLM readiness",
      child: IS_METAL ? metalProcess : null,
    });
    compose(["up", "-d", "--force-recreate", "tyr-static", "tyr-moflux"], { inherit: true });
    for (const arm of MANAGED_ARMS) {
      await waitFor(`http://127.0.0.1:${arm.port}/healthz`, {
        timeoutMs: 60_000,
        label: `Tyr ${arm.id} health`,
      });
    }
    await waitForAgents();
    await configurePools(POLICY.lending.grantTtlMs, { allowCreate: false });
    for (const arm of MANAGED_ARMS) {
      await jsonRequest(`${LATCHFLO}/v1/pools/${arm.pool}/rebalance`, {
        method: "POST",
        allowed: [200, 202],
      });
      await waitFor(`http://127.0.0.1:${arm.port}/readyz`, {
        timeoutMs: 60_000,
        label: `Tyr ${arm.id} readiness`,
      });
      await waitForUsableGrant(arm);
    }

    for (const [seedIndex, seed] of OPT.seeds.entries()) {
      const order = ORDER_PLAN[seedIndex].order;
      const trace = buildTrace({ ...WORKLOAD, seed });
      const traceFile = path.join(runOutputDir, `trace-seed-${seed}.json`);
      writeFileSync(traceFile, `${JSON.stringify(trace, null, 2)}\n`);
      const arms = {};
      const evidence = {};

      for (const armId of order) {
        const arm = vllmArm(armId);
        console.log(`\nseed ${seed} arm ${armId}: recreate vLLM (${arm.schedulingPolicy})`);
        await recreateVllm(arm);
        await waitFor(`${VLLM_ORIGIN}/health`, {
          timeoutMs: 360_000,
          label: "vLLM readiness",
          child: IS_METAL ? metalProcess : null,
        });
        if (arm.managed) {
          await waitFor(`http://127.0.0.1:${arm.port}/readyz`, {
            timeoutMs: 60_000,
            label: `Tyr ${arm.id} readiness after vLLM restart`,
          });
          await waitForUsableGrant(arm);
        }

        console.log(`seed ${seed} arm ${armId}: excluded warm-up`);
        const warmup = await warmupArm(arm, seed);
        const startingGrant = arm.managed
          ? await waitForUsableGrant(arm, { interactiveFloor: true })
          : null;
        const startedAt = Date.now();
        const managedInitial = arm.managed ? await sampleManagedArm(arm, startedAt) : null;
        const managedSampler = arm.managed
          ? startManagedSampler(arm, startedAt, managedInitial)
          : null;
        const telemetry = await startTelemetry(startedAt);
        console.log(`seed ${seed} arm ${armId}: measured trace`);
        let loadgenSummary = null;
        let measured = null;
        let managed = { samples: [], errors: [] };
        let armError = null;
        try {
          loadgenSummary = await runLoadgen({
            arm,
            seed,
            traceFile,
            outFile: path.join(runOutputDir, `${armId}-seed-${seed}.json`),
          });
          if (arm.managed) await sleep(POLICY.lending.postRunObserveMs);
        } catch (error) {
          armError = error;
        } finally {
          if (managedSampler) managed = await managedSampler.stop();
          try {
            measured = await telemetry.stop();
          } catch (error) {
            armError ??= error;
          }
        }
        if (armError) throw armError;
        measured.vllm = summarizeVllmTelemetry({
          samples: measured.raw.vllmSamples,
          start: measured.raw.start,
          end: measured.raw.end,
          errors: measured.raw.vllmErrors,
          workload: WORKLOAD,
          workloadSkewMs: Number(loadgenSummary?.startedAtEpochMs ?? startedAt) - startedAt,
        });

        const armSummary = {
          arm: arm.id,
          managed: arm.managed,
          pool: arm.pool,
          trace: { hash: loadgenSummary?.trace?.hash ?? trace.hash },
          runtimeIdentity: runtimeIdentity(arm, measured.gpu),
          warmup: {
            requestsPerClass: OPT.warmupRequestsPerClass,
            completed: warmup.length,
            excludedFromMeasurement: true,
          },
          startingGrant: startingGrant?.classes ?? null,
          classes: summarizeArmClasses(loadgenSummary, VLLM_HYPOTHESIS_THRESHOLDS),
          bindingConstraint: {
            interactive: loadgenSummary?.classes?.interactive?.bindingConstraint ?? null,
            batch: loadgenSummary?.classes?.batch?.bindingConstraint ?? null,
          },
          drain: loadgenSummary?.drain ?? null,
          generatorSaturated: loadgenSummary?.generatorSaturated ?? 0,
          vllm: measured.vllm,
          gpu: measured.gpu,
          hostProcess: measured.hostProcess,
          hostPressure: measured.hostPressure,
          dcgm: measured.dcgm,
          managedSampleCount: managed.samples.length,
          managedSampleErrors: managed.errors,
        };
        arms[armId] = armSummary;

        if (arm.managed) {
          const demandReturn = summarizeDemandTransitions({
            samples: managed.samples,
            trace,
            loadgenSummary,
            workload: WORKLOAD,
            startedAtEpochMs: startedAt,
            nominalGrant: NOMINAL_CLASS_GRANT,
          });
          const controlPlane = await collectControlPlaneEvidence(arm, startedAt);
          evidence[armId] = {
            lending: summarizeLendingEpisodes(managed.samples, {
              restorationSloMs: POLICY.lending.restorationSloMs,
              nominalGrant: NOMINAL_CLASS_GRANT,
            }),
            recovery: summarizeManagedRecovery(managed.samples, WORKLOAD, demandReturn, POLICY),
            demandReturn,
            controlPlane,
            criticalWindow: criticalWindowDigest(managed.samples, {
              fromMs: WORKLOAD.interactiveResumeStartMs - 10_000,
              toMs: WORKLOAD.interactiveResumeStartMs + 20_000,
              nominalGrant: NOMINAL_CLASS_GRANT,
            }),
          };
        }

        writeFileSync(
          path.join(runOutputDir, `${armId}-telemetry-seed-${seed}.json`),
          `${JSON.stringify({
            seed,
            arm: armId,
            sampling: SAMPLING,
            runtimeIdentity: armSummary.runtimeIdentity,
            vllm: measured.raw,
            managed: arm.managed ? managed : null,
          }, null, 2)}\n`,
        );
        await captureDiagnostics(`seed-${seed}-${armId}`);
        console.log(
          `seed ${seed} arm ${armId}: interactive SLO goodput ` +
            `${armSummary.classes.interactive.windows.contention?.sloGoodputRps ?? "n/a"} req/s; ` +
            `queue peak ${armSummary.vllm.gauges.waiting?.max ?? "n/a"}; ` +
            `preemptions ${armSummary.vllm.preemptions.delta ?? "n/a"}`,
        );
        const pressure = armSummary.hostPressure;
        if (pressure) {
          console.log(
            `seed ${seed} arm ${armId} host: memory pressure ${pressure.worstPressure ?? "n/a"} ` +
              `(${JSON.stringify(pressure.pressureSamples)}); swap used ` +
              `${pressure.swapUsedMiB?.start ?? "n/a"}→${pressure.swapUsedMiB?.end ?? "n/a"} MiB; ` +
              `swapouts during arm ${pressure.swapoutMiBDuringArm ?? "n/a"} MiB; ` +
              `min free ${pressure.freeMiB?.min ?? "n/a"} MiB; thermal warnings ` +
              `${pressure.thermalWarningSamples}/${pressure.sampleCount}; errors ${pressure.errors.length}`,
          );
        }
        if (OPT.pauseMs > 0) await sleep(OPT.pauseMs);
      }

      const comparison = compareVllmArms(arms);
      const proof = vllmSeedProof({
        arms,
        evidence,
        backend: OPT.backend,
        workload: WORKLOAD,
        policy: POLICY,
        gpuMemoryUtilization: OPT.gpuMemoryUtilization,
      });
      const row = { seed, order, arms, evidence, comparison, proof };
      rows.push(row);
      writeFileSync(
        path.join(runOutputDir, `comparison-seed-${seed}.json`),
        `${JSON.stringify(row, null, 2)}\n`,
      );
      console.log(
        `seed ${seed}: priority-fcfs ${comparison.priorityGoodputDeltaVsFcfsRps} req/s; ` +
          `moflux-priority ${comparison.mofluxGoodputDeltaVsPriorityRps} req/s; ` +
          `moflux-static batch borrow ${comparison.mofluxBatchBorrowDeltaVsStaticRps} req/s; ` +
          `valid=${proof.valid}`,
      );
    }
  }
} catch (error) {
  caughtError = error instanceof Error ? error : new Error(String(error));
  console.error(`\n${caughtError.message}`);
} finally {
  if (stackStarted && existsSync(runOutputDir)) {
    try { await captureDiagnostics("before-cleanup"); }
    catch (error) { console.warn(`diagnostic capture failed: ${error.message}`); }
  }
  await stopHostChildren();
  if (identity) await identity.close().catch(() => {});
  if (stackStarted && !OPT.keepStack) {
    compose(["down", "--volumes", "--remove-orphans"], { allowFailure: true });
  }
  if (!OPT.keepStack) rmSync(IDENTITY_RUNTIME, { recursive: true, force: true });
}

if (OPT.doctor) {
  process.exitCode = caughtError ? 1 : 0;
} else if (existsSync(runOutputDir)) {
  const proof = vllmSweepProof({
    rows,
    armOrder: ORDER_PLAN,
    requiredSeeds: VLLM_PUBLICATION_SEED_COUNT,
  });
  const summary = {
    schemaVersion: 1,
    benchmark: SWEEP_NAME,
    backend: OPT.backend,
    generatedAt: new Date().toISOString(),
    question:
      `On one ${IS_METAL ? "Apple-Silicon vLLM Metal" : "GPU-backed vLLM"} server, how do FCFS, native priority, a static protected ` +
      "partition, and MoFlux lending compare on SLO goodput and resource pressure?",
    runtime: {
      mofluxBench: JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version,
      tyr: VLLM_TYR_VERSION,
      tyrImage: TYR_IMAGE,
      latchflo: VLLM_LATCHFLO_VERSION,
      latchfloImage: LATCHFLO_IMAGE,
      vllm: IS_METAL ? metalRuntime?.engineVersion ?? null : VLLM_VERSION,
      // Docker's VM shares the Mac's unified memory with vLLM Metal.
      ...(IS_METAL ? { dockerVmMemoryBytes } : {}),
      ...(IS_METAL
        ? { vllmMetal: metalRuntime?.pluginVersion ?? null, platform: metalRuntime }
        : { image: OPT.image }),
      model: OPT.model,
      requestedModelRevision: OPT.modelRevision,
      resolvedModelRevision: resolvedRevision,
      servedModel: OPT.servedModel,
      node: process.version,
    },
    locality: {
      guard: "non-overridable",
      checkedEndpoints: [...Object.values(ARM_URLS), LATCHFLO, ...(OPT.dcgmUrl ? [OPT.dcgmUrl] : [])],
      hostedProviderCredentialSent: false,
      localInferenceCredentialConfigured: IS_METAL,
      modelRegistryCredentialConfigured: Boolean(env.HF_TOKEN || env.HUGGING_FACE_HUB_TOKEN),
      note: "Inference, control-plane, and optional DCGM endpoints must all be local/private.",
    },
    experiment: {
      arms: OPT.arms,
      armDescriptions: Object.fromEntries(OPT.arms.map((id) => [id, vllmArm(id).summary])),
      seeds: OPT.seeds,
      armOrder: ORDER_PLAN,
      counterbalanced: armOrderIsCounterbalanced(ORDER_PLAN, OPT.arms),
      workload: { ...WORKLOAD, fixedOutputMinTokens: !IS_METAL },
      sampling: SAMPLING,
      policy: POLICY,
      thresholds: VLLM_HYPOTHESIS_THRESHOLDS,
      engine: {
        maxNumSeqs: VLLM_MAX_NUM_SEQS,
        maxModelLen: 4_096,
        gpuMemoryUtilization: OPT.gpuMemoryUtilization,
        prefixCaching: false,
        ...(IS_METAL ? { pagedAttention: true } : {}),
      },
      phases: [
        { name: "warm-up", measured: false },
        { name: "interactive-only", fromMs: 0, toMs: WORKLOAD.batchStartMs },
        { name: "borrow", fromMs: WORKLOAD.batchStartMs, toMs: WORKLOAD.interactiveResumeStartMs },
        { name: "contention", fromMs: WORKLOAD.interactiveResumeStartMs, toMs: WORKLOAD.batchStartMs + WORKLOAD.batchDurationMs },
        { name: "drain", fromMs: WORKLOAD.batchStartMs + WORKLOAD.batchDurationMs, toMs: WORKLOAD.durationMs },
      ],
    },
    proof,
    passed: proof.passed,
    evidenceLimits: EVIDENCE_LIMITS,
    results: rows,
    ...(caughtError ? { error: caughtError.message } : {}),
  };
  writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
  if (pointerFile && !caughtError) {
    mkdirSync(path.dirname(pointerFile), { recursive: true });
    writeFileSync(
      pointerFile,
      `${JSON.stringify({ runId: OPT.runId, summary: repoRelative(summaryFile, ROOT) }, null, 2)}\n`,
    );
  }
  console.log(`\nwrote ${repoRelative(summaryFile, ROOT)} (${proof.status})`);
  if (caughtError || (OPT.requireProof && !proof.passed)) process.exitCode = 1;
} else {
  process.exitCode = 1;
}
