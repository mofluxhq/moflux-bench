/**
 * lending-lib.mjs — analysis for the capacity-lending benchmark.
 *
 * The question
 * ------------
 * A static split gives batch a permanent floor. While batch is idle that floor
 * is dead capacity: interactive cannot touch it, and the provider runs below
 * its envelope for no reason. Two API keys with separate quotas have exactly
 * this shape, and they cost nothing to operate — so a capacity control plane
 * that only reproduces a static split is not worth deploying.
 *
 * Lending is the claim that justifies one: while batch has no active work,
 * interactive borrows batch's reserved slots; when batch arrives, the floor is
 * returned. That is a temporal property, and no cumulative counter can show
 * it. A run-long peak-occupancy high-water mark of 32 is equally consistent
 * with "borrowed the idle slot all along" and "sat at 31 until batch arrived
 * and then hit 32 together".
 *
 * So the measurement splits the run at batch arrival and asks three things:
 *
 *   1. borrowed  — did occupancy during the idle window exceed what the
 *                  interactive pool alone is allowed?
 *   2. returned  — once batch arrived, did it actually get served, and how
 *                  long did reassertion take?
 *   3. paid for  — what did interactive give up at the handover?
 *
 * Every function here is pure so the arithmetic can be tested against
 * synthetic runs without Docker or a licensed image.
 */

/**
 * Highest occupancy observed inside a half-open window [startMs, endMs).
 *
 * `buckets` is the simulator's per-second `peakActiveBySecond`. A window is
 * scored by the seconds it covers; a window shorter than one second still
 * scores the second it falls in, because that bucket is the finest evidence
 * available.
 */
export function peakActiveInWindow(buckets, startMs, endMs) {
  if (!Array.isArray(buckets) || buckets.length === 0) return null;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  if (endMs <= startMs) return null;
  const first = Math.max(0, Math.floor(startMs / 1000));
  const last = Math.min(buckets.length - 1, Math.floor((endMs - 1) / 1000));
  if (last < first) return null;
  let peak = 0;
  for (let index = first; index <= last; index += 1) {
    const value = Number(buckets[index] ?? 0);
    if (value > peak) peak = value;
  }
  return peak;
}

/** Interactive samples whose completion fell inside the window. */
function samplesInWindow(samples, startMs, endMs) {
  if (!Array.isArray(samples)) return [];
  return samples.filter((sample) => {
    const offset = Number(sample?.offsetMs);
    return Number.isFinite(offset) && offset >= startMs && offset < endMs;
  });
}

export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return +sorted[index].toFixed(1);
}

/**
 * Splits one arm's run into the window before batch arrives and the window
 * after, and reports what interactive achieved in each.
 *
 * `batchArrivalMs` is the configured batch start, not the observed first
 * attempt: using the observed value would move the boundary between arms and
 * make the two windows incomparable.
 */
export function windowedInteractive(summary, batchArrivalMs, runEndMs) {
  // The load generator computes this split itself from a record that survives
  // metrics pruning. Trust it when present; fall back to raw samples only for
  // synthetic fixtures and pre-0.9.0 result files.
  const emitted = summary?.classes?.interactive?.windows;
  if (emitted && emitted.boundaryMs === batchArrivalMs) {
    return { idle: emitted.idle, contended: emitted.contended };
  }
  const samples = summary?.classes?.interactive?.samples ?? [];
  const idle = samplesInWindow(samples, 0, batchArrivalMs);
  const contended = samplesInWindow(samples, batchArrivalMs, runEndMs);
  const describe = (bucket, spanMs) => ({
    completed: bucket.length,
    goodputRps: spanMs > 0 ? +(bucket.length / (spanMs / 1000)).toFixed(3) : null,
    p50Ms: percentile(bucket.map((s) => s.latencyMs), 0.5),
    p95Ms: percentile(bucket.map((s) => s.latencyMs), 0.95),
    ttftP50Ms: percentile(bucket.map((s) => s.ttftMs), 0.5),
  });
  return {
    idle: describe(idle, batchArrivalMs),
    contended: describe(contended, Math.max(0, runEndMs - batchArrivalMs)),
  };
}

/**
 * The lending verdict for one arm.
 *
 * `interactiveCeiling` is the concurrency the interactive pool owns outright.
 * Occupancy above it during the idle window can only have come from capacity
 * lent by another pool, which is what makes this an observation rather than an
 * inference.
 */
export function lendingMetrics({
  summary,
  peakActiveBySecond,
  batchArrivalMs,
  runEndMs,
  interactiveCeiling,
  envelope,
}) {
  if (Number.isFinite(interactiveCeiling) && Number.isFinite(envelope) && interactiveCeiling > envelope) {
    throw new Error(
      `interactiveCeiling ${interactiveCeiling} exceeds the provider envelope ${envelope}; it must be the fleet-wide slot count, not a per-replica cap`,
    );
  }
  const idlePeak = peakActiveInWindow(peakActiveBySecond, 0, batchArrivalMs);
  const contendedPeak = peakActiveInWindow(peakActiveBySecond, batchArrivalMs, runEndMs);
  const batch = summary?.classes?.batch ?? {};
  const windows = windowedInteractive(summary, batchArrivalMs, runEndMs);

  const borrowedSlots = idlePeak === null ? null : Math.max(0, idlePeak - interactiveCeiling);

  return {
    batchArrivalMs,
    interactiveCeiling,
    envelope,
    idleWindow: {
      peakActive: idlePeak,
      borrowedSlots,
      /** Occupancy above the interactive pool's own ceiling means lending. */
      borrowed: borrowedSlots === null ? null : borrowedSlots > 0,
      interactive: windows.idle,
    },
    contendedWindow: {
      peakActive: contendedPeak,
      interactive: windows.contended,
    },
    floorReassertion: {
      batchFirstAttemptAtMs: batch.firstAttemptAtMs ?? null,
      batchFirstSuccessAtMs: batch.firstSuccessAtMs ?? null,
      /** Time from batch first asking to batch first being served. */
      admissionGapMs: batch.admissionGapMs ?? null,
      batchSuccess: batch.success ?? 0,
      /** A floor that is never reasserted is a starved pool, not lending. */
      reasserted: (batch.success ?? 0) > 0,
    },
    /**
     * What interactive gave up when the floor came back. Negative means
     * interactive was faster once contended, which usually means the idle
     * window was itself saturated.
     */
    handoverCostPercent:
      windows.idle.goodputRps && windows.contended.goodputRps
        ? +(((windows.idle.goodputRps - windows.contended.goodputRps) / windows.idle.goodputRps) * 100).toFixed(2)
        : null,
  };
}

/**
 * Compares a lending policy against a static one on the same trace.
 *
 * The static arm is the control: it cannot exceed its interactive ceiling
 * while batch is idle, by construction. If the lending arm does not beat it
 * there, lending did not happen, whatever the configuration claims.
 */
export function lendingComparison(staticMetrics, lendingMetrics_) {
  const idleGain =
    staticMetrics?.idleWindow?.peakActive && lendingMetrics_?.idleWindow?.peakActive
      ? lendingMetrics_.idleWindow.peakActive - staticMetrics.idleWindow.peakActive
      : null;
  const staticIdleGoodput = staticMetrics?.idleWindow?.interactive?.goodputRps ?? null;
  const lendingIdleGoodput = lendingMetrics_?.idleWindow?.interactive?.goodputRps ?? null;
  return {
    idlePeakActiveGain: idleGain,
    /** Lending is only demonstrated when idle-window occupancy actually rose. */
    lendingObserved: idleGain !== null && idleGain > 0,
    idleGoodputChangePercent:
      staticIdleGoodput && lendingIdleGoodput
        ? +(((lendingIdleGoodput / staticIdleGoodput) - 1) * 100).toFixed(2)
        : null,
    batchAdmissionGapStaticMs: staticMetrics?.floorReassertion?.admissionGapMs ?? null,
    batchAdmissionGapLendingMs: lendingMetrics_?.floorReassertion?.admissionGapMs ?? null,
    /**
     * The cost of lending: batch may wait longer for its first slot because a
     * borrowed slot has to drain first. If this grows without bound, the floor
     * is not a floor.
     */
    reassertionCostMs:
      staticMetrics?.floorReassertion?.admissionGapMs !== null &&
      lendingMetrics_?.floorReassertion?.admissionGapMs !== null
        ? +(
            lendingMetrics_.floorReassertion.admissionGapMs -
            staticMetrics.floorReassertion.admissionGapMs
          ).toFixed(1)
        : null,
    bothReasserted: Boolean(
      staticMetrics?.floorReassertion?.reasserted && lendingMetrics_?.floorReassertion?.reasserted,
    ),
  };
}
