#!/usr/bin/env node
/** Proves demo:full starts its public support stack before the first arm. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTelemetryRelayServer } from "./telemetry-relay-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(path.join(tmpdir(), "moflux-full-stack-"));
const bin = path.join(temp, "bin");
const marker = path.join(temp, "docker-calls.log");
const browserMarker = path.join(temp, "browser-calls.log");
const results = path.join(temp, "results");
mkdirSync(bin);

const docker = path.join(bin, "docker");
writeFileSync(
  docker,
  `#!/bin/sh\necho "$@" >> "${marker}"\nexit 0\n`,
);
chmodSync(docker, 0o755);

const browser = path.join(bin, "fake-browser");
writeFileSync(
  browser,
  `#!/bin/sh\necho "$@" >> "${browserMarker}"\nexit 0\n`,
);
chmodSync(browser, 0o755);

function healthServer(pathname, extraRoutes = new Map()) {
  return createServer((req, res) => {
    if (req.url === pathname) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"status":"ok"}');
      return;
    }
    const body = extraRoutes.get(req.url);
    if (body != null) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

async function listenWhenFree(server, port) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "127.0.0.1");
      });
      return;
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`port ${port} did not become available`);
}

const relay = createTelemetryRelayServer();
const prometheus = healthServer("/-/ready");
const grafana = healthServer(
  "/api/health",
  new Map([["/api/dashboards/uid/moflux-bench", '{"dashboard":{"uid":"moflux-bench"}}']]),
);

try {
  await Promise.all([
    listenWhenFree(relay, 8200),
    listenWhenFree(prometheus, 9090),
    listenWhenFree(grafana, 3000),
  ]);

  const run = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join(ROOT, "demo", "run-demo.mjs"),
        "--only=baseline",
        "--skip-verify",
        "--phase-ms=1200",
        "--pause-ms=0",
        "--sigma=0",
        "--r1=5000",
      ],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          MOFLUX_BENCH_RESULTS_DIR: results,
          MOFLUX_BENCH_BROWSER: browser,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });

  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /Telemetry relay, Prometheus, Grafana, and Redis are ready/);
  assert.match(run.stdout, /Opened Grafana dashboard/);
  assert.ok(
    run.stdout.indexOf("Opened Grafana dashboard") <
      run.stdout.indexOf("MoFlux benchmark harness — narrated walkthrough"),
    "Grafana should open before the first narrated phase",
  );
  const calls = readFileSync(marker, "utf8");
  assert.match(calls, /^info$/m);
  assert.match(calls, /^compose version$/m);
  assert.match(
    calls,
    /compose -f .*demo\/compose\.yaml up -d --force-recreate telemetry-relay prometheus grafana redis/,
  );
  const browserCalls = readFileSync(browserMarker, "utf8");
  assert.match(
    browserCalls,
    /^http:\/\/localhost:3000\/d\/moflux-bench\/moflux-benchmark-harness\?orgId=1&refresh=5s$/m,
  );
  console.log("PASS  demo:full starts its support stack and opens the provisioned dashboard");
} finally {
  await Promise.all([
    new Promise((resolve) => relay.close(resolve)),
    new Promise((resolve) => prometheus.close(resolve)),
    new Promise((resolve) => grafana.close(resolve)),
  ]);
  rmSync(temp, { recursive: true, force: true });
}
