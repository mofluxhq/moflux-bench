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

/**
 * The interactive class's arrival windows.
 *
 * A version-1 or version-2 trace has exactly one, spanning the whole run, which
 * is what `batchStartMs` alone can express: interactive traffic that is always
 * present and batch traffic that joins it.
 *
 * A contention benchmark needs the other shape. To lend an idle protected floor
 * a control plane must first observe one, so the workload has to contain a
 * window in which interactive demand is genuinely absent while batch traffic
 * runs — and then a window in which it returns. That is two interactive
 * windows, not one, and no arrangement of a single rate produces it.
 *
 * `interactiveResumeRps` is what selects the shape. When it is unset or zero
 * this returns the single historical window and every draw downstream is
 * unchanged, so a uniform version-1 trace still hashes exactly as it did.
 */
export function interactiveWindows(config) {
  const startMs = Number(config.interactiveStartMs ?? 0);
  const durationMs = Number(
    config.interactiveDurationMs ?? Math.max(0, config.durationMs - startMs),
  );
  const windows = [{ label: "interactive", startMs, durationMs, rps: config.interactiveRps }];
  if (Number(config.interactiveResumeRps ?? 0) > 0) {
    windows.push({
      label: "interactive-resume",
      startMs: Number(config.interactiveResumeStartMs ?? 0),
      durationMs: Number(config.interactiveResumeDurationMs ?? 0),
      rps: Number(config.interactiveResumeRps),
    });
  }
  return windows;
}

/** True when the configuration uses the multi-window interactive schedule. */
export function hasInteractiveResume(config) {
  return Number(config?.interactiveResumeRps ?? 0) > 0;
}

/**
 * Trace format version for a configuration.
 *
 * 1 — uniform sizes, one interactive window.
 * 2 — per-request lognormal sizes.
 * 3 — a second interactive arrival window.
 *
 * Version 3 wins over 2 because it is the more recent addition and its
 * validator handles both; a version-3 trace may carry lognormal sizes.
 */
export function traceVersion(config) {
  if (hasInteractiveResume(config)) return 3;
  return sizeDistribution(config) === "lognormal" ? 2 : 1;
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
  // Emitted only for a version-3 configuration, so the recorded workload of a
  // version-1 or version-2 trace — and therefore its hash — is untouched.
  const phased = hasInteractiveResume(config)
    ? {
        interactiveStartMs: Number(config.interactiveStartMs ?? 0),
        interactiveDurationMs: Number(
          config.interactiveDurationMs ?? Math.max(0, config.durationMs - (config.interactiveStartMs ?? 0)),
        ),
        interactiveResumeStartMs: Number(config.interactiveResumeStartMs ?? 0),
        interactiveResumeDurationMs: Number(config.interactiveResumeDurationMs ?? 0),
        interactiveResumeRps: Number(config.interactiveResumeRps),
      }
    : {};
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
    ...phased,
  };
}

/**
 * Arrivals for one class, or for one window of the interactive class.
 *
 * `window` is `null` for batch and for the historical single-window interactive
 * schedule; passing one selects a named window whose arrival stream and request
 * ids are derived from that name. Naming the stream is what keeps the addition
 * additive: the resume window draws from `interactive-resume:arrivals`, which
 * no earlier trace ever consumed, so not one existing draw shifts position.
 */
function classEntries(config, cls, window = null) {
  const isBatch = cls === "batch";
  const label = window?.label ?? cls;
  const startMs = window ? window.startMs : isBatch ? config.batchStartMs : 0;
  const durationMs = window
    ? window.durationMs
    : isBatch
      ? config.batchDurationMs
      : config.durationMs;
  const rps = window ? window.rps : isBatch ? config.batchRps : config.interactiveRps;
  const endMs = Math.min(config.durationMs, startMs + durationMs);
  if (!(rps > 0) || !(durationMs > 0) || startMs >= endMs) return [];

  const heterogeneous = sizeDistribution(config) === "lognormal";
  const bounds = heterogeneous ? sizeBounds(config, cls) : null;
  const arrivalRand = mulberry32(streamSeed(config.seed, `${label}:arrivals`));
  let atMs = startMs;
  let index = 0;
  const entries = [];
  while (true) {
    atMs += gapMs(arrivalRand, rps);
    if (atMs >= endMs) break;
    index += 1;
    const id = `${label}-${index}`;
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
    // Windows are passed explicitly rather than defaulted so the single-window
    // case still calls the historical code path with `window === null`.
    ...(hasInteractiveResume(config)
      ? interactiveWindows(config).flatMap((window) =>
          classEntries(config, "interactive", window),
        )
      : classEntries(config, "interactive")),
    ...classEntries(config, "batch"),
  ].sort((a, b) => a.arrivalMs - b.arrivalMs || a.class.localeCompare(b.class) || a.id.localeCompare(b.id));

  const trace = {
    // Version 2 carries per-request sizes and version 3 a second interactive
    // arrival window. A uniform single-window trace stays at version 1 and
    // hashes exactly as before, so results recorded against v1 remain
    // reproducible rather than merely archived.
    version: traceVersion(config),
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
  const expectedVersion = traceVersion(config);
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
    if (expectedVersion === 3 && entry.class === "interactive") {
      // Every interactive arrival has to fall inside a window the configuration
      // actually declares. Without this, a trace whose quiet window was filled
      // in by an edit would replay as an ordinary contended run and the
      // benchmark would report lending that the workload never made possible.
      const windows = interactiveWindows(config).filter((window) => window.rps > 0);
      const inSomeWindow = windows.some(
        (window) =>
          entry.arrivalMs >= window.startMs &&
          entry.arrivalMs < Math.min(config.durationMs, window.startMs + window.durationMs),
      );
      if (!inSomeWindow) {
        throw new Error(
          `trace entry ${entry.id ?? "unknown"} arrives at ${entry.arrivalMs}ms, outside every ` +
            "configured interactive window",
        );
      }
    }
    if (expectedVersion === 2 || (expectedVersion === 3 && sizeDistribution(config) === "lognormal")) {
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
