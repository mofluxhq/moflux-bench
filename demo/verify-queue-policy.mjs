#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MOFLUX_QUEUE_POLICY, maxQueuePerAgentForPool } from "./queue-policy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

assert.deepEqual(MOFLUX_QUEUE_POLICY["sim-interactive"], {
  maxQueuePerAgent: 1,
  queueTimeoutMs: 750,
});
assert.deepEqual(MOFLUX_QUEUE_POLICY["sim-batch"], { maxQueuePerAgent: 0 });
assert.equal(maxQueuePerAgentForPool("sim-interactive"), 1);
assert.equal(maxQueuePerAgentForPool("sim-batch"), 0);
assert.equal(maxQueuePerAgentForPool("unknown"), 0, "unknown pools must fail closed to no queue");

function poolBlock(yaml, poolName) {
  const escaped = poolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^  - name: ${escaped}\\n(?:(?!^  - name: )[\\s\\S])*?(?=^  - name: |^routing:)`,
    "m",
  ).exec(yaml)?.[0] ?? "";
}

for (let replica = 1; replica <= 4; replica += 1) {
  const file = path.join(ROOT, "demo", "moflux", `tyr-r${replica}.yaml`);
  const yaml = readFileSync(file, "utf8");
  const interactive = poolBlock(yaml, "sim-interactive");
  assert.ok(interactive, `${path.basename(file)} is missing sim-interactive`);
  assert.match(
    interactive,
    /^    maxQueue: 0$/m,
    `${path.basename(file)} must start at zero queue until Latchflo grants managed capacity`,
  );
  assert.match(
    interactive,
    /^    queueTimeoutMs: 750$/m,
    `${path.basename(file)} must pin the 750 ms interactive queue timeout`,
  );

  const batch = poolBlock(yaml, "sim-batch");
  if (replica === 4) {
    assert.ok(batch, "tyr-r4 must carry sim-batch");
    assert.match(batch, /^    maxQueue: 0$/m, "sim-batch must remain fail-fast");
    assert.doesNotMatch(batch, /^    queueTimeoutMs:/m, "sim-batch must not opt into waiting");
  } else {
    assert.equal(batch, "", `${path.basename(file)} must not carry sim-batch`);
  }
}

console.log("PASS  MoFlux queue policy keeps one bounded interactive waiter and fail-fast batch");
