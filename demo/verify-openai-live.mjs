#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openAIPath } from "./openai-api-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "openai-test-key-not-secret";
let requests = 0;

function makeServer(label, api) {
  return createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== openAIPath(api)) {
      res.writeHead(404).end();
      return;
    }
    assert.equal(req.headers.authorization, `Bearer ${KEY}`);
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    assert.equal(body.model, "gpt-5.6-luna");
    assert.equal(body.stream, true);
    if (api === "responses") {
      assert.equal(typeof body.input, "string");
      assert.equal(body.messages, undefined);
      assert.equal(body.max_output_tokens, 32);
      assert.equal(body.reasoning?.effort, "none");
    } else {
      assert.equal(Array.isArray(body.messages), true);
      assert.equal(body.input, undefined);
      assert.equal(body.stream_options?.include_usage, true);
      assert.equal(body.max_completion_tokens, 32);
      assert.equal(body.reasoning_effort, "none");
    }
    if (label === "moflux") assert.equal(req.headers["x-priority"], "high");
    if (label === "direct") assert.equal(req.headers["x-priority"], undefined);
    requests += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (api === "responses") {
      res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\n\n`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      res.end(`event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: { usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 } },
      })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 4 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    }
  });
}

async function listen(server, api) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}${openAIPath(api)}`;
}

async function run(args, env = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, "demo", "openai-live.mjs"), ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, stdout, stderr };
}

async function verifyApi(api) {
  const directServer = makeServer("direct", api);
  const mofluxServer = makeServer("moflux", api);
  const directUrl = await listen(directServer, api);
  const mofluxUrl = await listen(mofluxServer, api);
  const temp = mkdtempSync(path.join(os.tmpdir(), `moflux-openai-${api}-verify-`));
  const out = path.join(temp, "summary.json");
  try {
    const before = requests;
    const result = await run([
      "--manage-stack=false",
      `--openai-api=${api}`,
      "--requests-per-arm=2",
      "--max-output-tokens=32",
      "--max-usd=0.01",
      `--direct-url=${directUrl}`,
      `--moflux-url=${mofluxUrl}`,
      `--out=${out}`,
    ], { OPENAI_API_KEY: KEY });
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stdout.includes(KEY), false, "API key leaked to stdout");
    assert.equal(result.stderr.includes(KEY), false, "API key leaked to stderr");
    assert.equal(requests - before, 4);
    const summary = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(summary.acceptance.passed, true);
    assert.equal(summary.runtime.openaiApi, api);
    assert.equal(summary.runtime.endpoint, openAIPath(api));
    assert.equal(summary.arms.direct.success, 2);
    assert.equal(summary.arms.moflux.success, 2);
    assert.equal(summary.arms.direct.promptTokens, 24);
    assert.equal(summary.arms.moflux.completionTokens, 8);
    assert.equal(summary.budget.pricingUsdPerMillionTokens.input, 0.2);
    assert.equal(summary.budget.pricingUsdPerMillionTokens.output, 1.2);
    assert.ok(summary.budget.worstCaseUsd < 0.01);
    assert.ok(summary.budget.actualMeasuredUsd > 0);
  } finally {
    await Promise.all([
      new Promise((resolve) => directServer.close(resolve)),
      new Promise((resolve) => mofluxServer.close(resolve)),
    ]);
    rmSync(temp, { recursive: true, force: true });
  }
}

await verifyApi("responses");
await verifyApi("chat-completions");

const before = requests;
const guard = await run([
  "--dry-run",
  "--requests-per-arm=1000",
  "--max-output-tokens=1024",
  "--max-usd=0.000001",
]);
assert.notEqual(guard.code, 0, "oversized run should be refused");
assert.match(guard.stderr + guard.stdout, /Refusing to run/);
assert.equal(requests, before, "spend guard must fail before any API request");

const absoluteCap = await run(["--dry-run", "--max-usd=1.01"]);
assert.notEqual(absoluteCap.code, 0, "per-run cap above $1 must be refused");
assert.match(absoluteCap.stderr + absoluteCap.stdout, /no more than 1/);
assert.equal(requests, before, "absolute spend cap must fail before any API request");
console.log("PASS OpenAI live harness: Responses + Chat Completions, usage accounting, secret hygiene, and hard spend guard");
