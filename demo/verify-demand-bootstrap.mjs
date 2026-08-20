#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapCapacityGroup, findFreshDemandReport } from "./demand-bootstrap-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const live = Object.freeze({
  name: "adaptive-28-4",
  globalMaxConcurrent: 32,
  globalTokenBudget: 64_000,
  demandPolicy: Object.freeze({
    enabled: true,
    reportStaleAfterMs: 6_000,
    idleAfterMs: 3_000,
    maxStarvationMs: 5_000,
  }),
  members: Object.freeze([
    Object.freeze({ pool: "sim-interactive", guaranteedMaxConcurrent: 28, guaranteedTokenBudget: 24_000 }),
    Object.freeze({ pool: "sim-batch", guaranteedMaxConcurrent: 4, guaranteedTokenBudget: 40_000 }),
  ]),
});

const bootstrap = bootstrapCapacityGroup(live);
assert.notEqual(bootstrap, live);
assert.equal(bootstrap.name, live.name);
assert.equal(bootstrap.globalMaxConcurrent, 32);
assert.equal(bootstrap.globalTokenBudget, 64_000);
assert.deepEqual(bootstrap.members, live.members);
assert.equal(bootstrap.demandPolicy.enabled, false);
assert.equal(bootstrap.demandPolicy.idleAfterMs, 3_000);
assert.equal(live.demandPolicy.enabled, true, "bootstrap must not mutate the measured policy");

const liveHeadroom = Object.freeze({
  ...live,
  members: Object.freeze([
    Object.freeze({
      ...live.members[0],
      headroomLending: Object.freeze({
        minConcurrentHeadroom: 4,
        minTokenHeadroom: 4_000,
        demandingSustainMs: 3_000,
        maxDemandingConcurrentLend: 2,
        maxDemandingTokenLend: 10_000,
      }),
    }),
    live.members[1],
  ]),
});
const bootstrapHeadroom = bootstrapCapacityGroup(liveHeadroom);
assert.equal(bootstrapHeadroom.demandPolicy.enabled, false);
assert.equal(
  bootstrapHeadroom.members[0].headroomLending,
  undefined,
  "bootstrap must not send headroomLending while demandPolicy is disabled",
);
assert.equal(bootstrapHeadroom.members[0].guaranteedMaxConcurrent, 28);
assert.equal(bootstrapHeadroom.members[0].guaranteedTokenBudget, 24_000);
assert.equal(
  bootstrapHeadroom.members[1],
  liveHeadroom.members[1],
  "members without headroom lending should remain unchanged",
);
assert.deepEqual(
  liveHeadroom.members[0].headroomLending,
  {
    minConcurrentHeadroom: 4,
    minTokenHeadroom: 4_000,
    demandingSustainMs: 3_000,
    maxDemandingConcurrentLend: 2,
    maxDemandingTokenLend: 10_000,
  },
  "bootstrap must not mutate the measured headroom policy",
);

const startedAt = Date.parse("2026-08-10T22:00:00.000Z");
const reports = [
  { pool: "sim-interactive", hasDemand: true, receivedAt: "2026-08-10T21:59:59.999Z" },
  { pool: "sim-interactive", hasDemand: false, receivedAt: "2026-08-10T22:00:01.000Z" },
  { pool: "sim-batch", hasDemand: true, receivedAt: "2026-08-10T22:00:02.000Z" },
  { pool: "sim-interactive", hasDemand: true, receivedAt: "2026-08-10T22:00:03.000Z" },
];
assert.equal(findFreshDemandReport(reports, { pool: "sim-interactive", sinceMs: startedAt }), reports[3]);
assert.equal(findFreshDemandReport(reports.slice(0, 3), { pool: "sim-interactive", sinceMs: startedAt }), null);
assert.equal(findFreshDemandReport([], { pool: "sim-interactive", sinceMs: startedAt }), null);

const presenter = readFileSync(path.join(ROOT, "demo", "present.mjs"), "utf8");
assert.match(
  presenter,
  /capacityGroup:\s*BOOTSTRAP_CAPACITY_GROUP/g,
  "presenter must install the bootstrap-safe group during enrollment and steady-grant promotion",
);
assert.match(
  presenter,
  /activateDemandAwareLending\(env\.LATCHFLO_ADMIN_TOKEN, measuredRunStartedAtMs, loadgen\)/,
  "presenter must arm measured lending only while the load generator is running",
);
assert.match(
  presenter,
  /load generator exited before demand-aware lending was armed/,
  "presenter must fail rather than arm lending after the measured run has ended",
);
assert.match(
  presenter,
  /findFreshDemandReport\([\s\S]*sinceMs:\s*measuredRunStartedAtMs/,
  "activation must require demand observed after the measured run starts",
);

console.log("PASS  demand-aware bootstrap keeps protected grants until fresh measured demand arms lending");
