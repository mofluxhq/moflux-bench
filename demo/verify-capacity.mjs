import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reservationBounds, validateCapacityPlan } from "./capacity-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const interactive = reservationBounds({ inputChars: 1200, maxTokens: 400 });
const batch = reservationBounds({ inputChars: 24000, maxTokens: 3000 });
assert.equal(interactive.initial, 708);
assert.equal(interactive.adaptiveCeiling, 755);
assert.equal(batch.initial, 9008);
assert.equal(batch.adaptiveCeiling, 9942);

const valid = validateCapacityPlan({
  pools: [
    { name: "sim-interactive", maxConcurrent: 31, tokenBudget: 30000, agentCount: 4 },
    { name: "sim-batch", maxConcurrent: 1, tokenBudget: 10000, agentCount: 1 },
  ],
  requirements: { "sim-interactive": interactive, "sim-batch": batch },
});
assert.equal(valid[0].minimumLocalTokenGrant, 7500);
assert.equal(valid[0].tokenFundedConcurrency, 31);
assert.equal(valid[0].strandedConcurrency, 0);
assert.deepEqual(valid[0].localGrants.map((grant) => grant.maxConcurrent), [8, 8, 8, 7]);
assert.equal(valid[1].minimumLocalTokenGrant, 10000);
assert.equal(valid[1].tokenFundedConcurrency, 1);
assert.equal(valid[1].strandedConcurrency, 0);

const lending = validateCapacityPlan({
  pools: [
    { name: "sim-interactive", maxConcurrent: 28, tokenBudget: 24000, agentCount: 4 },
    { name: "sim-batch", maxConcurrent: 4, tokenBudget: 40000, agentCount: 1 },
  ],
  requirements: { "sim-interactive": interactive, "sim-batch": batch },
});
assert.deepEqual(lending[0].localGrants.map((grant) => grant.maxConcurrent), [7, 7, 7, 7]);
assert.equal(lending[0].tokenFundedConcurrency, 28);
assert.equal(lending[1].tokenFundedConcurrency, 4);
assert.equal(lending[0].strandedConcurrency + lending[1].strandedConcurrency, 0);

assert.throws(
  () => validateCapacityPlan({
    pools: [
      { name: "sim-interactive", maxConcurrent: 24, tokenBudget: 30000, agentCount: 4 },
      { name: "sim-batch", maxConcurrent: 8, tokenBudget: 10000, agentCount: 1 },
    ],
    requirements: { "sim-interactive": interactive, "sim-batch": batch },
  }),
  /sim-batch configures 8 concurrency slots.*funds only 1; 7 slots are stranded/s,
);

assert.throws(
  () => validateCapacityPlan({
    pools: [
      { name: "sim-interactive", maxConcurrent: 31, tokenBudget: 30000, agentCount: 4 },
      { name: "sim-batch", maxConcurrent: 1, tokenBudget: 10000, agentCount: 4 },
    ],
    requirements: { "sim-interactive": interactive, "sim-batch": batch },
  }),
  /leaving at least one agent with no usable slot/,
);

const invalidTokenShare = spawnSync(
  process.execPath,
  [
    path.join(ROOT, "demo", "present.mjs"),
    "--mode=doctor",
    "--batch-concurrency-slots=1",
    "--batch-token-percent=24",
  ],
  { cwd: ROOT, encoding: "utf8" },
);
assert.notEqual(invalidTokenShare.status, 0);
assert.match(
  `${invalidTokenShare.stdout}${invalidTokenShare.stderr}`,
  /minimum local grant 9600.*one request can require 9942/s,
);

const conflictingFlags = spawnSync(
  process.execPath,
  [
    path.join(ROOT, "demo", "present.mjs"),
    "--mode=doctor",
    "--batch-concurrency-slots=1",
    "--batch-concurrency-percent=25",
  ],
  { cwd: ROOT, encoding: "utf8" },
);
assert.notEqual(conflictingFlags.status, 0);
assert.match(
  `${conflictingFlags.stdout}${conflictingFlags.stderr}`,
  /cannot be combined/,
);

console.log("PASS  capacity plans fully fund both the canonical 31/1 policy and the 28/4 lending policy");
