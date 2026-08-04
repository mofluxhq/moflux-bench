/**
 * host-process-lib.mjs — supervision for the processes the demo runs on the
 * host rather than in Docker: the provider simulator, the replicas, and the
 * load generator.
 *
 * This exists because a startup failure here used to be reported as a bare
 * "timed out waiting for <label>; last result: fetch failed" with no other
 * evidence, which is true of every possible cause and therefore useful for
 * none of them. Three failures were indistinguishable:
 *
 *   - the port was already taken, so the child died on EADDRINUSE
 *   - the child was killed by a signal before it could listen
 *   - the child was alive and simply slower than the timeout
 *
 * The liveness guard checked only `child.exitCode`, which stays `null` when a
 * process is terminated by a signal, so a killed child was reported as a
 * timeout after the full wait with nothing on stderr. Every helper here
 * reports which of the three happened, and the recent output of the child
 * that failed.
 *
 * Extracted from present.mjs so demo/verify-host-supervision.mjs can exercise
 * it against real processes without Docker.
 */

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RED = "\u001b[31m";
const DIM = "\u001b[2m";
const OFF = "\u001b[0m";

/** Keep the tail small: it goes into an error message, not a log file. */
const OUTPUT_LINES = 12;
const OUTPUT_CHARS = 2000;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchWithTimeout(url, options = {}, timeoutMs = 1500) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

export const hostChildren = new Set();

export function killChildTree(child, signal = "SIGTERM") {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

/**
 * How a child ended, or null if it is still running.
 *
 * `exitCode` alone is not enough: a process terminated by a signal reports
 * `exitCode === null` and `signalCode === "SIGKILL"`. Treating that as "still
 * running" is what turned a kill into a silent timeout.
 */
export function describeChildExit(child) {
  if (!child) return null;
  if (child.signalCode !== null && child.signalCode !== undefined) {
    return `killed by signal ${child.signalCode}`;
  }
  if (child.exitCode !== null && child.exitCode !== undefined) {
    return `exit code ${child.exitCode}`;
  }
  return null;
}

function recordOutput(child, stream, chunk) {
  const lines = String(chunk).split("\n").filter((line) => line.trim().length > 0);
  for (const line of lines) child.recentOutput.push(`${stream}: ${line}`);
  while (child.recentOutput.length > OUTPUT_LINES) child.recentOutput.shift();
}

/**
 * The last thing the child said, for inclusion in an error message. A child
 * that was killed says nothing at all, so the absence is itself reported —
 * silence and "I never looked" must not read the same way.
 */
export function childOutputTail(child) {
  if (!child) return "";
  if (!child.recentOutput || child.recentOutput.length === 0) {
    return "; the process wrote nothing to stdout or stderr";
  }
  const tail = child.recentOutput.join(" | ").slice(-OUTPUT_CHARS);
  return `; last output: ${tail}`;
}

export function launchNode(label, script, argv, { echo = false } = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, script), ...argv], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  child.label = label;
  child.recentOutput = [];
  child.startedAt = Date.now();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    recordOutput(child, "stdout", chunk);
    if (echo) process.stdout.write(`${DIM}[${label}] ${chunk}${OFF}`);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    recordOutput(child, "stderr", chunk);
    process.stderr.write(`${RED}[${label}] ${chunk}${OFF}`);
  });
  hostChildren.add(child);
  child.on("close", () => hostChildren.delete(child));
  return child;
}

export async function terminateHostChild(child, graceMs = 1500) {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) killChildTree(child, "SIGTERM");
  const closed = await Promise.race([
    new Promise((resolve) => child.once("close", () => resolve(true))),
    sleep(graceMs).then(() => false),
  ]);
  if (!closed && child.exitCode === null) {
    killChildTree(child, "SIGKILL");
    await Promise.race([
      new Promise((resolve) => child.once("close", resolve)),
      sleep(500),
    ]);
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
  hostChildren.delete(child);
}

export async function stopHostChildren() {
  await Promise.all([...hostChildren].map((child) => terminateHostChild(child)));
}

export function stopHostChildrenSync() {
  for (const child of [...hostChildren]) killChildTree(child, "SIGTERM");
}

/**
 * Polls an HTTP endpoint until it answers, failing early and loudly if the
 * process backing it has already gone away.
 */
export async function waitFor(url, {
  timeoutMs = 30000,
  statuses = [200],
  label = url,
  child = null,
} = {}) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let last = "no response";
  while (Date.now() < deadline) {
    const ended = describeChildExit(child);
    if (ended) {
      throw new Error(
        `${label} process exited early (${ended})${childOutputTail(child)}`,
      );
    }
    try {
      const response = await fetchWithTimeout(url, {}, 1200);
      last = `HTTP ${response.status}`;
      if (statuses.includes(response.status)) return response;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }
  const elapsedMs = Date.now() - startedAt;
  const ended = describeChildExit(child);
  const liveness = child
    ? ended
      ? `; the process had already ended (${ended})`
      : "; the process was still running"
    : "";
  throw new Error(
    `timed out waiting for ${label} after ${elapsedMs}ms; last result: ${last}` +
      `${liveness}${child ? childOutputTail(child) : ""}`,
  );
}

/**
 * True when nothing is listening on the given TCP port of the given host.
 *
 * Binding is the only check that answers the question the caller actually has
 * — "can my child take this port" — so it is the check used. A connect probe
 * would miss a listener bound to a different address on the same port.
 */
export function isHostPortFree(port, host = "0.0.0.0") {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (error) => {
      probe.close();
      if (error?.code === "EADDRINUSE" || error?.code === "EACCES") return resolve(false);
      reject(error);
    });
    probe.listen(port, host, () => {
      probe.close(() => resolve(true));
    });
  });
}

/**
 * Waits for a host port to be free, then returns.
 *
 * The grace period exists because the presenter is re-run once per seed and a
 * previous seed's child may still be releasing its socket. A genuinely
 * occupied port still fails, and fails in the preflight rather than as an
 * unexplained startup timeout several minutes into a sweep.
 */
export async function assertHostPortFree(port, {
  label = `port ${port}`,
  timeoutMs = 5000,
  host = "0.0.0.0",
} = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await isHostPortFree(port, host)) return;
    if (Date.now() >= deadline) break;
    await sleep(250);
  }
  throw new Error(
    `${label} (TCP ${port}) is already in use, so the demo cannot start its own process there. ` +
      `Find the owner with \`lsof -nP -iTCP:${port} -sTCP:LISTEN\` (macOS/Linux) and stop it, ` +
      `then re-run. A stale process from an interrupted run is the usual cause; ` +
      `\`npm run demo:down\` does not remove it because it runs on the host, not in Docker.`,
  );
}
