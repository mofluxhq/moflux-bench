#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildTrace } from "../load/trace-lib.mjs";
import { reservationBounds } from "./capacity-lib.mjs";
import {
  VLLM_ARM_IDS,
  VLLM_GPU_MEMORY_UTILIZATION,
  VLLM_KV_PRESSURE_THRESHOLDS,
  VLLM_METAL_LONG_CONTEXT_SWEEP_NAME,
  VLLM_METAL_LONG_CONTEXT_WORKLOAD,
  VLLM_METAL_SWEEP_NAME,
  VLLM_METAL_HOST_PRESSURE_LIMITS,
  VLLM_METAL_WORKLOAD,
  VLLM_METAL_POLICY,
  VLLM_METAL_RUNTIME_PROBE_PREFIX,
  VLLM_NVIDIA_WORKLOAD,
  VLLM_NVIDIA_POLICY,
  VLLM_POLICY,
  VLLM_WORKLOAD,
  armOrderIsCounterbalanced,
  armOrderPlan,
  parseMetalRuntimeProbeOutput,
  parseNvidiaSmiRow,
  parseProcessTreeSnapshot,
  snapshotVllmMetrics,
  summarizeGpuTelemetry,
  summarizeProcessTelemetry,
  summarizeHostPressure,
  parseVmStat,
  parseMemorySysctl,
  parsePmsetTherm,
  summarizeManagedRecovery,
  summarizeVllmTelemetry,
  vllmApiKeyArgument,
  vllmFixedOutputFields,
  vllmGpuMemoryUtilizationForBackend,
  vllmNominalClassGrant,
  vllmPolicyForBackend,
  vllmPoolDefinition,
  vllmSamplingForBackend,
  vllmSeedProof,
  vllmSweepProof,
  vllmSweepNameFor,
  vllmWorkloadByProfile,
  vllmWorkloadForBackend,
} from "./vllm-contention-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

assert.deepEqual(VLLM_ARM_IDS, ["vllm-fcfs", "vllm-priority", "static", "moflux"]);
assert.equal(VLLM_POLICY.physical.maxConcurrent, 4);
assert.equal(VLLM_POLICY.physical.tokenBudget, 65_536);
assert.equal(VLLM_POLICY, VLLM_NVIDIA_POLICY);
assert.ok(VLLM_POLICY.physical.tokenBudget > 4 * 4_096);
assert.equal(VLLM_METAL_POLICY.physical.tokenBudget, 65_536);
assert.equal(VLLM_METAL_POLICY.physical.tokenBudget, VLLM_NVIDIA_POLICY.physical.tokenBudget);
assert.equal(
  VLLM_METAL_POLICY.physical.tokenBudget -
    VLLM_METAL_POLICY.classes.interactive.globalProtectedInFlightTokens -
    VLLM_METAL_POLICY.classes.batch.globalProtectedInFlightTokens,
  0,
);
assert.equal(VLLM_POLICY.classes.interactive.globalProtectedConcurrent, 3);
assert.equal(VLLM_POLICY.classes.batch.globalProtectedConcurrent, 1);
assert.equal(vllmNominalClassGrant().interactive.protectedInFlightTokens, 49_152);
assert.equal(vllmNominalClassGrant(VLLM_METAL_POLICY).interactive.maxInFlightTokens, 65_536);
assert.equal(vllmPolicyForBackend("nvidia"), VLLM_NVIDIA_POLICY);
assert.equal(vllmPolicyForBackend("metal"), VLLM_METAL_POLICY);
assert.throws(() => vllmPolicyForBackend("other"), /unknown vLLM policy backend/u);
assert.equal(VLLM_WORKLOAD, VLLM_NVIDIA_WORKLOAD);
assert.equal(vllmWorkloadForBackend("nvidia"), VLLM_NVIDIA_WORKLOAD);
assert.equal(vllmWorkloadForBackend("metal"), VLLM_METAL_WORKLOAD);
assert.equal(VLLM_NVIDIA_WORKLOAD.batchMaxTokens, 768);
assert.equal(VLLM_METAL_WORKLOAD.interactiveMaxTokens, 16);
assert.equal(VLLM_METAL_WORKLOAD.batchMaxTokens, 32);
assert.equal(VLLM_METAL_WORKLOAD.batchRps, 0.75);
assert.throws(() => vllmWorkloadForBackend("other"), /unknown vLLM workload backend/u);
assert.deepEqual(vllmSamplingForBackend("metal"), {
  vllmIntervalMs: 1_000,
  vllmTimeoutMs: 8_000,
  managedIntervalMs: 1_000,
  managedTimeoutMs: 8_000,
  platformIntervalMs: 5_000,
  platformTimeoutMs: 15_000,
});
assert.throws(() => vllmSamplingForBackend("other"), /unknown vLLM sampling backend/u);
for (const seed of [1, 2, 3, 4, 5]) {
  const trace = buildTrace({ ...VLLM_METAL_WORKLOAD, seed });
  const initialInteractive = trace.entries.filter(
    (entry) => entry.class === "interactive" &&
      entry.arrivalMs < VLLM_METAL_WORKLOAD.batchStartMs,
  ).length;
  const resumedInteractive = trace.entries.filter(
    (entry) => entry.class === "interactive" &&
      entry.arrivalMs >= VLLM_METAL_WORKLOAD.interactiveResumeStartMs,
  ).length;
  const borrowBatch = trace.entries.filter(
    (entry) => entry.class === "batch" &&
      entry.arrivalMs < VLLM_METAL_WORKLOAD.interactiveResumeStartMs,
  ).length;
  assert.ok(initialInteractive >= 4, `seed ${seed} lacks an interactive baseline`);
  assert.ok(resumedInteractive >= 9, `seed ${seed} lacks protected demand return`);
  assert.ok(borrowBatch >= 20, `seed ${seed} lacks a lending window`);
  assert.ok(trace.entries.length <= 100, `seed ${seed} exceeds the bounded Metal envelope`);
}
assert.deepEqual(vllmFixedOutputFields("nvidia", 16), {
  ignore_eos: true,
  min_tokens: 16,
});
assert.deepEqual(vllmFixedOutputFields("metal", 16), { ignore_eos: true });
assert.throws(() => vllmFixedOutputFields("other", 16), /unknown vLLM backend/u);
assert.equal(vllmApiKeyArgument("-dash-prefixed-secret"), "--api-key=-dash-prefixed-secret");
assert.throws(() => vllmApiKeyArgument(""), /non-empty string/u);

const metalRuntimeProbe = parseMetalRuntimeProbeOutput(
  "INFO 09-21 11:47:22 platform.py:91] registered Metal platform\n" +
  `${VLLM_METAL_RUNTIME_PROBE_PREFIX}{"engineVersion":"0.29.0","pluginVersion":"0.29.0","machine":"arm64"}\n`,
);
assert.deepEqual(metalRuntimeProbe, {
  engineVersion: "0.29.0",
  pluginVersion: "0.29.0",
  machine: "arm64",
});
assert.throws(
  () => parseMetalRuntimeProbeOutput('{"engineVersion":"0.29.0"}'),
  /did not emit its marked JSON record/u,
);
assert.throws(
  () => parseMetalRuntimeProbeOutput(`${VLLM_METAL_RUNTIME_PROBE_PREFIX}not-json\n`),
  /invalid marked JSON/u,
);
assert.throws(
  () => parseMetalRuntimeProbeOutput(
    `${VLLM_METAL_RUNTIME_PROBE_PREFIX}{}\n${VLLM_METAL_RUNTIME_PROBE_PREFIX}{}`,
  ),
  /more than one marked JSON record/u,
);

const staticPool = vllmPoolDefinition("vllm-static", 15_000, { lending: false });
const mofluxPool = vllmPoolDefinition("vllm-moflux", 15_000, { lending: true });
const metalPool = vllmPoolDefinition("vllm-metal", 15_000, {
  lending: true,
  policy: VLLM_METAL_POLICY,
});
assert.equal(staticPool.admissionClassDemandPolicy, undefined);
assert.equal(metalPool.globalTokenBudget, 65_536);
assert.equal(metalPool.admissionClassLimits.interactive.globalProtectedInFlightTokens, 49_152);
assert.equal(metalPool.admissionClassLimits.batch.globalProtectedInFlightTokens, 16_384);
assert.equal(metalPool.admissionClassLimits.interactive.globalMaxInFlightTokens, 65_536);
assert.equal(
  staticPool.admissionClassLimits.interactive.globalUnlentProtectedConcurrent,
  undefined,
);
assert.equal(mofluxPool.admissionClassDemandPolicy.enabled, true);
assert.equal(
  mofluxPool.admissionClassLimits.interactive.globalUnlentProtectedConcurrent,
  1,
);
assert.equal(mofluxPool.admissionClassLimits.batch.globalMaxConcurrent, 4);
assert.equal(mofluxPool.globalTokenBudget, 65_536);
assert.equal(mofluxPool.admissionClassLimits.interactive.globalUnlentProtectedInFlightTokens, 8_192);
assert.equal(mofluxPool.admissionClassLimits.batch.globalUnlentProtectedInFlightTokens, 4_096);
assert.equal(
  mofluxPool.admissionClassDemandPolicy.restoration.upstreamCapacity.releaseMechanism,
  "unlent_floor",
);
assert.throws(() => vllmPoolDefinition("bad", 0, { lending: true }), /positive integer/u);

const order = armOrderPlan([1, 2, 3, 4, 5]);
assert.equal(armOrderIsCounterbalanced(order), true);
for (const arm of VLLM_ARM_IDS) {
  for (let position = 0; position < VLLM_ARM_IDS.length; position += 1) {
    assert.ok(order.some((entry) => entry.order[position] === arm));
  }
}

function metrics({ running, waiting, kv, preemptions, count, sum }) {
  const lines = [
    `vllm:num_requests_running{model_name="moflux-vllm"} ${running}`,
    `vllm:num_requests_waiting{model_name="moflux-vllm"} ${waiting}`,
    `vllm:kv_cache_usage_perc{model_name="moflux-vllm"} ${kv}`,
    `vllm:num_preemptions_total{model_name="moflux-vllm"} ${preemptions}`,
  ];
  for (const base of [
    "time_to_first_token_seconds",
    "inter_token_latency_seconds",
    "request_queue_time_seconds",
    "request_prefill_time_seconds",
    "request_decode_time_seconds",
    "request_inference_time_seconds",
    "e2e_request_latency_seconds",
  ]) {
    lines.push(`vllm:${base}_bucket{model_name="moflux-vllm",le="0.1"} ${count - 1}`);
    lines.push(`vllm:${base}_bucket{model_name="moflux-vllm",le="1"} ${count}`);
    lines.push(`vllm:${base}_bucket{model_name="moflux-vllm",le="+Inf"} ${count}`);
    lines.push(`vllm:${base}_sum{model_name="moflux-vllm"} ${sum}`);
    lines.push(`vllm:${base}_count{model_name="moflux-vllm"} ${count}`);
  }
  return `${lines.join("\n")}\n`;
}

const start = snapshotVllmMetrics(metrics({ running: 0, waiting: 0, kv: 0.1, preemptions: 2, count: 5, sum: 1 }));
const end = snapshotVllmMetrics(metrics({ running: 2, waiting: 3, kv: 0.7, preemptions: 5, count: 9, sum: 3 }));
const vllm = summarizeVllmTelemetry({
  start,
  end,
  samples: [
    { atMs: 0, snapshot: start },
    { atMs: 250, snapshot: end },
  ],
});
assert.deepEqual(vllm.missingRequiredMetrics, []);
assert.equal(vllm.gauges.waiting.max, 3);
assert.equal(vllm.preemptions.delta, 3);
assert.equal(vllm.histograms.ttft.count, 4);
assert.equal(vllm.histograms.ttft.mean, 0.5);
assert.equal(vllm.histograms.ttft.p95, 0.1);
assert.ok(Object.hasOwn(vllm.phases, "contention"));
assert.ok(Object.hasOwn(vllm.recovery, "queueClearanceMs"));

const gpuRow = parseNvidiaSmiRow("GPU-abc, NVIDIA A100-SXM4-40GB, 87, 12000, 40960, 222.5, 68");
assert.equal(gpuRow.uuid, "GPU-abc");
assert.equal(gpuRow.utilizationGpuPct, 87);
const gpu = summarizeGpuTelemetry([
  { atMs: 0, ...gpuRow },
  { atMs: 1000, ...gpuRow, utilizationGpuPct: 99 },
]);
assert.equal(gpu.sampleCount, 2);
assert.equal(gpu.utilizationGpuPct.max, 99);

const processTree = parseProcessTreeSnapshot(
  "100 1 12.5 102400\n101 100 75.0 204800\n102 101 2.5 51200\n999 1 99.0 999999\n",
  100,
);
assert.equal(processTree.processCount, 3);
assert.equal(processTree.cpuPct, 90);
assert.equal(processTree.rssMiB, 350);
const hostProcess = summarizeProcessTelemetry([
  { atMs: 0, ...processTree },
  { atMs: 1000, ...processTree, cpuPct: 100, rssMiB: 400 },
]);
assert.equal(hostProcess.sampleCount, 2);
assert.equal(hostProcess.rssMiB.max, 400);

// Host pressure parsers, from real `vm_stat`, `sysctl`, and `pmset -g therm`
// output on the Apple M1 (16 GiB) development host.
const vmStatText = (swapouts, free, compressor) => `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     ${free}.
Pages active:                                 349011.
Pages inactive:                               346811.
Pages speculative:                              1466.
Pages throttled:                                   0.
Pages wired down:                             167690.
Pages purgeable:                                7722.
"Translation faults":                     7248601833.
Pages occupied by compressor:                 ${compressor}.
Decompressions:                           1041148480.
Compressions:                             1197560900.
Pageins:                                   249608879.
Pageouts:                                    3164157.
Swapins:                                    42055680.
Swapouts:                                   ${swapouts}.
`;
const vmStat = parseVmStat(vmStatText(46304874, 3588, 131419));
assert.equal(vmStat.pageSizeBytes, 16_384);
assert.equal(vmStat.freePages, 3588);
assert.equal(vmStat.compressorPages, 131_419);
assert.equal(vmStat.swapouts, 46_304_874);
assert.throws(() => parseVmStat("Pages free: 1."), /page size/u);
const memory = parseMemorySysctl(
  "kern.memorystatus_vm_pressure_level: 2\nvm.swapusage: total = 7168.00M  used = 5674.56M  free = 1493.44M  (encrypted)\n",
);
assert.deepEqual(memory, {
  pressureLevel: 2,
  pressure: "warn",
  swapTotalMiB: 7168,
  swapUsedMiB: 5674.56,
  swapFreeMiB: 1493.44,
});
const quietTherm = parsePmsetTherm(
  "Note: No thermal warning level has been recorded\nNote: No performance warning level has been recorded\nNote: No CPU power status has been recorded\n",
);
assert.deepEqual(quietTherm, { thermalWarning: false, performanceWarning: false, recordedLines: [] });
const hotTherm = parsePmsetTherm(
  "Thermal warning level: 1\nNote: No performance warning level has been recorded\n",
);
assert.equal(hotTherm.thermalWarning, true);
assert.deepEqual(hotTherm.recordedLines, ["Thermal warning level: 1"]);
const hostPressure = summarizeHostPressure([
  { atMs: 0, vm: vmStat, memory: { ...memory, pressure: "normal", pressureLevel: 1 }, therm: quietTherm },
  { atMs: 5_000, vm: parseVmStat(vmStatText(46_304_874 + 6_400, 1_200, 140_000)), memory, therm: hotTherm },
], ["sysctl timed out"]);
assert.equal(hostPressure.sampleCount, 2);
assert.equal(hostPressure.worstPressure, "warn");
assert.deepEqual(hostPressure.pressureSamples, { normal: 1, warn: 1, critical: 0, unknown: 0 });
assert.equal(hostPressure.pagesDuringArm.swapouts, 6_400);
assert.equal(hostPressure.swapoutMiBDuringArm, 100, "6,400 x 16 KiB pages = 100 MiB swapped out");
assert.equal(hostPressure.freeMiB.min, 18.8);
assert.equal(hostPressure.thermalWarningSamples, 1);
assert.deepEqual(hostPressure.thermalRecordedLines, ["Thermal warning level: 1"]);
assert.deepEqual(hostPressure.errors, ["sysctl timed out"]);
assert.equal(summarizeHostPressure([], []).worstPressure, null);
const healthyHostPressure = summarizeHostPressure([
  { atMs: 0, vm: vmStat, memory: { ...memory, pressure: "normal", pressureLevel: 1 }, therm: quietTherm },
  { atMs: 5_000, vm: vmStat, memory: { ...memory, pressure: "normal", pressureLevel: 1 }, therm: quietTherm },
], []);
assert.equal(healthyHostPressure.swapoutMiBDuringArm, 0);

assert.deepEqual(VLLM_GPU_MEMORY_UTILIZATION, { nvidia: 0.85, metal: 0.4 });
assert.equal(vllmGpuMemoryUtilizationForBackend("metal"), 0.4);
assert.throws(() => vllmGpuMemoryUtilizationForBackend("other"), /unknown vLLM memory backend/u);
assert.deepEqual(VLLM_METAL_HOST_PRESSURE_LIMITS, { maxSwapoutMiBPerArm: 256, maxCriticalPressureSamples: 0 });

const managedSamples = [
  { offsetMs: 30_000, pool: { maxConcurrent: 4 }, classes: {
    interactive: { limits: { protectedConcurrent: 1 }, inFlight: 0 },
    batch: { limits: { protectedConcurrent: 3 }, inFlight: 3 },
  } },
  { offsetMs: 60_100, pool: { maxConcurrent: 4 }, classes: {
    interactive: { limits: { protectedConcurrent: 1 }, inFlight: 0 },
    batch: { limits: { protectedConcurrent: 3 }, inFlight: 3 },
  } },
  { offsetMs: 62_000, pool: { maxConcurrent: 4 }, classes: {
    interactive: { limits: { protectedConcurrent: 3 }, inFlight: 1 },
    batch: { limits: { protectedConcurrent: 1 }, inFlight: 2 },
  } },
  { offsetMs: 75_000, pool: { maxConcurrent: 4 }, classes: {
    interactive: { limits: { protectedConcurrent: 3 }, inFlight: 2 },
    batch: { limits: { protectedConcurrent: 1 }, inFlight: 1 },
  } },
];
const recovery = summarizeManagedRecovery(managedSamples, VLLM_WORKLOAD, {
  benchmarkMarkedActiveAtMs: 60_000,
  restorationWasNeeded: true,
});
assert.equal(recovery.lendingObserved, true);
assert.equal(recovery.floorRestorationLatencyMs, 2_000);
assert.equal(recovery.occupancyRestorationLatencyMs, 15_000);
assert.equal(recovery.floorWithinSlo, true);
assert.equal(recovery.nativeUnlentConcurrentBreaches, 0);

const runtime = {
  backend: "nvidia",
  imageId: "sha256:image",
  model: "Qwen/Qwen2.5-1.5B-Instruct",
  gpuUuid: "GPU-abc",
  maxNumSeqs: 4,
  maxModelLen: 4096,
  modelRevision: "0123456789012345678901234567890123456789",
  servedModel: "moflux-vllm",
  engineVersion: "0.18.0",
  gpuMemoryUtilization: 0.85,
  prefixCaching: false,
  containerGpuDeviceIds: ["0"],
  gpuSelectionMatches: true,
};
const cls = (slo, borrow, completionTokens) => ({
  success: 1,
  completionTokens,
  promptTokens: 32,
  promptTokenReports: 1,
  serverErrors: 0,
  requestErrors: 0,
  tornStreams: 0,
  windows: {
    contention: { sloGoodputRps: slo, ttftP95Ms: 500 },
    borrow: { goodputRps: borrow },
  },
});
const arms = Object.fromEntries(VLLM_ARM_IDS.map((id) => [id, {
  trace: { hash: "trace" },
  generatorSaturated: 0,
  runtimeIdentity: { ...runtime, schedulingPolicy: id === "vllm-fcfs" ? "fcfs" : "priority" },
  vllm: {
    missingRequiredMetrics: [],
    sampleCount: 2,
    scrapeErrors: [],
    gauges: { waiting: { max: id.startsWith("vllm-") ? 3 : 0 } },
    histograms: { ttft: { count: 2 }, e2e: { count: 2 } },
  },
  gpu,
  managedSampleCount: ["static", "moflux"].includes(id) ? 2 : 0,
  managedSampleErrors: [],
  bindingConstraint: {
    interactive: { budgetLimited: 0, concurrencyLimited: ["static", "moflux"].includes(id) ? 1 : 0 },
    batch: { budgetLimited: 0, concurrencyLimited: ["static", "moflux"].includes(id) ? 2 : 0 },
  },
  classes: {
    interactive: cls(id === "vllm-fcfs" ? 1 : 1.2, 0, VLLM_WORKLOAD.interactiveMaxTokens),
    batch: cls(
      0,
      id === "moflux" ? 0.3 : id === "static" ? 0.1 : 0.2,
      VLLM_WORKLOAD.batchMaxTokens,
    ),
  },
}]));
const controlPlane = {
  unlentGauges: {
    concurrencyStatus: "measured",
    totalUnlentConcurrent: 1,
    totalUnlentTokens: 12_288,
  },
  handoff: { proofComplete: true, unsafeHandoffs: 0 },
  latchfloEpisodes: { status: "measured", episodes: 1 },
};
const seedProof = vllmSeedProof({ arms, evidence: { moflux: { recovery, controlPlane } } });
assert.equal(seedProof.valid, true, JSON.stringify(seedProof.failed));
const zeroDirectSloArms = structuredClone(arms);
for (const id of ["vllm-fcfs", "vllm-priority"]) {
  zeroDirectSloArms[id].classes.interactive.windows.contention.sloGoodputRps = 0;
}
const zeroDirectSloProof = vllmSeedProof({
  arms: zeroDirectSloArms,
  evidence: { moflux: { recovery, controlPlane } },
});
assert.equal(zeroDirectSloProof.valid, false);
assert.ok(zeroDirectSloProof.failed.some(({ gate }) => gate === "interactiveSloSignal"));
const tokenBoundArms = structuredClone(arms);
tokenBoundArms.moflux.bindingConstraint.batch.budgetLimited = 1;
tokenBoundArms.moflux.classes.batch.rejectionDetails = [{
  pool: "vllm-moflux",
  reason: "budget_limit",
  count: 1,
  requestedMin: 16_385,
  requestedMax: 16_385,
  availableMin: 16_384,
  availableMax: 16_384,
  budgetMin: 65_536,
  budgetMax: 65_536,
}];
tokenBoundArms.moflux.classes.batch.budgetRejectionSnapshots = [{
  requestId: "batch-7",
  globalInFlight: 3,
  globalMaxConcurrent: 4,
  tokenBudget: { requested: 16_385, available: 16_384 },
}];
const tokenBoundProof = vllmSeedProof({
  arms: tokenBoundArms,
  evidence: { moflux: { recovery, controlPlane } },
});
const tokenBoundGate = tokenBoundProof.failed.find(
  ({ gate }) => gate === "concurrencyAdmissionExercised",
);
assert.ok(tokenBoundGate);
assert.equal(tokenBoundGate.observed.budgetLimited, 1);
assert.equal(
  tokenBoundGate.observed.budgetRejectionEvidence.moflux.batch.ranges[0].requestedMax,
  16_385,
);
assert.equal(
  tokenBoundGate.observed.budgetRejectionEvidence.moflux.batch.snapshots[0].globalInFlight,
  3,
);
assert.ok(
  seedProof.gates.some(({ gate, passed }) => gate === "managedGrantContinuity" && passed),
  "a seed without zero-envelope refusals passes grant continuity",
);
// Tyr reports budget_limit while holding its even fail-closed revision between
// Latchflo grants. That is a control-plane gap, so it must invalidate the seed
// without being counted as token pressure.
const grantGapArms = structuredClone(arms);
grantGapArms.static.bindingConstraint.batch.grantUnavailable = 2;
grantGapArms.static.classes.batch.grantUnavailableRejections = 2;
grantGapArms.static.classes.batch.grantUnavailableSnapshots = [
  { requestId: "batch-1", reason: "budget_limit", rejectedAtMs: 27_507.2, admissionRevision: 130 },
  { requestId: "batch-2", reason: "budget_limit", rejectedAtMs: 27_710.4, admissionRevision: 130 },
];
grantGapArms.static.classes.batch.rejectionDetails = [{
  pool: "vllm-static",
  reason: "budget_limit",
  grantUnavailable: true,
  count: 2,
  budgetMin: 0,
  budgetMax: 0,
}];
const grantGapProof = vllmSeedProof({
  arms: grantGapArms,
  evidence: { moflux: { recovery, controlPlane } },
});
assert.equal(grantGapProof.valid, false);
const grantGapGate = grantGapProof.failed.find(({ gate }) => gate === "managedGrantContinuity");
assert.ok(grantGapGate);
assert.equal(grantGapGate.observed.grantUnavailable, 2);
assert.equal(grantGapGate.observed.byArm.static.batch.snapshots[0].admissionRevision, 130);
assert.ok(
  !grantGapProof.failed.some(({ gate }) => gate === "concurrencyAdmissionExercised"),
  "zero-envelope refusals are not token pressure",
);
const upstreamErrorArms = structuredClone(arms);
upstreamErrorArms.moflux.classes.interactive.serverErrors = 1;
upstreamErrorArms.moflux.classes.interactive.serverErrorCauses = { "upstream_error:ECONNRESET": 1 };
const upstreamErrorGate = vllmSeedProof({
  arms: upstreamErrorArms,
  evidence: { moflux: { recovery, controlPlane } },
}).failed.find(({ gate }) => gate === "noEngineOrTransportErrors");
assert.ok(upstreamErrorGate);
assert.deepEqual(upstreamErrorGate.observed.moflux.serverErrorCauses.interactive, {
  "upstream_error:ECONNRESET": 1,
});
const noInferenceArms = structuredClone(arms);
for (const arm of Object.values(noInferenceArms)) {
  for (const workload of ["interactive", "batch"]) {
    arm.classes[workload].completionTokens = 0;
    arm.classes[workload].promptTokens = 0;
    arm.classes[workload].promptTokenReports = 0;
  }
  arm.vllm.histograms.ttft.count = 0;
  arm.vllm.histograms.e2e.count = 0;
}
const noInferenceProof = vllmSeedProof({
  arms: noInferenceArms,
  evidence: { moflux: { recovery, controlPlane } },
});
assert.equal(noInferenceProof.valid, false);
assert.ok(noInferenceProof.failed.some(({ gate }) => gate === "successfulInferenceObserved"));
assert.ok(noInferenceProof.failed.some(({ gate }) => gate === "vllmRequestMetricsActive"));
const metalArms = Object.fromEntries(VLLM_ARM_IDS.map((id) => [id, {
  ...arms[id],
  classes: {
    interactive: {
      ...arms[id].classes.interactive,
      completionTokens: VLLM_METAL_WORKLOAD.interactiveMaxTokens,
    },
    batch: {
      ...arms[id].classes.batch,
      completionTokens: VLLM_METAL_WORKLOAD.batchMaxTokens,
    },
  },
  gpu: null,
  hostProcess,
  hostPressure: healthyHostPressure,
  runtimeIdentity: {
    backend: "metal",
    engineVersion: "0.29.0",
    pluginVersion: "0.29.0",
    model: runtime.model,
    modelRevision: runtime.modelRevision,
    servedModel: runtime.servedModel,
    appleChip: "Apple M4 Max",
    systemMemoryBytes: 68_719_476_736,
    platform: "darwin",
    arch: "arm64",
    macosVersion: "15.6.1",
    maxNumSeqs: 4,
    maxModelLen: 4096,
    gpuMemoryUtilization: 0.4,
    prefixCaching: false,
    pagedAttention: true,
    schedulingPolicy: id === "vllm-fcfs" ? "fcfs" : "priority",
  },
}]));
const metalSeedProof = vllmSeedProof({
  arms: metalArms,
  evidence: { moflux: { recovery, controlPlane } },
  backend: "metal",
  workload: VLLM_METAL_WORKLOAD,
  policy: VLLM_METAL_POLICY,
});
assert.equal(metalSeedProof.valid, true, JSON.stringify(metalSeedProof.failed));
assert.ok(metalSeedProof.gates.some(({ gate, passed }) => gate === "hostMemoryHeadroom" && passed));
const metalProofWith = (mutate, options = {}) => {
  const variant = structuredClone(metalArms);
  mutate(variant);
  return vllmSeedProof({
    arms: variant,
    evidence: { moflux: { recovery, controlPlane } },
    backend: "metal",
    workload: VLLM_METAL_WORKLOAD,
    policy: VLLM_METAL_POLICY,
    ...options,
  });
};
const failedGates = (proof) => proof.failed.map(({ gate }) => gate);
// A host that swaps gigabytes during an arm cannot produce arm-effect evidence.
const thrashing = metalProofWith((variant) => {
  variant.moflux.hostPressure = { ...healthyHostPressure, swapoutMiBDuringArm: 6_000 };
});
assert.deepEqual(failedGates(thrashing), ["hostMemoryHeadroom"]);
assert.equal(
  thrashing.failed[0].observed.moflux.swapoutMiB,
  6_000,
);
assert.deepEqual(
  failedGates(metalProofWith((variant) => {
    variant.static.hostPressure = {
      ...healthyHostPressure,
      pressureSamples: { normal: 1, warn: 0, critical: 1, unknown: 0 },
    };
  })),
  ["hostMemoryHeadroom"],
);
assert.deepEqual(
  failedGates(metalProofWith((variant) => { delete variant["vllm-fcfs"].hostPressure; })),
  ["hostMemoryHeadroom"],
  "missing pressure evidence fails closed",
);
assert.deepEqual(
  failedGates(metalProofWith((variant) => {
    variant["vllm-priority"].hostPressure = { ...healthyHostPressure, errors: ["vm_stat timed out"] };
  })),
  ["hostMemoryHeadroom"],
);
assert.ok(
  metalProofWith((variant) => {
    variant.moflux.hostPressure = { ...healthyHostPressure, swapoutMiBDuringArm: 255.9 };
  }).valid,
  "incidental paging under the limit is tolerated",
);
// The observed engine memory setting must match the run's declared value.
const undeclared = metalProofWith((variant) => {
  for (const arm of Object.values(variant)) arm.runtimeIdentity.gpuMemoryUtilization = 0.85;
});
assert.deepEqual(failedGates(undeclared), ["runtimeConfigurationObserved"]);
assert.ok(
  metalProofWith((variant) => {
    for (const arm of Object.values(variant)) arm.runtimeIdentity.gpuMemoryUtilization = 0.85;
  }, { gpuMemoryUtilization: 0.85 }).valid,
  "an explicitly declared override is a controlled runtime",
);
const wrongMetalWorkloadProof = vllmSeedProof({
  arms: metalArms,
  evidence: { moflux: { recovery, controlPlane } },
  backend: "metal",
  policy: VLLM_METAL_POLICY,
});
assert.equal(wrongMetalWorkloadProof.valid, false);
assert.ok(
  wrongMetalWorkloadProof.failed.some(({ gate }) => gate === "successfulInferenceObserved"),
);
// metal-long-context-v1: a pinned KV pool that three long batch requests nearly fill.
const longContext = VLLM_METAL_LONG_CONTEXT_WORKLOAD;
assert.equal(vllmWorkloadForBackend("metal"), VLLM_METAL_WORKLOAD, "the default Metal workload is unchanged");
assert.equal(VLLM_METAL_WORKLOAD.engine, undefined, "the published Metal profile pins no KV pool");
assert.equal(vllmWorkloadByProfile("metal-long-context-v1", "metal"), longContext);
assert.throws(() => vllmWorkloadByProfile("metal-long-context-v1", "nvidia"), /runs on --backend=metal/);
assert.throws(() => vllmWorkloadByProfile("metal-huge", "metal"), /--workload must be one of/);
assert.equal(vllmSweepNameFor("metal", longContext), VLLM_METAL_LONG_CONTEXT_SWEEP_NAME);
assert.equal(vllmSweepNameFor("metal", VLLM_METAL_WORKLOAD), VLLM_METAL_SWEEP_NAME);
assert.equal(vllmSweepNameFor("nvidia", VLLM_NVIDIA_WORKLOAD), "vllm-contention");
for (const key of [
  "durationMs", "interactiveRps", "interactiveDurationMs", "interactiveInputChars", "interactiveMaxTokens",
  "interactiveResumeStartMs", "interactiveResumeDurationMs", "interactiveResumeRps",
  "batchStartMs", "batchDurationMs", "maxAttempts", "forceOutputLength",
]) {
  assert.equal(longContext[key], VLLM_METAL_WORKLOAD[key], `long-context keeps metal-balanced-v1 ${key}`);
}
// Pool arithmetic from the 1,607 prompt tokens the M1 probe measured for a
// 7,100-character batch prompt under Qwen2.5-1.5B's chat template.
const MEASURED_BATCH_PROMPT_TOKENS = 1_607;
const { blockSize, kvCacheBlocks } = longContext.engine;
const blocksPerBatch = Math.ceil((MEASURED_BATCH_PROMPT_TOKENS + longContext.batchMaxTokens) / blockSize);
assert.ok(kvCacheBlocks * blockSize >= 4_096 + blockSize, "the pool still holds one max-length request");
assert.ok(3 * blocksPerBatch <= kvCacheBlocks, "three batch requests fit");
assert.ok(4 * blocksPerBatch > kvCacheBlocks, "four do not, so KV binds before max-num-seqs");
assert.ok(MEASURED_BATCH_PROMPT_TOKENS + longContext.batchMaxTokens <= 4_096);
// Tyr's token budget must never bind, or concurrencyAdmissionExercised fails.
const batchGrant = reservationBounds({
  inputChars: longContext.batchInputChars,
  maxTokens: longContext.batchMaxTokens,
}).requiredLocalGrant;
assert.ok(
  4 * batchGrant <= VLLM_METAL_POLICY.classes.batch.globalProtectedInFlightTokens,
  "four batch reservations fit the batch token floor",
);
// Every publication seed leaves borrowed batch resident when demand returns.
for (const seed of [1, 2, 3, 4, 5]) {
  const beforeReturn = buildTrace({ ...longContext, seed }).entries.filter((entry) =>
    entry.class === "batch" &&
    entry.arrivalMs >= longContext.interactiveResumeStartMs - 20_000 &&
    entry.arrivalMs < longContext.interactiveResumeStartMs).length;
  assert.ok(beforeReturn >= 3, `seed ${seed} has ${beforeReturn} batch arrivals in the 20s before demand returns`);
}

// vLLM publishes its cache configuration as labels; the pinned pool is read back from the engine.
const cachedSnapshot = snapshotVllmMetrics(
  `${metrics({ running: 1, waiting: 0, kv: 0.5, preemptions: 0, count: 2, sum: 1 })}` +
    'vllm:cache_config_info{block_size="16",engine="0",num_gpu_blocks="320",num_gpu_blocks_override="320"} 1.0\n',
);
assert.deepEqual(cachedSnapshot.cacheConfig, { blockSize: 16, numGpuBlocks: 320, numGpuBlocksOverride: 320 });
assert.equal(snapshotVllmMetrics(metrics({ running: 0, waiting: 0, kv: 0, preemptions: 0, count: 1, sum: 1 })).cacheConfig, null);

// Engine state when protected demand returns, and how long work then waits inside vLLM.
const returnAt = longContext.interactiveResumeStartMs;
const engineAt = (kv, running, waiting) => snapshotVllmMetrics(metrics({ running, waiting, kv, preemptions: 0, count: 2, sum: 1 }));
const returned = summarizeVllmTelemetry({
  workload: longContext,
  start: cachedSnapshot,
  end: cachedSnapshot,
  samples: [
    { atMs: returnAt - 1_000, snapshot: engineAt(0.98, 3, 0) },
    { atMs: returnAt, snapshot: engineAt(0.99, 3, 2) },
    { atMs: returnAt + 2_000, snapshot: engineAt(1, 4, 1) },
    { atMs: returnAt + 4_000, snapshot: engineAt(0.7, 3, 0) },
  ],
});
assert.equal(returned.cacheConfig.numGpuBlocks, 320);
assert.equal(returned.demandReturn.kvCacheUsage, 0.99);
assert.equal(returned.demandReturn.waiting, 2);
assert.equal(returned.demandReturn.waitingClearanceMs, 4_000);

// Seed validity with a pinned pool: the pool must be read back and KV must actually fill.
const longContextArms = Object.fromEntries(Object.entries(metalArms).map(([id, arm]) => [id, {
  ...arm,
  classes: {
    interactive: { ...arm.classes.interactive, completionTokens: longContext.interactiveMaxTokens },
    batch: { ...arm.classes.batch, completionTokens: longContext.batchMaxTokens },
  },
  runtimeIdentity: { ...arm.runtimeIdentity, blockSize, kvCacheBlocks },
  vllm: {
    ...arm.vllm,
    cacheConfig: { blockSize, numGpuBlocks: kvCacheBlocks, numGpuBlocksOverride: kvCacheBlocks },
    gauges: { ...arm.vllm.gauges, kvCacheUsage: { max: id.startsWith("vllm-") ? 1 : 0.8 } },
  },
}]));
const longContextProofWith = (mutate) => {
  const variant = structuredClone(longContextArms);
  mutate(variant);
  return vllmSeedProof({
    arms: variant,
    evidence: { moflux: { recovery, controlPlane } },
    backend: "metal",
    workload: longContext,
    policy: VLLM_METAL_POLICY,
  });
};
const longContextProof = longContextProofWith(() => {});
assert.equal(longContextProof.valid, true, JSON.stringify(longContextProof.failed));
for (const gate of ["kvPoolPinned", "kvPressureExercised"]) {
  assert.ok(longContextProof.gates.some((entry) => entry.gate === gate && entry.passed), gate);
}
assert.ok(
  !metalSeedProof.gates.some(({ gate }) => gate === "kvPoolPinned" || gate === "kvPressureExercised"),
  "an unpinned Metal run has no KV-pressure gates",
);
assert.deepEqual(
  failedGates(longContextProofWith((variant) => {
    variant.moflux.vllm.cacheConfig = { blockSize, numGpuBlocks: 1_933, numGpuBlocksOverride: null };
  })),
  ["kvPoolPinned"],
  "an engine that ignored the override is not the pinned pool",
);
assert.deepEqual(
  failedGates(longContextProofWith((variant) => { delete variant.static.vllm.cacheConfig; })),
  ["kvPoolPinned"],
  "a missing cache configuration fails closed",
);
assert.deepEqual(
  failedGates(longContextProofWith((variant) => {
    for (const id of ["vllm-fcfs", "vllm-priority"]) {
      variant[id].vllm.gauges.kvCacheUsage = { max: VLLM_KV_PRESSURE_THRESHOLDS.minPeakKvCacheUsage - 0.01 };
    }
  })),
  ["kvPressureExercised"],
  "a pressure workload that never filled the pool is inconclusive",
);
assert.deepEqual(
  failedGates(longContextProofWith((variant) => {
    for (const arm of Object.values(variant)) delete arm.runtimeIdentity.kvCacheBlocks;
  })),
  ["runtimeConfigurationObserved"],
  "the declared engine pool must match the workload",
);
assert.ok(
  failedGates(vllmSeedProof({
    arms: metalArms,
    evidence: { moflux: { recovery, controlPlane } },
    backend: "metal",
    workload: longContext,
    policy: VLLM_METAL_POLICY,
  })).includes("kvPoolPinned"),
  "metal-balanced-v1 evidence cannot pass as a long-context run",
);

const comparison = {
  priorityGoodputDeltaVsFcfsRps: 0.2,
  mofluxGoodputDeltaVsPriorityRps: 0,
  mofluxBatchBorrowDeltaVsStaticRps: 0.2,
};
const sweepProof = vllmSweepProof({
  rows: [1, 2, 3, 4, 5].map((seed) => ({
    seed,
    proof: seedProof,
    comparison,
    evidence: { moflux: { recovery } },
  })),
  armOrder: order,
});
assert.equal(sweepProof.status, "pass", JSON.stringify(sweepProof, null, 2));
const inconclusive = vllmSweepProof({ rows: [], armOrder: [] });
assert.equal(inconclusive.status, "inconclusive");

const compose = readFileSync(path.join(ROOT, "demo/vllm/compose.yaml"), "utf8");
for (const required of [
  "${MOFLUX_VLLM_IMAGE:?Set MOFLUX_VLLM_IMAGE}",
  "--scheduling-policy",
  "--max-num-seqs",
  '"4"',
  "--no-enable-prefix-caching",
  'device_ids: ["${MOFLUX_VLLM_GPU_DEVICE:-0}"]',
  "capabilities: [gpu]",
  "moflux-bench-vllm-hf-cache",
  "HF_TOKEN: ${HF_TOKEN:-}",
]) assert.ok(compose.includes(required), `compose missing ${required}`);
const metalCompose = readFileSync(path.join(ROOT, "demo/vllm/compose-metal.yaml"), "utf8");
assert.equal(/^  vllm:/mu.test(metalCompose), false, "Metal Compose must not start a CUDA vLLM service");
assert.ok(metalCompose.includes("./tyr-static-metal.yaml"));
assert.ok(metalCompose.includes("./tyr-moflux-metal.yaml"));
const runner = readFileSync(path.join(ROOT, "demo/vllm-contention.mjs"), "utf8");
assert.ok(
  runner.includes('["serve", "--help=all"]'),
  "Metal capability detection must request vLLM's exhaustive grouped help",
);
assert.equal(
  runner.includes('["serve", "--help"]'),
  false,
  "plain vLLM help omits required engine options in current releases",
);
assert.ok(
  runner.includes("vllmApiKeyArgument(VLLM_API_KEY)"),
  "Metal must bind the API key in one argv token",
);
assert.equal(
  runner.includes('"--api-key", VLLM_API_KEY'),
  false,
  "a dash-prefixed API key must not be parsed as another CLI option",
);
assert.ok(
  runner.includes("workload: WORKLOAD"),
  "the proof must validate fixed token totals against the selected backend workload",
);
assert.ok(
  runner.includes("await readMetalProcessTree()"),
  "Metal process sampling must not block the evidence loop with spawnSync",
);
assert.equal(
  runner.includes('runCommand("ps"'),
  false,
  "Metal process sampling must not use the synchronous command helper",
);
assert.ok(
  runner.includes("fetchTextFresh("),
  "vLLM metrics must use a fresh connection across recreated native servers",
);
assert.ok(
  runner.includes("env.HF_TOKEN || env.HUGGING_FACE_HUB_TOKEN"),
  "the runner must honor Hugging Face's current HF_TOKEN variable",
);
for (const config of ["tyr-static-metal.yaml", "tyr-moflux-metal.yaml"]) {
  const text = readFileSync(path.join(ROOT, "demo/vllm", config), "utf8");
  assert.ok(text.includes("baseUrl: http://host.docker.internal:18000"));
}

// End-to-end request-shape check: the generic load generator must add vLLM's
// extensions only when explicitly requested.
const temp = mkdtempSync(path.join(tmpdir(), "moflux-vllm-loadgen-"));
const bodies = [];
const authorizationHeaders = [];
let responseMode = "success";
const server = createServer((request, response) => {
  let raw = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => { raw += chunk; });
  request.on("end", () => {
    bodies.push(JSON.parse(raw));
    authorizationHeaders.push(request.headers.authorization ?? null);
    if (responseMode === "http-error") {
      response.writeHead(422, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "unsupported request field" } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (responseMode === "stream-error") {
      response.end(
        'data: {"error":{"message":"min_tokens is unsupported","type":"invalid_request_error"}}\n\n' +
        "data: [DONE]\n\n",
      );
      return;
    }
    response.end(
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":3,"total_tokens":4}}\n\n' +
      "data: [DONE]\n\n",
    );
  });
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
assert.ok(address && typeof address !== "string");

async function runFixtureLoadgen(name, extraArgs = []) {
  const outFile = path.join(temp, `${name}.json`);
  const child = spawn(process.execPath, [
    path.join(ROOT, "load/loadgen.mjs"),
    `--targets=http://127.0.0.1:${address.port}`,
    "--provider-api=openai",
    "--provider-api-key=local-vllm-test-key",
    "--duration-ms=400",
    "--interactive-rps=50",
    "--interactive-input-chars=10",
    "--interactive-max-tokens=3",
    "--batch-start-ms=5000",
    "--batch-duration-ms=0",
    "--batch-rps=0",
    "--max-attempts=1",
    "--backoff-base-ms=1",
    "--interactive-priority=0",
    "--batch-priority=10",
    "--force-output-length=true",
    "--metrics-port=0",
    "--drain-idle-ms=1000",
    "--drain-max-ms=5000",
    ...extraArgs,
    `--out=${outFile}`,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let childOutput = "";
  child.stdout.on("data", (chunk) => { childOutput += chunk; });
  child.stderr.on("data", (chunk) => { childOutput += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, childOutput, summary: JSON.parse(readFileSync(outFile, "utf8")) };
}

try {
  let bodyStart = bodies.length;
  const cuda = await runFixtureLoadgen("cuda");
  assert.equal(cuda.code, 0, cuda.childOutput);
  const cudaBodies = bodies.slice(bodyStart);
  assert.ok(cudaBodies.length > 0, "load generator issued no CUDA-shaped request");
  for (const body of cudaBodies) {
    assert.equal(body.priority, 0);
    assert.equal(body.ignore_eos, true);
    assert.equal(body.min_tokens, body.max_tokens);
  }
  assert.equal(cuda.summary.config.fixedOutputMinTokens, true);

  bodyStart = bodies.length;
  const metal = await runFixtureLoadgen("metal", ["--fixed-output-min-tokens=false"]);
  assert.equal(metal.code, 0, metal.childOutput);
  const metalBodies = bodies.slice(bodyStart);
  assert.ok(metalBodies.length > 0, "load generator issued no Metal-shaped request");
  for (const body of metalBodies) {
    assert.equal(body.ignore_eos, true);
    assert.equal(Object.hasOwn(body, "min_tokens"), false);
  }
  assert.equal(metal.summary.config.fixedOutputMinTokens, false);
  assert.ok(metal.summary.classes.interactive.outputTokens > 0);

  responseMode = "stream-error";
  const streamError = await runFixtureLoadgen("stream-error", ["--fixed-output-min-tokens=false"]);
  assert.equal(streamError.code, 0, streamError.childOutput);
  assert.equal(streamError.summary.classes.interactive.success, 0);
  assert.ok(streamError.summary.classes.interactive.requestError > 0);
  assert.ok(streamError.summary.classes.interactive.requestErrorReasons.stream_error > 0);
  assert.match(
    streamError.summary.classes.interactive.requestErrorSnapshots[0].body,
    /min_tokens is unsupported/u,
  );

  responseMode = "http-error";
  const httpError = await runFixtureLoadgen("http-error", ["--fixed-output-min-tokens=false"]);
  assert.equal(httpError.code, 0, httpError.childOutput);
  assert.equal(httpError.summary.classes.interactive.success, 0);
  assert.ok(httpError.summary.classes.interactive.requestErrorReasons.http_422 > 0);

  assert.ok(authorizationHeaders.every((value) => value === "Bearer local-vllm-test-key"));
  for (const result of [cuda, metal, streamError, httpError]) {
    assert.equal(result.summary.config.interactivePriority, 0);
    assert.equal(result.summary.config.batchPriority, 10);
    assert.equal(result.summary.config.forceOutputLength, true);
    assert.equal(result.summary.config.providerCredentialConfigured, true);
    assert.equal(JSON.stringify(result.summary).includes("local-vllm-test-key"), false);
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  rmSync(temp, { recursive: true, force: true });
}

console.log("PASS  vLLM experiment policy, telemetry, proof, Compose, and request shape");
