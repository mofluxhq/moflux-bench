#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTelemetryRelayServer } from "./telemetry-relay-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(path.join(tmpdir(), "moflux-telemetry-test-"));

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(resolve);
  });
}

const upstream = createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    res.writeHead(404).end();
    return;
  }
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      [
        'data: {"choices":[{"delta":{"content":"token"}}]}',
        "",
        'data: {"choices":[{"delta":{}}],"usage":{"completion_tokens":1}}',
        "",
        "data: [DONE]",
        "",
        "",
      ].join("\n"),
    );
  });
});
const relay = createTelemetryRelayServer();

async function runLoadgen({ arm, seed, relayPort, upstreamPort }) {
  const out = path.join(temp, `${arm}.json`);
  const child = spawn(
    process.execPath,
    [
      path.join(ROOT, "load/loadgen.mjs"),
      `--targets=http://127.0.0.1:${upstreamPort}`,
      `--arm-label=${arm}`,
      `--seed=${seed}`,
      "--duration-ms=1200",
      "--interactive-rps=20",
      "--interactive-input-chars=20",
      "--interactive-max-tokens=4",
      "--batch-start-ms=5000",
      "--max-attempts=1",
      "--metrics-port=0",
      `--metrics-relay-url=http://127.0.0.1:${relayPort}/ingest`,
      "--metrics-relay-required",
      "--metrics-push-interval-ms=100",
      `--out=${out}`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0) throw new Error(`${arm} loadgen exited ${code}\n${stdout}\n${stderr}`);
  const summary = JSON.parse(readFileSync(out, "utf8"));
  if (!(summary.classes?.interactive?.success > 0)) {
    throw new Error(`${arm} produced no successful interactive requests`);
  }
}

try {
  const [upstreamPort, relayPort] = await Promise.all([listen(upstream), listen(relay)]);
  await runLoadgen({ arm: "baseline-no-control", seed: 9, relayPort, upstreamPort });
  await runLoadgen({ arm: "moflux-enforce", seed: 9, relayPort, upstreamPort });

  const response = await fetch(`http://127.0.0.1:${relayPort}/metrics`);
  const metrics = await response.text();
  if (!response.ok) throw new Error(`relay metrics returned HTTP ${response.status}`);

  for (const arm of ["baseline-no-control", "moflux-enforce"]) {
    const latency = new RegExp(`bench_latency_p99_ms\\{arm="${arm}",seed="9",class="interactive"\\} ([0-9.]+)`).exec(metrics);
    const ttft = new RegExp(`bench_ttft_p99_ms\\{arm="${arm}",seed="9",class="interactive"\\} ([0-9.]+)`).exec(metrics);
    if (!latency || Number(latency[1]) <= 0) throw new Error(`missing positive ${arm} interactive p99 latency`);
    if (!ttft || Number(ttft[1]) <= 0) throw new Error(`missing positive ${arm} interactive p99 TTFT`);
  }

  const helpCount = (metrics.match(/^# HELP bench_latency_p99_ms /gm) ?? []).length;
  const typeCount = (metrics.match(/^# TYPE bench_latency_p99_ms /gm) ?? []).length;
  if (helpCount !== 1 || typeCount !== 1) {
    throw new Error(`relay emitted duplicate metric metadata: HELP=${helpCount}, TYPE=${typeCount}`);
  }
  if (!metrics.includes("bench_telemetry_relay_snapshots 2")) {
    throw new Error("relay did not retain both benchmark arms");
  }

  const prometheusConfig = readFileSync(path.join(ROOT, "demo/prometheus/prometheus.yml"), "utf8");
  if (!prometheusConfig.includes("job_name: loadgen-telemetry") ||
      !prometheusConfig.includes('targets: ["telemetry-relay:8200"]')) {
    throw new Error("Prometheus is not wired to scrape the persistent telemetry relay");
  }

  const dashboard = JSON.parse(
    readFileSync(path.join(ROOT, "demo/grafana/dashboards/moflux-bench.json"), "utf8"),
  );
  const latencyPanel = dashboard.panels.find((panel) => panel.id === 1);
  const ttftPanel = dashboard.panels.find((panel) => panel.id === 2);
  const healthPanel = dashboard.panels.find((panel) => panel.id === 16);
  if (latencyPanel?.targets?.[0]?.expr !== 'bench_latency_p99_ms{class="interactive"}' ||
      latencyPanel?.targets?.[0]?.legendFormat !== "{{arm}} / seed {{seed}}") {
    throw new Error("Grafana interactive p99 latency panel is not wired to arm/seed telemetry");
  }
  if (ttftPanel?.targets?.[0]?.expr !== 'bench_ttft_p99_ms{class="interactive"}' ||
      ttftPanel?.targets?.[0]?.legendFormat !== "{{arm}} / seed {{seed}}") {
    throw new Error("Grafana interactive p99 TTFT panel is not wired to arm/seed telemetry");
  }
  if (healthPanel?.targets?.[0]?.expr !== 'up{job="loadgen-telemetry"}') {
    throw new Error("Grafana telemetry pipeline health panel is missing");
  }

  console.log("PASS  telemetry relay retains baseline and MoFlux p99 latency and TTFT");
} finally {
  await Promise.all([close(upstream), close(relay)]);
  rmSync(temp, { recursive: true, force: true });
}
