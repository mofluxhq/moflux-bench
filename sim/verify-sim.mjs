/**
 * verify-sim.mjs — checks provider-sim.mjs against the analytic curve.
 *
 * A simulator whose measured throughput does not match its own stated model is
 * worse than no simulator, so this asserts fidelity before any arm is run.
 */

import { spawn } from "node:child_process";
import { once } from "node:events";

const SIM = new URL("./provider-sim.mjs", import.meta.url).pathname;
const R1 = 90;
const SIGMA = 0.35;
const KAPPA = 0;

const speedup = (n, sigma = SIGMA, kappa = KAPPA) =>
  n <= 0 ? 0 : n / (1 + sigma * (n - 1) + kappa * n * (n - 1));
const predictedAggregate = (n) => R1 * speedup(n);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit").catch(() => {});
  child.kill("SIGTERM");
  await exited;
}

async function startSim(extra = []) {
  const port = 9100 + Math.floor(Math.random() * 400);
  const child = spawn(
    process.execPath,
    [SIM, `--port=${port}`, `--r1=${R1}`, `--sigma=${SIGMA}`, `--kappa=${KAPPA}`, ...extra],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  await once(child.stdout, "data");
  for (let i = 0; i < 50; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(20);
  }
  return { child, base: `http://127.0.0.1:${port}` };
}

/** Opens a streaming request and counts emitted output tokens as they arrive. */
function openStream(base, counter, { maxTokens = 1_000_000 } = {}) {
  const controller = new AbortController();
  const promise = (async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "sim-model",
        stream: true,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: "x".repeat(400) }],
      }),
      signal: controller.signal,
    });
    if (!res.body) return;
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (!frame.startsWith("data: ")) continue;
        const payload = frame.slice(6);
        if (payload === "[DONE]") continue;
        try {
          const parsed = JSON.parse(payload);
          const content = parsed?.choices?.[0]?.delta?.content;
          if (typeof content === "string") counter.tokens += content.length / 4;
        } catch {
          /* partial frame */
        }
      }
    }
  })().catch(() => {
    /* aborted at end of measurement window */
  });
  return { controller, promise };
}

async function measureAggregate(base, n) {
  const counter = { tokens: 0 };
  const streams = Array.from({ length: n }, () => openStream(base, counter));

  await sleep(1500); // let all n reach steady-state decode
  const t0 = Date.now();
  const s0 = counter.tokens;
  await sleep(3000);
  const observed = ((counter.tokens - s0) / (Date.now() - t0)) * 1000;

  for (const s of streams) s.controller.abort();
  await Promise.allSettled(streams.map((s) => s.promise));
  return observed;
}

async function testCurveFidelity() {
  // sigma=0 on the output distribution makes every request emit an identical,
  // very long response, so throughput is the only variable under test.
  const { child, base } = await startSim([
    "--envelope=64",
    "--queue=64",
    "--output-mu=13.8", // exp(13.8) ~= 984k, so max_tokens is the binding cap
    "--output-sigma=0",
    "--prefill-r1=100000", // near-instant prefill: isolate decode throughput
  ]);

  const rows = [];
  let worst = 0;
  try {
    for (const n of [1, 5, 20, 40]) {
      const observed = await measureAggregate(base, n);
      const predicted = predictedAggregate(n);
      const errorPct = Math.abs(observed - predicted) / predicted * 100;
      worst = Math.max(worst, errorPct);
      rows.push({ n, predicted: +predicted.toFixed(1), observed: +observed.toFixed(1), errorPct: +errorPct.toFixed(1) });
    }
  } finally {
    await stopChild(child);
  }

  console.log("\nTest A — aggregate decode throughput vs USL prediction");
  console.table(rows);
  const pass = worst <= 8;
  console.log(`${pass ? "PASS" : "FAIL"}  worst deviation ${worst.toFixed(1)}% (threshold 8%)`);
  return pass;
}

async function testBackpressure() {
  const { child, base } = await startSim([
    "--envelope=2",
    "--queue=2",
    "--output-mu=5.3", // ~200 tokens; the burst still fills envelope + queue
    "--output-sigma=0",
    "--r1=2000", // keep the invariant test fast enough for CI
    "--prefill-r1=100000",
  ]);

  let ok = false;
  try {
    const results = await Promise.all(
      Array.from({ length: 24 }, () =>
        fetch(`${base}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "sim-model",
            max_tokens: 2000,
            messages: [{ role: "user", content: "y".repeat(200) }],
          }),
        }).then((r) => r.status),
      ),
    );
    const counts = results.reduce((acc, s) => ((acc[s] = (acc[s] ?? 0) + 1), acc), {});
    const stats = await (await fetch(`${base}/admin/stats`)).json();

    console.log("\nTest B — provider-side backpressure (envelope=2, queue=2, 24 concurrent)");
    console.log("  status counts:", counts);
    console.log("  peakActive:", stats.counters.peakActive, "peakQueue:", stats.counters.peakQueue);

    ok =
      (counts[429] ?? 0) > 0 &&
      (counts[200] ?? 0) > 0 &&
      stats.counters.peakActive <= 2 &&
      stats.counters.peakQueue <= 2;
    console.log(
      `${ok ? "PASS" : "FAIL"}  429s emitted, envelope never exceeded, queue bound respected`,
    );
  } finally {
    await stopChild(child);
  }
  return ok;
}

async function testOutputDistribution() {
  const { child, base } = await startSim([
    "--envelope=32",
    "--queue=256",
    "--output-mu=5.3",
    "--output-sigma=0.9",
    "--r1=100000", // finish fast; distribution is what matters here
    "--prefill-r1=1000000",
  ]);

  let ok = false;
  try {
    const lengths = [];
    for (let batch = 0; batch < 6; batch += 1) {
      const res = await Promise.all(
        Array.from({ length: 50 }, () =>
          fetch(`${base}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: "sim-model",
              max_tokens: 4096,
              messages: [{ role: "user", content: "z".repeat(300) }],
            }),
          }).then((r) => r.json()),
        ),
      );
      for (const r of res) if (r?.usage) lengths.push(r.usage.completion_tokens);
    }
    lengths.sort((a, b) => a - b);
    const q = (p) => lengths[Math.min(lengths.length - 1, Math.floor(p * lengths.length))];
    const median = q(0.5);
    const p99 = q(0.99);
    const ratio = p99 / median;

    console.log("\nTest C — output length distribution (n=" + lengths.length + ")");
    console.log(`  min ${lengths[0]}  median ${median}  p90 ${q(0.9)}  p99 ${p99}  max ${lengths.at(-1)}`);
    console.log(`  p99/median ratio ${ratio.toFixed(2)}`);

    // A heavy tail is the point: a flat distribution would make max_tokens
    // reservation look far more accurate than it is in production.
    ok = median > 100 && median < 350 && ratio >= 3 && lengths.at(-1) <= 4096;
    console.log(`${ok ? "PASS" : "FAIL"}  median in range, tail ratio >= 3, cap respected`);
  } finally {
    await stopChild(child);
  }
  return ok;
}

const results = [];
results.push(["curve fidelity", await testCurveFidelity()]);
results.push(["backpressure", await testBackpressure()]);
results.push(["output distribution", await testOutputDistribution()]);

console.log("\n──────── summary ────────");
for (const [name, pass] of results) console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
const allPass = results.every(([, p]) => p);
console.log(allPass ? "\nAll checks passed." : "\nOne or more checks FAILED.");
process.exit(allPass ? 0 : 1);
