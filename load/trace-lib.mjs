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

/**
 * Standard normal via Box-Muller, from a uniform stream.
 */
function standardNormal(rand) {
  let u1 = rand();
  while (u1 === 0) u1 = rand();
  const u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Lognormal draw with the given median, clamped to [min, max].
 *
 * Real LLM traffic within one class varies by one to two orders of magnitude:
 * a chat turn is 200 tokens or 20,000 depending on context length, retrieved
 * documents, and conversation history. A benchmark where every request in a
 * class is the same size cannot distinguish token-aware admission from a plain
 * concurrency semaphore, because with a fixed size those two policies are the
 * same algorithm.
 *
 * The clamp is not cosmetic. A request whose reservation exceeds the smallest
 * per-replica grant can never be admitted anywhere, which reproduces the
 * stranded-capacity failure through the workload instead of the configuration.
 * Bounding the tail keeps every drawn request admittable by construction.
 */
function lognormal(rand, { median, sigma, min, max }) {
  const value = median * Math.exp(sigma * standardNormal(rand));
  return Math.round(Math.min(max, Math.max(min, value)));
}

function gapMs(rand, rps) {
  return (-Math.log(1 - rand()) / rps) * 1000;
}

function roundMs(value) {
  return Math.round(value * 1000) / 1000;
}

export function sizeDistribution(config) {
  return config.sizeDistribution === "lognormal" ? "lognormal" : "uniform";
}

/** Per-class size bounds, derived from the class median and the spread. */
export function sizeBounds(config, cls) {
  const isBatch = cls === "batch";
  const medianChars = isBatch ? config.batchInputChars : config.interactiveInputChars;
  const medianTokens = isBatch ? config.batchMaxTokens : config.interactiveMaxTokens;
  const sigma = isBatch ? config.batchSizeSigma : config.interactiveSizeSigma;
  // A floor of one eighth and a ceiling of four times the median gives a 32x
  // spread within a class while keeping the largest request comfortably inside
  // a single pool grant.
  return {
    sigma,
    inputChars: { median: medianChars, min: Math.round(medianChars / 8), max: medianChars * 4 },
    maxTokens: { median: medianTokens, min: Math.round(medianTokens / 8), max: medianTokens * 4 },
  };
}

export function traceWorkload(config) {
  const distribution = sizeDistribution(config);
  const heterogeneous =
    distribution === "uniform"
      ? {}
      : {
          sizeDistribution: distribution,
          interactiveSizeSigma: config.interactiveSizeSigma,
          batchSizeSigma: config.batchSizeSigma,
        };
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
    ...heterogeneous,
  };
}

function classEntries(config, cls) {
  const isBatch = cls === "batch";
  const startMs = isBatch ? config.batchStartMs : 0;
  const durationMs = isBatch ? config.batchDurationMs : config.durationMs;
  const rps = isBatch ? config.batchRps : config.interactiveRps;
  const endMs = Math.min(config.durationMs, startMs + durationMs);
  if (!(rps > 0) || !(durationMs > 0) || startMs >= endMs) return [];

  const heterogeneous = sizeDistribution(config) === "lognormal";
  const bounds = heterogeneous ? sizeBounds(config, cls) : null;
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
    const entry = {
      id,
      class: cls,
      arrivalMs: roundMs(atMs),
      retryJitter,
      targetSlots,
      providerSeeds,
    };
    if (heterogeneous) {
      // A separate named stream, so adding sizes does not shift the existing
      // arrival, retry, target, or provider draws by a single value. That is
      // what lets a uniform trace stay hash-identical to version 1.
      const sizeRand = mulberry32(streamSeed(config.seed, `${id}:size`));
      entry.inputChars = lognormal(sizeRand, { ...bounds.inputChars, sigma: bounds.sigma });
      entry.maxTokens = lognormal(sizeRand, { ...bounds.maxTokens, sigma: bounds.sigma });
    }
    entries.push(entry);
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
    // Version 2 carries per-request sizes. A uniform trace stays at version 1
    // and hashes exactly as before, so results recorded against v1 remain
    // reproducible rather than merely archived.
    version: sizeDistribution(config) === "lognormal" ? 2 : 1,
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
  const expectedVersion = sizeDistribution(config) === "lognormal" ? 2 : 1;
  if (!trace || !Array.isArray(trace.entries)) {
    throw new Error("trace must be a benchmark trace with entries");
  }
  if (trace.version !== expectedVersion) {
    throw new Error(
      `trace is version ${trace.version} but this configuration expects version ${expectedVersion}; ` +
        "a uniform run cannot replay a heterogeneous trace, or the reverse",
    );
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
    if (expectedVersion === 2) {
      const bounds = sizeBounds(config, entry.class);
      for (const [key, range] of [
        ["inputChars", bounds.inputChars],
        ["maxTokens", bounds.maxTokens],
      ]) {
        const value = entry[key];
        if (!Number.isInteger(value) || value < range.min || value > range.max) {
          throw new Error(
            `trace entry ${entry.id ?? "unknown"} has ${key} ${value}, outside the admittable range [${range.min}, ${range.max}]`,
          );
        }
      }
    }
  }
  return { ...trace, hash: computed };
}
