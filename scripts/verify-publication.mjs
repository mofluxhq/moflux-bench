#!/usr/bin/env node
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REVIEWED_EVIDENCE, RUNS_DIRNAME, isReviewedEvidence } from "../demo/evidence-paths-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "VERIFICATION.md",
  ".gitignore",
  ".github/workflows/ci.yml",
  "demo/moflux/.env.example",
  "demo/classes/compose.yaml",
  "demo/classes/tyr-r1.yaml",
  "demo/TENANT-FAIRNESS.md",
  "demo/membership.mjs",
  "demo/membership/compose.yaml",
  "demo/openai-live.mjs",
  "demo/openai-overload.mjs",
  "demo/openai-overload-lib.mjs",
  "demo/verify-openai-overload.mjs",
  "demo/openai/compose.yaml",
  "demo/openai/compose-overload.yaml",
  "demo/openai/tyr.yaml",
  "demo/ollama/compose.yaml",
  "demo/ollama/tyr.yaml",
  "demo/local-inference.mjs",
  "demo/local-inference-lib.mjs",
  "demo/verify-local-inference.mjs",
  "demo/ollama/compose-contention.yaml",
  "demo/ollama/tyr-static.yaml",
  "demo/ollama/tyr-moflux.yaml",
  "demo/local-contention.mjs",
  "demo/local-contention-lib.mjs",
  "demo/verify-local-contention.mjs",
  "demo/LOCAL-CONTENTION.md",
];
const ignoredDirectories = new Set([".git", "node_modules", "coverage", ".tmp", "tmp"]);
const forbiddenNames = new Set([".DS_Store", "Thumbs.db"]);
const forbiddenExtensions = new Set([".pem", ".p12", ".pfx", ".jks", ".keystore"]);
const findings = [];

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(ROOT, full).split(path.sep).join("/");
    // Ephemeral per-run TLS material for the two identity fixtures. Both are
    // gitignored and both are removed on a clean exit; a crashed run can leave
    // them behind, and that is a local artifact rather than a release defect.
    if (rel === "demo/classes/runtime" || rel === "demo/ollama/runtime") continue;
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) findings.push(`${rel}: symbolic links are not allowed in a release`);
    if (entry.isDirectory()) {
      if (entry.name === "__MACOSX") findings.push(`${rel}: macOS archive metadata is not allowed`);
      files.push(...walk(full));
    } else if (entry.isFile()) {
      files.push({ full, rel });
    }
  }
  return files;
}

for (const rel of required) {
  try {
    if (!lstatSync(path.join(ROOT, rel)).isFile()) findings.push(`${rel}: required file is missing`);
  } catch {
    findings.push(`${rel}: required file is missing`);
  }
}

const files = walk(ROOT);
const privateKeyMarker = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
const contentPatterns = [
  [/(?:^|["'\s])\/(?:Users|home)\/[A-Za-z0-9._-]+\//m, "absolute user-home path"],
  [/[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\/i, "absolute Windows user-home path"],
  [/AKIA[0-9A-Z]{16}/, "AWS access key"],
  [/AIza[0-9A-Za-z_-]{35}/, "Google API key"],
  [/gh[pousr]_[A-Za-z0-9_]{20,}/, "GitHub token"],
  [/sk-[A-Za-z0-9_-]{20,}/, "API secret key"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [new RegExp(privateKeyMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "private key"],
];

for (const { full, rel } of files) {
  const base = path.basename(rel);
  if (forbiddenNames.has(base)) findings.push(`${rel}: forbidden generated file`);
  if (base === ".env" || (base.startsWith(".env.") && base !== ".env.example")) {
    findings.push(`${rel}: local environment file must not be published`);
  }
  if (forbiddenExtensions.has(path.extname(base).toLowerCase())) {
    findings.push(`${rel}: credential-container extension is not allowed`);
  }
  // Approved paths come from the same declaration the runtime guards use, so
  // this check and demo/evidence-paths-lib.mjs can never drift apart.
  const isPublishedResultJson = rel.endsWith(".json") && isReviewedEvidence(rel);
  const isGeneratedRun = rel.startsWith(`results/${RUNS_DIRNAME}/`);
  if (isGeneratedRun) {
    findings.push(`${rel}: generated run output must be deleted or published before release`);
  } else if (rel.startsWith("results/") && rel.endsWith(".json") && !isPublishedResultJson) {
    findings.push(`${rel}: generated JSON is not in an approved published-evidence path`);
  }
  if (rel === "scripts/verify-publication.mjs") continue;
  const buffer = readFileSync(full);
  if (buffer.includes(0)) continue;
  const text = buffer.toString("utf8");
  for (const [pattern, label] of contentPatterns) {
    if (pattern.test(text)) findings.push(`${rel}: contains ${label}`);
  }
  if (isPublishedResultJson) {
    try { JSON.parse(text); } catch (error) {
      findings.push(`${rel}: invalid published-evidence JSON (${error.message})`);
    }
  }
}

const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
if (pkg.private !== true) findings.push("package.json: benchmark package must remain private to prevent accidental npm publication");
if (pkg.license !== "Apache-2.0") findings.push("package.json: license must be Apache-2.0");
if (lock.packages?.[""]?.version !== pkg.version || lock.version !== pkg.version) {
  findings.push("package-lock.json: version does not match package.json");
}
const example = readFileSync(path.join(ROOT, "demo/moflux/.env.example"), "utf8");
for (const expected of [
  "MOFLUX_TYR_IMAGE=tyr-admission-controller:0.30.0",
  "MOFLUX_LATCHFLO_IMAGE=latchflo-control-plane:0.15.0",
]) {
  if (!example.includes(expected)) {
    findings.push(`demo/moflux/.env.example: missing pinned runtime ${expected}`);
  }
}
for (const name of ["LATCHFLO_ADMIN_TOKEN", "LATCHFLO_AGENT_BOOTSTRAP_TOKEN", "TYR_ROUTING_SECRET"]) {
  const match = new RegExp(`^${name}=(.*)$`, "m").exec(example);
  if (!match || !match[1].startsWith("replace-with-")) {
    findings.push(`demo/moflux/.env.example: ${name} must remain an explicit placeholder`);
  }
}

const compose = readFileSync(path.join(ROOT, "demo/moflux/compose.yaml"), "utf8");
if (!compose.includes("TYR_ROUTING_SECRET: ${TYR_ROUTING_SECRET:?Set TYR_ROUTING_SECRET}")) {
  findings.push("demo/moflux/compose.yaml: Tyr replicas must receive the shared routing secret");
}
for (let replica = 1; replica <= 4; replica += 1) {
  const rel = `demo/moflux/tyr-r${replica}.yaml`;
  const yaml = readFileSync(path.join(ROOT, rel), "utf8");
  if (!/^    version: 0\.30\.0$/m.test(yaml)) {
    findings.push(`${rel}: control-plane metadata must identify Tyr 0.30.0`);
  }
  if (!/^  anthropic:\n    baseUrl: http:\/\/host\.docker\.internal:9000$/m.test(yaml)) {
    findings.push(`${rel}: Anthropic simulator upstream is missing`);
  }
  const configuredPools = [...yaml.matchAll(/^  - name: ([^\s]+)$/gm)].length;
  const progressiveBlock = "    progressiveReconciliation:\n      enabled: true\n      updateStepTokens: 256\n      outputSafetyMarginTokens: 256";
  const progressiveBlocks = yaml.split(progressiveBlock).length - 1;
  if (progressiveBlocks !== configuredPools) {
    findings.push(`${rel}: every pool must use the pinned progressive reconciliation policy`);
  }
  if (!new RegExp(`^    instanceId: tyr-r${replica}$`, "m").test(yaml) ||
      !/^    sharedSecretEnv: TYR_ROUTING_SECRET$/m.test(yaml)) {
    findings.push(`${rel}: capacity-aware routing identity or secret environment is missing`);
  }
  if (!/^    peers: \[]$/m.test(yaml)) {
    findings.push(`${rel}: managed mode must start with an empty static peer list and consume Latchflo topology`);
  }
  if (/^      - id: tyr-r\d+$/m.test(yaml)) {
    findings.push(`${rel}: managed mode must not retain hard-coded Tyr peers`);
  }
  if (!new RegExp(`^    endpoint: http://tyr-r${replica}:8787$`, "m").test(yaml)) {
    findings.push(`${rel}: control-plane metadata must advertise the routable Tyr endpoint`);
  }
}

const classesCompose = readFileSync(path.join(ROOT, "demo/classes/compose.yaml"), "utf8");
for (const required of [
  "NODE_EXTRA_CA_CERTS: /etc/tyr/benchmark-ca.pem",
  "./classes/runtime/ca.pem:/etc/tyr/benchmark-ca.pem:ro",
]) {
  if (!classesCompose.includes(required)) {
    findings.push(`demo/classes/compose.yaml: missing ${required}`);
  }
}
for (let replica = 1; replica <= 4; replica += 1) {
  const rel = `demo/classes/tyr-r${replica}.yaml`;
  const yaml = readFileSync(path.join(ROOT, rel), "utf8");
  for (const required of [
    "jwksUrl: https://host.docker.internal:9010/jwks",
    "defaultClass: noisy",
    "tenantIds: [tenant-premium]",
    "pools: [sim-shared, sim-ceilings, sim-protected, sim-adaptive, sim-unlent, sim-deadline]",
    "name: sim-unlent",
    "name: sim-deadline",
    "version: 0.30.0",
  ]) {
    if (!yaml.includes(required)) findings.push(`${rel}: missing ${required}`);
  }
  const progressiveBlock = "    progressiveReconciliation:\n      enabled: true\n      updateStepTokens: 256\n      outputSafetyMarginTokens: 256";
  const progressiveBlocks = yaml.split(progressiveBlock).length - 1;
  if (progressiveBlocks !== 6) {
    findings.push(`${rel}: all six tenant-fairness pools must enable progressive reconciliation`);
  }
  // Tyr's borrowed-slot deadline is local policy Latchflo never sends. Only the
  // deadline arm may carry it: if it leaked onto sim-unlent, the two ladder
  // arms would stop isolating Latchflo's mechanism from Tyr's.
  const borrowedSlotBlocks = yaml.split("borrowedAdmissionSlot:").length - 1;
  if (borrowedSlotBlocks !== 1) {
    findings.push(`${rel}: borrowedAdmissionSlot must be configured on sim-deadline only`);
  }
  if (!yaml.slice(yaml.indexOf("name: sim-deadline")).includes("releaseMechanism: deadline_abandonment")) {
    findings.push(`${rel}: sim-deadline must declare the deadline_abandonment release mechanism`);
  }
  if (!new RegExp(`^    instanceId: tyr-r${replica}$`, "m").test(yaml)) {
    findings.push(`${rel}: routing instance ID is missing`);
  }
}
const tenantRunner = readFileSync(path.join(ROOT, "demo/tenant-fairness.mjs"), "utf8");
for (const required of [
  'tenantPoolDefinition("sim-shared"',
  'tenantPoolDefinition("sim-ceilings"',
  'tenantPoolDefinition("sim-protected"',
  'tenantPoolDefinition("sim-adaptive"',
  'model: "sim-model-shared"',
  'model: "sim-model-ceilings"',
  'model: "sim-model-protected"',
  'model: "sim-model-adaptive"',
  'tenantPoolDefinition("sim-unlent"',
  'tenantPoolDefinition("sim-deadline"',
  '"sim-model-unlent"',
  '"sim-model-deadline"',
  "collectRestorationLadder",
  "restorationEnforceabilityVerdict",
  "validateAdmissionClassGrantSet",
]) {
  if (!tenantRunner.includes(required)) findings.push(`demo/tenant-fairness.mjs: missing ${required}`);
}
for (const required of [
  "validateNoisyRequestFitsEveryGrant",
  "sim-protected",
  "sim-adaptive",
  "observeAdaptiveLending",
  "waitForAdaptiveNoisyFloorLent",
  "waitForAdaptiveNoisyFloorRestored",
  "bootstrapTenantStack",
  'compose("down", "--volumes", "--remove-orphans")',
  "collectAdaptiveClassHandoff",
  "admissionClassOccupancyAck",
  "/v1/events?limit=1000",
  "/v1/grants?pool=sim-adaptive&limit=1000",
  "adaptive noisy floor",
]) {
  if (!tenantRunner.includes(required)) findings.push(`demo/tenant-fairness.mjs: missing ${required}`);
}
const tenantProof = readFileSync(path.join(ROOT, "demo/tenant-fairness-lib.mjs"), "utf8");
for (const required of [
  "globalProtectedConcurrent",
  "globalProtectedInFlightTokens",
  "noisyServedUnderContention",
  "noisyMinimumCompletions",
  "minimumNoisyReservationTokensPerAgent",
  "summarizeAdaptiveLendingSamples",
  "summarizeAdaptiveClassHandoff",
  "adaptiveNoisyFloorLent",
  "adaptiveNoisyFloorRestored",
  "adaptiveClassHandoffBeatLeaseExpiry",
  "committedBeforeLeaseExpiry",
  "grantTtlMs: 240_000",
  "restorationObserveTimeoutMs: 15_000",
]) {
  if (!tenantProof.includes(required)) findings.push(`demo/tenant-fairness-lib.mjs: missing ${required}`);
}
const loadgen = readFileSync(path.join(ROOT, "load/loadgen.mjs"), "utf8");
if (!loadgen.includes('interactiveIdentityToken: interactiveIdentityToken ? "provided" : ""') ||
    !loadgen.includes('"x-tyr-identity-token"') ||
    !loadgen.includes("admissionClassResponses")) {
  findings.push("load/loadgen.mjs: identity attribution or token redaction is missing");
}

if (!loadgen.includes("firstResponseHeadersAtMs") ||
    !loadgen.includes("responseHeadersGapMs") ||
    loadgen.includes("Admission-layer wait only: first attempt until the first 2xx response")) {
  findings.push("load/loadgen.mjs: client 2xx timing must be labelled as response-header timing");
}
for (const required of [
  "localRejectSnapshots",
  "localRejectConstraints",
  "bench_local_reject_constraint_total",
  "x-latchflo-grant-id",
  "rejectionDetail",
]) {
  if (!loadgen.includes(required)) {
    findings.push(`load/loadgen.mjs: full rejection evidence is missing ${required}`);
  }
}
const providerSim = readFileSync(path.join(ROOT, "sim/provider-sim.mjs"), "utf8");
if (!providerSim.includes("firstRequestReceivedAtEpochMsByModel") ||
    !providerSim.includes("receivedByModel") ||
    !providerSim.includes("resetCounters")) {
  findings.push("sim/provider-sim.mjs: model-scoped provider dispatch timing is missing");
}
const lendingEvidence = readFileSync(path.join(ROOT, "demo/lending-evidence-lib.mjs"), "utf8");
for (const required of [
  "firstBatchAdmissionWindow",
  "commitToFirstBatchAdmissionMinMs",
  "commitToFirstBatchAdmissionMaxMs",
  "admissionOrderingStatus",
  "admissionOrderingProofSource",
  "exactAdmissionProvenance",
  "exactAdmissionProof",
  "firstBatchResponseHeadersAt",
]) {
  if (!lendingEvidence.includes(required)) {
    findings.push(`demo/lending-evidence-lib.mjs: missing corrected admission evidence ${required}`);
  }
}


const admissionProvenance = readFileSync(path.join(ROOT, "demo/admission-provenance-lib.mjs"), "utf8");
for (const required of [
  "tyr.admission-provenance.v1",
  "nextSequence",
  "captureFailures",
  "dropped",
  "proven_after_commit_by_successor_grant",
  "proven_before_commit_by_predecessor_grant",
]) {
  if (!admissionProvenance.includes(required)) {
    findings.push(`demo/admission-provenance-lib.mjs: missing exact provenance evidence ${required}`);
  }
}
const presenter023 = readFileSync(path.join(ROOT, "demo/present.mjs"), "utf8");
for (const required of [
  "adaptive-headroom-28-4",
  "headroomLending",
  "minConcurrentHeadroom",
  "minTokenHeadroom",
  "demandingSustainMs",
  "maxDemandingConcurrentLend",
  "maxDemandingTokenLend",
  "summarizeAdmissionProvenance",
  "observedHeadroomTransfer",
]) {
  if (!presenter023.includes(required)) {
    findings.push(`demo/present.mjs: missing retained headroom/provenance feature ${required}`);
  }
}

if (pkg.scripts?.demo !== "node demo/seed-sweep.mjs --seeds=1-5 --pause-ms=0 --provider-api=anthropic" ||
    pkg.scripts?.predemo !== "npm run demo:prepare" ||
    pkg.scripts?.["demo:record"] !== "node demo/seed-sweep.mjs --seeds=1-5 --step") {
  findings.push("package.json: npm run demo must remain automatic and demo:record must retain the step-through path");
}
if (!pkg.scripts?.verify?.includes("scripts/verify.mjs")) {
  findings.push("package.json: verify must use the bounded verification runner");
}
if (!pkg.scripts?.["demo:progressive"]?.includes("--provider-api=anthropic") ||
    pkg.scripts?.["demo:openai"] !== "node demo/openai-live.mjs" ||
    pkg.scripts?.["demo:openai:responses"] !== "node demo/openai-live.mjs --openai-api=responses" ||
    pkg.scripts?.["demo:openai:chat"] !== "node demo/openai-live.mjs --openai-api=chat-completions" ||
    pkg.scripts?.["verify:openai:responses:sim"] !== "node sim/verify-openai-responses.mjs" ||
    pkg.scripts?.["demo:openai:overload"] !== "node demo/openai-overload.mjs --mode=compare" ||
    pkg.scripts?.["demo:openai:overload:dry-run"] !== "node demo/openai-overload.mjs --mode=compare --dry-run" ||
    pkg.scripts?.["demo:openai:overload:calibrate"] !== "node demo/openai-overload.mjs --mode=calibrate" ||
    pkg.scripts?.["demo:openai:overload:sweep"] !== "node demo/openai-overload-sweep.mjs" ||
    pkg.scripts?.["demo:openai:overload:sweep:dry-run"] !== "node demo/openai-overload-sweep.mjs --dry-run" ||
    pkg.scripts?.["verify:openai:overload:sweep"] !== "node demo/verify-openai-overload-sweep.mjs" ||
    !pkg.scripts?.["demo:openai:sim"]?.includes("--provider-api=openai") ||
    pkg.scripts?.["demo:membership"] !== "node demo/membership.mjs") {
  findings.push("package.json: progressive, live OpenAI, simulator OpenAI, and membership demo commands are required");
}
if (pkg.scripts?.["demo:local"] !== "node demo/local-inference.mjs" ||
    pkg.scripts?.["demo:local:dry-run"] !== "node demo/local-inference.mjs --dry-run" ||
    pkg.scripts?.["verify:local"] !== "node demo/verify-local-inference.mjs") {
  findings.push("package.json: the local inference benchmark commands are required");
}
// The 0.33.0 contention benchmark. The publication command must keep both the
// five-seed default and --require-proof: a single seed is not evidence, and a
// sweep whose acceptance gate is optional is a demonstration.
const contentionScript = pkg.scripts?.["demo:local:contention"] ?? "";
for (const required of ["demo/local-contention.mjs", "--seeds=1-5", "--require-proof"]) {
  if (!contentionScript.includes(required)) {
    findings.push(`package.json: demo:local:contention is missing ${required}`);
  }
}
if (pkg.scripts?.["demo:local:contention:dry-run"] !== "node demo/local-contention.mjs --dry-run" ||
    pkg.scripts?.["demo:local:contention:doctor"] !== "node demo/local-contention.mjs --doctor" ||
    !pkg.scripts?.["demo:local:contention:single"]?.includes("demo/local-contention.mjs") ||
    pkg.scripts?.["verify:local:contention"] !== "node demo/verify-local-contention.mjs") {
  findings.push("package.json: the local contention dry-run, doctor, single-seed and verify commands are required");
}
if (pkg.version !== "0.33.2") {
  findings.push("package.json: the current benchmark release must be version 0.33.2");
}
if (
  !pkg.scripts?.["demo:restoration"]?.includes("--restoration-ladder") ||
  pkg.scripts?.["verify:restoration"] !== "node demo/verify-restoration-enforceability.mjs"
) {
  findings.push("package.json: the restoration-enforceability ladder commands are required");
}
// The analysis is what keeps an enforceability claim tied to its evidence and
// its bill; shipping the arms without it would leave the claim unchecked.
for (const [rel, required] of [
  ["demo/restoration-contract-lib.mjs", ["lease_safe_handoff", "unlent_floor", "deadline_abandonment"]],
  ["demo/restoration-enforceability-lib.mjs", ["not-claimed", "unverified", "silentTruncationRate"]],
  ["load/loadgen.mjs", ["borrowedDeadlineAbandoned", "borrowed_admission_deadline"]],
]) {
  const source = readFileSync(path.join(ROOT, rel), "utf8");
  for (const token of required) {
    if (!source.includes(token)) findings.push(`${rel}: missing ${token}`);
  }
}
const openaiLive = readFileSync(path.join(ROOT, "demo/openai-live.mjs"), "utf8");
for (const required of [
  'DEFAULT_MODEL = "gpt-5.6-luna"',
  'DEFAULT_MAX_USD = 0.01',
  'MAX_RUN_CAP_USD = 1.00',
  'OPENAI_API_KEY',
  'normalizeOpenAIApi',
  'buildOpenAIRequestBody',
  'observeOpenAIStreamEvent',
  'conservative worst-case cost',
  'usage',
]) {
  if (!openaiLive.includes(required)) findings.push(`demo/openai-live.mjs: missing budget/safety contract ${required}`);
}
const openaiOverload = readFileSync(path.join(ROOT, "demo/openai-overload.mjs"), "utf8");
for (const required of [
  "OPENAI_API_KEY",
  "conservative worst-case cost",
  "conclusiveProviderOverloadComparison",
  "mofluxAdmissionClassProof",
  "static_local",
  "provider_429",
  "calibration-rps-steps",
  "drain_inclusive_goodput_below_threshold",
  "rate_limit_headroom",
  "provider_non_overload_failure",
]) {
  if (!openaiOverload.includes(required)) findings.push(`demo/openai-overload.mjs: missing overload evidence/safety contract ${required}`);
}
for (const rel of [
  "demo/openai/compose.yaml",
  "demo/openai/compose-overload.yaml",
  "demo/openai/tyr.yaml",
  "demo/ollama/compose.yaml",
  "demo/ollama/tyr.yaml",
  "demo/moflux/.env.example",
]) {
  const text = readFileSync(path.join(ROOT, rel), "utf8");
  if (text.includes("OPENAI_API_KEY")) findings.push(`${rel}: live OpenAI API key must stay in the caller process only`);
}

// The local stack's only upstream must be the Ollama service in its own compose
// file. A hosted base URL here would put a metered provider behind a benchmark
// that deliberately has no spend guard.
const ollamaTyr = readFileSync(path.join(ROOT, "demo/ollama/tyr.yaml"), "utf8");
if (!/baseUrl:\s*http:\/\/ollama:11434\s*$/m.test(ollamaTyr)) {
  findings.push("demo/ollama/tyr.yaml: the local stack must serve only the in-compose ollama upstream");
}
if (/api\.openai\.com|api\.anthropic\.com/.test(ollamaTyr)) {
  findings.push("demo/ollama/tyr.yaml: a hosted provider must not be reachable from the unmetered local stack");
}
const verifyRunnerNewDemos = readFileSync(path.join(ROOT, "scripts/verify.mjs"), "utf8");
for (const required of ["sim/verify-openai-responses.mjs", "demo/verify-membership.mjs", "demo/verify-openai-live.mjs", "demo/verify-openai-overload.mjs", "demo/verify-local-inference.mjs"]) {
  if (!verifyRunnerNewDemos.includes(required)) findings.push(`scripts/verify.mjs: missing ${required}`);
}

// The locality guard is to the local benchmark what the spend guard is to the
// OpenAI one: the single thing standing between it and an unguarded paid run.
// It must stay present, non-overridable, and enforced on both upstreams.
for (const [rel, required] of [
  ["demo/local-inference-lib.mjs", [
    "assertLocalUpstream",
    "isLocalHostname",
    "not a local address",
    "buildLocalChatBody",
    "max_tokens",
  ]],
  ["demo/local-inference.mjs", [
    'assertLocalUpstream(directUrl, "--direct-url")',
    'assertLocalUpstream(mofluxUrl, "--moflux-url")',
    "meteredProviderReachable",
    'guard: "non-overridable"',
    "warmupPairs",
    "steadyStateMeasured",
    "must not be quoted",
  ]],
]) {
  const source = readFileSync(path.join(ROOT, rel), "utf8");
  for (const token of required) {
    if (!source.includes(token)) findings.push(`${rel}: missing local-inference safety contract ${token}`);
  }
}
const localInference = readFileSync(path.join(ROOT, "demo/local-inference.mjs"), "utf8");
if (/allow-nonlocal|allow-remote|skip-locality|force-upstream/.test(localInference)) {
  findings.push("demo/local-inference.mjs: the locality guard must not be overridable by a flag");
}
if (localInference.includes("OPENAI_API_KEY")) {
  findings.push("demo/local-inference.mjs: an unmetered local benchmark must not read a provider credential");
}

// The contention benchmark's guard is strictly stronger than the compatibility
// one's: its arm endpoints come from constants, so there is no endpoint flag to
// override in the first place. That property is the thing being protected here.
const localContention = readFileSync(path.join(ROOT, "demo/local-contention.mjs"), "utf8");
const localContentionLib = readFileSync(path.join(ROOT, "demo/local-contention-lib.mjs"), "utf8");
if (/allow-nonlocal|allow-remote|skip-locality|force-upstream|--direct-url|--moflux-url|--ollama-url/.test(localContention)) {
  findings.push("demo/local-contention.mjs: arm endpoints are constants and must stay unoverridable");
}
if (localContention.includes("OPENAI_API_KEY") || localContention.includes("ANTHROPIC_API_KEY")) {
  findings.push("demo/local-contention.mjs: an unmetered local benchmark must not read a provider credential");
}
for (const required of [
  "assertLocalUpstream",
  "meteredProviderReachable",
  'guard: "non-overridable"',
  "localContentionProof",
  "warmupArm",
  "evidenceLimits",
]) {
  if (!localContention.includes(required)) {
    findings.push(`demo/local-contention.mjs: missing local-contention safety/evidence contract ${required}`);
  }
}
// The claim boundary has to ship with the code, not only with the prose. These
// are the statements this benchmark is structurally unable to support.
for (const required of [
  "gpuPreemption",
  "gpuUtilization",
  "kvCacheReclamation",
  "ollamaSchedulerPreemption",
  "decodeDeterminism",
  "not-claimed",
  "unlent_floor",
  "HYPOTHESIS_THRESHOLDS",
  "leaseGapSamples",
]) {
  if (!localContentionLib.includes(required)) {
    findings.push(`demo/local-contention-lib.mjs: missing evidence contract ${required}`);
  }
}
// Its own named proof, and a top-level `passed` that means only that proof.
// Overloading one benchmark's `passed` with another's gates is a mistake this
// repository has already made once.
if (!localContention.includes("passed: proof.passed")) {
  findings.push("demo/local-contention.mjs: top-level passed must mirror localContentionProof and nothing else");
}
for (const rel of ["demo/ollama/tyr-static.yaml", "demo/ollama/tyr-moflux.yaml"]) {
  const text = readFileSync(path.join(ROOT, rel), "utf8");
  if (!/baseUrl:\s*http:\/\/ollama:11434\s*$/m.test(text)) {
    findings.push(`${rel}: the local stack must serve only the in-compose ollama upstream`);
  }
  if (/api\.openai\.com|api\.anthropic\.com/.test(text)) {
    findings.push(`${rel}: a hosted provider must not be reachable from the unmetered local stack`);
  }
  if (text.includes("OPENAI_API_KEY")) {
    findings.push(`${rel}: live OpenAI API key must stay in the caller process only`);
  }
}
const contentionCompose = readFileSync(path.join(ROOT, "demo/ollama/compose-contention.yaml"), "utf8");
if (contentionCompose.includes("OPENAI_API_KEY")) {
  findings.push("demo/ollama/compose-contention.yaml: live OpenAI API key must stay in the caller process only");
}
if (!/OLLAMA_NUM_PARALLEL: "4"/.test(contentionCompose)) {
  findings.push("demo/ollama/compose-contention.yaml: the admission bound is pinned to OLLAMA_NUM_PARALLEL=4");
}
if (!verifyRunnerNewDemos.includes("demo/verify-local-contention.mjs")) {
  findings.push("scripts/verify.mjs: missing demo/verify-local-contention.mjs");
}

const openaiApiLib = readFileSync(path.join(ROOT, "demo/openai-api-lib.mjs"), "utf8");
for (const required of ["/v1/responses", "/v1/chat/completions", "max_output_tokens", "response.output_text.delta"]) {
  if (!openaiApiLib.includes(required)) findings.push(`demo/openai-api-lib.mjs: missing Responses compatibility contract ${required}`);
}
for (const required of ["/v1/responses", "response.output_text.delta", "response.completed", "input_tokens", "output_tokens"]) {
  if (!providerSim.includes(required)) findings.push(`sim/provider-sim.mjs: missing Responses simulator contract ${required}`);
}

const classesScript = pkg.scripts?.["demo:classes"] ?? "";
for (const required of ["demo/tenant-fairness.mjs", "--seeds=1-5", "--require-proof"]) {
  if (!classesScript.includes(required)) {
    findings.push(`package.json: demo:classes is missing ${required}`);
  }
}
const adaptiveScripts = [
  ["demo:hetero:adaptive", true],
  ["demo:hetero:adaptive:blind", false],
];
for (const [name, honorsRetryHints] of adaptiveScripts) {
  const script = pkg.scripts?.[name] ?? "";
  for (const required of [
    "--size-distribution=lognormal",
    "--capacity-profile=adaptive-headroom-28-4",
    "--control-arms=all",
    "--require-adaptive-proof",
  ]) {
    if (!script.includes(required)) findings.push(`package.json: ${name} is missing ${required}`);
  }
  const blind = script.includes("--honor-retry-hints=false");
  if (blind === honorsRetryHints) {
    findings.push(`package.json: ${name} has the wrong retry-hint mode`);
  }
}


const headroomScript = pkg.scripts?.["demo:hetero:headroom"] ?? "";
for (const required of [
  "--size-distribution=lognormal",
  "--capacity-profile=adaptive-headroom-28-4",
  "--control-arms=all",
  "--require-adaptive-proof",
]) {
  if (!headroomScript.includes(required)) findings.push(`package.json: demo:hetero:headroom is missing ${required}`);
}
const headroomCompareScript = pkg.scripts?.["demo:headroom:compare"] ?? "";
for (const required of ["demo/headroom-compare.mjs", "--seeds=1-5"]) {
  if (!headroomCompareScript.includes(required)) findings.push(`package.json: demo:headroom:compare is missing ${required}`);
}
const headroomCompareCli = readFileSync(path.join(ROOT, "demo/headroom-compare.mjs"), "utf8");
for (const required of [
  "HEADROOM_EXERCISE_INTERACTIVE_RPS = 3",
  'HEADROOM_EXERCISE_SIZE_DISTRIBUTION = "uniform"',
  "--interactive-rps=${HEADROOM_EXERCISE_INTERACTIVE_RPS}",
  "--size-distribution=${HEADROOM_EXERCISE_SIZE_DISTRIBUTION}",
  "--adaptive-proof-context=headroom-compare",
]) {
  if (!headroomCompareCli.includes(required)) {
    findings.push(`demo/headroom-compare.mjs: missing deterministic exercise workload ${required}`);
  }
}
const headroomCompareLib = readFileSync(path.join(ROOT, "demo/headroom-compare-lib.mjs"), "utf8");
for (const required of [
  "effectiveFundedDemandingLend",
  "exercisedBatchSuccessDelta",
  "bounded-headroom-capacity",
  "schemaVersion: 4",
]) {
  if (!headroomCompareLib.includes(required)) {
    findings.push(`demo/headroom-compare-lib.mjs: missing 0.25.0 capacity-aware payoff evidence ${required}`);
  }
}
const seedSweepLib025 = readFileSync(path.join(ROOT, "demo/seed-sweep-lib.mjs"), "utf8");
if (!seedSweepLib025.includes("schemaVersion: 9")) {
  findings.push("demo/seed-sweep-lib.mjs: 0.26.0 evidence requires schemaVersion 9");
}
for (const required of [
  "headroomPolicyEvidence",
  "minConcurrentHeadroom",
  "minTokenHeadroom",
  "demandingSustainMs",
  "maxDemandingConcurrentLend",
  "maxDemandingTokenLend",
  "jointlyObservedSeeds",
]) {
  if (!seedSweepLib025.includes(required)) {
    findings.push(`demo/seed-sweep-lib.mjs: missing 0.25.0 headroom policy summary evidence ${required}`);
  }
}
for (const required of ["proofContext: context", "idleOccupancyRequired", 'context !== "headroom-compare"']) {
  if (!seedSweepLib025.includes(required)) {
    findings.push(`demo/seed-sweep-lib.mjs: missing headroom-comparison adaptive proof context ${required}`);
  }
}
for (const required of [
  "rawHeadroomTransferCandidateObserved",
  "headroomTransferCorrelations",
  "headroomCandidateLendingObserved",
  "headroomEvidenceWindow",
  'demandState !== "demanding"',
  "measuredRunEndedAt",
]) {
  if (!lendingEvidence.includes(required)) {
    findings.push(`demo/lending-evidence-lib.mjs: missing correlated headroom evidence ${required}`);
  }
}
const admissionTimingLib = readFileSync(path.join(ROOT, "demo/admission-timing-lib.mjs"), "utf8");
for (const required of [
  "tyr_admission_decision_seconds_sum",
  "tyr_admission_queue_wait_seconds_sum",
  "population mismatch",
  "Redis's atomic Lua reserve round trip",
  "measureAdmissionClockOverhead",
]) {
  if (!admissionTimingLib.includes(required)) findings.push(`demo/admission-timing-lib.mjs: missing 0.26.0 timing evidence ${required}`);
}
if (!presenter023.includes("assertTyrEnforceMode") || !presenter023.includes("summarizeTyrAdmissionTiming")) {
  findings.push("demo/present.mjs: 0.27.0 must runtime-assert enforce mode and collect Tyr admission timing");
}
const queuePolicy = readFileSync(path.join(ROOT, "demo/queue-policy.mjs"), "utf8");
for (const required of [
  '"sim-interactive": Object.freeze({ maxQueuePerAgent: 1, queueTimeoutMs: 750 })',
  '"sim-batch": Object.freeze({ maxQueuePerAgent: 0 })',
  'maxQueuePerAgentForPool',
]) {
  if (!queuePolicy.includes(required)) {
    findings.push(`demo/queue-policy.mjs: missing 0.27.0 bounded interactive queue policy ${required}`);
  }
}
if (!presenter023.includes('maxQueuePerAgentForPool(partition.name)')) {
  findings.push("demo/present.mjs: managed pool configuration must apply the shared queue policy");
}
for (let replica = 1; replica <= 4; replica += 1) {
  const config = readFileSync(path.join(ROOT, `demo/moflux/tyr-r${replica}.yaml`), "utf8");
  if (!/^    queueTimeoutMs: 750$/m.test(config)) {
    findings.push(`demo/moflux/tyr-r${replica}.yaml: interactive queue timeout must be 750 ms`);
  }
}

const verifyRunner = readFileSync(path.join(ROOT, "scripts/verify.mjs"), "utf8");
for (const required of ["demo/verify-admission-provenance.mjs", "demo/verify-admission-timing.mjs", "demo/verify-headroom-compare.mjs", "demo/verify-queue-policy.mjs"]) {
  if (!verifyRunner.includes(required)) findings.push(`scripts/verify.mjs: missing ${required}`);
}


const coordinatorAdaptive = pkg.scripts?.["demo:coordinator:adaptive"] ?? "";
for (const required of [
  "--capacity-profile=adaptive-28-4",
  "--rungs=0,5,20,50",
  "--seeds=1-8",
  "--rung-order=alternating",
]) {
  if (!coordinatorAdaptive.includes(required)) {
    findings.push(`package.json: demo:coordinator:adaptive is missing ${required}`);
  }
}
if (coordinatorAdaptive.includes("--require-adaptive-proof")) {
  findings.push(
    "package.json: demo:coordinator:adaptive must not condition coordinator-latency measurement on the adaptive outcome gate",
  );
}
const coordinatorAdaptiveStrict = pkg.scripts?.["demo:coordinator:adaptive:strict"] ?? "";
if (!coordinatorAdaptiveStrict.includes("--require-adaptive-proof")) {
  findings.push("package.json: demo:coordinator:adaptive:strict must require the full adaptive proof");
}

const handoffScript = pkg.scripts?.["demo:handoff"] ?? "";
for (const required of [
  "--seeds=1-5",
  "--size-distribution=lognormal",
  "--capacity-profile=adaptive-28-4",
  "--require-adaptive-proof",
  "--provider-api=anthropic",
]) {
  if (!handoffScript.includes(required)) {
    findings.push(`package.json: demo:handoff is missing ${required}`);
  }
}
if (handoffScript.includes("--control-arms=")) {
  findings.push("package.json: demo:handoff must stay focused on baseline versus MoFlux");
}

const lendingScript = pkg.scripts?.["demo:lending"] ?? "";
for (const required of [
  "--lending",
  "--batch-concurrency-slots=4",
  "--token-budget=64000",
  "--batch-token-percent=62.5",
  "--control-arms=static-partition",
]) {
  if (!lendingScript.includes(required)) {
    findings.push(`package.json: demo:lending is missing ${required}`);
  }
}
const dashboard = readFileSync(path.join(ROOT, "demo/grafana/dashboards/moflux-bench.json"), "utf8");
for (const metric of [
  "tyr_pool_progressive_tokens_released_total",
  "tyr_pool_progressive_usage_reports_total",
  "tyr_pool_progressive_updates_total",
  "tyr_pool_progressive_coalesced_total",
]) {
  if (!dashboard.includes(metric)) findings.push(`Grafana dashboard is missing ${metric}`);
}
const presenter = readFileSync(path.join(ROOT, "demo/present.mjs"), "utf8");
if (!presenter.includes('providerApi: str("provider-api", "anthropic")') ||
    !presenter.includes('`--provider-api=${PROVIDER.api}`') ||
    !presenter.includes("progressiveEarlyReleasedTokens")) {
  findings.push("demo/present.mjs: progressive Anthropic execution or evidence recording is missing");
}
if (!presenter.includes("const defaultBatchConcurrencySlots = lendingRequested ? 4 : 1") ||
    !presenter.includes("const defaultTokenBudget = lendingRequested ? 64_000 : 40_000") ||
    !presenter.includes("const defaultBatchTokenPercent = lendingRequested ? 62.5 : 25")) {
  findings.push("demo/present.mjs: lending defaults must be a fully token-funded 28/4 policy");
}
if (!presenter.includes('requestedCapacityProfile === "adaptive-28-4"') ||
    !presenter.includes('profile: OPT.capacityProfile')) {
  findings.push("demo/present.mjs: the named adaptive-28-4 capacity profile is missing");
}
if (!presenter.includes('grantTtlMs: num("grant-ttl-ms", 120000)') ||
    !presenter.includes('const REQUIRED_INITIAL_GRANT_RUNWAY_MS = REQUIRED_GRANT_RUNWAY_MS')) {
  findings.push("demo/present.mjs: adaptive handoff must use the 120-second steady lease with phase-length runway");
}
const seedSweep = readFileSync(path.join(ROOT, "demo/seed-sweep.mjs"), "utf8");
if (!seedSweep.includes("--capacity-profile=adaptive-28-4") &&
    !seedSweep.includes("adaptive 28/4 acceptance gate failed")) {
  findings.push("demo/seed-sweep.mjs: adaptive proof enforcement is missing");
}

/**
 * Reviewed evidence must be byte-identical to what is committed.
 *
 * This is the check that would have caught a sweep writing over
 * results/video-seed-sweep.json: the JSON stayed valid and the path stayed
 * approved, so nothing else noticed. Skipped rather than failed when git is
 * unavailable — a source tarball is a legitimate way to read this repo.
 */
const reviewedPaths = REVIEWED_EVIDENCE.map((entry) =>
  entry.endsWith("/") ? entry.slice(0, -1) : entry,
);
const inRepo = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
  cwd: ROOT,
  encoding: "utf8",
});
if (inRepo.status === 0 && inRepo.stdout.trim() === "true") {
  const dirty = spawnSync("git", ["status", "--porcelain", "--", ...reviewedPaths], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const changed = (dirty.stdout ?? "")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => ({ status: line.slice(0, 2).trim(), file: line.slice(3).trim() }));
  if (changed.length > 0) {
    // Only the paths git actually reports, so the suggested command cannot
    // fail with "pathspec did not match any file(s) known to git".
    const restorable = [...new Set(changed.map(({ file }) => file))];
    findings.push(
      "reviewed evidence differs from the committed copy — a run must never write it:\n" +
        changed.map(({ status, file }) => `    ${status} ${file}`).join("\n") +
        `\n    restore with: git checkout -- ${restorable.join(" ")}` +
        "\n    (run that from the repository root: cd \"$(git rev-parse --show-toplevel)\")" +
        "\n    or, if replacing it is intended: node demo/publish-evidence.mjs --as=<name> --force",
    );
  }
} else {
  console.log("SKIP  reviewed-evidence immutability (not a git work tree)");
}

if (findings.length > 0) {
  console.error("Publication verification failed:\n");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}
console.log(`PASS  publication hygiene (${files.length} files scanned)`);
