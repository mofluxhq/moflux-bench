#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TIMEOUT_MS = 120_000;
let activeChild = null;

const tests = [
  ["sim/verify-sim.mjs", 90_000],
  ["sim/verify-provider-determinism.mjs", 30_000],
  ["sim/verify-anthropic-stream.mjs", 30_000],
  ["load/verify-loadgen.mjs", 30_000],
  ["load/verify-anthropic-loadgen.mjs", 30_000],
  ["load/verify-drain.mjs", 180_000],
  ["load/verify-retry-hints.mjs", 30_000],
  ["load/verify-trace-sizes.mjs", 30_000],
  ["load/verify-trace.mjs", 30_000],
  ["demo/verify-env.mjs", 30_000],
  ["demo/verify-evidence-paths.mjs", 30_000],
  ["demo/verify-local-image-build.mjs", 30_000],
  ["demo/verify-capacity.mjs", 30_000],
  ["demo/verify-adaptive-profile.mjs", 30_000],
  ["demo/verify-adaptive-seed-sweep.mjs", 60_000],
  ["demo/verify-topology.mjs", 30_000],
  ["demo/verify-telemetry-relay.mjs", 30_000],
  ["demo/verify-full-stack-bootstrap.mjs", 30_000],
  ["demo/verify-host-supervision.mjs", 60_000],
  ["demo/verify-presenter.mjs", 360_000],
  ["demo/verify-seed-sweep.mjs", 30_000],
  ["demo/verify-control-arms.mjs", 30_000],
  ["demo/verify-static-cap.mjs", 30_000],
  ["demo/verify-arm-services.mjs", 30_000],
  ["demo/verify-loadgen-args.mjs", 30_000],
  ["demo/verify-coordination.mjs", 30_000],
  ["demo/verify-lending.mjs", 30_000],
  ["demo/verify-seed-sweep-runner.mjs", 180_000],
  ["demo/verify-demo-command.mjs", 180_000],
];

function killTree(child, signal) {
  if (!child.pid) return;
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

function run(file, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, file)], {
      cwd: ROOT,
      stdio: "inherit",
      detached: process.platform !== "win32",
    });
    activeChild = child;
    let timedOut = false;
    let forceTimer = null;
    let settled = false;

    function finish(error = null) {
      if (settled) return;
      settled = true;
      if (activeChild === child) activeChild = null;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (error) reject(error);
      else resolve();
    }

    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`TIMEOUT  ${file} exceeded ${Math.round(timeoutMs / 1000)}s`);
      killTree(child, "SIGTERM");
      forceTimer = setTimeout(() => killTree(child, "SIGKILL"), 2_000);
      forceTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();

    child.once("error", (error) => finish(error));
    // `close` means the process has exited and all inherited stdio handles are
    // closed. Advancing on `exit` can leave grandchildren alive and make the
    // following integration test inherit occupied ports or open descriptors.
    child.once("close", (code, signal) => {
      if (timedOut) return finish(new Error(`${file} timed out`));
      if (code === 0) return finish();
      finish(new Error(`${file} exited ${code ?? signal}`));
    });
  });
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    if (activeChild) killTree(activeChild, "SIGTERM");
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

for (const [file, timeoutMs] of tests) {
  console.log(`\n=== ${file} ===`);
  await run(file, timeoutMs);
}
console.log(`\nPASS  complete verification suite (${tests.length} checks)`);
