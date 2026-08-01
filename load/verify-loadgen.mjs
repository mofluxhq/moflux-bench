/**
 * Regression test: an application replica can disappear after fetch() has
 * returned response headers but before its SSE body finishes. The load
 * generator must count that as a retryable transport error and keep running.
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = mkdtempSync(path.join(tmpdir(), "moflux-loadgen-test-"));
const outFile = path.join(tempDir, "summary.json");
const sockets = new Set();
const timers = new Set();

const server = createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    res.writeHead(404).end();
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.flushHeaders();

  const timer = setInterval(() => {
    res.write('data: {"choices":[{"delta":{"content":"token"}}]}\n\n');
  }, 50);
  timers.add(timer);
  res.on("close", () => {
    clearInterval(timer);
    timers.delete(timer);
  });
});
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("test server did not bind to TCP");

let stdout = "";
let stderr = "";
const child = spawn(
  process.execPath,
  [
    path.join(ROOT, "load/loadgen.mjs"),
    `--targets=http://127.0.0.1:${address.port}`,
    "--arm-label=stream-drop-regression",
    "--duration-ms=1200",
    "--interactive-rps=8",
    "--interactive-max-tokens=4000",
    "--batch-start-ms=5000",
    "--max-attempts=2",
    "--backoff-base-ms=20",
    "--metrics-port=0",
    `--out=${outFile}`,
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
const exitPromise = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => resolve(code));
});

// Allow several requests to receive headers and begin consuming SSE, then
// emulate SIGKILL by dropping every active socket without a clean response end.
await new Promise((resolve) => setTimeout(resolve, 500));
for (const socket of sockets) socket.destroy();
await new Promise((resolve) => server.close(resolve));
for (const timer of timers) clearInterval(timer);

const exitCode = await exitPromise;

try {
  if (exitCode !== 0) {
    throw new Error(`load generator exited ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  const summary = JSON.parse(readFileSync(outFile, "utf8"));
  if (summary.config?.out !== "requested") {
    throw new Error(`result serialized its local output path: ${summary.config?.out ?? "missing"}`);
  }
  if (JSON.stringify(summary).includes(tempDir)) {
    throw new Error("result contains the caller's temporary directory");
  }
  const interactive = summary.classes?.interactive;
  if (!interactive || interactive.transportError < 1) {
    throw new Error(`expected at least one transport error, got ${interactive?.transportError ?? "missing"}`);
  }
  if (stderr.includes("TypeError: terminated") || stderr.includes("UND_ERR_SOCKET")) {
    throw new Error(`stream termination escaped the retry path:\n${stderr}`);
  }
  console.log("PASS  load generator survives an in-flight stream termination");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
