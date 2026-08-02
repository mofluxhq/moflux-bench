import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(path.join(tmpdir(), "moflux-anthropic-loadgen-"));
const out = path.join(temp, "summary.json");
const port = 9900 + Math.floor(Math.random() * 80);
const provider = spawn(process.execPath, [
  path.join(ROOT, "sim", "provider-sim.mjs"),
  `--port=${port}`,
  "--envelope=16",
  "--queue=16",
  "--r1=10000",
  "--prefill-r1=100000",
  "--tick-ms=5",
  "--output-mu=4.6",
  "--output-sigma=0",
  "--seed=4",
], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });

async function waitReady() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("provider did not start");
}

function runLoadgen() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(ROOT, "load", "loadgen.mjs"),
      `--targets=http://127.0.0.1:${port}`,
      "--provider-api=anthropic",
      "--arm-label=anthropic-verification",
      "--duration-ms=1500",
      "--interactive-rps=12",
      "--interactive-input-chars=400",
      "--interactive-max-tokens=200",
      "--batch-rps=0",
      "--max-attempts=1",
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
  await waitReady();
  const result = await runLoadgen();
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  const summary = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(summary.config.providerApi, "anthropic");
  assert.ok(summary.classes.interactive.success > 0, "no Anthropic request succeeded");
  assert.ok(summary.classes.interactive.outputTokens > 0, "Anthropic output usage was not parsed");
  assert.equal(summary.classes.interactive.serverError, 0);
  console.log(
    `PASS  load generator parsed ${summary.classes.interactive.outputTokens} Anthropic output tokens`,
  );
} finally {
  provider.kill("SIGTERM");
  rmSync(temp, { recursive: true, force: true });
}
