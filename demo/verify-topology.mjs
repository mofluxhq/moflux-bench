#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const family of ["moflux", "classes"]) {
  for (let replica = 1; replica <= 4; replica += 1) {
    const file = path.join(ROOT, "demo", family, `tyr-r${replica}.yaml`);
    const yaml = readFileSync(file, "utf8");
    assert.match(yaml, /^    version: 0\.29\.0$/m, `${path.basename(file)} must advertise Tyr 0.29.0`);
    assert.match(yaml, new RegExp(`^    instanceId: tyr-r${replica}$`, "m"), `${path.basename(file)} routing identity mismatch`);
    assert.match(yaml, /^    peers: \[\]$/m, `${path.basename(file)} must start with no static peers`);
    assert.doesNotMatch(yaml, /^      - id: tyr-r\d+$/m, `${path.basename(file)} must not publish a static peer list`);
    assert.match(yaml, new RegExp(`^    endpoint: http://tyr-r${replica}:8787$`, "m"), `${path.basename(file)} must advertise its routable endpoint to Latchflo`);
  }
}

console.log("PASS  dynamic Latchflo topology configs advertise endpoints and contain no static peers");
