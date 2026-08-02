/**
 * verify-drain.mjs — the load generator's end-of-run drain.
 *
 * The drain has to separate two situations that a fixed deadline cannot tell
 * apart: a request that is slow, and a request that is dead. The uncontrolled
 * arm produces the first one on every seed — a batch call finishing a
 * multi-thousand-token decode at a degraded per-stream rate is the tail the
 * benchmark exists to measure, and failing the run deletes it. A socket that
 * died holding a 200 is the second, and must still fail the run rather than
 * be written into a summary as if the request had never been issued.
 *
 * Three child scenarios, each against a purpose-built origin:
 *   1. slow but streaming  -> succeeds past the idle window
 *   2. headers then silence -> fails on --drain-idle-ms, naming the straggler
 *   3. streams forever      -> fails on --drain-max-ms
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const LOADGEN = join(HERE, "loadgen.mjs");
const failures = [];
const activeChildren = new Set();
const tempDir = mkdtempSync(join(tmpdir(), "moflux-drain-test-"));

function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures.push(label);
}

/**
 * @param {"slow"|"silent"|"endless"} behaviour
 */
async function startOrigin(behaviour) {
  const sockets = new Set();
  const timers = new Set();
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    req.resume();
    req.on("end", () => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.flushHeaders();
      // Headers are sent and nothing follows: the client cannot distinguish
      // this from a stream that is about to start, which is the point.
      if (behaviour === "silent") return;

      let frames = 0;
      const timer = setInterval(() => {
        frames += 1;
        res.write('data: {"choices":[{"delta":{"content":"tok"}}]}\n\n');
        // "slow" runs well past the idle window used below, then completes.
        if (behaviour === "slow" && frames >= 40) {
          clearInterval(timer);
          timers.delete(timer);
          res.write("data: [DONE]\n\n");
          res.end();
        }
      }, 200);
      timers.add(timer);
      res.on("close", () => {
        clearInterval(timer);
        timers.delete(timer);
      });
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
  const { port } = server.address();
  return {
    port,
    async close() {
      for (const timer of timers) clearInterval(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function runLoadgen(port, extraArgs, timeoutMs) {
  const outFile = join(tempDir, `summary-${port}.json`);
  const child = spawn(
    process.execPath,
    [
      LOADGEN,
      `--targets=http://127.0.0.1:${port}`,
      "--arm-label=drain-test",
      "--duration-ms=3000",
      "--interactive-rps=2",
      "--batch-rps=0",
      "--interactive-input-chars=64",
      "--interactive-max-tokens=64",
      "--max-attempts=1",
      "--metrics-port=0",
      `--out=${outFile}`,
      ...extraArgs,
    ],
    { stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  activeChildren.add(child);
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.resume();

  const killer = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }, timeoutMs);
  const code = await new Promise((resolve) => child.on("exit", resolve));
  clearTimeout(killer);
  activeChildren.delete(child);

  let summary = null;
  try {
    summary = JSON.parse(readFileSync(outFile, "utf8"));
  } catch {
    /* a failed run writes no summary, which is itself the assertion */
  }
  return { code, stderr, summary };
}

// ── 1. slow but streaming ────────────────────────────────────────────
{
  const origin = await startOrigin("slow");
  const started = Date.now();
  const result = await runLoadgen(origin.port, ["--drain-idle-ms=3000", "--drain-max-ms=60000"], 60000);
  const elapsedMs = Date.now() - started;
  await origin.close();

  check("a slow but progressing drain completes", result.code === 0, `exit=${result.code} ${result.stderr.slice(0, 300)}`);
  check(
    "the drain outlasted its own idle window",
    elapsedMs > 3000 + 3000,
    `run took ${elapsedMs}ms, which must exceed duration + idle window`,
  );
  check(
    "every request is recorded rather than discarded",
    result.summary !== null &&
      result.summary.classes.interactive.success === result.summary.classes.interactive.logical &&
      result.summary.classes.interactive.logical > 0,
    result.summary
      ? `${result.summary.classes.interactive.success}/${result.summary.classes.interactive.logical}`
      : "no summary written",
  );
  check(
    "the drain reports its own elapsed time and bounds",
    result.summary?.drain?.elapsedMs > 3000 &&
      result.summary?.drain?.idleMs === 3000 &&
      result.summary?.drain?.maxMs === 60000,
    JSON.stringify(result.summary?.drain),
  );
  check(
    "drain bounds are recorded in the summary config",
    result.summary?.config?.drainIdleMs === 3000 && result.summary?.config?.drainMaxMs === 60000,
    JSON.stringify({
      drainIdleMs: result.summary?.config?.drainIdleMs,
      drainMaxMs: result.summary?.config?.drainMaxMs,
    }),
  );
}

// ── 2. headers then silence ──────────────────────────────────────────
{
  const origin = await startOrigin("silent");
  const result = await runLoadgen(origin.port, ["--drain-idle-ms=2000", "--drain-max-ms=60000"], 60000);
  await origin.close();

  check("a stalled drain still fails the run", result.code !== 0, `exit=${result.code}`);
  check(
    "the failure blames the idle window, not elapsed time",
    result.stderr.includes("--drain-idle-ms"),
    result.stderr.slice(0, 300),
  );
  check(
    "the failure names a straggler and what it was doing",
    /interactive-\d+ class=interactive/.test(result.stderr) && result.stderr.includes("phase=streaming"),
    result.stderr.slice(0, 400),
  );
  check("a failed run writes no summary", result.summary === null);
}

// ── 3. streams forever ───────────────────────────────────────────────
{
  const origin = await startOrigin("endless");
  const result = await runLoadgen(origin.port, ["--drain-idle-ms=30000", "--drain-max-ms=5000"], 60000);
  await origin.close();

  check("an unbounded drain is stopped by the hard cap", result.code !== 0, `exit=${result.code}`);
  check(
    "the failure blames the hard cap",
    result.stderr.includes("--drain-max-ms"),
    result.stderr.slice(0, 300),
  );
}

for (const child of activeChildren) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}
check("all load-generator children were reaped", activeChildren.size === 0);
rmSync(tempDir, { recursive: true, force: true });

console.log();
if (failures.length > 0) {
  console.log(`${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("All checks passed.");
