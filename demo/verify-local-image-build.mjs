#!/usr/bin/env node
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(path.join(tmpdir(), "moflux-local-images-"));
const bin = path.join(temp, "bin");
const marker = path.join(temp, "docker-calls.log");
const envFile = path.join(temp, "demo.env");
const tyr = path.join(temp, "tyr-admission-controller");
const latchflo = path.join(temp, "latchflo-control-plane");
mkdirSync(bin);
for (const [dir, name, version] of [
  [tyr, "tyr-admission-controller", "0.28.0"],
  [latchflo, "latchflo-control-plane", "0.13.0"],
]) {
  mkdirSync(dir);
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version }));
  writeFileSync(path.join(dir, "Dockerfile"), "FROM scratch\n");
}
const docker = path.join(bin, "docker");
writeFileSync(
  docker,
  `#!/bin/sh
echo "$@" >> "${marker}"
case "$1 $2" in
  "--version ") exit 0 ;;
  "compose version") exit 0 ;;
  "compose --env-file") exit 0 ;;
  "info ") exit 0 ;;
  "image inspect")
    image="$3"
    safe=$(printf '%s' "$image" | tr '/:' '__')
    [ -f "${temp}/built-$safe" ] && exit 0
    exit 1
    ;;
  "build -t")
    image="$3"
    safe=$(printf '%s' "$image" | tr '/:' '__')
    touch "${temp}/built-$safe"
    exit 0
    ;;
  "pull "*) exit 1 ;;
esac
exit 0
`,
);
chmodSync(docker, 0o755);
writeFileSync(
  envFile,
  [
    "MOFLUX_TYR_IMAGE=tyr-admission-controller:0.28.0",
    "MOFLUX_LATCHFLO_IMAGE=latchflo-control-plane:0.13.0",
    `MOFLUX_TYR_SOURCE_DIR=${tyr}`,
    `MOFLUX_LATCHFLO_SOURCE_DIR=${latchflo}`,
    "LATCHFLO_ADMIN_TOKEN=test-admin",
    "LATCHFLO_AGENT_BOOTSTRAP_TOKEN=test-bootstrap",
    "TYR_ROUTING_SECRET=test-routing-secret-with-at-least-32-chars",
    "MOFLUX_TYR_USER=0:0",
    "",
  ].join("\n"),
);

try {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(ROOT, "demo", "present.mjs"), "--mode=doctor", "--no-open"],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          MOFLUX_BENCH_ENV_FILE: envFile,
          MOFLUX_BENCH_RESULTS_DIR: path.join(temp, "results"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  const calls = readFileSync(marker, "utf8");
  assert.match(calls, new RegExp(`build -t tyr-admission-controller:0\.28\.0 ${tyr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(calls, new RegExp(`build -t latchflo-control-plane:0\.13\.0 ${latchflo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.doesNotMatch(calls, /^pull /m);
  console.log("PASS  npm run demo can build missing pinned images from local source directories");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
