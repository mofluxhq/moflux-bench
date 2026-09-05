#!/usr/bin/env node
/**
 * Regression for how the demo reports a host process that fails to start.
 *
 * The bug this pins: `waitFor` decided a child was still alive by testing
 * `child.exitCode !== null`. A process terminated by a signal reports
 * `exitCode === null` and `signalCode === "SIGKILL"`, so a killed child looked
 * alive, the poll ran to its full deadline, and the operator was told
 * "timed out waiting for provider simulator; last result: fetch failed" — the
 * same sentence produced by a slow start, a taken port, and a crash. Nothing
 * in the run distinguished them.
 *
 * Every case below asserts on the sentence the operator actually reads.
 *
 * No Docker required.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertHostPortFree,
  describeChildExit,
  isHostPortFree,
  killChildTree,
  launchNode,
  sleep,
  terminateHostChild,
  waitFor,
  waitForChildOutput,
} from "./host-process-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(path.join(tmpdir(), "moflux-supervision-"));
const PROBE_PORT = 9312;
const SIM_ARGS = [
  `--port=${PROBE_PORT}`,
  "--envelope=32",
  "--queue=8",
  "--sigma=0.25",
  "--kappa=0",
  "--r1=400",
  "--input-char-ratio=3.6",
  "--input-jitter=0.04",
  "--seed=1",
];

function writeScript(name, body) {
  const file = path.join(temp, name);
  writeFileSync(file, body);
  return path.relative(ROOT, file);
}

async function expectRejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected a rejection, got success");
}

try {
  // ── 1. a child killed by a signal is reported as killed, not as a timeout ──
  {
    const silent = writeScript(
      "silent.mjs",
      "setInterval(() => {}, 1000);\n",
    );
    const child = launchNode("victim", silent, []);
    setTimeout(() => killChildTree(child, "SIGKILL"), 200);
    const startedAt = Date.now();
    const message = await expectRejection(
      waitFor(`http://127.0.0.1:${PROBE_PORT}/healthz`, {
        timeoutMs: 10_000,
        label: "victim",
        child,
      }),
    );
    const elapsedMs = Date.now() - startedAt;
    assert.match(message, /exited early/, `signal death must not read as a timeout: ${message}`);
    assert.match(message, /SIGKILL/, `the signal must be named: ${message}`);
    assert.ok(
      elapsedMs < 5_000,
      `a dead child must be reported at once, took ${elapsedMs}ms`,
    );
    await terminateHostChild(child);
    console.log(`  ok  signal-killed child reported in ${elapsedMs}ms: ${message}`);
  }

  // ── 2. a child that exits non-zero carries its own output into the error ──
  {
    const noisy = writeScript(
      "noisy.mjs",
      "console.error('config rejected: --envelope must be a finite number');\nprocess.exit(3);\n",
    );
    const child = launchNode("noisy", noisy, []);
    const message = await expectRejection(
      waitFor(`http://127.0.0.1:${PROBE_PORT}/healthz`, {
        timeoutMs: 10_000,
        label: "noisy",
        child,
      }),
    );
    assert.match(message, /exit code 3/, message);
    assert.match(message, /config rejected/, `the child's own reason must survive: ${message}`);
    await terminateHostChild(child);
    console.log("  ok  crashed child carries its stderr into the failure");
  }

  // ── 3. a genuine timeout says so, with elapsed time and liveness ──
  {
    const slow = writeScript("slow.mjs", "setInterval(() => {}, 1000);\n");
    const child = launchNode("slow", slow, []);
    const message = await expectRejection(
      waitFor(`http://127.0.0.1:${PROBE_PORT}/healthz`, {
        timeoutMs: 2_000,
        label: "slow",
        child,
      }),
    );
    assert.match(message, /timed out waiting for slow after \d+ms/, message);
    assert.match(message, /still running/, `liveness must be stated: ${message}`);
    assert.match(message, /wrote nothing/, `silence must be stated explicitly: ${message}`);
    await terminateHostChild(child);
    console.log("  ok  real timeout reports elapsed time and that the process was alive");
  }

  // ── 4. describeChildExit distinguishes the two ways a process can end ──
  {
    const child = launchNode("exit-codes", writeScript("bye.mjs", "process.exit(7);\n"), []);
    await new Promise((resolve) => child.once("close", resolve));
    assert.equal(describeChildExit(child), "exit code 7");

    const victim = launchNode("signalled", writeScript("hang.mjs", "setInterval(() => {}, 1000);\n"), []);
    await sleep(150);
    killChildTree(victim, "SIGKILL");
    await new Promise((resolve) => victim.once("close", resolve));
    assert.equal(describeChildExit(victim), "killed by signal SIGKILL");
    console.log("  ok  exit code and signal death are distinguished");
  }

  // ── 5. the preflight refuses a port that is already taken ──
  {
    assert.equal(await isHostPortFree(PROBE_PORT), true);
    const squatter = createServer((_req, res) => {
      res.writeHead(200);
      res.end("someone else");
    });
    await new Promise((resolve) => squatter.listen(PROBE_PORT, "0.0.0.0", resolve));
    assert.equal(await isHostPortFree(PROBE_PORT), false);

    const message = await expectRejection(
      assertHostPortFree(PROBE_PORT, { label: "provider simulator port", timeoutMs: 500 }),
    );
    assert.match(message, new RegExp(`TCP ${PROBE_PORT}`), message);
    assert.match(message, /lsof/, `the message must say how to find the owner: ${message}`);
    await new Promise((resolve) => squatter.close(resolve));

    // and it clears once the port is released
    await assertHostPortFree(PROBE_PORT, { timeoutMs: 2_000 });
    console.log("  ok  port preflight fails on a taken port and clears when released");
  }

  // ── 6. the preflight tolerates a socket still being released ──
  {
    const squatter = createServer();
    await new Promise((resolve) => squatter.listen(PROBE_PORT, "0.0.0.0", resolve));
    setTimeout(() => squatter.close(), 600);
    await assertHostPortFree(PROBE_PORT, { timeoutMs: 5_000 });
    console.log("  ok  port preflight waits out a port that is still being released");
  }

  // ── 7. the real simulator reports a taken port instead of a stack trace ──
  {
    const squatter = createServer();
    await new Promise((resolve) => squatter.listen(PROBE_PORT, "0.0.0.0", resolve));
    const child = launchNode("provider", "sim/provider-sim.mjs", SIM_ARGS);
    const message = await expectRejection(
      waitFor(`http://127.0.0.1:${PROBE_PORT}/healthz`, {
        timeoutMs: 10_000,
        label: "provider simulator",
        child,
      }),
    );
    assert.match(message, /exited early \(exit code 1\)/, message);
    assert.match(message, /already in use/, `the collision must be named: ${message}`);
    assert.doesNotMatch(message, /Unhandled 'error' event/, `no raw stack: ${message}`);
    await terminateHostChild(child);
    await new Promise((resolve) => squatter.close(resolve));
    console.log("  ok  provider simulator reports EADDRINUSE in one readable line");
  }

  // ── 8. the healthy path still works ──
  {
    const child = launchNode("provider", "sim/provider-sim.mjs", SIM_ARGS);
    const response = await waitFor(`http://127.0.0.1:${PROBE_PORT}/healthz`, {
      timeoutMs: 15_000,
      label: "provider simulator",
      child,
    });
    assert.equal(response.status, 200);
    await terminateHostChild(child);
    assert.equal(await isHostPortFree(PROBE_PORT), true);
    console.log("  ok  provider simulator starts, answers, and releases its port");
  }

  // ── 9. provider readiness can use its listen-callback output marker ──
  {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("poisoned global fetch");
    };
    const child = launchNode("provider", "sim/provider-sim.mjs", SIM_ARGS);
    try {
      const ready = await waitForChildOutput(child, `provider-sim :${PROBE_PORT}`, {
        timeoutMs: 15_000,
        label: "provider simulator",
      });
      assert.equal(ready.marker, `provider-sim :${PROBE_PORT}`);
    } finally {
      globalThis.fetch = originalFetch;
      await terminateHostChild(child);
    }
    assert.equal(await isHostPortFree(PROBE_PORT), true);
    console.log("  ok  provider readiness uses the listen-callback marker, not global fetch");
  }

  // ── 10. output readiness does not require a valid HTTP response at all ──
  {
    const script = writeScript(
      "marker-only.mjs",
      [
        'import { createServer } from "node:net";',
        `const server = createServer((socket) => { socket.end("not-http\\n"); });`,
        `server.listen(${PROBE_PORT}, "127.0.0.1", () => console.log("READY ${PROBE_PORT}"));`,
        'process.on("SIGTERM", () => server.close(() => process.exit(0)));',
      ].join("\n") + "\n",
    );
    const child = launchNode("marker-only", script, []);
    try {
      await waitForChildOutput(child, `READY ${PROBE_PORT}`, {
        timeoutMs: 5_000,
        label: "marker-only",
      });
      const message = await expectRejection(
        waitFor(`http://127.0.0.1:${PROBE_PORT}/healthz`, {
          timeoutMs: 750,
          label: "marker-only HTTP probe",
          child,
        }),
      );
      assert.match(message, /Parse Error|socket hang up|timed out|ECONNRESET|Expected HTTP/i, message);
    } finally {
      await terminateHostChild(child);
    }
    console.log("  ok  listen-marker readiness is independent of HTTP response parsing");
  }

  // ── 11. persistent child diagnostics capture output without leaking argv ──
  {
    const logFile = path.join(temp, "persistent-child.log");
    const secret = "super-secret-credential";
    const script = writeScript(
      "persistent-output.mjs",
      [
        'console.log("diagnostic stdout marker");',
        'console.error("diagnostic stderr marker");',
        'process.exit(9);',
      ].join("\n") + "\n",
    );
    const child = launchNode("persistent-output", script, [secret], { logFile });
    await new Promise((resolve) => child.once("close", resolve));
    const persisted = readFileSync(logFile, "utf8");
    assert.match(persisted, /diagnostic stdout marker/, persisted);
    assert.match(persisted, /diagnostic stderr marker/, persisted);
    assert.match(persisted, /# startedAt:/, persisted);
    assert.doesNotMatch(
      persisted,
      new RegExp(secret),
      "persistent diagnostics must not copy potentially sensitive argv into the log header",
    );
    console.log("  ok  persistent child diagnostics retain stdout/stderr without copying argv");
  }

  console.log("\nPASS  host process supervision reports why a startup failed");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
