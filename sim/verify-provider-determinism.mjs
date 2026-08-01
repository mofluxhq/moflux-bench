import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 9500 + Math.floor(Math.random() * 300);
const child = spawn(process.execPath, [
  path.join(ROOT, "sim/provider-sim.mjs"),
  `--port=${port}`,
  "--envelope=4",
  "--queue=4",
  "--r1=10000",
  "--prefill-r1=100000",
  "--tick-ms=5",
  "--seed=3",
], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });

async function waitReady() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("provider did not start");
}

async function call(seed) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "sim-model-interactive",
      stream: false,
      seed,
      max_tokens: 400,
      messages: [{ role: "user", content: "x".repeat(1200) }],
    }),
  });
  assert.equal(response.status, 200);
  return (await response.json()).usage;
}

try {
  await waitReady();
  const first = await call(12345);
  await call(98765);
  const replay = await call(12345);
  assert.deepEqual(replay, first);
  console.log("PASS  provider samples are request-keyed, not arrival-order-keyed");
} finally {
  child.kill("SIGTERM");
}
