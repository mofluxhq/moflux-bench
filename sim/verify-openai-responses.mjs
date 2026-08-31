#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

const SIM = new URL("./provider-sim.mjs", import.meta.url).pathname;
const port = 9600 + Math.floor(Math.random() * 300);
const child = spawn(process.execPath, [
  SIM,
  `--port=${port}`,
  "--envelope=4",
  "--queue=4",
  "--r1=1000",
  "--prefill-r1=100000",
  "--output-mu=1.1",
  "--output-sigma=0",
], { stdio: ["ignore", "pipe", "inherit"] });

async function stop() {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit").catch(() => {});
  child.kill("SIGTERM");
  await exited;
}

try {
  await once(child.stdout, "data");
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i += 1) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {
      // retry until the simulator is listening
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const nonStreaming = await fetch(`${base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "sim-model-responses",
      input: "Responses API deterministic non-streaming input",
      max_output_tokens: 16,
      stream: false,
      seed: 101,
    }),
  });
  assert.equal(nonStreaming.status, 200);
  const body = await nonStreaming.json();
  assert.equal(body.object, "response");
  assert.equal(body.status, "completed");
  assert.equal(body.model, "sim-model-responses");
  assert.ok(body.usage.input_tokens > 0);
  assert.ok(body.usage.output_tokens > 0);
  assert.equal(body.usage.total_tokens, body.usage.input_tokens + body.usage.output_tokens);
  assert.equal(body.output?.[0]?.content?.[0]?.type, "output_text");

  const streaming = await fetch(`${base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "sim-model-responses",
      instructions: "Keep the response short.",
      input: [{ role: "user", content: [{ type: "input_text", text: "stream me" }] }],
      max_output_tokens: 16,
      stream: true,
      seed: 102,
    }),
  });
  assert.equal(streaming.status, 200);
  assert.match(streaming.headers.get("content-type") ?? "", /text\/event-stream/);
  const text = await streaming.text();
  assert.match(text, /event: response\.created/);
  assert.match(text, /event: response\.output_text\.delta/);
  assert.match(text, /event: response\.completed/);
  const completedFrame = text
    .split("\n\n")
    .find((frame) => frame.startsWith("event: response.completed"));
  assert.ok(completedFrame);
  const data = completedFrame
    .split(/\r?\n/)
    .find((line) => line.startsWith("data:"));
  assert.ok(data);
  const completed = JSON.parse(data.slice(5).trim());
  assert.ok(completed.response.usage.input_tokens > 0);
  assert.ok(completed.response.usage.output_tokens > 0);

  console.log("PASS provider simulator OpenAI Responses: non-streaming body, semantic SSE, and usage accounting");
} finally {
  await stop();
}
