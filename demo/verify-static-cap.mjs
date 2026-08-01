#!/usr/bin/env node
/**
 * Regression for Arm 2's fleet-to-local concurrency calculation.
 *
 * The v0.9.0 presenter originally divided by `OPT.replicas`, an option that
 * did not exist in that code path. The resulting `NaN` local cap made every
 * semaphore comparison false, yielding zero provider activity with no startup
 * error. This test keeps the arithmetic explicit and verifies the replica
 * rejects a non-finite cap before it can emit benchmark evidence.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dividedStaticCap } from "./control-arm-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

assert.equal(dividedStaticCap({ envelope: 32, replicaCount: 4 }), 8);
assert.equal(dividedStaticCap({ envelope: 31, replicaCount: 4 }), 7);
assert.throws(
  () => dividedStaticCap({ envelope: 32, replicaCount: undefined }),
  /positive integer replica count/,
);
assert.throws(
  () => dividedStaticCap({ envelope: 3, replicaCount: 4 }),
  /local cap would be zero/,
);
console.log("PASS  Arm 2 divides a 32-slot envelope into four 8-slot local caps");
console.log("PASS  Arm 2 rejects missing and zero-slot topology inputs");

const invalid = spawnSync(
  process.execPath,
  [
    path.join(ROOT, "arms", "replica.mjs"),
    "--arm=static-cap",
    "--port=65534",
    "--max-concurrent=NaN",
  ],
  { cwd: ROOT, encoding: "utf8" },
);
assert.equal(invalid.status, 2);
assert.match(`${invalid.stdout}\n${invalid.stderr}`, /invalid --max-concurrent=NaN/);
console.log("PASS  the Arm 2 replica fails fast on a non-finite concurrency cap");

console.log("All checks passed.");
