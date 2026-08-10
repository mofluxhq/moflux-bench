#!/usr/bin/env node
/**
 * End-to-end regression for the one-command presenter without Docker.
 *
 * It substitutes a no-op Docker CLI and lightweight HTTP doubles for Latchflo,
 * Grafana, Prometheus, and four Tyr replicas. The real provider simulator and
 * real open-loop load generator still run, so this catches orchestration,
 * routing, result writing, and per-run recovery regressions in CI.
 */

import { spawn, spawnSync } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTelemetryRelayServer } from "./telemetry-relay-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(path.join(tmpdir(), "moflux-presenter-"));
const results = path.join(temp, "results");
mkdirSync(results, { recursive: true });
const ENV_FILE = path.join(temp, "moflux.env");
const BASELINE_FILE = path.join(results, "baseline.json");
const RESULT_FILE = path.join(results, "moflux-enforce.json");
const COMPARISON_FILE = path.join(results, "video-comparison.json");
const TRACE_FILE = path.join(results, "scenario-trace.json");
const RESULT_FILES = [BASELINE_FILE, RESULT_FILE, COMPARISON_FILE, TRACE_FILE];
const docker = path.join(temp, "docker");
const servers = [];
const POOL_TTL_HISTORY = {
  "sim-interactive": [],
  "sim-batch": [],
};
const POOL_CONFIG_HISTORY = {
  "sim-interactive": [],
  "sim-batch": [],
};
let steadyPromotedAt = 0;
let presenterChild = null;

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(resolve);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function killTree(child, signal = "SIGTERM") {
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

async function waitForFile(file, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${file}`);
}

async function listenWhenFree(factory, port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    const server = factory(port);
    try {
      await listen(server, port);
      if (!servers.includes(server)) servers.push(server);
      return server;
    } catch (error) {
      lastError = error;
      await close(server);
      if (error?.code !== "EADDRINUSE") throw error;
      await sleep(100);
    }
  }
  throw new Error(`timed out waiting for port ${port}: ${lastError?.message ?? "unknown error"}`);
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function text(res, status, body) {
  res.writeHead(status, { "content-type": "text/plain", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function controlPlane() {
  return createServer((req, res) => {
    if (req.url === "/readyz") return text(res, 200, "ready\n");
    if (req.url === "/v1/agents" && req.method === "GET") {
      return json(res, 200, { agents: [1, 2, 3, 4].map((n) => ({ instanceId: `tyr-r${n}` })) });
    }
    const put = /^\/v1\/pools\/(sim-interactive|sim-batch)$/.exec(req.url ?? "");
    if (put && req.method === "PUT") {
      void readJsonBody(req).then((body) => {
        const ttl = Number(body?.grantTtlMs);
        POOL_TTL_HISTORY[put[1]].push(ttl);
        POOL_CONFIG_HISTORY[put[1]].push(body);
        if (ttl === 120000) steadyPromotedAt ||= Date.now();
        json(res, 200, { name: put[1], updated: true, grantTtlMs: ttl });
      }).catch((error) => json(res, 400, { error: error.message }));
      return;
    }
    const rebalance = /^\/v1\/pools\/(sim-interactive|sim-batch)\/rebalance$/.exec(req.url ?? "");
    if (rebalance && req.method === "POST") {
      return json(res, 200, { rebalanced: true, name: rebalance[1] });
    }
    return json(res, 404, { error: "not_found" });
  });
}

function simpleHealth(kind) {
  return createServer((req, res) => {
    if (kind === "prometheus" && req.url === "/-/ready") return text(res, 200, "ready\n");
    if (kind === "prometheus" && req.url?.startsWith("/api/v1/query")) {
      return json(res, 200, {
        status: "success",
        data: {
          resultType: "vector",
          result: [{ metric: {}, value: [Date.now() / 1000, "1"] }],
        },
      });
    }
    if (kind === "grafana" && req.url === "/api/health") return json(res, 200, { database: "ok" });
    if (kind === "grafana" && req.url === "/api/annotations" && req.method === "POST") {
      req.resume();
      return json(res, 200, { message: "Annotation added" });
    }
    return json(res, 404, { error: "not_found" });
  });
}

const TYR_TRUTH = [];

function tyr(port) {
  const poolNames = port === 8104
    ? ["sim-interactive", "sim-batch"]
    : ["sim-interactive"];
  const countersByPool = Object.fromEntries(
    poolNames.map((pool) => [
      pool,
      {
        totalReserved: 0,
        totalConsumed: 0,
        totalRefunded: 0,
        totalOverrun: 0,
        progressiveReports: 0,
        progressiveUpdates: 0,
        progressiveCoalesced: 0,
        progressiveEarlyReleasedTokens: 0,
      },
    ]),
  );
  TYR_TRUTH.push(...Object.values(countersByPool));

  function enrollmentPhase() {
    if (!steadyPromotedAt) return "before-promotion";
    const elapsed = Date.now() - steadyPromotedAt;
    if (elapsed < 300) return "first-only";
    if (elapsed < 900) return "late-only";
    if (elapsed < 1200) return "short-batch-overlap";
    return "balanced";
  }

  function poolLimits(pool) {
    if (pool === "sim-batch") return { budget: 10000, maxConcurrent: 1 };
    if (port === 8101 && enrollmentPhase() === "late-only") {
      return { budget: 0, maxConcurrent: 0 };
    }
    return { budget: 7500, maxConcurrent: port === 8104 ? 7 : 8 };
  }

  function poolStats(pool) {
    const counters = countersByPool[pool];
    const { budget, maxConcurrent } = poolLimits(pool);
    return {
      limits: {
        revision: 101,
        maxConcurrent,
        maxQueue: 0,
        tokenBudget: { budget, highPriorityReserve: 0 },
      },
      tokenBudget: {
        budget,
        inFlightTokens: 0,
        available: budget,
        totalReserved: counters.totalReserved,
        totalConsumed: counters.totalConsumed,
        totalRefunded: counters.totalRefunded,
        totalOverrun: counters.totalOverrun,
      },
      tyr: {
        progressiveReconciliation: {
          enabled: true,
          updateStepTokens: 256,
          outputSafetyMarginTokens: 256,
          reports: counters.progressiveReports,
          updates: counters.progressiveUpdates,
          coalesced: counters.progressiveCoalesced,
          earlyReleasedTokens: counters.progressiveEarlyReleasedTokens,
        },
        provenance: {
          current: {
            source: "latchflo",
            grantId: `test-${port}-${pool}`,
            controllerEpoch: 1,
            revision: 101,
            expiresAt: new Date(
              Date.now() +
                (pool === "sim-batch" && enrollmentPhase() === "short-batch-overlap"
                  ? 1000
                  : 120000),
            ).toISOString(),
          },
        },
      },
    };
  }

  return createServer((req, res) => {
    if (req.url === "/healthz") return text(res, 200, "ok\n");
    if (req.url === "/readyz") {
      const phase = enrollmentPhase();
      const ready =
        phase === "balanced" ||
        phase === "short-batch-overlap" ||
        (phase === "first-only" && port === 8101) ||
        (phase === "late-only" && port !== 8101);
      return text(res, ready ? 200 : 503, ready ? "ok\n" : "not ready\n");
    }
    if (req.url === "/stats") {
      return json(
        res,
        200,
        Object.fromEntries(poolNames.map((pool) => [pool, poolStats(pool)])),
      );
    }
    if (req.url === "/metrics") {
      const lines = [];
      for (const pool of poolNames) {
        const counters = countersByPool[pool];
        lines.push(
          `tyr_pool_in_flight{pool="${pool}"} 0`,
          `tyr_pool_tokens_in_flight{pool="${pool}"} 0`,
          `tyr_pool_limit_revision{pool="${pool}"} 101`,
          `tyr_pool_tokens_reserved_total{pool="${pool}"} ${counters.totalReserved}`,
          `tyr_pool_tokens_consumed_total{pool="${pool}"} ${counters.totalConsumed}`,
          `tyr_pool_tokens_refunded_total{pool="${pool}"} ${counters.totalRefunded}`,
          `tyr_pool_tokens_overrun_total{pool="${pool}"} ${counters.totalOverrun}`,
          `tyr_pool_progressive_reconciliation_enabled{pool="${pool}"} 1`,
          `tyr_pool_progressive_usage_reports_total{pool="${pool}"} ${counters.progressiveReports}`,
          `tyr_pool_progressive_updates_total{pool="${pool}"} ${counters.progressiveUpdates}`,
          `tyr_pool_progressive_coalesced_total{pool="${pool}"} ${counters.progressiveCoalesced}`,
          `tyr_pool_progressive_tokens_released_total{pool="${pool}"} ${counters.progressiveEarlyReleasedTokens}`,
        );
      }
      lines.push("");
      return text(res, 200, lines.join("\n"));
    }
    if ((req.url === "/v1/chat/completions" || req.url === "/v1/messages") && req.method === "POST") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const payload = Buffer.concat(chunks);
        let body = {};
        try {
          body = JSON.parse(payload.toString("utf8"));
        } catch {
          // Use the interactive defaults for malformed test input.
        }
        const pool = body?.model === "sim-model-batch" ? "sim-batch" : "sim-interactive";
        const counters = countersByPool[pool];
        if (!counters) {
          return json(res, 500, { error: `pool ${pool} is not configured on Tyr ${port}` });
        }
        const maxTokens = Number(body?.max_tokens ?? 400);
        const reserved = Math.max(1, maxTokens + 300);
        const refunded = Math.round(reserved * 0.26);
        const overrun = Math.round(reserved * 0.008);
        const consumed = reserved - refunded + overrun;
        counters.totalReserved += reserved;
        counters.totalRefunded += refunded;
        counters.totalOverrun += overrun;
        counters.totalConsumed += consumed;
        const earlyReleased = Math.round(refunded * 0.75);
        counters.progressiveReports += 6;
        counters.progressiveUpdates += 4;
        counters.progressiveCoalesced += 2;
        counters.progressiveEarlyReleasedTokens += earlyReleased;

        const upstream = httpRequest(
          {
            hostname: "127.0.0.1",
            port: 9000,
            path: req.url,
            method: "POST",
            headers: { ...req.headers, "content-length": payload.length },
          },
          (upstreamRes) => {
            res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
            upstreamRes.pipe(res);
          },
        );
        upstream.on("error", (error) => {
          if (!res.headersSent) json(res, 502, { error: error.message });
          else res.destroy(error);
        });
        upstream.end(payload);
      });
      return;
    }
    return json(res, 404, { error: "not_found" });
  });
}

try {
  writeFileSync(
    docker,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Docker version test"; exit 0; fi\nif [ "$1" = "info" ]; then exit 0; fi\nif [ "$1" = "image" ]; then exit 0; fi\nif [ "$1" = "kill" ]; then exit 0; fi\nif [ "$1" = "compose" ]; then\n  if [ "$2" = "version" ]; then echo "Docker Compose version test"; fi\n  exit 0\nfi\nexit 0\n`,
  );
  chmodSync(docker, 0o755);
  writeFileSync(
    ENV_FILE,
    [
      "MOFLUX_TYR_IMAGE=test-tyr:0.24.0",
      "MOFLUX_LATCHFLO_IMAGE=test-latchflo:0.10.0",
      "LATCHFLO_ADMIN_TOKEN=test-admin",
      "LATCHFLO_AGENT_BOOTSTRAP_TOKEN=test-bootstrap",
      "TYR_ROUTING_SECRET=test-routing-secret-with-at-least-32-chars",
      "MOFLUX_TYR_USER=0:0",
      "",
    ].join("\n"),
  );

  for (const file of RESULT_FILES) rmSync(file, { force: true });

  const cp = controlPlane();
  const prom = simpleHealth("prometheus");
  const grafana = simpleHealth("grafana");
  const relay = createTelemetryRelayServer();
  await Promise.all([
    listenWhenFree(() => cp, 18080),
    listenWhenFree(() => prom, 9090),
    listenWhenFree(() => grafana, 3000),
    listenWhenFree(() => relay, 8200),
  ]);

  // The real baseline replicas must own 8101-8104 first. Once they finish and
  // release the ports, install the Tyr doubles so the same presenter process
  // can continue into its managed arm.
  const startTyrDoubles = (async () => {
    await waitForFile(BASELINE_FILE);
    for (const port of [8101, 8102, 8103, 8104]) {
      await listenWhenFree(tyr, port);
    }
  })();

  const run = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join(ROOT, "demo", "present.mjs"),
        "--mode=compare",
        "--phase-ms=10000",
        "--pause-ms=0",
        "--no-open",
        "--sigma=0",
        "--r1=5000",
      ],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          PATH: `${temp}:${process.env.PATH}`,
          MOFLUX_BENCH_RESULTS_DIR: results,
          MOFLUX_BENCH_ENV_FILE: ENV_FILE,
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      },
    );
    presenterChild = child;
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    let settled = false;
    let forceTimer = null;
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (error) reject(error);
      else resolve(value);
    }
    child.once("error", (error) => finish(error));
    const timer = setTimeout(() => {
      killTree(child, "SIGTERM");
      forceTimer = setTimeout(() => killTree(child, "SIGKILL"), 2_000);
      forceTimer.unref?.();
      finish(new Error(`presenter timed out
STDOUT:
${stdout}
STDERR:
${stderr}`));
    }, 120000);
    timer.unref?.();
    // Wait for both process exit and inherited pipe closure. This catches any
    // leaked provider/load-generator descendants instead of printing PASS and
    // then leaving the test process alive.
    child.once("close", (code, signal) => {
      finish(null, { status: code, signal, stdout, stderr });
    });
  });

  await startTyrDoubles;

  if (run.status !== 0) {
    throw new Error(`presenter exited ${run.status ?? run.signal}
STDOUT:
${run.stdout}
STDERR:
${run.stderr}`);
  }
  for (const file of RESULT_FILES) {
    if (!existsSync(file)) throw new Error(`presenter did not write ${file}`);
  }

  for (const [pool, history] of Object.entries(POOL_TTL_HISTORY)) {
    if (JSON.stringify(history) !== JSON.stringify([5000, 120000])) {
      throw new Error(`${pool} TTL history was ${JSON.stringify(history)}, expected enrollment then steady lease`);
    }
  }
  const expectedMinimumTokens = { "sim-interactive": 755, "sim-batch": 9942 };
  for (const [pool, history] of Object.entries(POOL_CONFIG_HISTORY)) {
    if (history.length !== 2) throw new Error(`${pool} was configured ${history.length} times, expected 2`);
    for (const body of history) {
      if (body.minimumGrantMaxConcurrent !== 1) {
        throw new Error(`${pool} omitted Latchflo 0.10.0 minimumGrantMaxConcurrent=1`);
      }
      if (body.minimumGrantTokenBudget !== expectedMinimumTokens[pool]) {
        throw new Error(
          `${pool} minimumGrantTokenBudget was ${body.minimumGrantTokenBudget}, ` +
            `expected ${expectedMinimumTokens[pool]}`,
        );
      }
      const expectedConcurrent = pool === "sim-interactive" ? 31 : 1;
      const expectedBudget = pool === "sim-interactive" ? 30000 : 10000;
      if (body.globalMaxConcurrent !== expectedConcurrent) {
        throw new Error(`${pool} globalMaxConcurrent was ${body.globalMaxConcurrent}, expected ${expectedConcurrent}`);
      }
      if (body.globalTokenBudget !== expectedBudget) {
        throw new Error(`${pool} globalTokenBudget was ${body.globalTokenBudget}, expected ${expectedBudget}`);
      }
    }
  }
  if (!steadyPromotedAt) throw new Error("presenter never promoted enrollment grants");

  const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
  const result = JSON.parse(readFileSync(RESULT_FILE, "utf8"));
  const comparison = JSON.parse(readFileSync(COMPARISON_FILE, "utf8"));

  if (baseline.arm !== "baseline-no-control") throw new Error("baseline arm was not labelled as no control");
  if (baseline.generatorSaturated !== 0) throw new Error("baseline saturated the generator");
  if (result.generatorSaturated !== 0) throw new Error("MoFlux run saturated the generator");
  if (baseline.classes.interactive.localReject + baseline.classes.batch.localReject !== 0) {
    throw new Error("no-control baseline incorrectly reported local admission rejects");
  }
  if (!baseline.scenario?.id || baseline.scenario.id !== result.scenario?.id) {
    throw new Error("baseline and MoFlux result fingerprints differ");
  }
  if (JSON.stringify(baseline.scenario.workload) !== JSON.stringify(result.scenario.workload)) {
    throw new Error("baseline and MoFlux workload definitions differ");
  }
  if (JSON.stringify(baseline.scenario.provider) !== JSON.stringify(result.scenario.provider)) {
    throw new Error("baseline and MoFlux provider definitions differ");
  }
  if (result.scenario.provider.api !== "anthropic") {
    throw new Error("presenter did not exercise the Anthropic progressive-usage path");
  }
  if (!baseline.scenario.trace?.hash || baseline.scenario.trace.hash !== result.scenario.trace?.hash) {
    throw new Error("baseline and MoFlux did not replay the same immutable trace");
  }
  if (baseline.classes.interactive.logical !== baseline.scenario.trace.planned.interactive ||
      baseline.classes.batch.logical !== baseline.scenario.trace.planned.batch) {
    throw new Error("baseline logical request counts do not match the trace");
  }
  if (!(result.classes.batch.success > 0)) {
    throw new Error("dedicated batch capacity did not carry a request");
  }
  if (result.capacity?.profile !== "historical-31-1" ||
      result.capacity?.policy !== "interactive-first-static" ||
      result.capacity?.interactiveConcurrencySlots !== 31 ||
      result.capacity?.batchConcurrencySlots !== 1) {
    throw new Error("presenter did not record the historical 31/1 capacity profile");
  }
  if (result.runtime?.tyr?.version !== "0.24.0" || result.runtime?.latchflo?.version !== "0.10.0") {
    throw new Error("result did not record the Tyr 0.24.0 / Latchflo 0.10.0 runtime");
  }
  if (result.runtime?.asyncBulkheadLlm?.version !== "3.15.1" ||
      result.runtime?.asyncBulkheadTs?.version !== "1.0.1") {
    throw new Error("result did not record the progressive bulkhead dependency versions");
  }
  if (!(result.tokenAccounting?.progressiveEarlyReleasedTokens > 0) ||
      !(result.tokenAccounting?.progressiveEarlyReleaseRate > 0)) {
    throw new Error("result did not record capacity released before request completion");
  }
  if (result.tokenAccounting?.progressiveConfiguration?.updateStepTokens !== 256 ||
      result.tokenAccounting?.progressiveConfiguration?.outputSafetyMarginTokens !== 256) {
    throw new Error("result did not record the pinned progressive reconciliation policy");
  }
  const configuredPools = result.capacity?.pools ?? [];
  if (configuredPools.some((pool) => pool.tokenFundedConcurrency !== pool.maxConcurrent || pool.strandedConcurrency !== 0)) {
    throw new Error("presenter accepted a capacity policy with token-unfunded concurrency");
  }
  const live = result.capacity?.liveGrants ?? [];
  if (live.filter((grant) => grant.pool === "sim-interactive").length !== 4 ||
      live.filter((grant) => grant.pool === "sim-batch").length !== 1) {
    throw new Error("presenter did not validate the 4-interactive/1-batch-pool topology");
  }
  if (comparison.scenario?.id !== baseline.scenario.id) throw new Error("comparison scenario mismatch");
  if (typeof comparison.metrics?.interactiveTailRatioBaseline !== "number") {
    throw new Error("comparison is missing the baseline p95/p50 ratio");
  }
  if (typeof comparison.metrics?.interactiveTailRatioMoflux !== "number") {
    throw new Error("comparison is missing the MoFlux p95/p50 ratio");
  }
  // The stats fixture assigns one pool to each replica. Assert the exact
  // fleet-wide sum so topology-aware accounting cannot silently miss a tier.
  const truth = TYR_TRUTH.reduce(
    (acc, c) => {
      acc.totalReserved += c.totalReserved;
      acc.totalConsumed += c.totalConsumed;
      acc.totalRefunded += c.totalRefunded;
      acc.totalOverrun += c.totalOverrun;
      return acc;
    },
    { totalReserved: 0, totalConsumed: 0, totalRefunded: 0, totalOverrun: 0 },
  );
  for (const key of Object.keys(truth)) {
    const reported = Number(result.tokenAccounting?.[key] ?? 0);
    if (reported !== truth[key]) {
      throw new Error(
        `tokenAccounting.${key} was ${reported}, expected ${truth[key]} ` +
          `(summed over every pool and replica) — a pool is being missed`,
      );
    }
  }
  if (!(result.tokenAccounting?.totalReserved > 0)) throw new Error("missing per-run reservations");
  if (!(result.tokenAccounting?.totalRefunded > 0)) throw new Error("missing per-run refunds");
  if (!(result.tokenAccounting?.grossRecoveryRate > 0)) throw new Error("missing recovery rate");
  console.log("PASS  full no-control -> MoFlux presenter comparison");
} finally {
  if (presenterChild?.exitCode === null) {
    killTree(presenterChild, "SIGTERM");
    await sleep(200);
    if (presenterChild.exitCode === null) killTree(presenterChild, "SIGKILL");
  }
  await Promise.all(servers.map(close));
  rmSync(temp, { recursive: true, force: true });
}
