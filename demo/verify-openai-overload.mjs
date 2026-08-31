#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateCompareTrace,
  OPENAI_OVERLOAD_COMPARE_DEFAULTS,
  OPENAI_OVERLOAD_DEFAULT_MAX_USD,
  OPENAI_OVERLOAD_DEFAULT_RATE_LIMIT_START_HEADROOM_RATIO,
  renderTyrOverloadConfig,
} from "./openai-overload-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "openai-overload-test-key-not-secret";
let directRequests = 0;
let mofluxRequests = 0;
let directActive = 0;

function decodeIdentityApplicationId(header) {
  assert.ok(typeof header === "string" && header.startsWith("Bearer "));
  const token = header.slice("Bearer ".length);
  const [, payload] = token.split(".");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).azp;
}

function sse(res, label, delayMs = 60) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  setTimeout(() => {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: label } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 4 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  }, delayMs);
}

const directServer = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    res.writeHead(404).end();
    return;
  }
  assert.equal(req.headers.authorization, `Bearer ${KEY}`);
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  assert.equal(body.model, "gpt-5.6-luna");
  assert.equal(body.stream, true);
  assert.equal(body.stream_options?.include_usage, true);
  directRequests += 1;
  directActive += 1;
  if (directActive > 2) {
    directActive -= 1;
    res.writeHead(429, {
      "content-type": "application/json",
      "x-ratelimit-limit-requests": "100",
      "x-ratelimit-remaining-requests": "0",
      "x-ratelimit-reset-requests": "20ms",
      "x-ratelimit-limit-tokens": "100000",
      "x-ratelimit-remaining-tokens": "99990",
      "x-ratelimit-reset-tokens": "1ms",
    });
    res.end(JSON.stringify({ error: { message: "mock overload" } }));
    return;
  }
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "x-ratelimit-limit-requests": "100",
    "x-ratelimit-remaining-requests": "99",
    "x-ratelimit-reset-requests": "1ms",
    "x-ratelimit-limit-tokens": "100000",
    "x-ratelimit-remaining-tokens": "99990",
    "x-ratelimit-reset-tokens": "1ms",
  });
  setTimeout(() => {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 4 } })}\n\n`);
    res.end("data: [DONE]\n\n");
    directActive -= 1;
  }, 80);
});

const missingHeadersServer = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    res.writeHead(404).end();
    return;
  }
  assert.equal(req.headers.authorization, `Bearer ${KEY}`);
  let raw = "";
  for await (const chunk of req) raw += chunk;
  JSON.parse(raw);
  sse(res, "ok", 5);
});

let recoveryRequests = 0;
const recoveryServer = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    res.writeHead(404).end();
    return;
  }
  assert.equal(req.headers.authorization, `Bearer ${KEY}`);
  let raw = "";
  for await (const chunk of req) raw += chunk;
  JSON.parse(raw);
  recoveryRequests += 1;
  const depleted = recoveryRequests === 1;
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "x-ratelimit-limit-requests": "100",
    "x-ratelimit-remaining-requests": depleted ? "10" : "99",
    "x-ratelimit-reset-requests": depleted ? "20ms" : "1ms",
    "x-ratelimit-limit-tokens": "100000",
    "x-ratelimit-remaining-tokens": "99990",
    "x-ratelimit-reset-tokens": "1ms",
  });
  setTimeout(() => {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 4 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  }, 5);
});

const mofluxServer = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    res.writeHead(404).end();
    return;
  }
  assert.equal(req.headers.authorization, `Bearer ${KEY}`);
  const applicationId = decodeIdentityApplicationId(req.headers["x-tyr-identity-token"]);
  assert.ok(applicationId === "interactive" || applicationId === "batch");
  let raw = "";
  for await (const chunk of req) raw += chunk;
  JSON.parse(raw);
  mofluxRequests += 1;
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "x-admission-outcome": "admitted",
    "x-admission-class": applicationId,
    "x-admission-revision": "0",
  });
  setTimeout(() => {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 18, completion_tokens: 3 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  }, 50);
});

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}/v1/chat/completions`;
}

async function run(args, env = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, "demo", "openai-overload.mjs"), ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, stdout, stderr };
}

const directUrl = await listen(directServer);
const recoveryUrl = await listen(recoveryServer);
const missingHeadersUrl = await listen(missingHeadersServer);
const mofluxUrl = await listen(mofluxServer);
const temp = mkdtempSync(path.join(os.tmpdir(), "moflux-openai-overload-verify-"));
try {
  const traceA = generateCompareTrace({
    seed: 1, durationMs: 1000, interactiveRps: 1, batchRps: 1, batchStartMs: 0,
    batchDurationMs: 1000, jitterFraction: 0.05, interactiveInputChars: 80, batchInputChars: 80,
    interactiveMaxOutputTokens: 8, batchMaxOutputTokens: 8,
  });
  const traceAReplay = generateCompareTrace({
    seed: 1, durationMs: 1000, interactiveRps: 1, batchRps: 1, batchStartMs: 0,
    batchDurationMs: 1000, jitterFraction: 0.05, interactiveInputChars: 80, batchInputChars: 80,
    interactiveMaxOutputTokens: 8, batchMaxOutputTokens: 8,
  });
  const traceB = generateCompareTrace({
    seed: 2, durationMs: 1000, interactiveRps: 1, batchRps: 1, batchStartMs: 0,
    batchDurationMs: 1000, jitterFraction: 0.05, interactiveInputChars: 80, batchInputChars: 80,
    interactiveMaxOutputTokens: 8, batchMaxOutputTokens: 8,
  });
  assert.equal(traceA.fingerprint, traceAReplay.fingerprint);
  assert.notEqual(traceA.fingerprint, traceB.fingerprint);
  assert.match(traceA.trace[0].requestId, /^s1-/);
  assert.match(traceB.trace[0].requestId, /^s2-/);

  const config = renderTyrOverloadConfig({
    modelPrefix: "gpt-5.6-luna",
    maxConcurrent: 4,
    interactiveFloor: 3,
    batchFloor: 1,
    maxOutputTokens: 32,
    jwksPort: 18113,
    issuer: "moflux-bench-openai-overload",
    audience: "moflux-bench-openai-overload",
  });
  assert.match(config, /protectedConcurrent: 3/);
  assert.match(config, /applicationIds: \[interactive\]/);
  assert.doesNotMatch(config, /OPENAI_API_KEY/);

  assert.equal(OPENAI_OVERLOAD_COMPARE_DEFAULTS.durationMs, 10_000);
  assert.equal(OPENAI_OVERLOAD_COMPARE_DEFAULTS.interactiveRps, 10);
  assert.equal(OPENAI_OVERLOAD_COMPARE_DEFAULTS.batchRps, 70);
  assert.equal(OPENAI_OVERLOAD_COMPARE_DEFAULTS.maxConcurrent, 36);
  assert.equal(OPENAI_OVERLOAD_COMPARE_DEFAULTS.interactiveFloor, 8);
  assert.equal(OPENAI_OVERLOAD_COMPARE_DEFAULTS.batchFloor, 4);
  assert.ok(
    OPENAI_OVERLOAD_COMPARE_DEFAULTS.interactiveFloor + OPENAI_OVERLOAD_COMPARE_DEFAULTS.batchFloor <
      OPENAI_OVERLOAD_COMPARE_DEFAULTS.maxConcurrent,
    "canonical protected floors must leave shared concurrency for borrowing",
  );
  assert.equal(OPENAI_OVERLOAD_DEFAULT_MAX_USD, 0.18);
  assert.equal(OPENAI_OVERLOAD_DEFAULT_RATE_LIMIT_START_HEADROOM_RATIO, 0.99);

  const defaultDryRun = await run(["--mode=compare", "--dry-run"]);
  assert.equal(defaultDryRun.code, 0, `${defaultDryRun.stdout}\n${defaultDryRun.stderr}`);
  assert.match(defaultDryRun.stdout, /1998/);
  assert.match(defaultDryRun.stdout, /1980/);
  assert.match(defaultDryRun.stdout, /0\.16832/);
  assert.match(defaultDryRun.stdout, /0\.18/);
  assert.doesNotMatch(
    defaultDryRun.stdout + defaultDryRun.stderr,
    /protected floors consume all configured concurrency/,
  );

  const fullyReservedDryRun = await run([
    "--mode=compare",
    "--dry-run",
    "--duration-ms=1000",
    "--interactive-rps=1",
    "--batch-rps=1",
    "--batch-start-ms=0",
    "--batch-duration-ms=1000",
    "--interactive-input-chars=64",
    "--batch-input-chars=64",
    "--interactive-max-output-tokens=8",
    "--batch-max-output-tokens=8",
    "--static-cap=2",
    "--moflux-max-concurrent=2",
    "--interactive-floor=1",
    "--batch-floor=1",
  ]);
  assert.equal(fullyReservedDryRun.code, 0, `${fullyReservedDryRun.stdout}\n${fullyReservedDryRun.stderr}`);
  assert.match(
    fullyReservedDryRun.stdout + fullyReservedDryRun.stderr,
    /protected floors consume all configured concurrency; no shared slots remain/,
  );

  const compareOut = path.join(temp, "compare.json");
  const compare = await run([
    "--mode=compare",
    "--manage-stack=false",
    "--arms=direct,static,moflux",
    "--runs=1",
    "--duration-ms=1000",
    "--interactive-rps=2",
    "--batch-rps=2",
    "--batch-start-ms=0",
    "--batch-duration-ms=1000",
    "--jitter-fraction=0",
    "--interactive-input-chars=80",
    "--batch-input-chars=80",
    "--interactive-max-output-tokens=8",
    "--batch-max-output-tokens=8",
    "--static-cap=1",
    "--moflux-max-concurrent=1",
    "--interactive-floor=1",
    "--batch-floor=0",
    "--arm-cooldown-ms=0",
    "--max-usd=0.10",
    `--direct-url=${directUrl}`,
    `--moflux-url=${mofluxUrl}`,
    `--out=${compareOut}`,
  ], { OPENAI_API_KEY: KEY });
  assert.equal(compare.code, 0, `${compare.stdout}\n${compare.stderr}`);
  assert.equal(compare.stdout.includes(KEY), false, "API key leaked to stdout");
  assert.equal(compare.stderr.includes(KEY), false, "API key leaked to stderr");
  const compareSummary = JSON.parse(readFileSync(compareOut, "utf8"));
  assert.equal(compareSummary.acceptance.executionCompleted, true);
  assert.equal(compareSummary.acceptance.matchedTraceByRun, true);
  assert.equal(compareSummary.acceptance.mofluxAdmissionClassProof, true);
  assert.equal(compareSummary.acceptance.rateLimitIsolationPassed, true);
  assert.equal(compareSummary.rateLimitIsolation.gates.length, 3);
  assert.ok(compareSummary.rateLimitIsolation.gates.every((gate) => gate.startHeadroom.requests.ratio >= 0.95));
  assert.ok(compareSummary.rateLimitIsolation.gates.every((gate) => gate.startHeadroom.tokens.ratio >= 0.95));
  assert.ok(compareSummary.aggregate.static.localRejects > 0, "static cap should reject overlapping arrivals");
  assert.equal(compareSummary.aggregate.moflux.classes.interactive.offered, 2);
  assert.equal(compareSummary.policies.moflux.admissionClasses.interactive.protectedConcurrent, 1);
  assert.ok(mofluxRequests > 0);

  const calibrationOut = path.join(temp, "calibration.json");
  const calibration = await run([
    "--mode=calibrate",
    "--calibration-rps-steps=10,50",
    "--calibration-stage-ms=500",
    "--calibration-baseline-requests=6",
    "--calibration-baseline-rps=10",
    "--calibration-input-chars=80",
    "--calibration-max-output-tokens=8",
    "--latency-factor=20",
    "--calibration-min-throughput-ratio=0.1",
    "--max-usd=0.10",
    `--direct-url=${directUrl}`,
    `--out=${calibrationOut}`,
  ], { OPENAI_API_KEY: KEY });
  assert.equal(calibration.code, 0, `${calibration.stdout}\n${calibration.stderr}`);
  const calibrationSummary = JSON.parse(readFileSync(calibrationOut, "utf8"));
  assert.equal(calibrationSummary.calibration.strategy, "sustained");
  assert.equal(calibrationSummary.calibration.baseline.offered, 6);
  assert.equal(calibrationSummary.calibration.rateLimitIsolation.passed, true);
  assert.ok(calibrationSummary.calibration.rateLimitIsolation.gates.length >= 2);
  assert.equal(calibrationSummary.calibration.pressureDetected, true);
  assert.equal(calibrationSummary.calibration.pressureStepRps, 50);
  assert.ok(calibrationSummary.calibration.results.at(-1).provider429s > 0);

  const drainTailOut = path.join(temp, "calibration-drain-tail.json");
  const drainTailCalibration = await run([
    "--mode=calibrate",
    "--calibration-rps-steps=20",
    "--calibration-stage-ms=500",
    "--calibration-baseline-requests=6",
    "--calibration-baseline-rps=10",
    "--calibration-input-chars=80",
    "--calibration-max-output-tokens=8",
    "--latency-factor=20",
    "--calibration-min-throughput-ratio=0.99",
    "--calibration-rate-limit-headroom-ratio=0",
    "--max-usd=0.10",
    `--direct-url=${directUrl}`,
    `--out=${drainTailOut}`,
  ], { OPENAI_API_KEY: KEY });
  assert.equal(drainTailCalibration.code, 0, `${drainTailCalibration.stdout}\n${drainTailCalibration.stderr}`);
  const drainTailSummary = JSON.parse(readFileSync(drainTailOut, "utf8"));
  assert.equal(drainTailSummary.calibration.pressureDetected, false,
    "drain-inclusive goodput must not independently declare provider pressure");
  assert.ok(
    drainTailSummary.calibration.results[0].throughputDiagnosticWarnings.includes(
      "drain_inclusive_goodput_below_threshold",
    ),
    "low drain-inclusive goodput should remain visible as a diagnostic",
  );

  const recoveryOut = path.join(temp, "calibration-recovery.json");
  const recoveryCalibration = await run([
    "--mode=calibrate",
    "--calibration-rps-steps=1",
    "--calibration-stage-ms=500",
    "--calibration-baseline-requests=5",
    "--calibration-baseline-rps=10",
    "--calibration-input-chars=80",
    "--calibration-max-output-tokens=8",
    "--latency-factor=20",
    "--calibration-rate-limit-headroom-ratio=0",
    "--rate-limit-recovery-timeout-ms=1000",
    "--rate-limit-recovery-max-probes=3",
    "--max-usd=0.10",
    `--direct-url=${recoveryUrl}`,
    `--out=${recoveryOut}`,
  ], { OPENAI_API_KEY: KEY });
  assert.equal(recoveryCalibration.code, 0, `${recoveryCalibration.stdout}\n${recoveryCalibration.stderr}`);
  const recoverySummary = JSON.parse(readFileSync(recoveryOut, "utf8"));
  assert.equal(recoverySummary.calibration.rateLimitIsolation.passed, true);
  assert.equal(recoverySummary.calibration.baseline.recoveryProbes, 2,
    "depleted starting headroom should force a wait and second probe");
  assert.equal(recoverySummary.calibration.rateLimitIsolation.gates[0].observations[0].requests.ratio, 0.1);
  assert.ok(recoverySummary.calibration.baseline.startHeadroom.requests.ratio >= 0.95);

  const legacyCalibration = await run([
    "--mode=calibrate",
    "--dry-run",
    "--calibration-steps=1,2",
    "--calibration-requests-per-worker=1",
    "--calibration-input-chars=80",
    "--calibration-max-output-tokens=8",
    "--max-usd=0.10",
  ]);
  assert.equal(legacyCalibration.code, 0, `${legacyCalibration.stdout}\n${legacyCalibration.stderr}`);
  assert.match(legacyCalibration.stdout, /legacy burst calibration spend guard/);

  const isolationFailureOut = path.join(temp, "compare-isolation-failure.json");
  const isolationFailure = await run([
    "--mode=compare",
    "--manage-stack=false",
    "--arms=direct",
    "--runs=1",
    "--duration-ms=1000",
    "--interactive-rps=1",
    "--batch-rps=0",
    "--batch-start-ms=0",
    "--batch-duration-ms=1000",
    "--interactive-input-chars=80",
    "--batch-input-chars=80",
    "--interactive-max-output-tokens=8",
    "--batch-max-output-tokens=8",
    "--rate-limit-recovery-max-probes=1",
    "--max-usd=0.10",
    `--direct-url=${missingHeadersUrl}`,
    `--out=${isolationFailureOut}`,
  ], { OPENAI_API_KEY: KEY });
  assert.notEqual(isolationFailure.code, 0, "comparison must fail when start headroom cannot be proven");
  const isolationFailureSummary = JSON.parse(readFileSync(isolationFailureOut, "utf8"));
  assert.equal(isolationFailureSummary.rateLimitIsolation.passed, false);
  assert.equal(isolationFailureSummary.acceptance.rateLimitIsolationPassed, false);
  assert.equal(isolationFailureSummary.interpretation.conclusiveProviderOverloadComparison, false);
  assert.ok(isolationFailureSummary.interpretation.inconclusiveReasons.some((reason) => reason.includes("rate-limit headroom")));

  const before = directRequests + mofluxRequests;
  const guard = await run([
    "--mode=compare",
    "--dry-run",
    "--duration-ms=10000",
    "--interactive-rps=2",
    "--batch-rps=6",
    "--max-usd=0.000001",
  ]);
  assert.notEqual(guard.code, 0, "oversized cost plan should be refused");
  assert.match(guard.stdout + guard.stderr, /Refusing to run/);
  assert.equal(directRequests + mofluxRequests, before, "spend guard must fail before any API request");

  console.log("PASS OpenAI overload harness: canonical shared-capacity defaults, full-floor warning, matched trace, static contention, class proof, per-stage/per-arm rate-limit start isolation with depleted-bucket recovery, sustained calibration pressure, drain-tail false-positive protection, legacy calibration compatibility, secret hygiene, and spend guard");
} finally {
  await Promise.all([
    new Promise((resolve) => directServer.close(resolve)),
    new Promise((resolve) => recoveryServer.close(resolve)),
    new Promise((resolve) => missingHeadersServer.close(resolve)),
    new Promise((resolve) => mofluxServer.close(resolve)),
  ]);
  rmSync(temp, { recursive: true, force: true });
}
