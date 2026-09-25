/** Reporting only: no inference, policy changes, or class attribution from engine gauges. */
const number = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value))
  ? Number(value) : null;

export function summarizeBorrowAccounting(loadgen, workload) {
  const fromMs = workload.batchStartMs;
  const toMs = workload.interactiveResumeStartMs;
  const samples = loadgen?.classes?.batch?.phaseSamples;
  const summarize = (field) => {
    const available = Array.isArray(samples) && samples.every((s) => number(s[field]) !== null);
    const completed = available ? samples.filter((s) => s[field] >= fromMs && s[field] < toMs).length : null;
    return { completed, goodputRps: completed === null || toMs <= fromMs
      ? null : Number((completed / ((toMs - fromMs) / 1000)).toFixed(3)) };
  };
  return {
    fromMs, toMs,
    arrivalCohort: summarize("arrivalMs"),
    completionWindow: summarize("completedAtMs"),
    note: "Arrival cohort counts eventual successful completions of borrow-phase arrivals; completion window counts successful completions timestamped inside that phase. Neither counts rejected or censored work as completed. Missing timestamps yield unknown values.",
  };
}

export function correlateReturnEvidence(engineSamples = [], managedSamples = [], demandReturn = {}) {
  const engines = [...engineSamples].sort((a, b) => a.atMs - b.atMs);
  const admissions = [...managedSamples].sort((a, b) => a.offsetMs - b.offsetMs);
  const snapshot = (time) => {
    const atMs = number(time);
    if (atMs === null) return null;
    const e = engines.find((s) => number(s.atMs) !== null && s.atMs >= atMs);
    const a = admissions.find((s) => number(s.offsetMs) !== null && s.offsetMs >= atMs);
    return {
      atMs,
      engine: e ? {
        sampledAtMs: e.atMs, sampleLagMs: e.atMs - atMs,
        running: number(e.snapshot?.gauges?.running), waiting: number(e.snapshot?.gauges?.waiting),
        kvCacheUsage: number(e.snapshot?.gauges?.kvCacheUsage),
      } : null,
      admission: a ? {
        sampledAtMs: a.offsetMs, sampleLagMs: a.offsetMs - atMs,
        batchInFlight: number(a.classes?.batch?.inFlight),
        batchBorrowedConcurrent: number(a.classes?.batch?.borrowedConcurrent),
        interactiveProtectedConcurrent: number(a.classes?.interactive?.limits?.protectedConcurrent),
      } : null,
    };
  };
  return {
    observedDemandReturn: snapshot(demandReturn.benchmarkMarkedActiveAtMs),
    grantFloorRestored: snapshot(demandReturn.floorRestoredAtMs),
    note: "Offsets share the arm sampler origin. Each snapshot is the first sample at or after its anchor; inspect sample lag. Borrowed occupancy is admission-side only. Engine gauges are aggregate and cannot establish batch KV residency, interactive queue time, or physical reclamation. Missing anchors or samples remain unknown.",
  };
}
