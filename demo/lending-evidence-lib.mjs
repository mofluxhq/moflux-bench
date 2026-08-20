import { proveAdmissionUsesSuccessorGrant } from "./admission-provenance-lib.mjs";

/**
 * Pure helpers for configuring and interpreting Latchflo 0.12 demand-aware
 * capacity groups. Kept separate from presenter orchestration so the safety
 * and evidence contract can be tested without Docker or licensed images.
 */

export const DEFAULT_CAPACITY_GROUP_NAME = "sim-workloads";

function finiteInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be an integer of at least ${minimum}`);
  }
  return value;
}

export function buildDemandAwareCapacityGroup({
  name = DEFAULT_CAPACITY_GROUP_NAME,
  envelope,
  tokenBudget,
  interactive,
  batch,
  reportStaleAfterMs,
  idleAfterMs,
  maxStarvationMs,
}) {
  finiteInteger(envelope, "envelope", 1);
  finiteInteger(tokenBudget, "tokenBudget", 1);
  finiteInteger(reportStaleAfterMs, "reportStaleAfterMs", 1000);
  finiteInteger(idleAfterMs, "idleAfterMs", 0);
  finiteInteger(maxStarvationMs, "maxStarvationMs", 1000);

  const members = [interactive, batch].map((member, index) => {
    if (!member?.pool) throw new Error(`member ${index + 1} requires a pool`);
    finiteInteger(member.priority, `${member.pool}.priority`, 0);
    finiteInteger(member.guaranteedMaxConcurrent, `${member.pool}.guaranteedMaxConcurrent`, 1);
    finiteInteger(member.guaranteedTokenBudget, `${member.pool}.guaranteedTokenBudget`, 1);
    const headroom = member.headroomLending;
    if (headroom !== undefined) {
      finiteInteger(headroom.minConcurrentHeadroom, `${member.pool}.headroomLending.minConcurrentHeadroom`, 0);
      finiteInteger(headroom.minTokenHeadroom, `${member.pool}.headroomLending.minTokenHeadroom`, 0);
    }
    return {
      pool: member.pool,
      priority: member.priority,
      guaranteedMaxConcurrent: member.guaranteedMaxConcurrent,
      guaranteedTokenBudget: member.guaranteedTokenBudget,
      ...(headroom === undefined
        ? {}
        : {
            headroomLending: {
              minConcurrentHeadroom: headroom.minConcurrentHeadroom,
              minTokenHeadroom: headroom.minTokenHeadroom,
            },
          }),
    };
  });

  const guaranteedConcurrent = members.reduce((sum, member) => sum + member.guaranteedMaxConcurrent, 0);
  const guaranteedTokens = members.reduce((sum, member) => sum + member.guaranteedTokenBudget, 0);
  if (guaranteedConcurrent > envelope) {
    throw new Error(`capacity-group guarantees ${guaranteedConcurrent} slots but the envelope is ${envelope}`);
  }
  if (guaranteedTokens > tokenBudget) {
    throw new Error(`capacity-group guarantees ${guaranteedTokens} tokens but the envelope is ${tokenBudget}`);
  }
  if (members[0].priority === members[1].priority) {
    throw new Error("capacity-group priorities must be unique");
  }

  return {
    name,
    globalMaxConcurrent: envelope,
    globalTokenBudget: tokenBudget,
    safetyReservePercent: 0,
    demandPolicy: {
      enabled: true,
      reportStaleAfterMs,
      idleAfterMs,
      maxStarvationMs,
    },
    members,
  };
}

function eventMembers(event) {
  return Array.isArray(event?.payload?.members) ? event.payload.members : [];
}

function allocatedFloor(event, pool, guaranteedMaxConcurrent, guaranteedTokenBudget) {
  const member = eventMembers(event).find((candidate) => candidate?.pool === pool);
  if (!member) return false;
  const concurrent = Number(member?.allocated?.maxConcurrent ?? 0);
  const tokens = Number(member?.allocated?.tokenBudget ?? 0);
  return concurrent >= guaranteedMaxConcurrent && tokens >= guaranteedTokenBudget;
}

function eventTime(event) {
  const value = Date.parse(event?.createdAt ?? "");
  return Number.isFinite(value) ? value : null;
}

/**
 * Converts raw /v1/events, /v1/demand, and the final rebalance response into a
 * compact, publishable proof record. The event stream remains the source of
 * truth for lending; occupancy alone is deliberately not enough.
 */
export function summarizeControllerLending({
  groupName = DEFAULT_CAPACITY_GROUP_NAME,
  events = [],
  demand = [],
  grants = [],
  finalRebalance = null,
  batchPool = "sim-batch",
  batchGuaranteedMaxConcurrent = 1,
  batchGuaranteedTokenBudget = 1,
  loadgenStartedAtEpochMs = null,
  batchFirstAttemptAtMs = null,
  batchFirstResponseHeadersAtMs = null,
  // Compatibility only for synthetic fixtures and pre-0.21 callers. This was
  // client-visible 2xx timing, not an admission timestamp.
  batchFirstAdmissionAtMs = null,
  batchModel = "sim-model-batch",
  providerCounters = null,
  appliedCapacity = null,
}) {
  const allEvents = [...events].sort((a, b) => Number(a?.id ?? 0) - Number(b?.id ?? 0));
  const relevant = allEvents.filter(
    (event) =>
      (event?.entityType === "capacity_group" && event?.entityId === groupName) ||
      event?.payload?.capacityGroup === groupName,
  );
  const lending = relevant.filter((event) => event.type === "capacity_group.lending_observed");
  const headroomLending = lending.filter((event) => {
    const lenders = Array.isArray(event?.payload?.lenders) ? event.payload.lenders : [];
    const borrowers = Array.isArray(event?.payload?.borrowers) ? event.payload.borrowers : [];
    return lenders.some((member) => member?.pool === "sim-interactive") &&
      borrowers.some((member) => member?.pool === batchPool);
  });
  const pending = relevant.filter((event) => event.type === "capacity_group.floor_restore_pending");
  const rebalanced = relevant.filter((event) => event.type === "capacity_group.rebalanced");

  // A controller may prepare more than one handoff whose target happens to
  // include the protected batch floor. Bind proof to the restoration episode
  // that actually produced the first data-plane floor restoration, rather than
  // blindly taking the last matching handoff in the run. This prevents a later
  // post-workload handoff from retroactively reclassifying earlier admissions.
  const restorationPreparedCandidates = relevant
    .filter((event) => event.type === "capacity_group.handoff_prepared")
    .filter((event) => {
      const grants = Array.isArray(event?.payload?.grants) ? event.payload.grants : [];
      return grants.some((grant) => {
        if (grant?.pool !== batchPool) return false;
        const concurrent = Number(grant?.limits?.maxConcurrent ?? 0);
        const tokens = Number(grant?.limits?.tokenBudget?.budget ?? 0);
        return (
          concurrent >= batchGuaranteedMaxConcurrent &&
          tokens >= batchGuaranteedTokenBudget
        );
      });
    });
  const restorationObservedAtHint = Date.parse(
    appliedCapacity?.restorationObservation?.firstObservedAt ?? "",
  );
  const candidatesBeforeObservedRestoration = Number.isFinite(restorationObservedAtHint)
    ? restorationPreparedCandidates.filter((event) => {
        const preparedAt = eventTime(event);
        return preparedAt !== null && preparedAt <= restorationObservedAtHint;
      })
    : restorationPreparedCandidates;
  const candidatePool = candidatesBeforeObservedRestoration.length > 0
    ? candidatesBeforeObservedRestoration
    : restorationPreparedCandidates;
  const pendingHandoffIds = new Set(
    pending.map((event) => event?.payload?.handoffId).filter(Boolean),
  );
  const pendingCandidates = candidatePool.filter((event) =>
    pendingHandoffIds.has(event?.payload?.handoffId),
  );
  const restorationPrepared = (pendingCandidates.length > 0
    ? pendingCandidates
    : candidatePool).at(-1) ?? null;
  const handoffId = restorationPrepared?.payload?.handoffId ?? null;
  const handoffEvents = handoffId === null
    ? []
    : relevant.filter((event) => event?.payload?.handoffId === handoffId);
  const drainGrants = Array.isArray(restorationPrepared?.payload?.grants)
    ? restorationPrepared.payload.grants.filter((grant) => grant?.role === "drain")
    : [];
  const appliedDrainEvents = handoffEvents.filter(
    (event) => event.type === "capacity_group.handoff_grant_applied",
  );
  const committed = handoffEvents.find(
    (event) => event.type === "capacity_group.handoff_committed",
  ) ?? null;
  const aborted = handoffEvents.find(
    (event) => event.type === "capacity_group.handoff_aborted",
  ) ?? null;
  const matchingPending = handoffId === null
    ? pending.at(-1) ?? null
    : pending.filter((event) => event?.payload?.handoffId === handoffId).at(-1) ?? pending.at(-1) ?? null;

  const latestPending = matchingPending;
  const pendingId = Number(latestPending?.id ?? -1);
  const restoredEvent = rebalanced.find(
    (event) =>
      Number(event?.id ?? -1) > pendingId &&
      allocatedFloor(
        event,
        batchPool,
        batchGuaranteedMaxConcurrent,
        batchGuaranteedTokenBudget,
      ),
  ) ?? null;

  const finalBatch = Array.isArray(finalRebalance?.members)
    ? finalRebalance.members.find((member) => member?.pool === batchPool)
    : null;
  const finalFloorRestored = finalBatch
    ? Number(finalBatch?.allocated?.maxConcurrent ?? 0) >= batchGuaranteedMaxConcurrent &&
      Number(finalBatch?.allocated?.tokenBudget ?? 0) >= batchGuaranteedTokenBudget
    : false;

  const pendingAt = eventTime(latestPending);
  const restoredAt = eventTime(restoredEvent) ?? eventTime(committed);
  const restorationDurationMs = pendingAt !== null && restoredAt !== null
    ? Math.max(0, restoredAt - pendingAt)
    : null;

  const latestDemandByPool = Object.fromEntries(
    [...demand]
      .sort((a, b) => Date.parse(a?.receivedAt ?? "") - Date.parse(b?.receivedAt ?? ""))
      .map((record) => [record.pool, {
        instanceId: record.instanceId,
        receivedAt: record.receivedAt,
        stateSince: record.stateSince,
        hasDemand: record.hasDemand,
        inFlight: record.inFlight,
        inFlightTokens: record.inFlightTokens,
        pending: record.pending,
        recentAdmissions: record.recentAdmissions,
        recentRejections: record.recentRejections,
        recentBudgetRejections: record.recentBudgetRejections,
        recentConcurrencyRejections: record.recentConcurrencyRejections,
      }]),
  );

  const preparedAt = eventTime(restorationPrepared);
  const commitAt = eventTime(committed);
  const drainIds = new Set(drainGrants.map((grant) => grant.grantId).filter(Boolean));
  const drainAppliedEvents = appliedDrainEvents.filter((event) =>
    drainIds.has(event?.entityId ?? event?.payload?.grantId),
  );
  const firstAckByGrantId = new Map();
  const lastAckByGrantId = new Map();
  const ackCountByGrantId = new Map();
  for (const event of drainAppliedEvents) {
    const grantId = event?.entityId ?? event?.payload?.grantId;
    const at = eventTime(event);
    if (!grantId || at === null) continue;
    if (!firstAckByGrantId.has(grantId) || at < firstAckByGrantId.get(grantId)) {
      firstAckByGrantId.set(grantId, at);
    }
    if (!lastAckByGrantId.has(grantId) || at > lastAckByGrantId.get(grantId)) {
      lastAckByGrantId.set(grantId, at);
    }
    ackCountByGrantId.set(grantId, (ackCountByGrantId.get(grantId) ?? 0) + 1);
  }
  const everyDrainApplied =
    drainIds.size > 0 && [...drainIds].every((grantId) => firstAckByGrantId.has(grantId));
  const allDrainsAcknowledgedAt = everyDrainApplied
    ? Math.max(...[...drainIds].map((grantId) => firstAckByGrantId.get(grantId)))
    : null;
  const lastDrainAckAt = drainAppliedEvents
    .map(eventTime)
    .filter((value) => value !== null)
    .reduce((latest, value) => latest === null ? value : Math.max(latest, value), null);
  const latestBatchDemand = latestDemandByPool[batchPool] ?? null;
  const demandStateSince = latestBatchDemand?.hasDemand === true
    ? Date.parse(latestBatchDemand.stateSince ?? "")
    : Number.NaN;
  // /v1/demand is a current-state view, not a demand-event history. A final idle
  // snapshot can therefore describe a state transition that happened after the
  // restoration handoff. Only use stateSince when it is temporally compatible
  // with the prepared handoff; otherwise leave demand detection unobserved.
  const demandDetectedAt =
    Number.isFinite(demandStateSince) && preparedAt !== null && demandStateSince <= preparedAt
      ? demandStateSince
      : null;
  const grantById = new Map(
    (Array.isArray(grants) ? grants : []).map((grant) => [grant?.grantId, grant]),
  );
  const preparedEntries = Array.isArray(restorationPrepared?.payload?.grants)
    ? restorationPrepared.payload.grants
    : [];
  const sourceExpiries = preparedEntries
    .map((entry) => grantById.get(entry?.fromGrantId))
    .map((grant) => Date.parse(grant?.expiresAt ?? ""))
    .filter(Number.isFinite);
  const successorExpiries = preparedEntries
    .map((entry) => grantById.get(entry?.grantId))
    .map((grant) => Date.parse(grant?.expiresAt ?? ""))
    .filter(Number.isFinite);
  const predecessorLeaseDeadline = sourceExpiries.length > 0
    ? Math.max(...sourceExpiries)
    : null;
  const successorGrantDeadline = successorExpiries.length === preparedEntries.length && successorExpiries.length > 0
    ? Math.min(...successorExpiries)
    : null;
  const reportedFallbackDeadline = Date.parse(
    finalRebalance?.handoff?.fallbackDeadline ??
      matchingPending?.payload?.floorRestorationDeadline ??
      finalRebalance?.floorRestorationDeadline ??
      "",
  );
  const finiteNumber = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const parsedTime = (value) => {
    if (typeof value !== "string" || value === "") return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const loadgenStartedAt = finiteNumber(loadgenStartedAtEpochMs);
  const batchAttemptOffset = finiteNumber(batchFirstAttemptAtMs);
  const responseHeadersOffset = finiteNumber(
    batchFirstResponseHeadersAtMs ?? batchFirstAdmissionAtMs,
  );
  const firstBatchAttemptAt =
    loadgenStartedAt !== null && batchAttemptOffset !== null
      ? loadgenStartedAt + batchAttemptOffset
      : null;
  const firstBatchResponseHeadersAt =
    loadgenStartedAt !== null && responseHeadersOffset !== null
      ? loadgenStartedAt + responseHeadersOffset
      : null;

  // Tyr's admitted counter is sampled independently of client response timing.
  // The previous poll gives a conservative lower bound; the provider's first
  // receipt of the batch model is an upper bound because Tyr cannot dispatch
  // upstream until its local bulkhead has admitted the request. If provider
  // timing is absent, the first counter observation remains a coarser upper
  // bound. This is intentionally an interval, not a fabricated point estimate.
  const admissionObservation = appliedCapacity?.admissionObservation ?? null;
  const previousAdmissionPollStartedAt = parsedTime(
    admissionObservation?.previousPollStartedAt ?? null,
  );
  const firstAdmissionCounterObservedAt = parsedTime(
    admissionObservation?.firstObservedAt ?? null,
  );
  const providerDispatchAt = finiteNumber(
    providerCounters?.firstRequestReceivedAtEpochMsByModel?.[batchModel],
  );
  const firstBatchAdmissionNotBeforeAt = previousAdmissionPollStartedAt;
  const upperCandidates = [providerDispatchAt, firstAdmissionCounterObservedAt]
    .filter((value) => value !== null);
  const firstBatchAdmissionNotAfterAt = upperCandidates.length > 0
    ? Math.min(...upperCandidates)
    : null;
  const admissionWindowMs =
    firstBatchAdmissionNotBeforeAt !== null && firstBatchAdmissionNotAfterAt !== null
      ? Math.max(0, firstBatchAdmissionNotAfterAt - firstBatchAdmissionNotBeforeAt)
      : null;

  const delta = (from, to) =>
    from !== null && to !== null && Number.isFinite(from) && Number.isFinite(to) && to >= from
      ? to - from
      : null;
  const iso = (value) =>
    value !== null && Number.isFinite(value) ? new Date(value).toISOString() : null;
  const appliedDrainIds = new Set(firstAckByGrantId.keys());
  const safeEventOrder =
    preparedAt !== null &&
    allDrainsAcknowledgedAt !== null &&
    commitAt !== null &&
    preparedAt <= allDrainsAcknowledgedAt &&
    allDrainsAcknowledgedAt <= commitAt &&
    aborted === null &&
    everyDrainApplied;
  const intervalCommitBeforeBatchAdmission =
    commitAt === null
      ? null
      : firstBatchAdmissionNotBeforeAt !== null && commitAt <= firstBatchAdmissionNotBeforeAt
        ? true
        : firstBatchAdmissionNotAfterAt !== null && commitAt > firstBatchAdmissionNotAfterAt
          ? false
          : null;
  const intervalAdmissionOrderingStatus =
    intervalCommitBeforeBatchAdmission === true
      ? "proven_after_commit"
      : intervalCommitBeforeBatchAdmission === false
        ? "proven_before_commit"
        : firstBatchAdmissionNotAfterAt !== null
          ? "inconclusive"
          : "unobserved";

  const stagedBatchEntries = preparedEntries.filter(
    (entry) => entry?.pool === batchPool && entry?.role === "staged",
  );
  const successorBatchGrantIds = stagedBatchEntries.map((entry) => entry?.grantId).filter(Boolean);
  const predecessorBatchGrantIds = stagedBatchEntries.map((entry) => entry?.fromGrantId).filter(Boolean);
  const exactAdmissionProof = proveAdmissionUsesSuccessorGrant({
    provenance: appliedCapacity?.admissionProvenance?.batch ?? null,
    successorGrantIds: successorBatchGrantIds,
    predecessorGrantIds: predecessorBatchGrantIds,
    notBeforeAt: preparedAt,
  });
  const exactAdmissionAvailable = appliedCapacity?.admissionProvenance?.batch !== undefined;
  const commitBeforeBatchAdmission = exactAdmissionAvailable
    ? exactAdmissionProof.proven === true
      ? true
      : exactAdmissionProof.violated === true
        ? false
        : null
    : intervalCommitBeforeBatchAdmission;
  const admissionOrderingStatus = exactAdmissionAvailable
    ? exactAdmissionProof.status
    : intervalAdmissionOrderingStatus;
  const admissionOrderingProofSource = exactAdmissionAvailable
    ? exactAdmissionProof.source
    : "tyr.stats.llm.admitted+provider.request_received";
  // Latchflo 0.12.2 transfers physical handoff safety authority after the ACK
  // barrier. Before every restrictive drain is applied, the predecessor lease
  // is the fallback. Afterwards the prepared successor envelope is already
  // authoritative at Tyr, so natural predecessor expiry is not a failure; the
  // earliest successor-grant expiry becomes the safety deadline.
  const safetyDeadline = everyDrainApplied
    ? successorGrantDeadline
    : predecessorLeaseDeadline ?? (Number.isFinite(reportedFallbackDeadline) ? reportedFallbackDeadline : null);
  const safetyDeadlineSource = everyDrainApplied
    ? (successorGrantDeadline !== null ? "prepared_successor_grants" : null)
    : predecessorLeaseDeadline !== null
      ? "predecessor_leases"
      : Number.isFinite(reportedFallbackDeadline)
        ? "controller_fallback"
        : null;
  const committedBeforeSafetyDeadline =
    commitAt !== null && safetyDeadline !== null
      ? commitAt < safetyDeadline
      : null;
  // Retain the predecessor comparison as a diagnostic so 0.12.0 runs can show
  // that a safe handoff legitimately committed after old source expiry.
  const committedBeforeLeaseExpiry =
    commitAt !== null && predecessorLeaseDeadline !== null
      ? commitAt < predecessorLeaseDeadline
      : null;
  const controllerFloorRestored = committed !== null || restoredEvent !== null || finalFloorRestored;
  const dataPlaneFloorRestored = appliedCapacity?.observedRestoredPartition === true;
  const restoredObservedAt = parsedTime(appliedCapacity?.restorationObservation?.firstObservedAt ?? null);
  const effectiveRestoredAt = appliedCapacity === null || appliedCapacity === undefined
    ? eventTime(restoredEvent) ?? eventTime(committed)
    : restoredObservedAt;
  const effectiveFloorRestored = appliedCapacity === null || appliedCapacity === undefined
    ? controllerFloorRestored
    : controllerFloorRestored && dataPlaneFloorRestored;
  const effectiveRestorationDurationMs =
    pendingAt !== null && effectiveRestoredAt !== null && effectiveRestoredAt >= pendingAt
      ? effectiveRestoredAt - pendingAt
      : null;

  const appliedTimeline = Array.isArray(appliedCapacity?.timeline) ? appliedCapacity.timeline : [];
  const drainReadiness = drainGrants.map((grant) => {
    const grantId = grant?.grantId ?? null;
    const targetConcurrent = Number(grant?.limits?.maxConcurrent ?? 0);
    const targetTokens = Number(grant?.limits?.tokenBudget?.budget ?? 0);
    const matching = appliedTimeline.flatMap((sample) =>
      (Array.isArray(sample?.replicas) ? sample.replicas : [])
        .filter((replica) => replica?.interactive?.grants?.some((entry) => entry?.grantId === grantId))
        .map((replica) => ({ sample, replica })),
    );
    const firstApplied = matching.at(0) ?? null;
    const firstOccupancyReady = matching.find(({ replica }) =>
      Number(replica?.interactive?.inFlight ?? 0) <= targetConcurrent &&
      Number(replica?.interactive?.inFlightTokens ?? 0) <= targetTokens
    ) ?? null;
    return {
      grantId,
      instanceId: grant?.instanceId ?? null,
      target: { maxConcurrent: targetConcurrent, tokenBudget: targetTokens },
      firstAckAt: iso(firstAckByGrantId.get(grantId) ?? null),
      lastAckAt: iso(lastAckByGrantId.get(grantId) ?? null),
      ackEvents: ackCountByGrantId.get(grantId) ?? 0,
      firstObservedAppliedAt: firstApplied?.sample?.observedAt ?? null,
      firstObservedOccupancyReadyAt: firstOccupancyReady?.sample?.observedAt ?? null,
      firstObservedOccupancy: firstOccupancyReady
        ? {
            port: firstOccupancyReady.replica?.port ?? null,
            inFlight: firstOccupancyReady.replica?.interactive?.inFlight ?? null,
            inFlightTokens: firstOccupancyReady.replica?.interactive?.inFlightTokens ?? null,
          }
        : null,
    };
  });

  return {
    group: groupName,
    demandAware: finalRebalance?.demandAware === true,
    lendingObserved: lending.length > 0,
    lendingEvents: lending.map((event) => ({
      id: event.id,
      createdAt: event.createdAt,
      lenders: event?.payload?.lenders ?? [],
      borrowers: event?.payload?.borrowers ?? [],
    })),
    headroomLendingObserved: headroomLending.length > 0,
    headroomLendingEvents: headroomLending.map((event) => ({
      id: event.id,
      createdAt: event.createdAt,
      lenders: event?.payload?.lenders ?? [],
      borrowers: event?.payload?.borrowers ?? [],
    })),
    floorRestorePendingObserved: pending.length > 0,
    floorRestorationDeadline: matchingPending?.payload?.floorRestorationDeadline ??
      finalRebalance?.floorRestorationDeadline ?? null,
    floorRestored: effectiveFloorRestored,
    controllerFloorRestored,
    dataPlaneFloorRestored,
    floorRestoredAt: iso(effectiveRestoredAt),
    restorationDurationMs: effectiveRestorationDurationMs,
    handoff: {
      observed: restorationPrepared !== null,
      handoffId,
      drainGrants: drainGrants.length,
      appliedDrainGrants: appliedDrainIds.size,
      everyDrainApplied,
      drainGrantAcks: drainGrants.map((grant) => ({
        grantId: grant?.grantId ?? null,
        instanceId: grant?.instanceId ?? null,
        firstAckAt: iso(firstAckByGrantId.get(grant?.grantId) ?? null),
        lastAckAt: iso(lastAckByGrantId.get(grant?.grantId) ?? null),
        ackEvents: ackCountByGrantId.get(grant?.grantId) ?? 0,
      })),
      duplicateDrainAckEvents: Math.max(0, drainAppliedEvents.length - appliedDrainIds.size),
      aborted: aborted !== null,
      abortReason: aborted?.payload?.reason ?? null,
      demandDetectedAt: iso(demandDetectedAt),
      demandDetectionSource: demandDetectedAt !== null ? "demand.stateSince" : null,
      restorePendingObservedAt: iso(pendingAt),
      drainStartedAt: iso(preparedAt),
      capacityAcknowledgedAt: iso(allDrainsAcknowledgedAt),
      lastDrainAckAt: iso(lastDrainAckAt),
      committedAt: iso(commitAt),
      exactAdmissionProvenance: appliedCapacity?.admissionProvenance?.batch ?? null,
      exactAdmissionProof,
      admissionOrderingProofSource,
      firstBatchAdmissionWindow: {
        source: "tyr.stats.llm.admitted+provider.request_received",
        sampleIntervalMs: admissionObservation?.sampleIntervalMs ?? null,
        notBeforeAt: iso(firstBatchAdmissionNotBeforeAt),
        notAfterAt: iso(firstBatchAdmissionNotAfterAt),
        widthMs: admissionWindowMs,
        firstCounterObservedAt: iso(firstAdmissionCounterObservedAt),
        firstProviderDispatchAt: iso(providerDispatchAt),
        admittedCountAtFirstObservation:
          admissionObservation?.admittedCountAtFirstObservation ?? null,
      },
      firstBatchAttemptAt: iso(firstBatchAttemptAt),
      firstBatchResponseHeadersAt: iso(firstBatchResponseHeadersAt),
      fallbackDeadline: safetyDeadline !== null
        ? new Date(safetyDeadline).toISOString()
        : null,
      safetyDeadline: safetyDeadline !== null ? new Date(safetyDeadline).toISOString() : null,
      safetyDeadlineSource,
      predecessorLeaseDeadline: predecessorLeaseDeadline !== null
        ? new Date(predecessorLeaseDeadline).toISOString()
        : null,
      successorGrantDeadline: successorGrantDeadline !== null
        ? new Date(successorGrantDeadline).toISOString()
        : null,
      demandToDrainStartMs: delta(demandDetectedAt, preparedAt),
      drainStartToAcknowledgedMs: delta(preparedAt, allDrainsAcknowledgedAt),
      acknowledgedToCommitMs: delta(allDrainsAcknowledgedAt, commitAt),
      commitToFirstBatchAdmissionMinMs:
        commitAt !== null && firstBatchAdmissionNotBeforeAt !== null
          ? Math.max(0, firstBatchAdmissionNotBeforeAt - commitAt)
          : null,
      commitToFirstBatchAdmissionMaxMs:
        commitAt !== null && firstBatchAdmissionNotAfterAt !== null
          ? Math.max(0, firstBatchAdmissionNotAfterAt - commitAt)
          : null,
      demandToFirstBatchAdmissionMinMs:
        demandDetectedAt !== null && firstBatchAdmissionNotBeforeAt !== null
          ? Math.max(0, firstBatchAdmissionNotBeforeAt - demandDetectedAt)
          : null,
      demandToFirstBatchAdmissionMaxMs:
        demandDetectedAt !== null && firstBatchAdmissionNotAfterAt !== null
          ? Math.max(0, firstBatchAdmissionNotAfterAt - demandDetectedAt)
          : null,
      attemptToFirstBatchAdmissionMinMs:
        firstBatchAttemptAt !== null && firstBatchAdmissionNotBeforeAt !== null
          ? Math.max(0, firstBatchAdmissionNotBeforeAt - firstBatchAttemptAt)
          : null,
      attemptToFirstBatchAdmissionMaxMs:
        firstBatchAttemptAt !== null && firstBatchAdmissionNotAfterAt !== null
          ? Math.max(0, firstBatchAdmissionNotAfterAt - firstBatchAttemptAt)
          : null,
      commitToFirstBatchResponseHeadersMs: delta(commitAt, firstBatchResponseHeadersAt),
      demandToFirstBatchResponseHeadersMs: delta(demandDetectedAt, firstBatchResponseHeadersAt),
      attemptToFirstBatchResponseHeadersMs: delta(firstBatchAttemptAt, firstBatchResponseHeadersAt),
      handoffDurationMs: delta(preparedAt, commitAt),
      leaseTimeAvoidedMs:
        commitAt !== null && predecessorLeaseDeadline !== null
          ? Math.max(0, predecessorLeaseDeadline - commitAt)
          : null,
      predecessorLeaseLeadMs:
        commitAt !== null && predecessorLeaseDeadline !== null
          ? predecessorLeaseDeadline - commitAt
          : null,
      safetyTimeRemainingMs:
        commitAt !== null && safetyDeadline !== null
          ? safetyDeadline - commitAt
          : null,
      safeEventOrder,
      drainReadiness,
      commitBeforeBatchAdmission,
      admissionOrderingStatus,
      intervalCommitBeforeBatchAdmission,
      intervalAdmissionOrderingStatus,
      committedBeforeSafetyDeadline,
      committedBeforeLeaseExpiry,
      appliedCapacity,
    },
    finalMembers: Array.isArray(finalRebalance?.members) ? finalRebalance.members : [],
    latestDemandByPool,
  };
}
