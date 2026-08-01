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
        detail: { tokenBudget: { budget: 2500, available: 2500, requested: 9008 } },
      },
    });
    res.writeHead(429, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
      "x-admission-reason": "budget_limit",
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
  assert.equal(summary.classes.batch.localRejectDetails[0].availableMax, 2500);
  console.log("PASS  immutable trace replay and exact rejection diagnostics");
} finally {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  rmSync(temp, { recursive: true, force: true });
}
