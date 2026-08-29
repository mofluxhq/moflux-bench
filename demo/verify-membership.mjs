#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ADMIN = "membership-admin-test";
const BOOTSTRAP = "membership-bootstrap-test";
const AGENT_TIMEOUT_MS = 220;
const agents = new Map();
let revision = 0;
let tokenSequence = 0;

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function auth(req) {
  return req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
}

function activeMembers() {
  const now = Date.now();
  let changed = false;
  for (const agent of agents.values()) {
    if (agent.active && now - agent.lastHeartbeatAt > AGENT_TIMEOUT_MS) {
      agent.active = false;
      changed = true;
    }
  }
  if (changed) revision += 1;
  return [...agents.values()]
    .filter((agent) => agent.active && agent.endpoint)
    .sort((a, b) => a.instanceId.localeCompare(b.instanceId))
    .map(({ instanceId, endpoint }) => ({ instanceId, endpoint }));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/readyz") return json(res, 200, { ok: true });
  if (req.method === "POST" && url.pathname === "/v1/pools") {
    assert.equal(auth(req), ADMIN);
    for await (const _chunk of req) { /* drain */ }
    return json(res, 201, { name: "ok" });
  }
  if (req.method === "POST" && url.pathname === "/v1/agents/register") {
    assert.equal(auth(req), BOOTSTRAP);
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const endpoint = body.metadata?.endpoint;
    const existing = agents.get(body.instanceId);
    const membershipChanged = !existing || !existing.active || existing.endpoint !== endpoint;
    const token = `agent-token-${++tokenSequence}`;
    agents.set(body.instanceId, {
      instanceId: body.instanceId,
      endpoint,
      token,
      active: true,
      lastHeartbeatAt: Date.now(),
    });
    if (membershipChanged) revision += 1;
    return json(res, 201, {
      agent: { instanceId: body.instanceId },
      agentToken: token,
      controllerEpoch: 1,
      heartbeatIntervalMs: 50,
      pollIntervalMs: 20,
      grants: [],
    });
  }
  const heartbeat = /^\/v1\/agents\/([^/]+)\/heartbeat$/.exec(url.pathname);
  if (req.method === "POST" && heartbeat) {
    const id = decodeURIComponent(heartbeat[1]);
    const agent = agents.get(id);
    assert.ok(agent);
    assert.equal(auth(req), agent.token);
    for await (const _chunk of req) { /* drain */ }
    if (!agent.active) {
      agent.active = true;
      revision += 1;
    }
    agent.lastHeartbeatAt = Date.now();
    return json(res, 200, { ok: true });
  }
  const desired = /^\/v1\/agents\/([^/]+)\/desired-state$/.exec(url.pathname);
  if (req.method === "GET" && desired) {
    const id = decodeURIComponent(desired[1]);
    const agent = agents.get(id);
    assert.ok(agent);
    assert.equal(auth(req), agent.token);
    const members = activeMembers();
    return json(res, 200, {
      controllerEpoch: 1,
      serverTime: new Date().toISOString(),
      heartbeatIntervalMs: 50,
      pollIntervalMs: 20,
      grants: [],
      routingTopology: { revision, members },
    });
  }
  json(res, 404, { error: "not found" });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
const temp = mkdtempSync(path.join(os.tmpdir(), "moflux-membership-verify-"));
const out = path.join(temp, "summary.json");
try {
  const child = spawn(process.execPath, [
    path.join(ROOT, "demo", "membership.mjs"),
    "--manage-stack=false",
    "--runs=1",
    `--base-url=http://127.0.0.1:${address.port}`,
    `--agent-timeout-ms=${AGENT_TIMEOUT_MS}`,
    "--poll-ms=20",
    `--out=${out}`,
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      LATCHFLO_ADMIN_TOKEN: ADMIN,
      LATCHFLO_AGENT_BOOTSTRAP_TOKEN: BOOTSTRAP,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, 0, `${stdout}\n${stderr}`);
  const summary = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(summary.acceptance.passed, true);
  assert.equal(summary.acceptance.completedRuns, 1);
  assert.equal(summary.runs[0].removalRevision, summary.runs[0].initialRevision + 1);
  assert.equal(summary.runs[0].joinRevision, summary.runs[0].removalRevision + 1);
  assert.equal(summary.runs[0].finalRevision, summary.runs[0].joinRevision);
  assert.ok(summary.runs[0].removalLatencyMs >= AGENT_TIMEOUT_MS - 50);
  assert.ok(summary.runs[0].joinPropagationMs < 500);
  console.log("PASS membership benchmark harness verifies join, timeout removal, replacement, and revision stability");
} finally {
  await new Promise((resolve) => server.close(resolve));
  rmSync(temp, { recursive: true, force: true });
}
