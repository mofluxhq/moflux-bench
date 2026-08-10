export function bootstrapCapacityGroup(capacityGroup) {
  if (capacityGroup === null || capacityGroup === undefined) return capacityGroup;
  const policy = capacityGroup.demandPolicy;
  if (policy === null || policy === undefined) return capacityGroup;
  return Object.freeze({
    ...capacityGroup,
    demandPolicy: Object.freeze({ ...policy, enabled: false }),
  });
}

export function findFreshDemandReport(reports, {
  pool,
  sinceMs,
} = {}) {
  if (!Array.isArray(reports) || typeof pool !== "string" || !Number.isFinite(sinceMs)) {
    return null;
  }
  return reports.find((report) => {
    if (report?.pool !== pool || report?.hasDemand !== true) return false;
    const receivedAtMs = Date.parse(report?.receivedAt ?? "");
    return Number.isFinite(receivedAtMs) && receivedAtMs >= sinceMs;
  }) ?? null;
}
