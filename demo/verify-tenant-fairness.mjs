import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startIdentityFixture } from "./identity-fixture-lib.mjs";
import {
  TENANT_FAIRNESS_POLICY,
  compareTenantFairness,
  tenantFairnessProof,
  tenantPoolDefinition,
  validateAdmissionClassGrantSet,
} from "./tenant-fairness-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(path.join(tmpdir(), "moflux-tenant-fairness-"));
let identity;
let target;

function getJson(url, ca) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { ca }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    });
    req.once("error", reject);
    req.end();
  });
}

function decodePayload(token) {
  const parts = token.split(".");
  assert.equal(parts.length, 3);
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

function startTarget() {
  const seen = [];
  const server = createServer((req, res) => {
    const raw = String(req.headers["x-tyr-identity-token"] ?? "");
    const token = raw.startsWith("Bearer ") ? raw.slice("Bearer ".length) : raw;
    const cls = token === "premium-token" ? "premium" : token === "noisy-token" ? "noisy" : "unknown";
    seen.push({ cls, token });
    req.resume();
    req.on("end", () => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "x-admission-class": cls,
      });
      for (const frame of [
        ["message_start", { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } }],
        ["content_block_delta", { type: "content_block_delta", delta: { type: "text_delta", text: "x" } }],
        ["message_delta", { type: "message_delta", usage: { output_tokens: 1 } }],
        ["message_stop", { type: "message_stop" }],
      ]) {
        res.write(`event: ${frame[0]}\ndata: ${JSON.stringify(frame[1])}\n\n`);
      }
      res.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, seen }));
  });
}

function runLoadgen(port, out) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(ROOT, "load", "loadgen.mjs"),
      `--targets=http://127.0.0.1:${port}`,
      "--provider-api=anthropic",
      "--arm-label=identity-verification",
      "--duration-ms=1200",
      "--interactive-rps=8",
      "--interactive-input-chars=100",
      "--interactive-max-tokens=10",
      "--batch-start-ms=100",
      "--batch-duration-ms=1000",
      "--batch-rps=8",
      "--batch-input-chars=100",
      "--batch-max-tokens=10",
      "--max-attempts=1",
      "--interactive-identity-token=premium-token",
      "--batch-identity-token=noisy-token",
      "--metrics-port=0",
      `--out=${out}`,
    ], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

try {
  identity = await startIdentityFixture(path.join(temp, "identity"), { port: 0 });
  const jwks = await getJson(`${identity.url}/jwks`, readFileSync(identity.tls.ca));
  assert.equal(jwks.status, 200);
  assert.equal(jwks.body.keys.length, 1);
  assert.equal(decodePayload(identity.tokens.premium).tenant_id, "tenant-premium");
  assert.equal(decodePayload(identity.tokens.noisy).tenant_id, "tenant-noisy");

  const shared = tenantPoolDefinition("sim-shared", 120000);
  const isolated = tenantPoolDefinition("sim-isolated", 120000, { isolated: true });
  assert.equal(shared.admissionClassLimits, undefined);
  assert.deepEqual(isolated.admissionClassLimits, TENANT_FAIRNESS_POLICY.admissionClasses);
  const grants = [0, 1, 2, 3].map(() => ({
    pool: "sim-isolated",
    limits: { admissionClasses: {
      premium: { maxConcurrent: 2, maxInFlightTokens: 4000 },
      noisy: { maxConcurrent: 6, maxInFlightTokens: 12000 },
    } },
  }));
  assert.deepEqual(validateAdmissionClassGrantSet(grants), {
    premium: { maxConcurrent: 8, maxInFlightTokens: 16000 },
    noisy: { maxConcurrent: 24, maxInFlightTokens: 48000 },
  });

  const fakeShared = {
    trace: { hash: "same" },
    classes: {
      interactive: { successRate: 0.6, upstreamReject: 0, windows: { contended: { goodputRps: 2, ttftP95Ms: 1000 } } },
      batch: { successRate: 0.8, upstreamReject: 0 },
    },
  };
  const fakeIsolated = {
    trace: { hash: "same" },
    classes: {
      interactive: {
        successRate: 0.95,
        upstreamReject: 0,
        admissionClassResponses: { premium: 20 },
        windows: { contended: { goodputRps: 5, ttftP95Ms: 300 } },
      },
      batch: {
        successRate: 0.5,
        upstreamReject: 0,
        localReject: 9,
        admissionClassResponses: { noisy: 20 },
      },
    },
  };
  assert.equal(tenantFairnessProof(compareTenantFairness(fakeShared, fakeIsolated)).passed, true);

  target = await startTarget();
  const out = path.join(temp, "loadgen.json");
  const result = await runLoadgen(target.port, out);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  const summaryText = readFileSync(out, "utf8");
  assert.equal(summaryText.includes("premium-token"), false, "identity token leaked into summary");
  assert.equal(summaryText.includes("noisy-token"), false, "identity token leaked into summary");
  const summary = JSON.parse(summaryText);
  assert.equal(summary.config.interactiveIdentityToken, "provided");
  assert.equal(summary.config.batchIdentityToken, "provided");
  assert.ok(summary.classes.interactive.admissionClassResponses.premium > 0);
  assert.ok(summary.classes.batch.admissionClassResponses.noisy > 0);
  assert.ok(target.seen.some((row) => row.cls === "premium"));
  assert.ok(target.seen.some((row) => row.cls === "noisy"));

  for (let replica = 1; replica <= 4; replica += 1) {
    const yaml = readFileSync(path.join(ROOT, "demo", "classes", `tyr-r${replica}.yaml`), "utf8");
    assert.match(yaml, /version: 0\.21\.0/);
    assert.match(yaml, /defaultClass: noisy/);
    assert.match(yaml, /tenantIds: \[tenant-premium\]/);
    assert.match(yaml, /jwksUrl: https:\/\/host\.docker\.internal:9010\/jwks/);
  }
  console.log("PASS  tenant-fairness policy, identity fixture, loadgen attribution, and proof checks");
} finally {
  if (target) await new Promise((resolve) => target.server.close(resolve));
  if (identity) await identity.close().catch(() => {});
  rmSync(temp, { recursive: true, force: true });
}
