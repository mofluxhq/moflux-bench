#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registrations = { "sim-interactive": 0, "sim-batch": 0 };

for (let replica = 1; replica <= 4; replica += 1) {
  const file = path.join(ROOT, "demo", "moflux", `tyr-r${replica}.yaml`);
  const yaml = readFileSync(file, "utf8");
  assert.match(yaml, /^    version: 0\.20\.0$/m, `${path.basename(file)} must advertise Tyr 0.20.0`);
  assert.doesNotMatch(yaml, /0\.18\.0/, `${path.basename(file)} contains stale Tyr 0.18.0 metadata`);
  assert.match(yaml, /^  anthropic:\n    baseUrl: http:\/\/host\.docker\.internal:9000$/m, `${path.basename(file)} must expose the Anthropic simulator upstream`);
  const progressiveBlocks = [...yaml.matchAll(/^    progressiveReconciliation:\n      enabled: true\n      updateStepTokens: 256\n      outputSafetyMarginTokens: 256$/gm)];
  assert.match(yaml, new RegExp(`^    instanceId: tyr-r${replica}$`, "m"), `${path.basename(file)} routing instanceId differs`);
  assert.match(yaml, /^    sharedSecretEnv: TYR_ROUTING_SECRET$/m, `${path.basename(file)} must use the shared routing secret`);
  const peerIds = [...yaml.matchAll(/^      - id: (tyr-r\d)$/gm)].map((match) => match[1]);
  const expectedPeers = [1, 2, 3, 4].filter((candidate) => candidate !== replica).map((candidate) => `tyr-r${candidate}`);
  assert.deepEqual(peerIds, expectedPeers, `${path.basename(file)} has the wrong capacity-routing peers`);
  for (const peer of expectedPeers) {
    assert.match(yaml, new RegExp(`^        baseUrl: http://${peer}:8787$`, "m"), `${path.basename(file)} is missing ${peer}'s private URL`);
  }
  const configured = [...yaml.matchAll(/^  - name: ([^\s]+)$/gm)].map((match) => match[1]);
  const controlMatch = /^  pools: \[([^\]]*)\]$/m.exec(yaml);
  assert.ok(controlMatch, `${path.basename(file)} is missing controlPlane.pools`);
  const controlled = controlMatch[1].split(",").map((value) => value.trim()).filter(Boolean);

  assert.deepEqual(controlled, configured, `${path.basename(file)} config and control-plane pools differ`);
  assert.ok(configured.includes("sim-interactive"), `${path.basename(file)} must carry interactive traffic`);

  const expected = replica === 4
    ? ["sim-interactive", "sim-batch"]
    : ["sim-interactive"];
  assert.deepEqual(configured, expected, `${path.basename(file)} has the wrong pool topology`);
  assert.equal(
    progressiveBlocks.length,
    configured.length,
    `${path.basename(file)} must enable the pinned progressive policy on every pool`,
  );

  for (const pool of controlled) registrations[pool] += 1;
}

assert.deepEqual(
  registrations,
  { "sim-interactive": 4, "sim-batch": 1 },
  "batch must have one grant recipient while interactive retains all four",
);

console.log("PASS  topology prevents batch-token fragmentation without reducing interactive fan-out");
