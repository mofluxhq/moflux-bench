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
  ".gitignore",
  ".github/workflows/ci.yml",
  "demo/moflux/.env.example",
  "demo/classes/compose.yaml",
  "demo/classes/tyr-r1.yaml",
  "demo/TENANT-FAIRNESS.md",
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
    if (rel === "demo/classes/runtime") continue;
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
  "MOFLUX_TYR_IMAGE=tyr-admission-controller:0.25.1",
  "MOFLUX_LATCHFLO_IMAGE=latchflo-control-plane:0.11.4",
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
  if (!/^    version: 0\.25\.1$/m.test(yaml)) {
    findings.push(`${rel}: control-plane metadata must identify Tyr 0.25.1`);
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
  for (let peer = 1; peer <= 4; peer += 1) {
    const peerLine = new RegExp(`^      - id: tyr-r${peer}$`, "m");
    if (peer === replica && peerLine.test(yaml)) findings.push(`${rel}: routing peer list includes itself`);
    if (peer !== replica && !peerLine.test(yaml)) findings.push(`${rel}: routing peer tyr-r${peer} is missing`);
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
    "pools: [sim-shared, sim-ceilings, sim-protected, sim-adaptive]",
    "version: 0.25.1",
  ]) {
    if (!yaml.includes(required)) findings.push(`${rel}: missing ${required}`);
  }
  const progressiveBlock = "    progressiveReconciliation:\n      enabled: true\n      updateStepTokens: 256\n      outputSafetyMarginTokens: 256";
  const progressiveBlocks = yaml.split(progressiveBlock).length - 1;
  if (progressiveBlocks !== 4) {
    findings.push(`${rel}: all four tenant-fairness pools must enable progressive reconciliation`);
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

if (pkg.scripts?.demo !== "node demo/seed-sweep.mjs --seeds=1-5 --pause-ms=0 --provider-api=anthropic" ||
    pkg.scripts?.predemo !== "npm run demo:prepare" ||
    pkg.scripts?.["demo:record"] !== "node demo/seed-sweep.mjs --seeds=1-5 --step") {
  findings.push("package.json: npm run demo must remain automatic and demo:record must retain the step-through path");
}
if (!pkg.scripts?.verify?.includes("scripts/verify.mjs")) {
  findings.push("package.json: verify must use the bounded verification runner");
}
if (!pkg.scripts?.["demo:progressive"]?.includes("--provider-api=anthropic") ||
    !pkg.scripts?.["demo:openai"]?.includes("--provider-api=openai")) {
  findings.push("package.json: progressive and OpenAI compatibility demo commands are required");
}
if (pkg.version !== "0.20.0") {
  findings.push("package.json: the current benchmark release must be version 0.20.0");
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
    "--capacity-profile=adaptive-28-4",
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
