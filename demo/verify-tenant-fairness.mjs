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
  summarizeAdaptiveClassHandoff,
  summarizeAdaptiveLendingSamples,
  tenantFairnessProof,
  tenantPoolDefinition,
  validateAdmissionClassCeilings,
  validateAdmissionClassGrantSet,
  validateNoisyRequestFitsEveryGrant,
} from "./tenant-fairness-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tenantRunnerSource = readFileSync(path.join(ROOT, "demo", "tenant-fairness.mjs"), "utf8");
assert.match(tenantRunnerSource, /for \(const seed of OPT\.seeds\) \{[\s\S]*?bootstrapTenantStack\(adminToken\)/);
assert.match(tenantRunnerSource, /async function bootstrapTenantStack\(adminToken\) \{[\s\S]*?compose\("down", "--volumes", "--remove-orphans"\)/);
assert.match(tenantRunnerSource, /waitForAdaptiveNoisyFloorLent\(adminToken\)/);
assert.match(tenantRunnerSource, /waitForAdaptiveNoisyFloorRestored\([\s\S]*?sampledAdaptiveObservation/);
assert.equal(TENANT_FAIRNESS_POLICY.adaptive.restorationObserveTimeoutMs, 15_000);
assert.match(tenantRunnerSource, /policy: classGrants, seeds: OPT\.seeds/);
assert.doesNotMatch(tenantRunnerSource, /policy: fleet\.aggregate, seeds: OPT\.seeds/);
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

function fakeSummary({ hash = "same", premiumClass, noisyClass, noisyCompleted = 8, noisyRejects = 9 }) {
  return {
    trace: { hash },
    classes: {
      interactive: {
        successRate: 0.9,
        upstreamReject: 0,
        admissionClassResponses: premiumClass ? { premium: 20 } : {},
        windows: { contended: { completed: 20, goodputRps: 4, ttftP95Ms: 300 } },
      },
      batch: {
        successRate: 0.5,
        upstreamReject: 0,
        localReject: noisyRejects,
        admissionClassResponses: noisyClass ? { noisy: 20 } : {},
        windows: {
          contended: {
            completed: noisyCompleted,
            goodputRps: noisyCompleted / 5,
            ttftP95Ms: 800,
          },
        },
      },
    },
  };
}

function adaptiveSample(offsetMs, { lent = false, demanding = false, pending = false, restored = false } = {}) {
  const nominal = { protectedConcurrent: 4, protectedInFlightTokens: 36000 };
  const active = lent && !restored
    ? { protectedConcurrent: 0, protectedInFlightTokens: 0 }
    : nominal;
  const released = lent && !restored
    ? nominal
    : { protectedConcurrent: 0, protectedInFlightTokens: 0 };
  return {
    offsetMs,
    controller: {
      pool: "sim-adaptive",
      enabled: true,
      classes: [{
        admissionClass: "noisy",
        demand: {
          state: demanding ? "demanding" : "idle",
          inFlight: demanding ? 1 : 0,
          recentAdmissions: demanding ? 1 : 0,
          recentRejections: 0,
        },
        nominal,
        active,
        released,
        restorationPending: pending,
      }],
    },
    applied: {
      noisy: {
        protectedConcurrent: active.protectedConcurrent,
        maxConcurrent: 24,
        protectedInFlightTokens: active.protectedInFlightTokens,
        maxInFlightTokens: 64000,
      },
    },
  };
}

try {
  identity = await startIdentityFixture(path.join(temp, "identity"), { port: 0 });
  const jwks = await getJson(`${identity.url}/jwks`, readFileSync(identity.tls.ca));
  assert.equal(jwks.status, 200);
  assert.equal(jwks.body.keys.length, 1);
  assert.equal(decodePayload(identity.tokens.premium).tenant_id, "tenant-premium");
  assert.equal(decodePayload(identity.tokens.noisy).tenant_id, "tenant-noisy");

  const steadyTtlMs = TENANT_FAIRNESS_POLICY.adaptive.grantTtlMs;
  const shared = tenantPoolDefinition("sim-shared", steadyTtlMs);
  const ceilings = tenantPoolDefinition("sim-ceilings", steadyTtlMs, { classPolicy: "ceilings" });
  const protectedPool = tenantPoolDefinition("sim-protected", steadyTtlMs, { classPolicy: "protected" });
  const adaptivePool = tenantPoolDefinition(
    "sim-adaptive",
    TENANT_FAIRNESS_POLICY.adaptive.grantTtlMs,
    { classPolicy: "adaptive" },
  );
  assert.equal(shared.admissionClassLimits, undefined);
  assert.deepEqual(ceilings.admissionClassLimits, TENANT_FAIRNESS_POLICY.classPolicies.ceilings);
  assert.deepEqual(protectedPool.admissionClassLimits, TENANT_FAIRNESS_POLICY.classPolicies.protected);
  assert.deepEqual(adaptivePool.admissionClassLimits, TENANT_FAIRNESS_POLICY.classPolicies.adaptive);
  assert.deepEqual(adaptivePool.admissionClassDemandPolicy, {
    enabled: true,
    reportStaleAfterMs: 5000,
    idleAfterMs: 1000,
  });

  const ceilingsGrants = [0, 1, 2, 3].map(() => ({
    pool: "sim-ceilings",
    limits: { admissionClasses: {
      premium: {
        protectedConcurrent: 0,
        maxConcurrent: 2,
        protectedInFlightTokens: 0,
        maxInFlightTokens: 16000,
      },
      noisy: {
        protectedConcurrent: 0,
        maxConcurrent: 6,
        protectedInFlightTokens: 0,
        maxInFlightTokens: 16000,
      },
    } },
  }));
  const protectedGrants = [0, 1, 2, 3].map(() => ({
    pool: "sim-protected",
    limits: { admissionClasses: {
      premium: {
        protectedConcurrent: 1,
        maxConcurrent: 2,
        protectedInFlightTokens: 2000,
        maxInFlightTokens: 16000,
      },
      noisy: {
        protectedConcurrent: 1,
        maxConcurrent: 6,
        protectedInFlightTokens: 9000,
        maxInFlightTokens: 16000,
      },
    } },
  }));
  const adaptiveLentGrants = [0, 1, 2, 3].map(() => ({
    pool: "sim-adaptive",
    limits: { admissionClasses: {
      premium: {
        protectedConcurrent: 0,
        maxConcurrent: 2,
        protectedInFlightTokens: 0,
        maxInFlightTokens: 16000,
      },
      noisy: {
        protectedConcurrent: 0,
        maxConcurrent: 6,
        protectedInFlightTokens: 0,
        maxInFlightTokens: 16000,
      },
    } },
  }));

  assert.deepEqual(validateAdmissionClassGrantSet(
    ceilingsGrants,
    "sim-ceilings",
    "ceilings",
  ), {
    premium: {
      protectedConcurrent: 0,
      maxConcurrent: 8,
      protectedInFlightTokens: 0,
      maxInFlightTokens: 64000,
    },
    noisy: {
      protectedConcurrent: 0,
      maxConcurrent: 24,
      protectedInFlightTokens: 0,
      maxInFlightTokens: 64000,
    },
  });
  assert.deepEqual(validateAdmissionClassGrantSet(
    protectedGrants,
    "sim-protected",
    "protected",
  ), {
    premium: {
      protectedConcurrent: 4,
      maxConcurrent: 8,
      protectedInFlightTokens: 8000,
      maxInFlightTokens: 64000,
    },
    noisy: {
      protectedConcurrent: 4,
      maxConcurrent: 24,
      protectedInFlightTokens: 36000,
      maxInFlightTokens: 64000,
    },
  });
  assert.deepEqual(validateAdmissionClassCeilings(
    adaptiveLentGrants,
    "sim-adaptive",
    "adaptive",
  ), {
    premium: {
      protectedConcurrent: 0,
      maxConcurrent: 8,
      protectedInFlightTokens: 0,
      maxInFlightTokens: 64000,
    },
    noisy: {
      protectedConcurrent: 0,
      maxConcurrent: 24,
      protectedInFlightTokens: 0,
      maxInFlightTokens: 64000,
    },
  });
  assert.equal(validateNoisyRequestFitsEveryGrant(adaptiveLentGrants, "sim-adaptive"), true);

  assert.equal(validateNoisyRequestFitsEveryGrant(ceilingsGrants, "sim-ceilings"), true);
  assert.equal(validateNoisyRequestFitsEveryGrant(
    protectedGrants,
    "sim-protected",
    { requireProtected: true },
  ), true);
  const fragmented = structuredClone(protectedGrants);
  fragmented[0].limits.admissionClasses.noisy.protectedInFlightTokens = 7000;
  assert.throws(
    () => validateNoisyRequestFitsEveryGrant(
      fragmented,
      "sim-protected",
      { requireProtected: true },
    ),
    /one protected request needs at least 8000/,
  );

  const fakeShared = fakeSummary({ premiumClass: false, noisyClass: false });
  const fakeCeilings = fakeSummary({ premiumClass: true, noisyClass: true });
  const fakeProtected = fakeSummary({ premiumClass: true, noisyClass: true });
  const fakeAdaptive = fakeSummary({ premiumClass: true, noisyClass: true });
  const adaptiveLending = summarizeAdaptiveLendingSamples([
    adaptiveSample(0, { lent: true }),
    adaptiveSample(5500, { lent: true, demanding: true, pending: true }),
    adaptiveSample(8000, { demanding: true, restored: true }),
  ]);
  assert.equal(adaptiveLending.noisyFloorLent, true);
  assert.equal(adaptiveLending.noisyDemandObservedAfterLending, true);
  assert.equal(adaptiveLending.noisyFloorRestored, true);
  assert.equal(adaptiveLending.hardCeilingsPreservedWhileLent, true);
  assert.equal(adaptiveLending.restorationLatencyMs, 2500);

  const neverLent = summarizeAdaptiveLendingSamples([
    adaptiveSample(0),
    adaptiveSample(5500, { demanding: true }),
    adaptiveSample(8000, { demanding: true, restored: true }),
  ]);
  assert.equal(neverLent.noisyFloorLent, false);
  assert.equal(neverLent.noisyDemandObservedAfterLending, false);
  assert.equal(neverLent.noisyFloorRestored, false);
  assert.equal(neverLent.restorationLatencyMs, null);

  const handoffStartedAt = 1_000_000;
  const sourceGrants = [1, 2, 3, 4].map((index) => ({
    grantId: `source-${index}`,
    expiresAt: new Date(handoffStartedAt + 120_000 + index).toISOString(),
  }));
  const targetGrant = (index) => ({
    grantId: `drain-${index}`,
    instanceId: `tyr-r${index}`,
    role: "drain",
    fromGrantId: `source-${index}`,
    limits: { admissionClasses: { noisy: {
      protectedConcurrent: 1,
      maxConcurrent: 6,
      protectedInFlightTokens: 9_000,
      maxInFlightTokens: 16_000,
    } } },
  });
  const handoffEvents = [
    {
      type: "admission_class.handoff_prepared",
      entityId: "sim-adaptive",
      createdAt: new Date(handoffStartedAt + 5_600).toISOString(),
      payload: { handoffId: "handoff-1", grants: [1, 2, 3, 4].map(targetGrant) },
    },
    ...[1, 2, 3, 4].map((index) => ({
      type: "admission_class.handoff_grant_applied",
      entityId: `drain-${index}`,
      createdAt: new Date(handoffStartedAt + 5_700 + index).toISOString(),
      payload: { handoffId: "handoff-1", pool: "sim-adaptive" },
    })),
    {
      type: "admission_class.handoff_committed",
      entityId: "sim-adaptive",
      createdAt: new Date(handoffStartedAt + 6_000).toISOString(),
      payload: { handoffId: "handoff-1" },
    },
  ];
  const adaptiveHandoff = summarizeAdaptiveClassHandoff(
    handoffEvents,
    sourceGrants,
    handoffStartedAt,
  );
  assert.equal(adaptiveHandoff.handoffPrepared, true);
  assert.equal(adaptiveHandoff.allDrainAcksApplied, true);
  assert.equal(adaptiveHandoff.handoffCommitted, true);
  assert.equal(adaptiveHandoff.handoffAborted, false);
  assert.equal(adaptiveHandoff.committedBeforeLeaseExpiry, true);
  assert.ok(adaptiveHandoff.leaseAvoidedMs > 100_000);
  const missingAckHandoff = summarizeAdaptiveClassHandoff(
    handoffEvents.filter((event) => event.entityId !== "drain-4"),
    sourceGrants,
    handoffStartedAt,
  );
  assert.equal(missingAckHandoff.allDrainAcksApplied, false);
  assert.equal(
    tenantFairnessProof(
      compareTenantFairness(fakeShared, fakeCeilings, fakeProtected, fakeAdaptive),
      adaptiveLending,
      missingAckHandoff,
    ).passed,
    false,
    "a class handoff missing one drain acknowledgement must not pass",
  );
  const expiredSourceGrants = sourceGrants.map((grant, index) => ({
    ...grant,
    expiresAt: new Date(handoffStartedAt + 5_900 + index).toISOString(),
  }));
  const lateHandoff = summarizeAdaptiveClassHandoff(
    handoffEvents,
    expiredSourceGrants,
    handoffStartedAt,
  );
  assert.equal(lateHandoff.committedBeforeLeaseExpiry, false);
  assert.equal(
    tenantFairnessProof(
      compareTenantFairness(fakeShared, fakeCeilings, fakeProtected, fakeAdaptive),
      adaptiveLending,
      lateHandoff,
    ).passed,
    false,
    "a class handoff that commits after source lease expiry must not pass",
  );
  assert.equal(
    tenantFairnessProof(
      compareTenantFairness(fakeShared, fakeCeilings, fakeProtected, fakeAdaptive),
      adaptiveLending,
      adaptiveHandoff,
    ).passed,
    true,
  );
  const starved = fakeSummary({
    premiumClass: true,
    noisyClass: true,
    noisyCompleted: 0,
    noisyRejects: 20,
  });
  const starvedProof = tenantFairnessProof(
    compareTenantFairness(fakeShared, fakeCeilings, fakeProtected, starved),
    adaptiveLending,
    adaptiveHandoff,
  );
  assert.equal(starvedProof.passed, false, "zero noisy completions must never pass fairness");
  assert.equal(starvedProof.checks.noisyServedUnderContention, false);
  assert.equal(starvedProof.checks.noisyMinimumCompletions, false);

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
    assert.match(yaml, /version: 0\.27\.0/);
    assert.match(yaml, /name: sim-ceilings/);
    assert.match(yaml, /name: sim-protected/);
    assert.match(yaml, /name: sim-adaptive/);
    assert.match(yaml, /defaultClass: noisy/);
    assert.match(yaml, /tenantIds: \[tenant-premium\]/);
    assert.match(yaml, /protectedConcurrent: 0/);
    assert.match(yaml, /protectedInFlightTokens: 0/);
    assert.match(yaml, /jwksUrl: https:\/\/host\.docker\.internal:9010\/jwks/);
  }
  console.log("PASS  four-arm tenant fairness, pre-expiry class handoff proof, feasible grants, starvation rejection, and identity attribution");
} finally {
  if (target) await new Promise((resolve) => target.server.close(resolve));
  if (identity) await identity.close().catch(() => {});
  rmSync(temp, { recursive: true, force: true });
}
