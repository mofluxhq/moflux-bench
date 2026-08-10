/**
 * Pure helpers for configuring and interpreting Latchflo 0.10 demand-aware
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
    return {
      pool: member.pool,
      priority: member.priority,
      guaranteedMaxConcurrent: member.guaranteedMaxConcurrent,
      guaranteedTokenBudget: member.guaranteedTokenBudget,
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
  finalRebalance = null,
  batchPool = "sim-batch",
  batchGuaranteedMaxConcurrent = 1,
  batchGuaranteedTokenBudget = 1,
  loadgenStartedAtEpochMs = null,
  batchFirstAdmissionAtMs = null,
  appliedCapacity = null,
}) {
  const allEvents = [...events].sort((a, b) => Number(a?.id ?? 0) - Number(b?.id ?? 0));
  const relevant = allEvents.filter(
    (event) =>
      (event?.entityType === "capacity_group" && event?.entityId === groupName) ||
      event?.payload?.capacityGroup === groupName,
  );
  const lending = relevant.filter((event) => event.type === "capacity_group.lending_observed");
  const pending = relevant.filter((event) => event.type === "capacity_group.floor_restore_pending");
  const rebalanced = relevant.filter((event) => event.type === "capacity_group.rebalanced");

  // A 0.10 controller may prepare two handoffs in one run: one to lend an idle
  // batch floor and one to restore it. Select the handoff whose target batch
  // grant restores the configured protected floor.
  const restorationPrepared = relevant
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
    })
    .at(-1) ?? null;
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
    : pending.find((event) => event?.payload?.handoffId === handoffId) ?? pending.at(-1) ?? null;

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
  const appliedAt = appliedDrainEvents
    .map(eventTime)
    .filter((value) => value !== null);
  const allDrainsAcknowledgedAt =
    drainGrants.length > 0 && appliedDrainEvents.length >= drainGrants.length && appliedAt.length > 0
      ? Math.max(...appliedAt)
      : null;
  const latestBatchDemand = latestDemandByPool[batchPool] ?? null;
  const demandStateSince = latestBatchDemand?.hasDemand === true
    ? Date.parse(latestBatchDemand.stateSince ?? "")
    : Number.NaN;
  const demandDetectedAt = Number.isFinite(demandStateSince)
    ? demandStateSince
    : pendingAt;
  const fallbackDeadline = Date.parse(
    matchingPending?.payload?.floorRestorationDeadline ??
      finalRebalance?.floorRestorationDeadline ??
      "",
  );
  const firstBatchAdmissionAt =
    Number.isFinite(Number(loadgenStartedAtEpochMs)) &&
    Number.isFinite(Number(batchFirstAdmissionAtMs))
      ? Number(loadgenStartedAtEpochMs) + Number(batchFirstAdmissionAtMs)
      : null;
  const delta = (from, to) =>
    from !== null && to !== null && Number.isFinite(from) && Number.isFinite(to)
      ? Math.max(0, to - from)
      : null;
  const iso = (value) =>
    value !== null && Number.isFinite(value) ? new Date(value).toISOString() : null;
  const drainIds = new Set(drainGrants.map((grant) => grant.grantId));
  const appliedDrainIds = new Set(
    appliedDrainEvents.map((event) => event?.entityId).filter(Boolean),
  );
  const everyDrainApplied =
    drainIds.size > 0 && [...drainIds].every((grantId) => appliedDrainIds.has(grantId));
  const safeEventOrder =
    preparedAt !== null &&
    allDrainsAcknowledgedAt !== null &&
    commitAt !== null &&
    preparedAt <= allDrainsAcknowledgedAt &&
    allDrainsAcknowledgedAt <= commitAt &&
    aborted === null &&
    everyDrainApplied;
  const commitBeforeBatchAdmission =
    commitAt !== null &&
    firstBatchAdmissionAt !== null &&
    commitAt <= firstBatchAdmissionAt;
  const committedBeforeLeaseExpiry =
    commitAt !== null && Number.isFinite(fallbackDeadline)
      ? commitAt < fallbackDeadline
      : null;

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
    floorRestorePendingObserved: pending.length > 0,
    floorRestorationDeadline: matchingPending?.payload?.floorRestorationDeadline ??
      finalRebalance?.floorRestorationDeadline ?? null,
    floorRestored: committed !== null || restoredEvent !== null || finalFloorRestored,
    floorRestoredAt: committed?.createdAt ?? restoredEvent?.createdAt ?? null,
    restorationDurationMs,
    handoff: {
      observed: restorationPrepared !== null,
      handoffId,
      drainGrants: drainGrants.length,
      appliedDrainGrants: appliedDrainIds.size,
      everyDrainApplied,
      aborted: aborted !== null,
      abortReason: aborted?.payload?.reason ?? null,
      demandDetectedAt: iso(demandDetectedAt),
      demandDetectionSource: Number.isFinite(demandStateSince)
        ? "demand.stateSince"
        : pendingAt !== null
          ? "capacity_group.floor_restore_pending"
          : null,
      drainStartedAt: iso(preparedAt),
      capacityAcknowledgedAt: iso(allDrainsAcknowledgedAt),
      committedAt: iso(commitAt),
      firstBatchAdmissionAt: iso(firstBatchAdmissionAt),
      fallbackDeadline: Number.isFinite(fallbackDeadline)
        ? new Date(fallbackDeadline).toISOString()
        : null,
      demandToDrainStartMs: delta(demandDetectedAt, preparedAt),
      drainStartToAcknowledgedMs: delta(preparedAt, allDrainsAcknowledgedAt),
      acknowledgedToCommitMs: delta(allDrainsAcknowledgedAt, commitAt),
      commitToFirstBatchAdmissionMs: delta(commitAt, firstBatchAdmissionAt),
      demandToFirstBatchAdmissionMs: delta(demandDetectedAt, firstBatchAdmissionAt),
      handoffDurationMs: delta(preparedAt, commitAt),
      leaseTimeAvoidedMs:
        commitAt !== null && Number.isFinite(fallbackDeadline)
          ? Math.max(0, fallbackDeadline - commitAt)
          : null,
      safeEventOrder,
      commitBeforeBatchAdmission,
      committedBeforeLeaseExpiry,
      appliedCapacity,
    },
    finalMembers: Array.isArray(finalRebalance?.members) ? finalRebalance.members : [],
    latestDemandByPool,
  };
}
