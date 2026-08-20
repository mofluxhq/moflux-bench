/**
 * Pure helpers for the licensed presenter seed sweep.
 *
 * Kept separate from the process orchestration so aggregation can be tested
 * without Docker or proprietary images.
 */

export function parseSeedSpec(spec) {
  const text = String(spec ?? "").trim();
  if (!text) throw new Error("seed specification must not be empty");

  const seeds = [];
  for (const token of text.split(",").map((part) => part.trim()).filter(Boolean)) {
    const range = /^(\d+)-(\d+)$/.exec(token);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start > end) throw new Error(`descending seed range is not supported: ${token}`);
      if (end - start > 99) throw new Error(`seed range is too large: ${token}`);
      for (let seed = start; seed <= end; seed += 1) seeds.push(seed);
      continue;
    }

    if (!/^\d+$/.test(token)) throw new Error(`invalid seed: ${token}`);
    seeds.push(Number(token));
  }

  const unique = [...new Set(seeds)];
  if (unique.length === 0) throw new Error("at least one seed is required");
  if (unique.some((seed) => !Number.isSafeInteger(seed) || seed < 0)) {
    throw new Error("seeds must be non-negative safe integers");
  }
  if (unique.length > 20) {
    throw new Error(`refusing to run ${unique.length} seeds; the maximum is 20`);
  }
  return unique;
}

export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function summarize(values) {
  const finite = values
    .filter((value) => value !== null && value !== undefined && value !== "")
    .map(Number)
    .filter(Number.isFinite);
  if (finite.length === 0) return null;
  return {
    n: finite.length,
    median: median(finite),
    min: Math.min(...finite),
    max: Math.max(...finite),
  };
}

function tailRatio(summary) {
  const latency = summary?.classes?.interactive?.latencyMs ?? {};
  return Number(latency.p50) > 0 ? Number(latency.p95) / Number(latency.p50) : 0;
}

function interactiveGoodput(summary) {
  const durationMs = Number(summary?.config?.durationMs ?? summary?.scenario?.workload?.durationMs ?? 0);
  return durationMs > 0
    ? Number(summary?.classes?.interactive?.success ?? 0) / (durationMs / 1000)
    : 0;
}

/**
 * Per-arm summary of whether the token budget ever bound.
 *
 * Reported as counts and the number of seeds on which it fired, rather than a
 * bare boolean, so a single seed exercising it is not mistaken for the
 * benchmark exercising it throughout.
 */
function tokenAwarenessByArm(records, controlArmKeys) {
  const armsOf = (record) => ({
    baseline: record.baseline,
    ...Object.fromEntries(controlArmKeys.map((key) => [key, record.controlArms?.[key]])),
    moflux: record.moflux,
  });
  const names = [...new Set(records.flatMap((record) => Object.keys(armsOf(record))))];
  return Object.fromEntries(
    names.map((name) => {
      const perSeed = records
        .map((record) => armsOf(record)[name]?.classes?.interactive?.bindingConstraint)
        .filter(Boolean);
      if (perSeed.length === 0) return [name, null];
      const budget = perSeed.reduce((total, b) => total + (b.budgetLimited ?? 0), 0);
      const seedsExercised = perSeed.filter((b) => (b.budgetLimited ?? 0) > 0).length;
      return [
        name,
        {
          seeds: perSeed.length,
          seedsExercised,
          totalBudgetLimitedRejects: budget,
          exercisedTokenAwareness: seedsExercised > 0,
          /** True only when every seed exercised it, not merely one. */
          exercisedOnEverySeed: seedsExercised === perSeed.length,
        },
      ];
    }),
  );
}

export function armMetrics(summary) {
  const interactive = summary.classes.interactive;
  const batch = summary.classes.batch;
  const constraintRejects = (constraint) =>
    Number(interactive.localRejectConstraints?.[constraint] ?? 0) +
    Number(batch.localRejectConstraints?.[constraint] ?? 0);
  const rejectionSnapshotsCaptured =
    (Array.isArray(interactive.localRejectSnapshots) ? interactive.localRejectSnapshots.length : 0) +
    (Array.isArray(batch.localRejectSnapshots) ? batch.localRejectSnapshots.length : 0);
  const rejectionSnapshotsWithDetail = [
    ...(Array.isArray(interactive.localRejectSnapshots) ? interactive.localRejectSnapshots : []),
    ...(Array.isArray(batch.localRejectSnapshots) ? batch.localRejectSnapshots : []),
  ].filter((snapshot) => snapshot?.detail !== null && snapshot?.detail !== undefined).length;
  return {
    interactiveSuccessRate: interactive.successRate,
    interactiveGoodputRps: interactiveGoodput(summary),
    interactiveP50Ms: interactive.latencyMs.p50,
    interactiveP95Ms: interactive.latencyMs.p95,
    interactiveTailRatio: tailRatio(summary),
    interactiveTtftP50Ms: interactive.ttftMs.p50,
    interactiveTtftP95Ms: interactive.ttftMs.p95,
    interactiveRetryAmplification: interactive.retryAmplification,
    batchSuccessRate: batch.successRate,
    localRejects: interactive.localReject + batch.localReject,
    rejectionSnapshotsCaptured,
    rejectionSnapshotsWithDetail,
    globalConstraintRejects: constraintRejects("global"),
    admissionClassConstraintRejects: constraintRejects("admission_class"),
    admissionClassProtectionRejects: constraintRejects("admission_class_protection"),
    unspecifiedConstraintRejects: constraintRejects("unspecified"),
    upstream429s: interactive.upstreamReject + batch.upstreamReject,
    peakActive: Number(summary.simCounters?.peakActive ?? 0),
    batchResponseHeadersGapMs:
      summary.classes.batch?.responseHeadersGapMs ??
      summary.classes.batch?.admissionGapMs ?? null,
    // Truthful per arm since 0.19.0: an arm that does not consult a coordinator
    // while admitting records 0 however far away the rung set the coordinator.
    // The rung itself is carried separately so a ladder can still prove which
    // sweep produced this file.
    coordinatorLatencyMs: summary.coordinatorLatencyMs ?? 0,
    coordinatorOnAdmissionPath: summary.coordinatorOnAdmissionPath ?? null,
    coordinatorLadderRungMs: summary.coordinatorLadderRungMs ?? null,
    admissionOverheadMs: summary.admissionDecision?.overheadMsAvg ?? null,
    admissionDecisionSamples: summary.admissionDecision?.decisions ?? null,
    unattributedFailures: summary.health?.unattributed ?? null,
    // Which limit actually refused work. Without these in the aggregate, a
    // reader has to open five per-seed files to learn whether the token budget
    // decided anything — and a comparison between a token-aware arm and a
    // concurrency-only one is uninterpretable until they do.
    budgetLimitedRejects: interactive.bindingConstraint?.budgetLimited ?? null,
    concurrencyLimitedRejects: interactive.bindingConstraint?.concurrencyLimited ?? null,
    tokenBoundShare: interactive.bindingConstraint?.tokenBoundShare ?? null,
    // The realised workload, so a claimed size distribution can be checked
    // against what the arm was actually offered.
    requestSizeP50: interactive.requestSizes?.p50 ?? null,
    requestSizeP95: interactive.requestSizes?.p95 ?? null,
    requestSizeSpread: interactive.requestSizes?.spread ?? null,
    borrowedSlots: summary.lending?.idleWindow?.borrowedSlots ?? null,
    occupancyLendingObserved: summary.lending?.idleWindow?.borrowed ?? null,
    controllerLendingObserved: summary.lending?.controlPlane?.lendingObserved ?? null,
    headroomLendingObserved: summary.lending?.controlPlane?.headroomLendingObserved ?? null,
    dataPlaneHeadroomObserved:
      summary.lending?.controlPlane?.handoff?.appliedCapacity?.observedHeadroomTransfer ?? null,
    floorRestored: summary.lending?.controlPlane?.floorRestored ?? null,
    controllerFloorRestored: summary.lending?.controlPlane?.controllerFloorRestored ?? null,
    dataPlaneFloorRestored: summary.lending?.controlPlane?.dataPlaneFloorRestored ?? null,
    floorRestorationDurationMs: summary.lending?.controlPlane?.restorationDurationMs ?? null,
    batchFloorAdmissionGapMinMs:
      summary.lending?.floorReassertion?.admissionGapMinMs ??
      summary.lending?.controlPlane?.handoff?.attemptToFirstBatchAdmissionMinMs ?? null,
    batchFloorAdmissionGapMaxMs:
      summary.lending?.floorReassertion?.admissionGapMaxMs ??
      summary.lending?.controlPlane?.handoff?.attemptToFirstBatchAdmissionMaxMs ?? null,
    batchFloorResponseHeadersGapMs:
      summary.lending?.floorReassertion?.responseHeadersGapMs ??
      summary.lending?.floorReassertion?.admissionGapMs ?? null,
    batchFloorFirstSuccessGapMs: summary.lending?.floorReassertion?.firstSuccessGapMs ?? null,
    handoffObserved: summary.lending?.controlPlane?.handoff?.observed ?? null,
    handoffSafeEventOrder: summary.lending?.controlPlane?.handoff?.safeEventOrder ?? null,
    handoffCommitBeforeBatchAdmission:
      summary.lending?.controlPlane?.handoff?.commitBeforeBatchAdmission ?? null,
    handoffAdmissionOrderingStatus:
      summary.lending?.controlPlane?.handoff?.admissionOrderingStatus ?? null,
    handoffAdmissionOrderingProofSource:
      summary.lending?.controlPlane?.handoff?.admissionOrderingProofSource ?? null,
    handoffExactAdmissionProvenanceComplete:
      summary.lending?.controlPlane?.handoff?.exactAdmissionProvenance?.complete ?? null,
    handoffAdmissionProvenanceDroppedDelta:
      summary.lending?.controlPlane?.handoff?.exactAdmissionProvenance?.droppedDelta ?? null,
    handoffAdmissionProvenanceCaptureFailuresDelta:
      summary.lending?.controlPlane?.handoff?.exactAdmissionProvenance?.captureFailuresDelta ?? null,
    handoffCommittedBeforeSafetyDeadline:
      summary.lending?.controlPlane?.handoff?.committedBeforeSafetyDeadline ??
      summary.lending?.controlPlane?.handoff?.committedBeforeLeaseExpiry ?? null,
    handoffCommittedBeforeLeaseExpiry:
      summary.lending?.controlPlane?.handoff?.committedBeforeLeaseExpiry ?? null,
    noAppliedOverallocation:
      summary.lending?.controlPlane?.handoff?.appliedCapacity?.noAppliedOverallocation ?? null,
    handoffDurationMs: summary.lending?.controlPlane?.handoff?.handoffDurationMs ?? null,
    demandToDrainStartMs: summary.lending?.controlPlane?.handoff?.demandToDrainStartMs ?? null,
    drainStartToAcknowledgedMs:
      summary.lending?.controlPlane?.handoff?.drainStartToAcknowledgedMs ?? null,
    acknowledgedToCommitMs:
      summary.lending?.controlPlane?.handoff?.acknowledgedToCommitMs ?? null,
    commitToFirstBatchAdmissionMinMs:
      summary.lending?.controlPlane?.handoff?.commitToFirstBatchAdmissionMinMs ?? null,
    commitToFirstBatchAdmissionMaxMs:
      summary.lending?.controlPlane?.handoff?.commitToFirstBatchAdmissionMaxMs ?? null,
    demandToFirstBatchAdmissionMinMs:
      summary.lending?.controlPlane?.handoff?.demandToFirstBatchAdmissionMinMs ?? null,
    demandToFirstBatchAdmissionMaxMs:
      summary.lending?.controlPlane?.handoff?.demandToFirstBatchAdmissionMaxMs ?? null,
    commitToFirstBatchResponseHeadersMs:
      summary.lending?.controlPlane?.handoff?.commitToFirstBatchResponseHeadersMs ??
      summary.lending?.controlPlane?.handoff?.commitToFirstBatchAdmissionMs ?? null,
    demandToFirstBatchResponseHeadersMs:
      summary.lending?.controlPlane?.handoff?.demandToFirstBatchResponseHeadersMs ??
      summary.lending?.controlPlane?.handoff?.demandToFirstBatchAdmissionMs ?? null,
    safetyTimeRemainingMs:
      summary.lending?.controlPlane?.handoff?.safetyTimeRemainingMs ??
      summary.lending?.controlPlane?.handoff?.leaseTimeAvoidedMs ?? null,
    predecessorLeaseLeadMs:
      summary.lending?.controlPlane?.handoff?.predecessorLeaseLeadMs ??
      summary.lending?.controlPlane?.handoff?.leaseTimeAvoidedMs ?? null,
    leaseTimeAvoidedMs: summary.lending?.controlPlane?.handoff?.leaseTimeAvoidedMs ?? null,
  };
}

function aggregateMetricObjects(objects) {
  const keys = [...new Set(objects.flatMap((object) => Object.keys(object ?? {})))];
  return Object.fromEntries(
    keys.map((key) => [key, summarize(objects.map((object) => object?.[key]))]),
  );
}


function capacityPolicy(summary) {
  const capacity = summary?.capacity;
  if (!capacity) return null;
  return {
    profile: capacity.profile ?? null,
    policy: capacity.policy ?? null,
    batchFloorPercent: capacity.batchFloorPercent ?? null,
    batchConcurrencySlots: capacity.batchConcurrencySlots,
    interactiveConcurrencySlots: capacity.interactiveConcurrencySlots,
    batchConcurrencyPercent: capacity.batchConcurrencyPercent,
    batchTokenPercent: capacity.batchTokenPercent,
    envelope: capacity.envelope,
    tokenBudget: capacity.tokenBudget,
    capacityGroup: capacity.capacityGroup ?? null,
    demandPolicy: capacity.demandPolicy ?? null,
    pools: capacity.pools,
  };
}

const ADAPTIVE_MIN_INTERACTIVE_SUCCESS_RATE = 0.9;
const ADAPTIVE_MIN_BATCH_SUCCESSES = 4;

function adaptiveProof(records, capacity, { context = "default" } = {}) {
  const supportedProfiles = new Set(["adaptive-28-4", "adaptive-headroom-28-4"]);
  if (!supportedProfiles.has(capacity?.profile)) return null;

  const headroomProfile = capacity.profile === "adaptive-headroom-28-4";
  const idleOccupancyRequired = context !== "headroom-compare";
  const interactivePool = capacity.pools?.find((pool) => pool.name === "sim-interactive");
  const batchPool = capacity.pools?.find((pool) => pool.name === "sim-batch");
  // headroomLending is a capacity-group member policy. The resolved pool
  // projection intentionally does not carry it, so validate the authoritative
  // capacityGroup.members representation instead of the derived pool summary.
  const capacityGroup = capacity.capacityGroup;
  const interactiveMember = capacityGroup?.members?.find(
    (member) => member.pool === "sim-interactive",
  );
  const headroom = interactiveMember?.headroomLending;
  const policyMatches =
    capacity.policy === (headroomProfile
      ? "interactive-first-headroom-aware"
      : "interactive-first-demand-aware") &&
    capacity.interactiveConcurrencySlots === 28 &&
    capacity.batchConcurrencySlots === 4 &&
    capacity.envelope === 32 &&
    capacity.tokenBudget === 64_000 &&
    capacity.batchTokenPercent === 62.5 &&
    Boolean(capacityGroup) &&
    capacity.demandPolicy?.enabled === true &&
    interactivePool?.guaranteedMaxConcurrent === 28 &&
    interactivePool?.guaranteedTokenBudget === 24_000 &&
    interactivePool?.ceilingMaxConcurrent === 32 &&
    interactivePool?.ceilingTokenBudget === 64_000 &&
    (headroomProfile
      ? headroom?.minConcurrentHeadroom === 4 &&
        headroom?.minTokenHeadroom === 4000 &&
        headroom?.demandingSustainMs === 3000 &&
        headroom?.maxDemandingConcurrentLend === 2 &&
        headroom?.maxDemandingTokenLend === 10_000
      : headroom === undefined) &&
    batchPool?.guaranteedMaxConcurrent === 4 &&
    batchPool?.guaranteedTokenBudget === 40_000 &&
    batchPool?.ceilingMaxConcurrent === 32 &&
    batchPool?.ceilingTokenBudget === 64_000;


  const perSeed = records.map((record) => {
    const moflux = record.moflux ?? {};
    const lending = moflux.lending ?? {};
    const upstream429s =
      Number(moflux.classes?.interactive?.upstreamReject ?? 0) +
      Number(moflux.classes?.batch?.upstreamReject ?? 0);
    const interactiveSuccessRate = Number(moflux.classes?.interactive?.successRate ?? 0);
    const batchSuccessRate = Number(moflux.classes?.batch?.successRate ?? 0);
    const batchSuccess = Number(moflux.classes?.batch?.success ?? 0);
    const interactiveTargetMet = interactiveSuccessRate >= ADAPTIVE_MIN_INTERACTIVE_SUCCESS_RATE;
    const minimumBatchSuccesses = Math.max(
      ADAPTIVE_MIN_BATCH_SUCCESSES,
      Number(capacity.batchConcurrencySlots ?? 0),
    );
    const batchTargetMet = batchSuccess >= minimumBatchSuccesses;
    const occupancyLendingObserved = lending.idleWindow?.borrowed === true;
    const controllerLendingObserved = lending.controlPlane?.lendingObserved === true;
    const headroomLendingObserved = lending.controlPlane?.headroomLendingObserved === true;
    const dataPlaneHeadroomObserved =
      lending.controlPlane?.handoff?.appliedCapacity?.observedHeadroomTransfer === true;
    const floorRestored = lending.controlPlane?.floorRestored === true;
    const controllerFloorRestored = lending.controlPlane?.controllerFloorRestored === true;
    const dataPlaneFloorRestored = lending.controlPlane?.dataPlaneFloorRestored === true;
    const handoff = lending.controlPlane?.handoff ?? {};
    const handoffObserved = handoff.observed === true;
    const handoffCommitted = typeof handoff.committedAt === "string";
    const handoffAborted = handoff.aborted === true;
    const handoffAbortReason = handoff.abortReason ?? null;
    const handoffEveryDrainApplied = handoff.everyDrainApplied === true;
    const handoffSafeEventOrder = handoff.safeEventOrder === true;
    const handoffCommitBeforeBatchAdmission = handoff.commitBeforeBatchAdmission === true;
    const handoffAdmissionOrderingStatus = handoff.admissionOrderingStatus ?? "unobserved";
    const handoffAdmissionOrderingProofSource = handoff.admissionOrderingProofSource ?? null;
    const handoffExactAdmissionProvenanceComplete = handoff.exactAdmissionProvenance?.complete === true;
    const handoffExactAdmissionProof =
      handoffCommitBeforeBatchAdmission &&
      handoffAdmissionOrderingStatus === "proven_after_commit_by_successor_grant" &&
      handoffAdmissionOrderingProofSource === "tyr.stats.tyr.admissionProvenance" &&
      handoffExactAdmissionProvenanceComplete;
    const handoffAdmissionOrderViolated = handoffAdmissionOrderingStatus.startsWith("proven_before_commit");
    const handoffCommittedBeforeSafetyDeadline =
      (handoff.committedBeforeSafetyDeadline ?? handoff.committedBeforeLeaseExpiry) === true;
    const handoffCommittedBeforeLeaseExpiry = handoff.committedBeforeLeaseExpiry === true;
    const noAppliedOverallocation = handoff.appliedCapacity?.noAppliedOverallocation === true;
    const batchServed = batchSuccess > 0;
    const passed =
      policyMatches &&
      upstream429s === 0 &&
      interactiveTargetMet &&
      batchTargetMet &&
      controllerLendingObserved &&
      floorRestored &&
      handoffObserved &&
      handoffSafeEventOrder &&
      handoffExactAdmissionProof &&
      handoffCommittedBeforeSafetyDeadline &&
      noAppliedOverallocation &&
      batchServed;

    return {
      seed: record.seed,
      passed,
      upstream429s,
      interactiveSuccessRate,
      batchSuccessRate,
      batchSuccess,
      minimumBatchSuccesses,
      interactiveTargetMet,
      batchTargetMet,
      occupancyLendingObserved,
      controllerLendingObserved,
      headroomLendingObserved,
      dataPlaneHeadroomObserved,
      floorRestored,
      controllerFloorRestored,
      dataPlaneFloorRestored,
      handoffObserved,
      handoffCommitted,
      handoffAborted,
      handoffAbortReason,
      handoffEveryDrainApplied,
      handoffSafeEventOrder,
      handoffCommitBeforeBatchAdmission,
      handoffAdmissionOrderingStatus,
      handoffAdmissionOrderingProofSource,
      handoffExactAdmissionProvenanceComplete,
      handoffExactAdmissionProof,
      handoffAdmissionOrderViolated,
      handoffCommittedBeforeSafetyDeadline,
      handoffCommittedBeforeLeaseExpiry,
      handoffCommittedAt: handoff.committedAt ?? null,
      handoffFirstBatchAdmissionWindow: handoff.firstBatchAdmissionWindow ?? null,
      handoffSafetyDeadline: handoff.safetyDeadline ?? handoff.fallbackDeadline ?? null,
      handoffFallbackDeadline: handoff.fallbackDeadline ?? handoff.safetyDeadline ?? null,
      handoffSafetyDeadlineSource: handoff.safetyDeadlineSource ?? null,
      handoffPredecessorLeaseDeadline: handoff.predecessorLeaseDeadline ?? null,
      handoffSuccessorGrantDeadline: handoff.successorGrantDeadline ?? null,
      duplicateDrainAckEvents: Number(handoff.duplicateDrainAckEvents ?? 0),
      lastDrainAckAt: handoff.lastDrainAckAt ?? null,
      drainReadiness: handoff.drainReadiness ?? [],
      batchLastAttemptAtMs: moflux.classes?.batch?.lastAttemptAtMs ?? null,
      batchLastLocalRejectAtMs: moflux.classes?.batch?.lastLocalRejectAtMs ?? null,
      noAppliedOverallocation,
      borrowedSlots: lending.idleWindow?.borrowedSlots ?? null,
      floorRestorationDurationMs: lending.controlPlane?.restorationDurationMs ?? null,
      batchFirstAdmissionGapMinMs: lending.floorReassertion?.admissionGapMinMs ?? null,
      batchFirstAdmissionGapMaxMs: lending.floorReassertion?.admissionGapMaxMs ?? null,
      batchFirstResponseHeadersGapMs:
        lending.floorReassertion?.responseHeadersGapMs ??
        lending.floorReassertion?.admissionGapMs ?? null,
      batchFirstSuccessGapMs: lending.floorReassertion?.firstSuccessGapMs ?? null,
      handoffDurationMs: handoff.handoffDurationMs ?? null,
      demandToDrainStartMs: handoff.demandToDrainStartMs ?? null,
      drainStartToAcknowledgedMs: handoff.drainStartToAcknowledgedMs ?? null,
      acknowledgedToCommitMs: handoff.acknowledgedToCommitMs ?? null,
      commitToFirstBatchAdmissionMinMs: handoff.commitToFirstBatchAdmissionMinMs ?? null,
      commitToFirstBatchAdmissionMaxMs: handoff.commitToFirstBatchAdmissionMaxMs ?? null,
      demandToFirstBatchAdmissionMinMs: handoff.demandToFirstBatchAdmissionMinMs ?? null,
      demandToFirstBatchAdmissionMaxMs: handoff.demandToFirstBatchAdmissionMaxMs ?? null,
      commitToFirstBatchResponseHeadersMs:
        handoff.commitToFirstBatchResponseHeadersMs ?? handoff.commitToFirstBatchAdmissionMs ?? null,
      demandToFirstBatchResponseHeadersMs:
        handoff.demandToFirstBatchResponseHeadersMs ?? handoff.demandToFirstBatchAdmissionMs ?? null,
      safetyTimeRemainingMs: handoff.safetyTimeRemainingMs ?? handoff.leaseTimeAvoidedMs ?? null,
      predecessorLeaseLeadMs: handoff.predecessorLeaseLeadMs ?? handoff.leaseTimeAvoidedMs ?? null,
      leaseTimeAvoidedMs: handoff.leaseTimeAvoidedMs ?? null,
    };
  });

  const count = (key) => perSeed.filter((seed) => seed[key] === true).length;
  const failures = [];
  if (!policyMatches) failures.push(`capacity policy is not the exact ${capacity.profile} profile`);
  for (const seed of perSeed) {
    const missing = [];
    if (seed.upstream429s !== 0) missing.push(`${seed.upstream429s} upstream 429s`);
    if (!seed.interactiveTargetMet) {
      missing.push(
        `interactive success ${(seed.interactiveSuccessRate * 100).toFixed(1)}% < ` +
          `${(ADAPTIVE_MIN_INTERACTIVE_SUCCESS_RATE * 100).toFixed(0)}%`,
      );
    }
    if (!seed.batchTargetMet) {
      missing.push(
        `batch completions ${seed.batchSuccess} < protected floor ${seed.minimumBatchSuccesses}`,
      );
    }
    if (!seed.controllerLendingObserved) missing.push("no controller lending event");
    if (!seed.floorRestored) missing.push("batch floor not restored");
    if (!seed.handoffObserved) {
      missing.push("no restoration handoff");
    } else {
      if (seed.handoffAborted) {
        missing.push(
          seed.handoffAbortReason
            ? `handoff aborted (${seed.handoffAbortReason})`
            : "handoff aborted",
        );
      } else if (!seed.handoffCommitted) {
        missing.push("handoff commit not observed");
      }

      if (!seed.handoffSafeEventOrder && !seed.handoffAborted && seed.handoffCommitted) {
        missing.push(
          seed.handoffEveryDrainApplied
            ? "handoff order not proven safe"
            : "not every drain grant was acknowledged before commit",
        );
      }

      if (seed.handoffCommitted && !seed.handoffExactAdmissionProof) {
        missing.push(
          seed.handoffAdmissionOrderViolated
            ? "batch admission proven under predecessor authority"
            : seed.handoffExactAdmissionProvenanceComplete
              ? `exact successor-grant admission proof missing (${seed.handoffAdmissionOrderingStatus})`
              : "exact Tyr admission provenance incomplete",
        );
      }

      if (seed.handoffCommitted && !seed.handoffCommittedBeforeSafetyDeadline) {
        const committedAt = Date.parse(seed.handoffCommittedAt ?? "");
        const safetyAt = Date.parse(seed.handoffSafetyDeadline ?? "");
        missing.push(
          Number.isFinite(committedAt) && Number.isFinite(safetyAt) && committedAt >= safetyAt
            ? "handoff exceeded its safety-authority deadline"
            : "handoff successor safety deadline not proven",
        );
      }
    }
    if (!seed.noAppliedOverallocation) missing.push("applied capacity safety not proven");
    if (seed.batchSuccess <= 0) missing.push("no batch success");
    if (missing.length > 0) failures.push(`seed ${seed.seed}: ${missing.join(", ")}`);
  }

  const occupancyObservedSeeds = count("occupancyLendingObserved");
  if (idleOccupancyRequired && occupancyObservedSeeds === 0) {
    failures.push("no seed showed idle occupancy above the static 28-slot floor");
  }
  const headroomEvidenceSeeds = perSeed.filter(
    (seed) => seed.headroomLendingObserved && seed.dataPlaneHeadroomObserved,
  ).length;
  if (headroomProfile && headroomEvidenceSeeds === 0) {
    failures.push("no seed proved interactive-to-batch headroom lending at both controller and data plane");
  }

  return {
    profile: capacity.profile,
    targets: {
      minimumInteractiveSuccessRate: ADAPTIVE_MIN_INTERACTIVE_SUCCESS_RATE,
      minimumBatchSuccesses: ADAPTIVE_MIN_BATCH_SUCCESSES,
      maximumUpstream429s: 0,
    },
    policyMatches,
    proofContext: context,
    idleOccupancyRequired,
    seeds: perSeed.length,
    passedSeeds: perSeed.filter((seed) => seed.passed).length,
    zeroUpstream429Seeds: perSeed.filter((seed) => seed.upstream429s === 0).length,
    interactiveTargetSeeds: count("interactiveTargetMet"),
    batchTargetSeeds: count("batchTargetMet"),
    occupancyObservedSeeds,
    controllerObservedSeeds: count("controllerLendingObserved"),
    headroomObservedSeeds: count("headroomLendingObserved"),
    dataPlaneHeadroomObservedSeeds: count("dataPlaneHeadroomObserved"),
    headroomEvidenceSeeds,
    floorRestoredSeeds: count("floorRestored"),
    controllerFloorRestoredSeeds: count("controllerFloorRestored"),
    dataPlaneFloorRestoredSeeds: count("dataPlaneFloorRestored"),
    handoffObservedSeeds: count("handoffObserved"),
    handoffCommittedSeeds: count("handoffCommitted"),
    safeHandoffSeeds: count("handoffSafeEventOrder"),
    commitBeforeAdmissionSeeds: count("handoffCommitBeforeBatchAdmission"),
    exactAdmissionProofSeeds: count("handoffExactAdmissionProof"),
    exactAdmissionProvenanceCompleteSeeds: count("handoffExactAdmissionProvenanceComplete"),
    admissionOrderViolationSeeds: count("handoffAdmissionOrderViolated"),
    admissionOrderInconclusiveSeeds: perSeed.filter(
      (seed) => !seed.handoffExactAdmissionProof && !seed.handoffAdmissionOrderViolated,
    ).length,
    handoffWithinSafetyDeadlineSeeds: count("handoffCommittedBeforeSafetyDeadline"),
    handoffBeatLeaseExpirySeeds: count("handoffCommittedBeforeLeaseExpiry"),
    noAppliedOverallocationSeeds: count("noAppliedOverallocation"),
    batchServedSeeds: perSeed.filter((seed) => seed.batchSuccess > 0).length,
    passed:
      policyMatches &&
      perSeed.length > 0 &&
      (!idleOccupancyRequired || occupancyObservedSeeds > 0) &&
      (!headroomProfile || headroomEvidenceSeeds > 0) &&
      perSeed.every((seed) => seed.passed),
    failures,
    perSeed,
  };
}

export function adaptiveProofFailureMessage(proof) {
  if (!proof) return "the run did not use an adaptive 28/4 capacity profile";
  if (proof.passed) return null;
  return proof.failures.length > 0
    ? proof.failures.join("; ")
    : "adaptive proof did not pass on every seed";
}

function omitSeed(object) {
  if (!object || typeof object !== "object") return object;
  const { seed: _seed, ...rest } = object;
  return rest;
}

export function buildSweepSummary({ mode, fault, seeds, records, adaptiveProofContext = "default" }) {
  if (!new Set(["default", "headroom-compare"]).has(adaptiveProofContext)) {
    throw new Error(`unsupported adaptive proof context ${adaptiveProofContext}`);
  }
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error("cannot aggregate an empty seed sweep");
  }
  if (records.length !== seeds.length) {
    throw new Error(`seed sweep expected ${seeds.length} records but received ${records.length}`);
  }
  for (let index = 0; index < seeds.length; index += 1) {
    if (records[index]?.seed !== seeds[index]) {
      throw new Error(`seed sweep record ${index + 1} does not match seed ${seeds[index]}`);
    }
  }

  const firstScenario = records.find((record) => record.scenario)?.scenario;
  if (firstScenario) {
    const expectedTemplate = JSON.stringify({
      workload: omitSeed(firstScenario.workload),
      provider: omitSeed(firstScenario.provider),
      routing: firstScenario.routing ?? null,
    });
    for (const record of records) {
      const actualTemplate = JSON.stringify({
        workload: omitSeed(record.scenario?.workload),
        provider: omitSeed(record.scenario?.provider),
        routing: record.scenario?.routing ?? null,
      });
      if (actualTemplate !== expectedTemplate) {
        throw new Error(`seed ${record.seed} changed a non-seed scenario setting`);
      }
    }
  }
  const capacityPolicies = records
    .map((record) => ({ seed: record.seed, policy: capacityPolicy(record.moflux) }))
    .filter((entry) => entry.policy !== null);
  const firstCapacityPolicy = capacityPolicies[0]?.policy ?? null;
  if (firstCapacityPolicy) {
    const expected = JSON.stringify(firstCapacityPolicy);
    for (const { seed, policy } of capacityPolicies) {
      if (JSON.stringify(policy) !== expected) {
        throw new Error(`seed ${seed} changed the MoFlux capacity policy`);
      }
    }
  }

  // Every control arm present on every seed. An arm that appears on only some
  // seeds is dropped rather than aggregated across an inconsistent set, which
  // would silently compare different sample sizes.
  const controlArmKeys = [
    ...new Set(records.flatMap((record) => Object.keys(record.controlArms ?? {}))),
  ].filter((key) => records.every((record) => record.controlArms?.[key]));

  const controlArmAggregates = Object.fromEntries(
    controlArmKeys.map((key) => [
      key,
      aggregateMetricObjects(records.map((record) => armMetrics(record.controlArms[key]))),
    ]),
  );

  // MoFlux against each alternative, paired per seed then medianed — the
  // comparison that decides whether MoFlux is worth deploying over a policy
  // someone could write themselves.
  const headToHead = Object.fromEntries(
    controlArmKeys.map((key) => [
      key,
      aggregateMetricObjects(
        records
          .map((record) => record.armComparisons?.mofluxVersus?.[key])
          .filter(Boolean),
      ),
    ]),
  );

  const versusBaseline = Object.fromEntries(
    [...controlArmKeys, "moflux"].map((key) => [
      key,
      aggregateMetricObjects(
        records
          .map((record) => record.armComparisons?.versusBaseline?.[key])
          .filter(Boolean),
      ),
    ]),
  );

  const baselineMetrics = records
    .filter((record) => record.baseline)
    .map((record) => armMetrics(record.baseline));
  const mofluxMetrics = records
    .filter((record) => record.moflux)
    .map((record) => armMetrics(record.moflux));
  const pairedMetrics = records
    .map((record) => record.comparison?.metrics)
    .filter(Boolean);
  const tokenMetrics = records
    .map((record) => record.moflux?.tokenAccounting)
    .filter(Boolean);
  const progressiveConfigurations = tokenMetrics
    .map((metrics) => metrics.progressiveConfiguration);
  const progressiveConfiguration = progressiveConfigurations[0] ?? null;
  if (progressiveConfiguration) {
    if (progressiveConfigurations.some((configuration) => !configuration)) {
      throw new Error("seed sweep omitted the progressive reconciliation policy on one or more seeds");
    }
    const expected = JSON.stringify(progressiveConfiguration);
    for (const configuration of progressiveConfigurations) {
      if (JSON.stringify(configuration) !== expected) {
        throw new Error("seed sweep changed the progressive reconciliation policy");
      }
    }
  }
  const numericTokenMetrics = tokenMetrics.map(({ progressiveConfiguration: _configuration, ...metrics }) => metrics);

  return {
    schemaVersion: 7,
    generatedAt: new Date().toISOString(),
    kind: mode === "compare" ? "paired-seed-sweep" : "seed-sweep",
    mode,
    fault: Boolean(fault),
    seeds,
    scenarioTemplate: firstScenario
      ? {
          workload: omitSeed(firstScenario.workload),
          provider: omitSeed(firstScenario.provider),
          routing: firstScenario.routing ?? null,
        }
      : null,
    capacityPolicy: firstCapacityPolicy,
    adaptiveProof: adaptiveProof(records, firstCapacityPolicy, { context: adaptiveProofContext }),
    runs: records.map((record) => ({
      seed: record.seed,
      scenario: record.scenario,
      arms: record.arms,
      metrics: record.comparison?.metrics ?? null,
      tokenAccounting: record.moflux?.tokenAccounting ?? null,
      lending: record.moflux?.lending ?? null,
      // Additive per-seed policy metrics make same-trace policy comparisons
      // possible without reopening every raw arm file.
      mofluxMetrics: record.moflux ? armMetrics(record.moflux) : null,
    })),
    controlArms: controlArmKeys,
    /**
     * Did each arm's token budget refuse anything?
     *
     * `false` means the arm never made an admission decision a plain
     * concurrency counter could not have made, so nothing in its comparison is
     * attributable to token-aware admission — whatever the configuration says.
     * Read this before any MoFlux-versus-concurrency claim.
     */
    tokenAwareness: tokenAwarenessByArm(records, controlArmKeys),
    aggregate: {
      arms: {
        baseline: baselineMetrics.length > 0 ? aggregateMetricObjects(baselineMetrics) : null,
        ...controlArmAggregates,
        moflux: mofluxMetrics.length > 0 ? aggregateMetricObjects(mofluxMetrics) : null,
      },
      paired: pairedMetrics.length > 0 ? aggregateMetricObjects(pairedMetrics) : null,
      // Each policy against no control. Answers "does this help at all".
      versusBaseline: controlArmKeys.length > 0 ? versusBaseline : null,
      // MoFlux against each alternative. Answers "is this worth deploying".
      mofluxVersus: controlArmKeys.length > 0 ? headToHead : null,
      tokenAccounting: numericTokenMetrics.length > 0
        ? {
            ...aggregateMetricObjects(numericTokenMetrics),
            progressiveConfiguration,
          }
        : null,
      lending: mofluxMetrics.some((metrics) => metrics.controllerLendingObserved !== null)
        ? {
            borrowedSlots: summarize(mofluxMetrics.map((metrics) => metrics.borrowedSlots)),
            occupancyObservedSeeds: mofluxMetrics.filter((metrics) => metrics.occupancyLendingObserved === true).length,
            controllerObservedSeeds: mofluxMetrics.filter((metrics) => metrics.controllerLendingObserved === true).length,
            headroomObservedSeeds: mofluxMetrics.filter((metrics) => metrics.headroomLendingObserved === true).length,
            dataPlaneHeadroomObservedSeeds: mofluxMetrics.filter((metrics) => metrics.dataPlaneHeadroomObserved === true).length,
            floorRestoredSeeds: mofluxMetrics.filter((metrics) => metrics.floorRestored === true).length,
            controllerFloorRestoredSeeds: mofluxMetrics.filter((metrics) => metrics.controllerFloorRestored === true).length,
            dataPlaneFloorRestoredSeeds: mofluxMetrics.filter((metrics) => metrics.dataPlaneFloorRestored === true).length,
            duplicateDrainAckEvents: summarize(mofluxMetrics.map((metrics) => metrics.duplicateDrainAckEvents)),
            floorRestorationDurationMs: summarize(
              mofluxMetrics.map((metrics) => metrics.floorRestorationDurationMs),
            ),
            batchFloorAdmissionGapMinMs: summarize(
              mofluxMetrics.map((metrics) => metrics.batchFloorAdmissionGapMinMs),
            ),
            batchFloorAdmissionGapMaxMs: summarize(
              mofluxMetrics.map((metrics) => metrics.batchFloorAdmissionGapMaxMs),
            ),
            batchFloorResponseHeadersGapMs: summarize(
              mofluxMetrics.map((metrics) => metrics.batchFloorResponseHeadersGapMs),
            ),
            batchFloorFirstSuccessGapMs: summarize(
              mofluxMetrics.map((metrics) => metrics.batchFloorFirstSuccessGapMs),
            ),
            handoffObservedSeeds: mofluxMetrics.filter((metrics) => metrics.handoffObserved === true).length,
            safeHandoffSeeds: mofluxMetrics.filter((metrics) => metrics.handoffSafeEventOrder === true).length,
            commitBeforeAdmissionSeeds: mofluxMetrics.filter(
              (metrics) => metrics.handoffCommitBeforeBatchAdmission === true,
            ).length,
            exactAdmissionProofSeeds: mofluxMetrics.filter(
              (metrics) =>
                metrics.handoffAdmissionOrderingStatus === "proven_after_commit_by_successor_grant" &&
                metrics.handoffExactAdmissionProvenanceComplete === true,
            ).length,
            exactAdmissionProvenanceCompleteSeeds: mofluxMetrics.filter(
              (metrics) => metrics.handoffExactAdmissionProvenanceComplete === true,
            ).length,
            handoffWithinSafetyDeadlineSeeds: mofluxMetrics.filter(
              (metrics) => metrics.handoffCommittedBeforeSafetyDeadline === true,
            ).length,
            handoffBeatLeaseExpirySeeds: mofluxMetrics.filter(
              (metrics) => metrics.handoffCommittedBeforeLeaseExpiry === true,
            ).length,
            noAppliedOverallocationSeeds: mofluxMetrics.filter(
              (metrics) => metrics.noAppliedOverallocation === true,
            ).length,
            handoffDurationMs: summarize(mofluxMetrics.map((metrics) => metrics.handoffDurationMs)),
            demandToDrainStartMs: summarize(mofluxMetrics.map((metrics) => metrics.demandToDrainStartMs)),
            drainStartToAcknowledgedMs: summarize(
              mofluxMetrics.map((metrics) => metrics.drainStartToAcknowledgedMs),
            ),
            acknowledgedToCommitMs: summarize(
              mofluxMetrics.map((metrics) => metrics.acknowledgedToCommitMs),
            ),
            commitToFirstBatchAdmissionMinMs: summarize(
              mofluxMetrics.map((metrics) => metrics.commitToFirstBatchAdmissionMinMs),
            ),
            commitToFirstBatchAdmissionMaxMs: summarize(
              mofluxMetrics.map((metrics) => metrics.commitToFirstBatchAdmissionMaxMs),
            ),
            demandToFirstBatchAdmissionMinMs: summarize(
              mofluxMetrics.map((metrics) => metrics.demandToFirstBatchAdmissionMinMs),
            ),
            demandToFirstBatchAdmissionMaxMs: summarize(
              mofluxMetrics.map((metrics) => metrics.demandToFirstBatchAdmissionMaxMs),
            ),
            commitToFirstBatchResponseHeadersMs: summarize(
              mofluxMetrics.map((metrics) => metrics.commitToFirstBatchResponseHeadersMs),
            ),
            demandToFirstBatchResponseHeadersMs: summarize(
              mofluxMetrics.map((metrics) => metrics.demandToFirstBatchResponseHeadersMs),
            ),
            leaseTimeAvoidedMs: summarize(mofluxMetrics.map((metrics) => metrics.leaseTimeAvoidedMs)),
            predecessorLeaseLeadMs: summarize(mofluxMetrics.map((metrics) => metrics.predecessorLeaseLeadMs)),
            safetyTimeRemainingMs: summarize(mofluxMetrics.map((metrics) => metrics.safetyTimeRemainingMs)),
          }
        : null,
    },
  };
}
