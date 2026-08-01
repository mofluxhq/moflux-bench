/**
 * verify-retry-hints.mjs — retry-hint policy and load-generator integration.
 *
 * Pure checks cover all supported header forms. Two compact child-process
 * scenarios prove that the load generator wires the policy into the CLI while
 * replaying an identical immutable trace. Child processes are isolated in
 * their own process groups and forcibly reaped on timeout or interruption.
 */
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  blindBackoffMs,
  chooseRetryDelay,
  retryHintMs,
} from "./retry-policy.mjs";
import { traceHash } from "./trace-lib.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const LOADGEN = join(HERE, "loadgen.mjs");
const failures = [];
const activeChildren = new Set();
const TRACE_WORKLOAD = Object.freeze({
  durationMs: 1500,
  seed: 3,
  interactiveRps: 1,
  interactiveInputChars: 1200,
  interactiveMaxTokens: 400,
  batchStartMs: 1000,
  batchDurationMs: 0,
  batchRps: 0,
  batchInputChars: 40000,
  batchMaxTokens: 4000,
  maxAttempts: 2,
  backoffBaseMs: 20,
});
const TRACE = (() => {
  const trace = {
    version: 1,
    workload: TRACE_WORKLOAD,
    planned: { interactive: 1, batch: 0, total: 1 },
    entries: [{
      id: "interactive-1",
      class: "interactive",
      arrivalMs: 25,
      retryJitter: [1, 1],
      targetSlots: [1, 1],
      providerSeeds: [1, 2],
    }],
  };
  return { ...trace, hash: traceHash(trace) };
})();

function check(name, condition, detail = "") {
  if (condition) console.log(`PASS  ${name}`);
  else {
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
}

function response(headers = {}) {
  return { headers: new Headers(headers) };
}

function killTree(child, signal = "SIGTERM") {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    return;
  }
  try { process.kill(-child.pid, signal); }
  catch { try { child.kill(signal); } catch { /* already gone */ } }
}

async function stopChildren() {
  for (const child of activeChildren) killTree(child, "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 100));
  for (const child of activeChildren) killTree(child, "SIGKILL");
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, async () => {
    await stopChildren();
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

function startMock(hintMs) {
  const seen = new Map();
  const sockets = new Set();
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const id = req.headers["x-bench-request-id"] ?? "missing-id";
      const n = (seen.get(id) ?? 0) + 1;
      seen.set(id, n);
      if (n === 1) {
        res.writeHead(429, {
          "content-type": "application/json",
          connection: "close",
          "x-admission-reason": "concurrency_limit",
          "x-admission-retry-after-ms": String(hintMs),
        });
        res.end(JSON.stringify({
          error: { type: "admission_rejected", reason: "concurrency_limit", pool: "p" },
        }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      res.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "hello" } }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { completion_tokens: 8 } })}\n\n` +
        "data: [DONE]\n\n",
      );
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({
      server,
      sockets,
      port: server.address().port,
    }));
  });
}

async function closeMock(server, sockets) {
  for (const socket of sockets) socket.destroy();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  if (!server.listening) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 1000);
    timer.unref?.();
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function runLoadgen(port, outPath, tracePath, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      LOADGEN,
      `--targets=http://127.0.0.1:${port}`,
      `--duration-ms=${TRACE_WORKLOAD.durationMs}`,
      `--interactive-rps=${TRACE_WORKLOAD.interactiveRps}`,
      `--interactive-input-chars=${TRACE_WORKLOAD.interactiveInputChars}`,
      `--interactive-max-tokens=${TRACE_WORKLOAD.interactiveMaxTokens}`,
      `--batch-start-ms=${TRACE_WORKLOAD.batchStartMs}`,
      `--batch-rps=${TRACE_WORKLOAD.batchRps}`,
      `--batch-duration-ms=${TRACE_WORKLOAD.batchDurationMs}`,
      `--batch-input-chars=${TRACE_WORKLOAD.batchInputChars}`,
      `--batch-max-tokens=${TRACE_WORKLOAD.batchMaxTokens}`,
      `--max-attempts=${TRACE_WORKLOAD.maxAttempts}`,
      `--backoff-base-ms=${TRACE_WORKLOAD.backoffBaseMs}`,
      `--seed=${TRACE_WORKLOAD.seed}`,
      "--metrics-port=0",
      `--trace-file=${tracePath}`,
      `--out=${outPath}`,
      ...extraArgs,
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    activeChildren.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, "SIGTERM");
      setTimeout(() => killTree(child, "SIGKILL"), 500).unref?.();
    }, 10_000);
    timer.unref?.();
    child.once("error", (error) => {
      activeChildren.delete(child);
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      activeChildren.delete(child);
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`loadgen timed out\n${stderr || stdout}`));
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(`loadgen exited ${code ?? signal}\n${stderr || stdout}`));
      }
    });
  });
}

async function scenario(honorRetryHints) {
  const { server, sockets, port } = await startMock(900);
  const dir = mkdtempSync(join(tmpdir(), "moflux-hint-"));
  const out = join(dir, "result.json");
  const trace = join(dir, "trace.json");
  writeFileSync(trace, JSON.stringify(TRACE));
  try {
    await runLoadgen(port, out, trace, [`--honor-retry-hints=${honorRetryHints}`]);
    return JSON.parse(readFileSync(out, "utf8"));
  } finally {
    await closeMock(server, sockets);
    rmSync(dir, { recursive: true, force: true });
  }
}

// Pure policy checks: these execute the exact functions imported by loadgen.
check("millisecond hint is preferred", retryHintMs(response({
  "x-admission-retry-after-ms": "900",
  "retry-after": "2",
})) === 900);
check("Retry-After seconds are scaled", retryHintMs(response({ "retry-after": "2" })) === 2000);
check("absent headers are not a zero hint", retryHintMs(response()) === null);
check("HTTP-date Retry-After is ignored", retryHintMs(response({
  "retry-after": new Date(Date.now() + 60_000).toUTCString(),
})) === null);
const hinted = chooseRetryDelay({
  response: response({ "x-admission-retry-after-ms": "900" }),
  honorRetryHints: true,
  baseMs: 20,
  attempt: 0,
  jitter: 1,
});
check("hint is a floor", hinted.kind === "hinted" && hinted.waitMs >= 900);
const ignored = chooseRetryDelay({
  response: response({ "x-admission-retry-after-ms": "900" }),
  honorRetryHints: false,
  baseMs: 20,
  attempt: 0,
  jitter: 1,
});
check("disabled hints use blind backoff", ignored.kind === "blind" && ignored.waitMs === blindBackoffMs(20, 0, 1));

// Compact CLI integration: one enabled run and one exact-trace disabled run.
const enabledResult = await scenario(true);
const disabledResult = await scenario(false);
{
  const h = enabledResult.classes.interactive.retryHints;
  check("loadgen receives and applies Tyr-style hint", h.received === 1 && h.applied === 1);
  check("loadgen records hinted wait", h.hintedSleepMs >= 900 && h.blindSleepMs === 0);
}
{
  const h = disabledResult.classes.interactive.retryHints;
  check("CLI switch disables hint handling", h.received === 0 && h.hintedSleepMs === 0 && h.blindSleepMs > 0);
  check("CLI setting is recorded", disabledResult.config.honorRetryHints === false);
}
check(
  "hint policy does not perturb the request trace",
  enabledResult.trace.hash === disabledResult.trace.hash && enabledResult.trace.hash === TRACE.hash,
  `${enabledResult.trace.hash?.slice(0, 12)} vs ${disabledResult.trace.hash?.slice(0, 12)}`,
);

await stopChildren();
check("all load-generator children were reaped", activeChildren.size === 0);
console.log();
if (failures.length > 0) {
  console.log(`${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("All checks passed.");
