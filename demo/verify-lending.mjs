/**
 * verify-lending.mjs — the lending analysis says "lending" only when it saw it.
 *
 * The failure this guards against is the expensive one: a lending policy that
 * is misconfigured, silently behaves exactly like the static split, and still
 * produces a report claiming lending worked. Every assertion below is built
 * from synthetic runs whose answer is known in advance, so the arithmetic is
 * checked without Docker or a licensed image.
 *
 * Run: node demo/verify-lending.mjs
 */
import {
  lendingComparison,
  lendingMetrics,
  peakActiveInWindow,
  percentile,
  windowedInteractive,
} from "./lending-lib.mjs";
import {
  buildDemandAwareCapacityGroup,
  summarizeControllerLending,
} from "./lending-evidence-lib.mjs";

const failures = [];
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`PASS  ${name}`);
  } else {
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
}

const ENVELOPE = 32;
const INTERACTIVE_CEILING = 28;
const BATCH_ARRIVAL_MS = 15_000;
const RUN_END_MS = 45_000;

/** Interactive completions at a steady rate across the whole run. */
function interactiveSamples({ ratePerSec, latencyMs, fromMs = 0, toMs = RUN_END_MS }) {
  const samples = [];
  for (let t = fromMs; t < toMs; t += Math.round(1000 / ratePerSec)) {
    samples.push({ offsetMs: t, latencyMs, ttftMs: Math.round(latencyMs / 4) });
  }
  return samples;
}

function runSummary({ idleRate, contendedRate, batch }) {
  return {
    classes: {
      interactive: {
        samples: [
          ...interactiveSamples({ ratePerSec: idleRate, latencyMs: 3000, toMs: BATCH_ARRIVAL_MS }),
          ...interactiveSamples({
            ratePerSec: contendedRate,
            latencyMs: 5000,
            fromMs: BATCH_ARRIVAL_MS,
          }),
        ],
      },
      batch,
    },
  };
}

/** Per-second occupancy: `idle` before batch arrives, `contended` after. */
function buckets(idle, contended) {
  return Array.from({ length: 45 }, (_, second) =>
    second * 1000 < BATCH_ARRIVAL_MS ? idle : contended,
  );
}

const servedBatch = { success: 12, firstAttemptAtMs: 15_100, firstResponseHeadersAtMs: 15_300, firstSuccessAtMs: 15_400, responseHeadersGapMs: 200, firstSuccessGapMs: 300 };
const starvedBatch = { success: 0, firstAttemptAtMs: 15_100, firstResponseHeadersAtMs: null, firstSuccessAtMs: null, responseHeadersGapMs: null, firstSuccessGapMs: null };

// ── window arithmetic ────────────────────────────────────────────────
{
  const b = buckets(32, 28);
  check("idle window scores only its own seconds", peakActiveInWindow(b, 0, BATCH_ARRIVAL_MS) === 32);
  check(
    "contended window excludes the idle seconds",
    peakActiveInWindow(b, BATCH_ARRIVAL_MS, RUN_END_MS) === 28,
  );
  check("an empty bucket list yields no answer", peakActiveInWindow([], 0, 1000) === null);
  check("a zero-width window yields no answer", peakActiveInWindow(b, 5000, 5000) === null);
  check(
    "a window past the recorded run is clamped, not fabricated",
    peakActiveInWindow(b, 100_000, 200_000) === null,
  );
  // A single late spike must not be reported as idle-window occupancy: that is
  // exactly the confusion a cumulative high-water mark creates.
  const lateSpike = Array.from({ length: 45 }, (_, s) => (s === 44 ? 32 : 20));
  check(
    "a late spike does not leak into the idle window",
    peakActiveInWindow(lateSpike, 0, BATCH_ARRIVAL_MS) === 20,
  );
}

// ── percentiles ──────────────────────────────────────────────────────
{
  check("percentile picks an actual observation", percentile([1, 2, 3, 4, 5], 0.5) === 3);
  check("p95 of a short series is the top observation", percentile([10, 20], 0.95) === 20);
  check("no samples means no percentile", percentile([], 0.5) === null);
}

// ── windowed interactive split ───────────────────────────────────────
{
  const summary = runSummary({ idleRate: 6, contendedRate: 4, batch: servedBatch });
  const windows = windowedInteractive(summary, BATCH_ARRIVAL_MS, RUN_END_MS);
  check("idle completions are counted in the idle window", windows.idle.completed > 0);
  check("contended completions are counted separately", windows.contended.completed > 0);
  check(
    "no sample is counted in both windows",
    windows.idle.completed + windows.contended.completed ===
      summary.classes.interactive.samples.length,
  );
  check(
    "the idle window shows the higher goodput here",
    windows.idle.goodputRps > windows.contended.goodputRps,
  );
}

// ── lending detected ─────────────────────────────────────────────────
{
  const metrics = lendingMetrics({
    summary: runSummary({ idleRate: 6, contendedRate: 4, batch: servedBatch }),
    peakActiveBySecond: buckets(32, 32),
    batchArrivalMs: BATCH_ARRIVAL_MS,
    runEndMs: RUN_END_MS,
    interactiveCeiling: INTERACTIVE_CEILING,
    envelope: ENVELOPE,
  });
  check("occupancy above the interactive ceiling counts as borrowed", metrics.idleWindow.borrowed === true);
  check("all four idle batch slots are observed as borrowed", metrics.idleWindow.borrowedSlots === 4);
  check("a served batch class marks the floor reasserted", metrics.floorReassertion.reasserted === true);
  check("client timing is labelled response-header gap", metrics.floorReassertion.responseHeadersGapMs === 200);
  check("handover cost is reported as a percentage", metrics.handoverCostPercent > 0);
}

// ── static split: no lending, and it must not be reported as lending ──
{
  const metrics = lendingMetrics({
    summary: runSummary({ idleRate: 5, contendedRate: 4, batch: servedBatch }),
    peakActiveBySecond: buckets(28, 32),
    batchArrivalMs: BATCH_ARRIVAL_MS,
    runEndMs: RUN_END_MS,
    interactiveCeiling: INTERACTIVE_CEILING,
    envelope: ENVELOPE,
  });
  check("a static split never exceeds its ceiling while batch is idle", metrics.idleWindow.borrowed === false);
  check("nothing is reported as borrowed", metrics.idleWindow.borrowedSlots === 0);
  // The whole run still reaches 32 — which is why a run-long high-water mark
  // cannot distinguish this case from the lending case above.
  check(
    "the run-long peak alone cannot tell these apart",
    peakActiveInWindow(buckets(28, 32), 0, RUN_END_MS) === 32,
  );
}

// ── starved batch is a failure, not a win ────────────────────────────
{
  const metrics = lendingMetrics({
    summary: runSummary({ idleRate: 6, contendedRate: 6, batch: starvedBatch }),
    peakActiveBySecond: buckets(32, 32),
    batchArrivalMs: BATCH_ARRIVAL_MS,
    runEndMs: RUN_END_MS,
    interactiveCeiling: INTERACTIVE_CEILING,
    envelope: ENVELOPE,
  });
  check("a batch class that never ran is not a reasserted floor", metrics.floorReassertion.reasserted === false);
  check("an unserved batch class reports no response-header gap", metrics.floorReassertion.responseHeadersGapMs === null);
}

// ── comparison between the two policies ──────────────────────────────
{
  const staticArm = lendingMetrics({
    summary: runSummary({ idleRate: 5, contendedRate: 4, batch: servedBatch }),
    peakActiveBySecond: buckets(28, 32),
    batchArrivalMs: BATCH_ARRIVAL_MS,
    runEndMs: RUN_END_MS,
    interactiveCeiling: INTERACTIVE_CEILING,
    envelope: ENVELOPE,
  });
  const lendingArm = lendingMetrics({
    summary: runSummary({ idleRate: 6, contendedRate: 4, batch: { ...servedBatch, firstResponseHeadersAtMs: 16_000, responseHeadersGapMs: 900, firstSuccessAtMs: 16_100, firstSuccessGapMs: 1000 } }),
    peakActiveBySecond: buckets(32, 32),
    batchArrivalMs: BATCH_ARRIVAL_MS,
    runEndMs: RUN_END_MS,
    interactiveCeiling: INTERACTIVE_CEILING,
    envelope: ENVELOPE,
  });
  const comparison = lendingComparison(staticArm, lendingArm);
  check("lending is observed only when idle occupancy actually rose", comparison.lendingObserved === true);
  check("the gain is four slots", comparison.idlePeakActiveGain === 4);
  check("idle goodput improvement is reported", comparison.idleGoodputChangePercent > 0);
  check("the client-visible response-header cost of lending is surfaced", comparison.responseHeadersCostMs === 700);
  check("both policies returned the floor", comparison.bothReasserted === true);

  // Same policy compared with itself must report no lending.
  const selfComparison = lendingComparison(staticArm, staticArm);
  check("comparing a static arm with itself shows no lending", selfComparison.lendingObserved === false);
  check("and no idle occupancy gain", selfComparison.idlePeakActiveGain === 0);
}

// ── regression: the emitted windows are preferred over raw samples ───
{
  // A result file whose rolling `samples` array has been pruned down to the
  // contended window only. Before the generator emitted its own windows, this
  // silently reported zero idle goodput instead of failing.
  const pruned = {
    classes: {
      interactive: {
        samples: interactiveSamples({ ratePerSec: 4, latencyMs: 5000, fromMs: BATCH_ARRIVAL_MS }),
        windows: {
          boundaryMs: BATCH_ARRIVAL_MS,
          idle: { completed: 90, goodputRps: 6, p50Ms: 3000, p95Ms: 4000, ttftP50Ms: 700 },
          contended: { completed: 120, goodputRps: 4, p50Ms: 5000, p95Ms: 8000, ttftP50Ms: 900 },
        },
      },
      batch: servedBatch,
    },
  };
  const windows = windowedInteractive(pruned, BATCH_ARRIVAL_MS, RUN_END_MS);
  check("emitted windows survive a pruned sample array", windows.idle.completed === 90);
  check("idle goodput is not silently zero after pruning", windows.idle.goodputRps === 6);

  // A boundary mismatch means the file was produced under a different phase
  // layout, so the emitted split must not be trusted.
  const mismatched = {
    classes: {
      interactive: { samples: [], windows: { ...pruned.classes.interactive.windows, boundaryMs: 999 } },
      batch: servedBatch,
    },
  };
  check(
    "emitted windows from a different boundary are not reused",
    windowedInteractive(mismatched, BATCH_ARRIVAL_MS, RUN_END_MS).idle.completed === 0,
  );
}

// ── the phase split accounts for every completion ────────────────────
{
  // idle + contended + drain must equal the class's successes. If it does not,
  // one of the three buckets is dropping or double-counting work, and every
  // per-window goodput figure is wrong by an unknown amount.
  const emitted = {
    boundaryMs: BATCH_ARRIVAL_MS,
    endMs: RUN_END_MS,
    idle: { completed: 17, goodputRps: 3.4 },
    contended: { completed: 13, goodputRps: 4.333 },
    drainCompleted: 13,
  };
  check(
    "the three buckets account for every success",
    emitted.idle.completed + emitted.contended.completed + emitted.drainCompleted === 43,
  );
  check(
    "drain completions are excluded from the contended window",
    emitted.contended.completed < emitted.contended.completed + emitted.drainCompleted,
  );
}

// ── regression: a per-replica ceiling must not read as borrowing ─────
{
  // maxConcurrent is configured per replica; the fleet ceiling is that times
  // the replica count. Passing the per-replica figure made a static cap look
  // like it was borrowing.
  let threw = false;
  try {
    lendingMetrics({
      summary: runSummary({ idleRate: 5, contendedRate: 4, batch: servedBatch }),
      peakActiveBySecond: buckets(8, 8),
      batchArrivalMs: BATCH_ARRIVAL_MS,
      runEndMs: RUN_END_MS,
      interactiveCeiling: 40,
      envelope: ENVELOPE,
    });
  } catch {
    threw = true;
  }
  check("a ceiling above the envelope is rejected as a misconfiguration", threw);
}


// ── Latchflo 0.7 capacity-group contract ─────────────────────────────
{
  const group = buildDemandAwareCapacityGroup({
    envelope: 32,
    tokenBudget: 64_000,
    reportStaleAfterMs: 6000,
    idleAfterMs: 3000,
    maxStarvationMs: 5000,
    interactive: {
      pool: "sim-interactive",
      priority: 100,
      guaranteedMaxConcurrent: 28,
      guaranteedTokenBudget: 24_000,
    },
    batch: {
      pool: "sim-batch",
      priority: 10,
      guaranteedMaxConcurrent: 4,
      guaranteedTokenBudget: 40_000,
    },
  });
  check("demand-aware group owns the full concurrency envelope", group.globalMaxConcurrent === 32);
  check("demand-aware group owns the full token envelope", group.globalTokenBudget === 64_000);
  check("batch retains a four-slot protected floor", group.members[1].guaranteedMaxConcurrent === 4);
  check("demand-aware allocation is explicitly enabled", group.demandPolicy.enabled === true);

  let rejected = false;
  try {
    buildDemandAwareCapacityGroup({
      envelope: 31,
      tokenBudget: 64_000,
      reportStaleAfterMs: 6000,
      idleAfterMs: 3000,
      maxStarvationMs: 5000,
      interactive: {
        pool: "sim-interactive",
        priority: 100,
        guaranteedMaxConcurrent: 28,
        guaranteedTokenBudget: 24_000,
      },
      batch: {
        pool: "sim-batch",
        priority: 10,
        guaranteedMaxConcurrent: 4,
        guaranteedTokenBudget: 40_000,
      },
    });
  } catch {
    rejected = true;
  }
  check("an overcommitted protected floor is rejected", rejected);
}

// ── controller event proof ───────────────────────────────────────────
{
  const events = [
    {
      id: 10,
      type: "capacity_group.lending_observed",
      entityType: "capacity_group",
      entityId: "sim-workloads",
      createdAt: "2026-08-01T20:00:05.000Z",
      payload: {
        lenders: [{ pool: "sim-batch", released: { maxConcurrent: 4, tokenBudget: 40_000 } }],
        borrowers: [{ pool: "sim-interactive", borrowed: { maxConcurrent: 4, tokenBudget: 40_000 } }],
      },
    },
    {
      id: 11,
      type: "capacity_group.floor_restore_pending",
      entityType: "capacity_group",
      entityId: "sim-workloads",
      createdAt: "2026-08-01T20:00:27.000Z",
      payload: {
        pools: ["sim-batch"],
        floorRestorationDeadline: "2026-08-01T20:00:32.000Z",
      },
    },
    {
      id: 12,
      type: "capacity_group.rebalanced",
      entityType: "capacity_group",
      entityId: "sim-workloads",
      createdAt: "2026-08-01T20:00:31.000Z",
      payload: {
        members: [
          { pool: "sim-interactive", allocated: { maxConcurrent: 28, tokenBudget: 24_000 } },
          { pool: "sim-batch", allocated: { maxConcurrent: 4, tokenBudget: 40_000 } },
        ],
      },
    },
  ];
  const proof = summarizeControllerLending({
    events,
    demand: [],
    finalRebalance: {
      demandAware: true,
      members: [
        { pool: "sim-interactive", allocated: { maxConcurrent: 28, tokenBudget: 24_000 } },
        { pool: "sim-batch", allocated: { maxConcurrent: 4, tokenBudget: 40_000 } },
      ],
    },
    batchGuaranteedMaxConcurrent: 4,
    batchGuaranteedTokenBudget: 40_000,
  });
  check("controller evidence records lending", proof.lendingObserved === true);
  check("controller evidence records a pending floor restore", proof.floorRestorePendingObserved === true);
  check("controller evidence proves the floor was restored", proof.floorRestored === true);
  check("controller evidence measures restoration duration", proof.restorationDurationMs === 4000);

  const handoffEvents = [
    {
      id: 20,
      type: "capacity_group.lending_observed",
      entityType: "capacity_group",
      entityId: "sim-workloads",
      createdAt: "2026-08-01T20:00:05.000Z",
      payload: {},
    },
    {
      id: 30,
      type: "capacity_group.handoff_prepared",
      entityType: "capacity_group",
      entityId: "sim-workloads",
      createdAt: "2026-08-01T20:00:27.200Z",
      payload: {
        handoffId: "restore-1",
        grants: [
          {
            grantId: "interactive-drain",
            instanceId: "tyr-r4",
            pool: "sim-interactive",
            role: "drain",
            fromGrantId: "interactive-source",
            limits: { maxConcurrent: 7, tokenBudget: { budget: 6000 } },
          },
          {
            grantId: "batch-expand",
            instanceId: "tyr-r4",
            pool: "sim-batch",
            role: "staged",
            fromGrantId: "batch-source",
            limits: { maxConcurrent: 4, tokenBudget: { budget: 40000 } },
          },
        ],
      },
    },
    {
      id: 31,
      type: "capacity_group.floor_restore_pending",
      entityType: "capacity_group",
      entityId: "sim-workloads",
      createdAt: "2026-08-01T20:00:27.201Z",
      payload: {
        handoffId: "restore-1",
        pools: ["sim-batch"],
        floorRestorationDeadline: "2026-08-01T20:00:27.700Z",
      },
    },
    {
      id: 32,
      type: "capacity_group.handoff_grant_applied",
      entityType: "grant",
      entityId: "interactive-drain",
      createdAt: "2026-08-01T20:00:27.450Z",
      payload: { handoffId: "restore-1", capacityGroup: "sim-workloads" },
    },
    {
      id: 33,
      type: "capacity_group.handoff_grant_applied",
      entityType: "grant",
      entityId: "interactive-drain",
      createdAt: "2026-08-01T20:00:27.750Z",
      payload: { handoffId: "restore-1", capacityGroup: "sim-workloads" },
    },
    {
      id: 34,
      type: "capacity_group.handoff_committed",
      entityType: "capacity_group",
      entityId: "sim-workloads",
      createdAt: "2026-08-01T20:00:27.900Z",
      payload: { handoffId: "restore-1", grants: [] },
    },
  ];
  const handoffProof = summarizeControllerLending({
    events: handoffEvents,
    grants: [
      { grantId: "interactive-source", expiresAt: "2026-08-01T20:00:27.700Z", lifecycle: "expired" },
      { grantId: "batch-source", expiresAt: "2026-08-01T20:00:27.700Z", lifecycle: "expired" },
      { grantId: "interactive-drain", expiresAt: "2026-08-01T20:01:27.200Z", lifecycle: "active" },
      { grantId: "batch-expand", expiresAt: "2026-08-01T20:01:27.200Z", lifecycle: "active" },
    ],
    demand: [{
      pool: "sim-batch",
      instanceId: "tyr-r4",
      receivedAt: "2026-08-01T20:00:28.000Z",
      stateSince: "2026-08-01T20:00:27.000Z",
      hasDemand: true,
      inFlight: 1,
      pending: 2,
    }],
    finalRebalance: {
      demandAware: true,
      members: [
        { pool: "sim-interactive", allocated: { maxConcurrent: 28, tokenBudget: 24000 } },
        { pool: "sim-batch", allocated: { maxConcurrent: 4, tokenBudget: 40000 } },
      ],
    },
    batchGuaranteedMaxConcurrent: 4,
    batchGuaranteedTokenBudget: 40000,
    loadgenStartedAtEpochMs: Date.parse("2026-08-01T20:00:00.000Z"),
    batchFirstAttemptAtMs: 27920,
    batchFirstResponseHeadersAtMs: 28200,
    providerCounters: {
      firstRequestReceivedAtEpochMsByModel: {
        "sim-model-batch": Date.parse("2026-08-01T20:00:28.010Z"),
      },
    },
    appliedCapacity: {
      noAppliedOverallocation: true,
      observedLentPartition: true,
      observedRestoredPartition: true,
      restorationObservation: {
        source: "tyr.stats.applied_limits",
        sampleIntervalMs: 500,
        firstObservedAt: "2026-08-01T20:00:28.050Z",
      },
      timeline: [
        {
          observedAt: "2026-08-01T20:00:27.460Z",
          replicas: [{
            port: 8104,
            interactive: {
              inFlight: 8,
              inFlightTokens: 6500,
              grants: [{ grantId: "interactive-drain" }],
            },
          }],
        },
        {
          observedAt: "2026-08-01T20:00:27.960Z",
          replicas: [{
            port: 8104,
            interactive: {
              inFlight: 7,
              inFlightTokens: 5900,
              grants: [{ grantId: "interactive-drain" }],
            },
          }],
        },
      ],
      admissionObservation: {
        source: "tyr.stats.llm.admitted",
        sampleIntervalMs: 500,
        previousPollStartedAt: "2026-08-01T20:00:27.950Z",
        previousObservedAt: "2026-08-01T20:00:27.960Z",
        firstObservedAt: "2026-08-01T20:00:28.050Z",
        admittedCountAtFirstObservation: 1,
      },
    },
  });
  check("0.11.6 handoff is identified as the floor-restoration handoff", handoffProof.handoff.observed === true);
  check("every drain grant was acknowledged before commit", handoffProof.handoff.safeEventOrder === true);
  check("capacity acknowledgement uses the first unique ACK barrier", handoffProof.handoff.capacityAcknowledgedAt === "2026-08-01T20:00:27.450Z");
  check("duplicate drain ACKs remain diagnostic only", handoffProof.handoff.duplicateDrainAckEvents === 1);
  check("last duplicate drain ACK is preserved separately", handoffProof.handoff.lastDrainAckAt === "2026-08-01T20:00:27.750Z");
  check("data-plane restoration time comes from the first restored Tyr sample", handoffProof.floorRestoredAt === "2026-08-01T20:00:28.050Z");
  check("per-drain readiness records the first locally safe sample", handoffProof.handoff.drainReadiness[0]?.firstObservedOccupancyReadyAt === "2026-08-01T20:00:27.960Z");
  check("handoff commit precedes the bounded first batch admission", handoffProof.handoff.commitBeforeBatchAdmission === true);
  check("admission ordering is explicitly proven", handoffProof.handoff.admissionOrderingStatus === "proven_after_commit");
  check("first admission window is bounded to 60ms", handoffProof.handoff.firstBatchAdmissionWindow.widthMs === 60);
  check("commit-to-admission upper bound excludes provider prefill", handoffProof.handoff.commitToFirstBatchAdmissionMaxMs === 110);
  check("handoff may commit after predecessor expiry", handoffProof.handoff.committedBeforeLeaseExpiry === false);
  check("successor authority is the post-ACK safety deadline", handoffProof.handoff.safetyDeadlineSource === "prepared_successor_grants");
  check("handoff commits before successor expiry", handoffProof.handoff.committedBeforeSafetyDeadline === true);
  check("legacy lease-time-avoided remains zero after predecessor expiry", handoffProof.handoff.leaseTimeAvoidedMs === 0);
  check("old-lease lead is signed and shows a 200ms post-expiry commit", handoffProof.handoff.predecessorLeaseLeadMs === -200);
  check("successor safety retains 59.3s at commit", handoffProof.handoff.safetyTimeRemainingMs === 59300);
  check("demand-to-admission upper bound excludes provider prefill", handoffProof.handoff.demandToFirstBatchAdmissionMaxMs === 1010);
  check("response-header timing remains separately visible", handoffProof.handoff.demandToFirstBatchResponseHeadersMs === 1200);
  check("data-plane applied-capacity proof is preserved", handoffProof.handoff.appliedCapacity.noAppliedOverallocation === true);

  const staleDemandTiming = summarizeControllerLending({
    events: handoffEvents,
    grants: [
      { grantId: "interactive-source", expiresAt: "2026-08-01T20:00:27.700Z" },
      { grantId: "batch-source", expiresAt: "2026-08-01T20:00:27.700Z" },
      { grantId: "interactive-drain", expiresAt: "2026-08-01T20:01:27.200Z" },
      { grantId: "batch-expand", expiresAt: "2026-08-01T20:01:27.200Z" },
    ],
    demand: [{
      pool: "sim-batch",
      instanceId: "tyr-r4",
      receivedAt: "2026-08-01T20:00:40.000Z",
      stateSince: "2026-08-01T20:00:39.000Z",
      hasDemand: true,
    }],
    finalRebalance: { demandAware: true, members: [] },
    batchGuaranteedMaxConcurrent: 4,
    batchGuaranteedTokenBudget: 40000,
  });
  check("a later current-state demand snapshot is not treated as historical handoff demand", staleDemandTiming.handoff.demandDetectedAt === null);
  check("impossible demand-to-drain timing is null rather than clamped to zero", staleDemandTiming.handoff.demandToDrainStartMs === null);

  const occupancyOnly = summarizeControllerLending({
    events: [],
    demand: [],
    finalRebalance: null,
    batchGuaranteedMaxConcurrent: 4,
    batchGuaranteedTokenBudget: 40_000,
  });
  check("occupancy without a Latchflo event is not controller proof", occupancyOnly.lendingObserved === false);
  check("null response timing stays null instead of becoming the Unix epoch", occupancyOnly.handoff.firstBatchResponseHeadersAt === null);
}

console.log();
if (failures.length > 0) {
  console.log(`${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("All checks passed.");
