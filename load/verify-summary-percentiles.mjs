/**
 * verify-summary-percentiles.mjs — class percentiles cover the whole run.
 *
 * The rolling `samples` array backs the Prometheus gauges and is trimmed to
 * `--window-ms` on every scrape. Until the summary took its percentiles from
 * the unpruned record, a scrape late in a run silently dropped everything
 * before it: a 45 s sweep reported the p95 of its last 30 s and read as a
 * whole-run tail.
 *
 * The replayed trace sends four slow requests first and four fast ones last,
 * and the test scrapes /metrics after the slow ones have aged out of a 200 ms
 * window. A whole-run p95 must still be a slow request. Run once with
 * `--emit-phase-samples=true`, to check the percentiles against the samples,
 * and once without, because the flag only controls output.
 */
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { traceHash } from "./trace-lib.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const LOADGEN = join(HERE, "loadgen.mjs");
const failures = [];
const activeChildren = new Set();
const SLOW_MS = 400;
const WINDOW_MS = 200;
const WORKLOAD = Object.freeze({
  durationMs: 1200,
  seed: 5,
  interactiveRps: 1,
  interactiveInputChars: 1200,
  interactiveMaxTokens: 400,
  batchStartMs: 1100,
  batchDurationMs: 0,
  batchRps: 0,
  batchInputChars: 40000,
  batchMaxTokens: 4000,
  maxAttempts: 1,
  backoffBaseMs: 20,
});
const SLOW_IDS = new Set(["interactive-1", "interactive-2", "interactive-3", "interactive-4"]);
const TRACE = (() => {
  const arrivals = [20, 40, 60, 80, 900, 920, 940, 960];
  const trace = {
    version: 1,
    workload: WORKLOAD,
    planned: { interactive: arrivals.length, batch: 0, total: arrivals.length },
    entries: arrivals.map((arrivalMs, index) => ({
      id: `interactive-${index + 1}`,
      class: "interactive",
      arrivalMs,
      retryJitter: [1],
      targetSlots: [1],
      providerSeeds: [index + 1],
    })),
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

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Holds each slow request for SLOW_MS before its first byte; answers the rest at once. */
function startOrigin(onSlowDone) {
  const sockets = new Set();
  let slowDone = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const slow = SLOW_IDS.has(req.headers["x-bench-request-id"]);
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
        res.end(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "hello" } }] })}\n\n` +
          `data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { completion_tokens: 8 } })}\n\n` +
          "data: [DONE]\n\n",
        );
        if (slow && ++slowDone === SLOW_IDS.size) onSlowDone();
      }, slow ? SLOW_MS : 0);
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return { server, sockets };
}

async function closeOrigin(server, sockets) {
  for (const socket of sockets) socket.destroy();
  server.closeAllConnections?.();
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

function runLoadgen(targetPort, metricsPort, outPath, tracePath, extraArgs) {
  const child = spawn(process.execPath, [
    LOADGEN,
    `--targets=http://127.0.0.1:${targetPort}`,
    `--duration-ms=${WORKLOAD.durationMs}`,
    `--interactive-rps=${WORKLOAD.interactiveRps}`,
    `--interactive-input-chars=${WORKLOAD.interactiveInputChars}`,
    `--interactive-max-tokens=${WORKLOAD.interactiveMaxTokens}`,
    `--batch-start-ms=${WORKLOAD.batchStartMs}`,
    `--batch-rps=${WORKLOAD.batchRps}`,
    `--batch-duration-ms=${WORKLOAD.batchDurationMs}`,
    `--batch-input-chars=${WORKLOAD.batchInputChars}`,
    `--batch-max-tokens=${WORKLOAD.batchMaxTokens}`,
    `--max-attempts=${WORKLOAD.maxAttempts}`,
    `--backoff-base-ms=${WORKLOAD.backoffBaseMs}`,
    `--seed=${WORKLOAD.seed}`,
    `--window-ms=${WINDOW_MS}`,
    `--metrics-port=${metricsPort}`,
    `--trace-file=${tracePath}`,
    `--out=${outPath}`,
    ...extraArgs,
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  activeChildren.add(child);
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      killTree(child, "SIGKILL");
      reject(new Error(`loadgen timed out\n${output}`));
    }, 10_000);
    timer.unref?.();
    child.once("error", reject);
    child.once("close", (code, signal) => {
      activeChildren.delete(child);
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`loadgen exited ${code ?? signal}\n${output}`));
    });
  });
  return { child, exited };
}

/** The load generator's own nearest-rank percentile, rounded as its summary rounds. */
function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return +sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(1);
}

async function scenario(emitPhaseSamples) {
  const dir = mkdtempSync(join(tmpdir(), "moflux-percentiles-"));
  const out = join(dir, "result.json");
  const trace = join(dir, "trace.json");
  writeFileSync(trace, JSON.stringify(TRACE));
  const metricsPort = await freePort();
  let scrape = null;
  let running = true;
  const { server, sockets } = startOrigin(() => {
    // Every slow completion is now older than the window by the time this
    // scrape prunes, and the fast arrivals at 900 ms have not started.
    setTimeout(() => {
      const scrapedWhileRunning = running;
      scrape = fetch(`http://127.0.0.1:${metricsPort}/metrics`)
        .then((response) => ({ status: response.status, scrapedWhileRunning }))
        .catch((error) => ({ status: null, error: error.message, scrapedWhileRunning }));
    }, WINDOW_MS + 100);
  });
  const port = await listen(server);
  try {
    const run = runLoadgen(port, metricsPort, out, trace, [`--emit-phase-samples=${emitPhaseSamples}`]);
    await run.exited;
    running = false;
    return { summary: JSON.parse(readFileSync(out, "utf8")), scrape: await scrape };
  } finally {
    await closeOrigin(server, sockets);
    rmSync(dir, { recursive: true, force: true });
  }
}

try {
  for (const emitPhaseSamples of [true, false]) {
    const label = emitPhaseSamples ? "with samples" : "without samples";
    const { summary, scrape } = await scenario(emitPhaseSamples);
    const interactive = summary.classes.interactive;
    check(
      `${label}: /metrics was scraped mid-run after the slow requests aged out`,
      scrape?.status === 200 && scrape.scrapedWhileRunning,
      JSON.stringify(scrape),
    );
    check(`${label}: every request succeeded`, interactive.success === TRACE.entries.length, `${interactive.success}`);
    check(`${label}: summary declares whole-run percentiles`, summary.percentileScope === "run", `${summary.percentileScope}`);
    check(
      `${label}: p95 latency still includes the pruned slow requests`,
      interactive.latencyMs.p95 >= SLOW_MS,
      `${interactive.latencyMs.p95}ms`,
    );
    check(
      `${label}: p95 TTFT still includes the pruned slow requests`,
      interactive.ttftMs.p95 >= SLOW_MS,
      `${interactive.ttftMs.p95}ms`,
    );
    if (emitPhaseSamples) {
      const samples = interactive.phaseSamples ?? [];
      check("phaseSamples holds every completion", samples.length === TRACE.entries.length, `${samples.length}`);
      for (const key of ["latencyMs", "ttftMs"]) {
        const expected = Object.fromEntries(
          [["p50", 0.5], ["p95", 0.95], ["p99", 0.99]].map(([name, p]) => [
            name,
            percentile(samples.map((sample) => sample[key]), p),
          ]),
        );
        check(
          `${key} percentiles are the phaseSamples percentiles`,
          JSON.stringify(interactive[key]) === JSON.stringify(expected),
          `${JSON.stringify(interactive[key])} vs ${JSON.stringify(expected)}`,
        );
      }
    } else {
      check("phaseSamples stays out of the summary by default", !("phaseSamples" in interactive));
    }
  }
} finally {
  await stopChildren();
}

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("\nsummary percentiles cover the whole run.");
