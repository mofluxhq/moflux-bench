#!/usr/bin/env node
/**
 * Regression: Tyr's bounded admission queue reports an expired wait as HTTP
 * 504 + x-admission-reason: timeout. That response is an attributable local
 * admission decision, not a harness/server fault. An unmarked 504 must remain
 * a serverError so unrelated gateway/provider failures are never hidden.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { traceHash } from "./trace-lib.mjs";
import { armHealth } from "../demo/arm-health-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOADGEN = path.join(ROOT, "load", "loadgen.mjs");
const WORKLOAD = Object.freeze({
  durationMs: 500,
  seed: 17,
  interactiveRps: 1,
  interactiveInputChars: 1200,
  interactiveMaxTokens: 400,
  batchStartMs: 1000,
  batchDurationMs: 0,
  batchRps: 0,
  batchInputChars: 24000,
  batchMaxTokens: 3000,
  maxAttempts: 1,
  backoffBaseMs: 20,
});
const TRACE = (() => {
  const trace = {
    version: 1,
    workload: WORKLOAD,
    planned: { interactive: 1, batch: 0, total: 1 },
    entries: [{
      id: "interactive-1",
      class: "interactive",
      arrivalMs: 25,
      retryJitter: [1],
      targetSlots: [0],
      providerSeeds: [1],
    }],
  };
  return { ...trace, hash: traceHash(trace) };
})();

async function runScenario({ localTimeout }) {
  const sockets = new Set();
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const headers = {
        "content-type": "application/json",
        connection: "close",
        ...(localTimeout
          ? {
              "x-admission-reason": "timeout",
              "x-admission-revision": "7",
              "x-admission-retry-after-ms": "750",
              "x-admission-class": "interactive",
            }
          : {}),
      };
      res.writeHead(504, headers);
      res.end(JSON.stringify(localTimeout
        ? {
            error: {
              type: "admission_rejected",
              reason: "timeout",
              pool: "sim-interactive",
              detail: { limitRevision: 7 },
            },
          }
        : { error: { type: "gateway_timeout" } }));
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const dir = mkdtempSync(path.join(tmpdir(), "moflux-admission-timeout-"));
  const out = path.join(dir, "summary.json");
  const trace = path.join(dir, "trace.json");
  writeFileSync(trace, JSON.stringify(TRACE));

  try {
    const args = [
      LOADGEN,
      `--targets=http://127.0.0.1:${address.port}`,
      `--duration-ms=${WORKLOAD.durationMs}`,
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
      `--seed=${WORKLOAD.seed}`,
      "--metrics-port=0",
      `--trace-file=${trace}`,
      `--out=${out}`,
    ];
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(code, 0, `loadgen failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    return JSON.parse(readFileSync(out, "utf8"));
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
}

const attributed = await runScenario({ localTimeout: true });
const interactive = attributed.classes.interactive;
assert.equal(interactive.attempts, 1);
assert.equal(interactive.localReject, 1);
assert.equal(interactive.localRejectReasons.timeout, 1);
assert.equal(interactive.serverError, 0);
assert.equal(interactive.transportError, 0);
assert.equal(interactive.localRejectSnapshots.length, 1);
assert.equal(interactive.localRejectSnapshots[0].reason, "timeout");
assert.equal(interactive.localRejectSnapshots[0].type, "admission_rejected");
assert.equal(interactive.localRejectSnapshots[0].pool, "sim-interactive");
assert.equal(interactive.localRejectSnapshots[0].retryAfterMs, 750);
assert.equal(armHealth(attributed).ok, true, "attributable queue timeout must not trip arm-health");

const unattributed = await runScenario({ localTimeout: false });
const unmarked = unattributed.classes.interactive;
assert.equal(unmarked.attempts, 1);
assert.equal(unmarked.localReject, 0);
assert.equal(unmarked.serverError, 1);
assert.equal(unmarked.transportError, 0);
assert.equal(unmarked.localRejectSnapshots.length, 0);
assert.equal(armHealth(unattributed).ok, false, "unmarked 504 must still trip arm-health");

console.log("PASS  bounded queue 504 is local admission; unmarked 504 remains a harness/server fault");
