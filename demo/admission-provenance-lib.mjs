/**
 * Pure helpers for turning Tyr's stable admission-provenance.v1 rings
 * into benchmark evidence. A synchronous pre-load sample establishes the
 * per-replica next-sequence baseline, so later records are attributable to the
 * measured run without relying on wall-clock ordering across processes.
 */

function finiteInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function normalizedEvidence(pool) {
  const evidence = pool?.admissionProvenance ?? null;
  if (!evidence || typeof evidence !== "object") return null;
  return {
    capacity: finiteInteger(evidence.capacity),
    retained: finiteInteger(evidence.retained),
    dropped: finiteInteger(evidence.dropped),
    captureFailures: finiteInteger(evidence.captureFailures),
    nextSequence: finiteInteger(evidence.nextSequence),
    events: Array.isArray(evidence.events) ? evidence.events : [],
  };
}

function counterDelta(current, baseline) {
  if (current === null || baseline === null) return null;
  return Math.max(0, current - baseline);
}

export function summarizeAdmissionProvenance(samples, { pool = "batch" } = {}) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return {
      source: "tyr.stats.tyr.admissionProvenance",
      schema: "tyr.admission-provenance.v1",
      pool,
      complete: false,
      reason: "no_samples",
      replicas: [],
      firstEventsByReplica: [],
      events: [],
      droppedDelta: null,
      captureFailuresDelta: null,
    };
  }

  const first = samples[0];
  const baselineByPort = new Map();
  for (const replica of first?.replicas ?? []) {
    const evidence = normalizedEvidence(replica?.[pool]);
    if (!evidence || evidence.nextSequence === null) continue;
    baselineByPort.set(replica.port, {
      nextSequence: evidence.nextSequence,
      dropped: evidence.dropped,
      captureFailures: evidence.captureFailures,
    });
  }

  const seen = new Map();
  const latestCounters = new Map();
  for (const sample of samples) {
    for (const replica of sample?.replicas ?? []) {
      const evidence = normalizedEvidence(replica?.[pool]);
      if (!evidence) continue;
      const port = replica.port ?? null;
      const baseline = baselineByPort.get(port);
      if (!baseline) continue;
      latestCounters.set(port, {
        dropped: evidence.dropped,
        captureFailures: evidence.captureFailures,
      });
      for (const event of evidence.events) {
        const sequence = finiteInteger(event?.sequence);
        if (sequence === null || sequence < baseline.nextSequence) continue;
        const key = `${String(port)}:${sequence}`;
        if (seen.has(key)) continue;
        seen.set(key, {
          ...event,
          port,
          firstObservedAt: sample?.observedAt ?? null,
        });
      }
    }
  }

  const replicas = [...baselineByPort.entries()].map(([port, baseline]) => {
    const latest = latestCounters.get(port) ?? {};
    return {
      port,
      baselineNextSequence: baseline.nextSequence,
      baselineDropped: baseline.dropped,
      baselineCaptureFailures: baseline.captureFailures,
      droppedDelta: counterDelta(latest.dropped ?? baseline.dropped, baseline.dropped),
      captureFailuresDelta: counterDelta(
        latest.captureFailures ?? baseline.captureFailures,
        baseline.captureFailures,
      ),
    };
  });
  const events = [...seen.values()].sort((left, right) => {
    if (left.port === right.port) return Number(left.sequence) - Number(right.sequence);
    const leftAt = Date.parse(left.admittedAt ?? "");
    const rightAt = Date.parse(right.admittedAt ?? "");
    if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && leftAt !== rightAt) {
      return leftAt - rightAt;
    }
    return String(left.port).localeCompare(String(right.port));
  });
  const firstEventsByReplica = replicas.map(({ port }) =>
    events.find((event) => event.port === port) ?? null,
  ).filter(Boolean);
  const droppedDelta = replicas.some((replica) => replica.droppedDelta === null)
    ? null
    : replicas.reduce((total, replica) => total + replica.droppedDelta, 0);
  const captureFailuresDelta = replicas.some((replica) => replica.captureFailuresDelta === null)
    ? null
    : replicas.reduce((total, replica) => total + replica.captureFailuresDelta, 0);
  const complete =
    replicas.length > 0 &&
    droppedDelta === 0 &&
    captureFailuresDelta === 0;

  return {
    source: "tyr.stats.tyr.admissionProvenance",
    schema: "tyr.admission-provenance.v1",
    pool,
    complete,
    reason: complete
      ? null
      : replicas.length === 0
        ? "no_provenance_baseline"
        : droppedDelta === null || captureFailuresDelta === null
          ? "invalid_provenance_counters"
          : droppedDelta > 0
            ? "retention_loss"
            : "capture_failure",
    replicas,
    firstEventsByReplica,
    events,
    droppedDelta,
    captureFailuresDelta,
  };
}

export function proveAdmissionUsesSuccessorGrant({
  provenance,
  successorGrantIds = [],
  predecessorGrantIds = [],
  notBeforeAt = null,
} = {}) {
  const successors = new Set(successorGrantIds.filter(Boolean));
  const predecessors = new Set(predecessorGrantIds.filter(Boolean));
  const lineage = new Set([...successors, ...predecessors]);
  const fallbackFirstEvents = Array.isArray(provenance?.firstEventsByReplica)
    ? provenance.firstEventsByReplica
    : [];
  const allEvents = Array.isArray(provenance?.events) && provenance.events.length > 0
    ? provenance.events
    : fallbackFirstEvents;
  const parsedNotBeforeAt = typeof notBeforeAt === "string"
    ? Date.parse(notBeforeAt)
    : Number(notBeforeAt);
  const hasNotBeforeAt = Number.isFinite(parsedNotBeforeAt);
  const scopedEvents = allEvents.filter((event) => {
    const grantId = event?.grant?.grantId ?? null;
    if (!grantId || !lineage.has(grantId)) return false;
    if (!hasNotBeforeAt) return true;
    const admittedAt = Date.parse(event?.admittedAt ?? "");
    return Number.isFinite(admittedAt) && admittedAt >= parsedNotBeforeAt;
  });
  const firstByReplica = new Map();
  for (const event of scopedEvents) {
    const key = event?.port ?? "unknown";
    const current = firstByReplica.get(key);
    if (!current) {
      firstByReplica.set(key, event);
      continue;
    }
    const currentAt = Date.parse(current?.admittedAt ?? "");
    const nextAt = Date.parse(event?.admittedAt ?? "");
    if (Number.isFinite(nextAt) && (!Number.isFinite(currentAt) || nextAt < currentAt)) {
      firstByReplica.set(key, event);
    }
  }
  const firstEvents = [...firstByReplica.values()];

  if (provenance?.complete !== true) {
    return {
      proven: false,
      violated: false,
      status: provenance?.reason === "retention_loss" || provenance?.reason === "capture_failure"
        ? "inconclusive_provenance_loss"
        : "inconclusive_provenance_unavailable",
      source: provenance?.source ?? "tyr.stats.tyr.admissionProvenance",
      firstEvents,
    };
  }
  if (firstEvents.length === 0) {
    return {
      proven: false,
      violated: false,
      status: "unobserved",
      source: provenance.source,
      firstEvents,
    };
  }

  const predecessorEvent = scopedEvents.find((event) => predecessors.has(event?.grant?.grantId));
  if (predecessorEvent) {
    return {
      proven: false,
      violated: true,
      status: "proven_before_commit_by_predecessor_grant",
      source: provenance.source,
      firstEvents,
      violatingEvent: predecessorEvent,
    };
  }

  const allSuccessor =
    successors.size > 0 &&
    firstEvents.every((event) => successors.has(event?.grant?.grantId));
  if (allSuccessor) {
    return {
      proven: true,
      violated: false,
      status: "proven_after_commit_by_successor_grant",
      source: provenance.source,
      firstEvents,
      successorGrantIds: [...successors],
    };
  }

  return {
    proven: false,
    violated: false,
    status: firstEvents.some((event) => !event?.grant?.grantId)
      ? "inconclusive_missing_grant_provenance"
      : "inconclusive_unexpected_grant",
    source: provenance.source,
    firstEvents,
    successorGrantIds: [...successors],
  };
}
