#!/usr/bin/env node
/**
 * Verifies the local inference harness without Docker, Ollama, or weights.
 *
 * Two fake OpenAI-compatible servers on loopback stand in for the direct and
 * proxied arms. That is enough to pin the parts that would otherwise only be
 * caught during a real run: the request body Ollama actually reads, the arm
 * asymmetry, usage accounting, and the locality guard that replaces the spend
 * guard the OpenAI demos have.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOCAL_ENDPOINT,
  assertLocalUpstream,
  buildLocalChatBody,
  decodeTokensPerSecond,
  isLocalHostname,
  percentile,
  summarizeArm,
} from "./local-inference-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODEL = "qwen3:0.6b";
let requests = 0;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

for (const host of [
  "127.0.0.1", "localhost", "::1", "[::1]", "10.1.2.3", "192.168.0.9", "172.16.4.1",
  "172.31.255.254", "host.docker.internal", "ollama", "nas.local", "box.internal",
  "fd00::1", "fe80::1",
]) {
  assert.equal(isLocalHostname(host), true, `${host} must be treated as local`);
}
for (const host of [
  "api.openai.com", "api.anthropic.com", "generativelanguage.googleapis.com",
  "8.8.8.8", "172.15.0.1", "172.32.0.1", "example.com", "2606:4700::1111",
]) {
  assert.equal(isLocalHostname(host), false, `${host} must not be treated as local`);
}

assert.throws(
  () => assertLocalUpstream("https://api.openai.com/v1/chat/completions", "--direct-url"),
  /not a local address/,
  "a hosted provider must be refused",
);
assert.throws(() => assertLocalUpstream("ftp://127.0.0.1/x", "--direct-url"), /http\(s\)/);
assert.throws(() => assertLocalUpstream("not a url", "--direct-url"), /not a valid URL/);
assert.equal(
  assertLocalUpstream(`http://127.0.0.1:11434${LOCAL_ENDPOINT}`, "--direct-url").port,
  "11434",
);

// The body must use the spellings Ollama reads, not the hosted-OpenAI ones.
const body = buildLocalChatBody({ model: MODEL, prompt: "hi", maxOutputTokens: 32, seed: 3 });
assert.equal(body.max_tokens, 32);
assert.equal(body.max_completion_tokens, undefined, "max_completion_tokens is ignored by Ollama");
assert.equal(body.reasoning_effort, undefined, "reasoning_effort is ignored by Ollama");
assert.equal(body.temperature, 0);
assert.equal(body.seed, 3);
assert.equal(body.stream_options.include_usage, true);
assert.equal(buildLocalChatBody({ model: MODEL, prompt: "hi", maxOutputTokens: 8, stream: false })
  .stream_options, undefined);

assert.equal(percentile([], 0.5), null);
assert.equal(percentile([3, 1, 2], 0.5), 2);
assert.equal(summarizeArm([]).successRate, 0);
assert.equal(summarizeArm([{ ok: true, completionTokens: 4 }, { ok: false }]).failures, 1);
// 8 tokens decoded over 1000ms of decode time (1200ms total minus 200ms TTFT).
assert.equal(
  decodeTokensPerSecond([{ ok: true, completionTokens: 8, ttftMs: 200, latencyMs: 1200 }]),
  8,
);
assert.equal(decodeTokensPerSecond([{ ok: false, completionTokens: 8 }]), null);

// ---------------------------------------------------------------------------
// End-to-end against fake local servers
// ---------------------------------------------------------------------------

function makeServer(label) {
  return createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== LOCAL_ENDPOINT) {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const parsed = JSON.parse(raw);
    assert.equal(parsed.model, MODEL);
    assert.equal(parsed.stream, true);
    assert.equal(parsed.max_tokens, 32);
    assert.equal(parsed.temperature, 0);
    assert.equal(Array.isArray(parsed.messages), true);
    assert.equal(parsed.stream_options?.include_usage, true);
    // A self-hosted server has no credential; sending one would be a secret
    // this benchmark invented for itself.
    assert.equal(req.headers.authorization, undefined, "no credential may be sent");
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
  return `http://127.0.0.1:${address.port}${LOCAL_ENDPOINT}`;
}

async function run(args, env = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, "demo", "local-inference.mjs"), ...args], {
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
const temp = mkdtempSync(path.join(os.tmpdir(), "moflux-local-inference-verify-"));
const out = path.join(temp, "summary.json");

try {
  const before = requests;
  const result = await run([
    "--manage-stack=false",
    `--model=${MODEL}`,
    "--requests-per-arm=2",
    "--max-output-tokens=32",
    `--direct-url=${directUrl}`,
    `--moflux-url=${mofluxUrl}`,
    `--out=${out}`,
  ]);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(requests - before, 4);

  const summary = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(summary.acceptance.passed, true);
  assert.equal(summary.acceptance.localityGuardPassed, true);
  assert.equal(summary.runtime.openaiApi, "chat-completions");
  assert.equal(summary.runtime.endpoint, LOCAL_ENDPOINT);
  assert.equal(summary.runtime.model, MODEL);
  assert.equal(summary.arms.direct.success, 2);
  assert.equal(summary.arms.moflux.success, 2);
  assert.equal(summary.arms.direct.promptTokens, 24);
  assert.equal(summary.arms.moflux.completionTokens, 8);
  assert.equal(summary.locality.meteredProviderReachable, false);
  assert.equal(summary.locality.guard, "non-overridable");
  // A run this short is warm-up by construction; the summary has to say so
  // rather than let two pairs read as a steady-state measurement. The flag
  // rides on the deltas themselves, because that is what gets quoted.
  assert.ok(summary.caveats.warmupPairs >= 2);
  assert.equal(summary.deltas.steadyState, false);
  assert.equal(summary.acceptance.steadyStateMeasured, false);
  // Every request still succeeded, and that is a real compatibility result.
  // Warm-up must not be allowed to fail the run, only to label it.
  assert.equal(summary.acceptance.passed, true);
  assert.match(result.stdout + result.stderr, /must not be quoted/);
  assert.equal(summary.budget, undefined, "a local run must not report a budget it cannot have");

  // Past warm-up the flag must clear, or it would be a constant rather than a
  // measurement of the run.
  const longOut = path.join(temp, "long.json");
  const long = await run([
    "--manage-stack=false",
    `--model=${MODEL}`,
    "--requests-per-arm=6",
    "--max-output-tokens=32",
    `--direct-url=${directUrl}`,
    `--moflux-url=${mofluxUrl}`,
    `--out=${longOut}`,
  ]);
  assert.equal(long.code, 0, `${long.stdout}\n${long.stderr}`);
  const longSummary = JSON.parse(readFileSync(longOut, "utf8"));
  assert.equal(longSummary.deltas.steadyState, true);
  assert.equal(longSummary.acceptance.steadyStateMeasured, true);
  assert.doesNotMatch(long.stdout + long.stderr, /must not be quoted/);

  // The guard must fire before any request, and must not be reachable past a
  // flag: this is the only thing standing between an unmetered benchmark and
  // an unguarded paid one.
  const hosted = await run([
    "--manage-stack=false",
    "--requests-per-arm=1",
    "--direct-url=https://api.openai.com/v1/chat/completions",
    `--moflux-url=${mofluxUrl}`,
    `--out=${out}`,
  ]);
  assert.notEqual(hosted.code, 0, "a hosted upstream must be refused");
  assert.match(hosted.stderr + hosted.stdout, /not a local address/);
  assert.equal(requests, before + 16, "the locality guard must fire before any request");

  const hostedProxy = await run([
    "--manage-stack=false",
    "--requests-per-arm=1",
    `--direct-url=${directUrl}`,
    "--moflux-url=http://api.anthropic.com/v1/chat/completions",
    `--out=${out}`,
  ]);
  assert.notEqual(hostedProxy.code, 0, "a hosted proxy upstream must be refused");
  assert.match(hostedProxy.stderr + hostedProxy.stdout, /not a local address/);
  assert.equal(requests, before + 16);

  const responses = await run([
    "--manage-stack=false",
    "--dry-run",
    "--openai-api=responses",
  ]);
  assert.notEqual(responses.code, 0, "the Responses API has no local implementation");
  assert.match(responses.stderr + responses.stdout, /Chat Completions/);

  const dry = await run(["--manage-stack=false", "--dry-run"]);
  assert.equal(dry.code, 0, `${dry.stdout}\n${dry.stderr}`);
  assert.match(dry.stdout, /no inference request was sent/);
  assert.equal(requests, before + 16, "a dry run must send nothing");
} finally {
  await Promise.all([
    new Promise((resolve) => directServer.close(resolve)),
    new Promise((resolve) => mofluxServer.close(resolve)),
  ]);
  rmSync(temp, { recursive: true, force: true });
}

console.log(
  "PASS local inference harness: Ollama-compatible request body, arm asymmetry, usage accounting, " +
  "steady-state labelling, and a non-overridable locality guard",
);
