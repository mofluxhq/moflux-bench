#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "openai-test-key-not-secret";
let requests = 0;

function makeServer(label) {
  return createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    assert.equal(req.headers.authorization, `Bearer ${KEY}`);
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    assert.equal(body.model, "gpt-5.6-luna");
    assert.equal(body.stream, true);
    assert.equal(body.stream_options?.include_usage, true);
    assert.equal(body.max_completion_tokens, 32);
    assert.equal(body.reasoning_effort, "none");
    if (label === "moflux") assert.equal(req.headers["x-priority"], "high");
    if (label === "direct") assert.equal(req.headers["x-priority"], undefined);
    requests += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 4 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}/v1/chat/completions`;
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

const directServer = makeServer("direct");
const mofluxServer = makeServer("moflux");
const directUrl = await listen(directServer);
const mofluxUrl = await listen(mofluxServer);
const temp = mkdtempSync(path.join(os.tmpdir(), "moflux-openai-verify-"));
const out = path.join(temp, "summary.json");
try {
  const result = await run([
    "--manage-stack=false",
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
  assert.equal(requests, 4);
  const summary = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(summary.acceptance.passed, true);
  assert.equal(summary.arms.direct.success, 2);
  assert.equal(summary.arms.moflux.success, 2);
  assert.equal(summary.arms.direct.promptTokens, 24);
  assert.equal(summary.arms.moflux.completionTokens, 8);
  assert.equal(summary.budget.pricingUsdPerMillionTokens.input, 0.2);
  assert.equal(summary.budget.pricingUsdPerMillionTokens.output, 1.2);
  assert.ok(summary.budget.worstCaseUsd < 0.01);
  assert.ok(summary.budget.actualMeasuredUsd > 0);

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
  console.log("PASS OpenAI live harness: paired requests, usage accounting, secret hygiene, and hard spend guard");
} finally {
  await Promise.all([
    new Promise((resolve) => directServer.close(resolve)),
    new Promise((resolve) => mofluxServer.close(resolve)),
  ]);
  rmSync(temp, { recursive: true, force: true });
}
