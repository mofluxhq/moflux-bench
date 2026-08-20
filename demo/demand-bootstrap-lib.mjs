export function bootstrapCapacityGroup(capacityGroup) {
  if (capacityGroup === null || capacityGroup === undefined) return capacityGroup;
  const policy = capacityGroup.demandPolicy;
  if (policy === null || policy === undefined) return capacityGroup;

  // Latchflo requires member-level headroom lending to be paired with an
  // enabled demand policy. During bootstrap we deliberately disable measured
  // lending until fresh run-local demand exists, so the bootstrap copy must
  // also omit headroomLending. The original live group is left untouched and
  // is reinstalled by activateDemandAwareLending() once measured traffic is
  // present.
  const members = Array.isArray(capacityGroup.members)
    ? Object.freeze(capacityGroup.members.map((member) => {
        if (member === null || typeof member !== "object" || !("headroomLending" in member)) {
          return member;
        }
        const { headroomLending: _headroomLending, ...bootstrapMember } = member;
        return Object.freeze(bootstrapMember);
      }))
    : capacityGroup.members;

  return Object.freeze({
    ...capacityGroup,
    ...(members === undefined ? {} : { members }),
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
