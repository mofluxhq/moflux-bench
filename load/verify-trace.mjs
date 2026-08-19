import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTrace } from "./trace-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(path.join(tmpdir(), "moflux-trace-"));
const traceFile = path.join(temp, "trace.json");
const outFile = path.join(temp, "summary.json");
const config = {
  durationMs: 1200,
  seed: 17,
  interactiveRps: 8,
  interactiveInputChars: 1200,
  interactiveMaxTokens: 400,
  batchStartMs: 250,
  batchDurationMs: 700,
  batchRps: 5,
  batchInputChars: 24000,
  batchMaxTokens: 3000,
  maxAttempts: 1,
  backoffBaseMs: 10,
};
const trace = buildTrace(config);
assert.equal(buildTrace(config).hash, trace.hash);
assert.ok(trace.planned.interactive > 0);
assert.ok(trace.planned.batch > 0);
writeFileSync(traceFile, JSON.stringify(trace));

const rejectionDetail = {
  limitRevision: 17,
  constraint: "admission_class_protection",
  inFlight: 4,
  maxConcurrent: 8,
  pending: 0,
  maxQueue: 0,
  tokenBudget: {
    budget: 2500,
    inFlightTokens: 2500,
    effectiveBudget: 2500,
    available: 0,
    requested: 9008,
  },
  sharedCapacity: {
    concurrency: { capacity: 4, inUse: 4, available: 0, requestedBorrowed: 1 },
    tokenBudget: { capacity: 1000, inUse: 1000, available: 0, requestedBorrowed: 6508 },
  },
  admissionClass: {
    id: "batch",
    inFlight: 1,
    protectedConcurrent: 1,
    protectedConcurrentInUse: 1,
    borrowedConcurrent: 0,
    availableProtectedConcurrent: 0,
    maxConcurrent: 4,
    availableConcurrent: 3,
    tokenBudget: {
      inFlightTokens: 2500,
      protectedInFlightTokens: 2500,
      protectedTokensInUse: 2500,
      borrowedInFlightTokens: 0,
      availableProtectedTokens: 0,
      maxInFlightTokens: 10000,
      available: 7500,
      requested: 9008,
    },
  },
};

const server = createServer(async (req, res) => {
  if (req.url !== "/v1/chat/completions") return res.writeHead(404).end();
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (String(body.model).includes("batch")) {
    const payload = JSON.stringify({
      error: {
        type: "admission_rejected",
        reason: "budget_limit",
        pool: "sim-batch",
        detail: rejectionDetail,
      },
    });
    res.writeHead(429, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
      "x-admission-reason": "budget_limit",
      "x-admission-class": "batch",
      "x-admission-revision": "17",
      "x-admission-retry-after-ms": "1250",
      "x-latchflo-grant-id": "grant-17",
      "x-latchflo-controller-epoch": "3",
    });
    return res.end(payload);
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(
    'data: {"choices":[{"delta":{"content":"token"}}]}\n\n' +
      'data: {"choices":[{"delta":{}}],"usage":{"completion_tokens":1}}\n\n' +
      "data: [DONE]\n\n",
  );
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("server did not bind");

try {
  const args = [
    path.join(ROOT, "load/loadgen.mjs"),
    `--targets=http://127.0.0.1:${address.port}`,
    `--trace-file=${traceFile}`,
    `--out=${outFile}`,
    "--metrics-port=0",
    "--arm-label=trace-regression",
    ...Object.entries(config).map(([key, value]) =>
      `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}=${value}`,
    ),
  ];
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
  if (result.code !== 0) throw new Error(`loadgen failed\n${result.stdout}\n${result.stderr}`);
  const summary = JSON.parse(readFileSync(outFile, "utf8"));
  assert.equal(summary.trace.hash, trace.hash);
  assert.equal(summary.classes.interactive.logical, trace.planned.interactive);
  assert.equal(summary.classes.batch.logical, trace.planned.batch);
  assert.equal(summary.classes.batch.localRejectReasons.budget_limit, trace.planned.batch);
  assert.equal(summary.classes.batch.localRejectDetails[0].requestedMin, 9008);
  assert.equal(summary.classes.batch.localRejectDetails[0].availableMax, 0);
  assert.equal(
    summary.classes.batch.localRejectConstraints.admission_class_protection,
    trace.planned.batch,
  );
  assert.equal(summary.classes.batch.localRejectSnapshots.length, trace.planned.batch);
  const snapshot = summary.classes.batch.localRejectSnapshots[0];
  assert.equal(snapshot.requestClass, "batch");
  assert.equal(snapshot.attempt, 1);
  assert.match(snapshot.requestId, /^batch-/);
  assert.equal(snapshot.type, "admission_rejected");
  assert.equal(snapshot.pool, "sim-batch");
  assert.equal(snapshot.reason, "budget_limit");
  assert.equal(snapshot.admissionClass, "batch");
  assert.equal(snapshot.admissionRevision, 17);
  assert.equal(snapshot.retryAfterMs, 1250);
  assert.deepEqual(snapshot.grant, { id: "grant-17", controllerEpoch: 3 });
  assert.deepEqual(snapshot.detail, rejectionDetail);
  assert.match(snapshot.target, /^http:\/\/127\.0\.0\.1:/);
  assert.ok(Number.isFinite(snapshot.rejectedAtMs));
  console.log("PASS  immutable trace replay and full local-rejection snapshots");
} finally {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  rmSync(temp, { recursive: true, force: true });
}
