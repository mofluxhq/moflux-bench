import { createHash } from "node:crypto";

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function streamSeed(seed, label) {
  const digest = createHash("sha256").update(`${seed}:${label}`).digest();
  return digest.readUInt32BE(0);
}

function gapMs(rand, rps) {
  return (-Math.log(1 - rand()) / rps) * 1000;
}

function roundMs(value) {
  return Math.round(value * 1000) / 1000;
}

export function traceWorkload(config) {
  return {
    durationMs: config.durationMs,
    seed: config.seed,
    interactiveRps: config.interactiveRps,
    interactiveInputChars: config.interactiveInputChars,
    interactiveMaxTokens: config.interactiveMaxTokens,
    batchStartMs: config.batchStartMs,
    batchDurationMs: config.batchDurationMs,
    batchRps: config.batchRps,
    batchInputChars: config.batchInputChars,
    batchMaxTokens: config.batchMaxTokens,
    maxAttempts: config.maxAttempts,
    backoffBaseMs: config.backoffBaseMs,
  };
}

function classEntries(config, cls) {
  const isBatch = cls === "batch";
  const startMs = isBatch ? config.batchStartMs : 0;
  const durationMs = isBatch ? config.batchDurationMs : config.durationMs;
  const rps = isBatch ? config.batchRps : config.interactiveRps;
  const endMs = Math.min(config.durationMs, startMs + durationMs);
  if (!(rps > 0) || !(durationMs > 0) || startMs >= endMs) return [];

  const arrivalRand = mulberry32(streamSeed(config.seed, `${cls}:arrivals`));
  let atMs = startMs;
  let index = 0;
  const entries = [];
  while (true) {
    atMs += gapMs(arrivalRand, rps);
    if (atMs >= endMs) break;
    index += 1;
    const id = `${cls}-${index}`;
    const requestRand = mulberry32(streamSeed(config.seed, id));
    const retryJitter = [];
    const targetSlots = [];
    const providerSeeds = [];
    for (let attempt = 0; attempt < config.maxAttempts; attempt += 1) {
      retryJitter.push(0.5 + requestRand());
      targetSlots.push(Math.floor(requestRand() * 0x100000000) >>> 0);
      providerSeeds.push(Math.floor(requestRand() * 0x7fffffff));
    }
    entries.push({
      id,
      class: cls,
      arrivalMs: roundMs(atMs),
      retryJitter,
      targetSlots,
      providerSeeds,
    });
  }
  return entries;
}

export function buildTrace(config) {
  const workload = traceWorkload(config);
  const entries = [
    ...classEntries(config, "interactive"),
    ...classEntries(config, "batch"),
  ].sort((a, b) => a.arrivalMs - b.arrivalMs || a.class.localeCompare(b.class) || a.id.localeCompare(b.id));

  const trace = {
    version: 1,
    workload,
    planned: {
      interactive: entries.filter((entry) => entry.class === "interactive").length,
      batch: entries.filter((entry) => entry.class === "batch").length,
      total: entries.length,
    },
    entries,
  };
  return { ...trace, hash: traceHash(trace) };
}

export function traceHash(trace) {
  const canonical = {
    version: trace.version,
    workload: trace.workload,
    planned: trace.planned,
    entries: trace.entries,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function validateTrace(trace, config) {
  if (!trace || trace.version !== 1 || !Array.isArray(trace.entries)) {
    throw new Error("trace must be a version-1 benchmark trace");
  }
  const expected = traceWorkload(config);
  if (JSON.stringify(trace.workload) !== JSON.stringify(expected)) {
    throw new Error("trace workload does not match the load-generator configuration");
  }
  const computed = traceHash(trace);
  if (trace.hash !== undefined && trace.hash !== computed) {
    throw new Error(`trace hash mismatch: expected ${trace.hash}, computed ${computed}`);
  }
  for (const entry of trace.entries) {
    if (!entry || !["interactive", "batch"].includes(entry.class)) {
      throw new Error("trace contains an invalid request class");
    }
    if (!Number.isFinite(entry.arrivalMs) || entry.arrivalMs < 0 || entry.arrivalMs >= config.durationMs) {
      throw new Error(`trace entry ${entry.id ?? "unknown"} has an invalid arrival time`);
    }
    for (const key of ["retryJitter", "targetSlots", "providerSeeds"]) {
      if (!Array.isArray(entry[key]) || entry[key].length < config.maxAttempts) {
        throw new Error(`trace entry ${entry.id ?? "unknown"} is missing ${key}`);
      }
    }
  }
  return { ...trace, hash: computed };
}
