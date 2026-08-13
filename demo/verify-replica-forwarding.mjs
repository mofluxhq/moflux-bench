#!/usr/bin/env node
/**
 * Regression for replica request/response lifecycle handling.
 *
 * Once readJson(req) has consumed the request body, IncomingMessage `close`
 * must not be treated as a caller disconnect. Modern Node emits that event when
 * the request itself completes normally. Cancellation belongs to the response
 * side: if ServerResponse closes before writableEnded, the caller is gone and
 * the in-flight provider fetch may be aborted.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const replicaSource = readFileSync(path.join(ROOT, "arms", "replica.mjs"), "utf8");
const failures = [];

function check(name, condition, detail = "") {
  if (condition) console.log(`PASS  ${name}`);
  else {
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
}

check(
  "replica does not abort provider work from IncomingMessage close",
  !/req\.(?:on|once)\(\s*["']close["']/.test(replicaSource),
);
check(
  "premature ServerResponse close aborts provider work",
  /res\.(?:on|once)\(\s*["']close["'][\s\S]{0,260}!res\.writableEnded[\s\S]{0,180}controller\.abort\(\)/.test(
    replicaSource,
  ),
);

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

function httpRequest({ port, path: pathname, method = "GET", body = null, destroyAfterMs = null }) {
  return new Promise((resolve, reject) => {
    const headers = { connection: "close" };
    if (body !== null) {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(body);
    }
    const req = request(
      { host: "127.0.0.1", port, path: pathname, method, headers },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, body: text }));
      },
    );
    req.once("error", (error) => {
      if (destroyAfterMs !== null && error?.code === "ECONNRESET") return resolve({ destroyed: true });
      reject(error);
    });
    if (body !== null) req.write(body);
    req.end();
    if (destroyAfterMs !== null) {
      setTimeout(() => req.destroy(), destroyAfterMs).unref?.();
    }
  });
}

async function waitForReplica(port, child) {
  const deadline = Date.now() + 5_000;
  let last = "not started";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`replica exited ${child.exitCode}: ${last}`);
    try {
      const result = await httpRequest({ port, path: "/healthz" });
      if (result.status === 200) return;
      last = `HTTP ${result.status}`;
    } catch (error) {
      last = error?.message ?? String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`replica did not become ready: ${last}`);
}

function metric(text, name) {
  const match = new RegExp(`^${name}\\{[^}]*\\}\\s+([0-9.]+)$`, "m").exec(text);
  return match ? Number(match[1]) : null;
}

async function getMetrics(port) {
  const response = await httpRequest({ port, path: "/metrics" });
  if (response.status !== 200) throw new Error(`metrics returned ${response.status}`);
  return response.body;
}

let provider;
let replica;
try {
  let providerRequests = 0;
  provider = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume */ }
    providerRequests += 1;
    await new Promise((resolve) => setTimeout(resolve, 80));
    if (res.destroyed) return;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const providerPort = await listen(provider);
  const replicaPort = await freePort();

  replica = spawn(
    process.execPath,
    [
      path.join(ROOT, "arms", "replica.mjs"),
      `--port=${replicaPort}`,
      `--upstream=http://127.0.0.1:${providerPort}`,
      "--arm=passthrough",
      "--id=lifecycle-test",
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );

  let childOutput = "";
  replica.stdout.on("data", (chunk) => { childOutput += chunk; });
  replica.stderr.on("data", (chunk) => { childOutput += chunk; });
  await waitForReplica(replicaPort, replica);

  const payload = JSON.stringify({
    model: "sim-model-interactive",
    messages: [{ role: "user", content: "lifecycle regression" }],
    max_tokens: 16,
  });
  const forwarded = await httpRequest({
    port: replicaPort,
    path: "/v1/chat/completions",
    method: "POST",
    body: payload,
  });
  check("completed request body still reaches provider", forwarded.status === 200, JSON.stringify(forwarded));
  check("provider receives the normal request exactly once", providerRequests === 1, String(providerRequests));

  let metrics = await getMetrics(replicaPort);
  check("normal forwarding records one upstream 2xx", metric(metrics, "replica_upstream_2xx_total") === 1);
  check("normal forwarding records no transport error", metric(metrics, "replica_transport_errors_total") === 0);
  check("normal request is not counted as a client disconnect", metric(metrics, "replica_client_disconnects_total") === 0);

  // A real caller disconnect must still cancel/release the in-flight request.
  void httpRequest({
    port: replicaPort,
    path: "/v1/chat/completions",
    method: "POST",
    body: payload,
    destroyAfterMs: 20,
  });

  const deadline = Date.now() + 3_000;
  let disconnectObserved = false;
  while (Date.now() < deadline) {
    metrics = await getMetrics(replicaPort);
    if (
      metric(metrics, "replica_client_disconnects_total") === 1
      && metric(metrics, "replica_in_flight") === 0
    ) {
      disconnectObserved = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  check("real client disconnect is counted and releases admission", disconnectObserved);
  check("client cancellation is not counted as an upstream transport error", metric(metrics, "replica_transport_errors_total") === 0);

  if (replica.exitCode !== null && replica.exitCode !== 0) {
    check("replica remains alive during lifecycle regression", false, childOutput.trim());
  }
} catch (error) {
  check("replica lifecycle integration completes", false, error?.stack ?? String(error));
} finally {
  if (replica && replica.exitCode === null) {
    replica.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      replica.once("close", () => { clearTimeout(timer); resolve(); });
    });
  }
  if (provider) await new Promise((resolve) => provider.close(resolve));
}

console.log();
if (failures.length > 0) {
  console.log(`${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("All checks passed.");
