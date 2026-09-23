const entries = (event) => Array.isArray(event?.payload?.grants) ? event.payload.grants : [];
const time = (event) => Date.parse(event?.createdAt ?? "");
const limits = (grant) => ({
  concurrent: grant?.limits?.maxConcurrent,
  tokens: grant?.limits?.tokenBudget?.budget,
});
const validLimits = (value) => [value.concurrent, value.tokens]
  .every((number) => Number.isFinite(number) && number >= 0);

// A restrictive successor may admit under the already committed parent envelope
// before its own handoff commits. Resolve only unique, same-owner drain chains.
export function restrictiveGrantLineage({ rootEntries, events, committedAt }) {
  const commit = Date.parse(committedAt ?? "");
  if (!Number.isFinite(commit)) return [];
  const roots = new Map(rootEntries.map((grant) => [grant.grantId, grant]));
  const prepared = events.filter((event) => event.type === "capacity_group.handoff_prepared");
  const definitions = new Map();
  for (const event of prepared) for (const grant of entries(event)) {
    const rows = definitions.get(grant.grantId) ?? [];
    rows.push({ grant, at: time(event) });
    definitions.set(grant.grantId, rows);
  }
  const resolve = (id, visiting = new Set()) => {
    if (roots.has(id)) return { root: roots.get(id), grant: roots.get(id), at: commit };
    if (!id || visiting.has(id)) return null;
    const rows = definitions.get(id) ?? [];
    if (rows.length !== 1) return null;
    const { grant, at } = rows[0];
    if (grant.role !== "drain" || !Number.isFinite(at) || at < commit) return null;
    const parent = resolve(grant.fromGrantId, new Set([...visiting, id]));
    const value = limits(grant);
    const previous = limits(parent?.grant);
    if (!parent || at < parent.at || grant.pool !== parent.grant.pool ||
        grant.instanceId !== parent.grant.instanceId || !validLimits(value) ||
        !validLimits(previous) || value.concurrent > previous.concurrent ||
        value.tokens > previous.tokens) return null;
    return { root: parent.root, grant, at };
  };
  return [...definitions.keys()].filter((id) => !roots.has(id)).flatMap((id) => {
    const resolved = resolve(id);
    return resolved ? [{
      grantId: id, rootGrantId: resolved.root.grantId,
      notBeforeAt: new Date(resolved.at).toISOString(),
    }] : [];
  });
}

// The first restored snapshot can overlap the preparation of the next handoff.
// Its batch grant identifies the issuing handoff; preparation time alone cannot.
export function selectRestorationHandoff(candidates, pending, observation, { events = [], batchPool = "sim-batch" } = {}) {
  const ids = (observation?.batch?.grants ?? []).map((grant) => grant?.grantId).filter(Boolean);
  const observedAt = Date.parse(observation?.firstObservedAt ?? "");
  if (ids.length > 0) {
    const matches = candidates.filter((event) => {
      if (!Number.isFinite(observedAt) || time(event) > observedAt) return false;
      const roots = entries(event).filter((grant) => grant.pool === batchPool && grant.role === "staged");
      const commits = events.filter((candidate) => candidate.type === "capacity_group.handoff_committed" &&
        candidate.payload?.handoffId === event.payload?.handoffId);
      const descendants = restrictiveGrantLineage({
        rootEntries: roots, events, committedAt: commits.length === 1 ? commits[0].createdAt : null,
      });
      return ids.every((id) => roots.some((grant) => grant.grantId === id) ||
        descendants.some((grant) => grant.grantId === id && Date.parse(grant.notBeforeAt) <= observedAt));
    });
    return {
      event: matches.length === 1 ? matches[0] : null,
      source: "restoration_batch_grant_lineage",
      status: matches.length === 1 ? "matched" : matches.length > 1 ? "ambiguous" : "missing_origin",
      grantIds: ids,
    };
  }
  // Compatibility for older evidence without grant IDs. Never use this fallback
  // when grant IDs are present but their issuing handoff is missing.
  const before = candidates.filter((event) => !Number.isFinite(observedAt) || time(event) <= observedAt);
  const pool = before.length > 0 ? before : candidates;
  const pendingIds = new Set(pending.map((event) => event?.payload?.handoffId).filter(Boolean));
  const preferred = pool.filter((event) => pendingIds.has(event?.payload?.handoffId));
  return {
    event: (preferred.length > 0 ? preferred : pool).at(-1) ?? null,
    source: "legacy_restoration_time",
    status: "grant_lineage_unavailable",
    grantIds: [],
  };
}

// Resolve a sampled lender grant back to the transfer's original grant. Only
// restrictive drain successors may stand in for that grant; a matching aggregate
// from an unrelated transfer is not evidence for this episode.
function poolMatches(snapshot, originals, prepared, observedAt, allowDrains) {
  const sampled = snapshot?.grants ?? [];
  if (originals.length === 0 || sampled.length !== originals.length) return false;
  const roots = new Map(originals.map((grant) => [grant.grantId, grant]));
  if (roots.size !== originals.length) return false;
  const used = new Set();
  let concurrent = 0;
  let tokens = 0;
  for (const sampledGrant of sampled) {
    let id = sampledGrant?.grantId;
    let currentLimits = null;
    const visited = new Set();
    while (!roots.has(id)) {
      if (!allowDrains || !id || visited.has(id)) return false;
      visited.add(id);
      const links = prepared.flatMap((event) => time(event) <= observedAt
        ? entries(event).filter((grant) => grant.grantId === id)
        : []);
      if (links.length !== 1) return false;
      const link = links[0];
      const value = limits(link);
      if (link.role !== "drain" || !validLimits(value)) return false;
      const parent = roots.get(link.fromGrantId) ?? prepared.flatMap(entries)
        .find((grant) => grant.grantId === link.fromGrantId);
      const parentLimits = limits(parent);
      if (!parent || parent.pool !== link.pool || parent.instanceId !== link.instanceId ||
          !validLimits(parentLimits) || value.concurrent > parentLimits.concurrent ||
          value.tokens > parentLimits.tokens) return false;
      currentLimits ??= value;
      id = link.fromGrantId;
    }
    if (used.has(id)) return false;
    used.add(id);
    currentLimits ??= limits(roots.get(id));
    if (!validLimits(currentLimits)) return false;
    concurrent += currentLimits.concurrent;
    tokens += currentLimits.tokens;
  }
  return snapshot.maxConcurrent === concurrent && snapshot.tokenBudget === tokens;
}

export function correlateHeadroomByGrant({ event, events, timeline, batchPool, guarantees, withinRun }) {
  const eventAt = time(event);
  // Latchflo emits lending_observed immediately after the authority event. Use
  // event ordering (IDs), not timestamps that can coincide within one tick.
  const authority = events.filter((candidate) => Number(candidate.id) < Number(event.id) &&
    ["capacity_group.handoff_committed", "capacity_group.rebalanced"].includes(candidate.type)).at(-1);
  if (!authority || !Number.isFinite(eventAt) || time(authority) > eventAt) return null;
  const authorityEntries = entries(authority);
  const interactive = authorityEntries.filter((grant) => grant.pool === "sim-interactive");
  const batch = authorityEntries.filter((grant) => grant.pool === batchPool);
  if (interactive.length === 0 || batch.length === 0 ||
      [...interactive, ...batch].some((grant) => !grant.grantId || !validLimits(limits(grant)))) return null;
  const total = (grants, key) => grants.reduce((sum, grant) => sum + limits(grant)[key], 0);
  const lender = event.payload?.lenders?.find((member) => member.pool === "sim-interactive");
  const borrower = event.payload?.borrowers?.find((member) => member.pool === batchPool);
  if (!lender || !borrower || Object.values(guarantees).some((value) => !Number.isFinite(value))) return null;
  // Check the issuing envelope against the controller event. Later restrictive
  // lender grants can reduce it further without invalidating the original loan.
  const changes = [
    [guarantees.interactiveConcurrent - total(interactive, "concurrent"), lender.released?.maxConcurrent],
    [guarantees.interactiveTokens - total(interactive, "tokens"), lender.released?.tokenBudget],
    [total(batch, "concurrent") - guarantees.batchConcurrent, borrower.borrowed?.maxConcurrent],
    [total(batch, "tokens") - guarantees.batchTokens, borrower.borrowed?.tokenBudget],
  ];
  if (changes.some(([actual, reported]) => !Number.isFinite(reported) || actual !== reported)) return null;
  const prepared = events.filter((candidate) => candidate.type === "capacity_group.handoff_prepared");
  const sample = timeline.find((candidate) => {
    const observedAt = Date.parse(candidate?.observedAt ?? "");
    return Number.isFinite(observedAt) && observedAt >= eventAt && withinRun(observedAt) &&
      poolMatches(candidate.interactive, interactive, prepared, observedAt, true) &&
      poolMatches(candidate.batch, batch, prepared, observedAt, false);
  });
  if (!sample) return null;
  return {
    controllerEventId: event.id,
    controllerObservedAt: event.createdAt,
    authorityEventId: authority.id,
    handoffId: authority.payload?.handoffId ?? null,
    source: "latchflo.grant_lineage+tyr.stats.applied_limits",
    firstObservedAt: sample.observedAt,
    interactive: sample.interactive,
    batch: sample.batch,
  };
}
