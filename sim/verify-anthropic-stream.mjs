import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 9800 + Math.floor(Math.random() * 100);
const child = spawn(process.execPath, [
  path.join(ROOT, "sim", "provider-sim.mjs"),
  `--port=${port}`,
  "--envelope=4",
  "--queue=4",
  "--r1=5000",
  "--prefill-r1=100000",
  "--tick-ms=5",
  "--output-mu=5.3",
  "--output-sigma=0",
  "--seed=9",
], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });

async function waitReady() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("provider did not start");
}

try {
  await waitReady();
  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": "benchmark-local",
    },
    body: JSON.stringify({
      model: "sim-model-interactive",
      stream: true,
      seed: 123,
      max_tokens: 400,
      messages: [{ role: "user", content: "x".repeat(1200) }],
    }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

  const events = [];
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body ?? []) {
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const data = frame.split(/\r?\n/).find((line) => line.startsWith("data:"));
      if (!data) continue;
      events.push(JSON.parse(data.slice(5).trim()));
    }
  }

  const start = events.find((event) => event.type === "message_start");
  assert.ok(start, "stream omitted message_start");
  assert.ok(start.message.usage.input_tokens > 0, "message_start omitted input usage");

  const content = events.filter((event) => event.type === "content_block_delta");
  assert.ok(content.length > 0, "stream omitted content deltas");

  const usage = events
    .filter((event) => event.type === "message_delta" && Number.isFinite(event.usage?.output_tokens))
    .map((event) => event.usage.output_tokens);
  assert.ok(usage.length >= 2, "stream did not expose progressive cumulative output usage");
  for (let index = 1; index < usage.length; index += 1) {
    assert.ok(usage[index] >= usage[index - 1], "output usage regressed");
  }
  assert.ok(usage.at(-1) > 0, "final output usage was zero");
  assert.ok(events.some((event) => event.type === "message_stop"), "stream omitted message_stop");

  console.log(
    `PASS  Anthropic simulator emits input usage plus ${usage.length} monotonic live output updates`,
  );
} finally {
  child.kill("SIGTERM");
}
