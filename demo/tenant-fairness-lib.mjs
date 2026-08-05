export const TENANT_FAIRNESS_POLICY = Object.freeze({
  physical: Object.freeze({
    maxConcurrent: 32,
    tokenBudget: 64_000,
    minimumGrantTokenBudget: 750,
  }),
  admissionClasses: Object.freeze({
    premium: Object.freeze({
      globalMaxConcurrent: 8,
      globalMaxInFlightTokens: 16_000,
    }),
    noisy: Object.freeze({
      globalMaxConcurrent: 24,
      globalMaxInFlightTokens: 48_000,
    }),
  }),
});

export function tenantPoolDefinition(name, grantTtlMs, { isolated = false } = {}) {
  const policy = TENANT_FAIRNESS_POLICY;
  return Object.freeze({
    name,
    globalMaxConcurrent: policy.physical.maxConcurrent,
    minimumGrantMaxConcurrent: 1,
    maxQueuePerAgent: 0,
    globalTokenBudget: policy.physical.tokenBudget,
    minimumGrantTokenBudget: policy.physical.minimumGrantTokenBudget,
    globalHighPriorityReserve: 0,
    safetyReservePercent: 0,
    grantTtlMs,
    ...(isolated ? { admissionClassLimits: policy.admissionClasses } : {}),
  });
}

function classCount(summary, workload, admissionClass) {
  return Number(summary?.classes?.[workload]?.admissionClassResponses?.[admissionClass] ?? 0);
}

function contended(summary, workload) {
  return summary?.classes?.[workload]?.windows?.contended ?? null;
}

export function compareTenantFairness(shared, isolated) {
  const sharedPremium = shared?.classes?.interactive ?? {};
  const isolatedPremium = isolated?.classes?.interactive ?? {};
  const sharedNoisy = shared?.classes?.batch ?? {};
  const isolatedNoisy = isolated?.classes?.batch ?? {};
  const sharedWindow = contended(shared, "interactive");
  const isolatedWindow = contended(isolated, "interactive");
  const ratio = (numerator, denominator) =>
    Number(denominator) > 0 ? +(Number(numerator) / Number(denominator)).toFixed(4) : null;

  return Object.freeze({
    traceHashMatches: shared?.trace?.hash === isolated?.trace?.hash,
    upstream429s: Object.freeze({
      shared: Number(sharedPremium.upstreamReject ?? 0) + Number(sharedNoisy.upstreamReject ?? 0),
      isolated: Number(isolatedPremium.upstreamReject ?? 0) + Number(isolatedNoisy.upstreamReject ?? 0),
    }),
    premium: Object.freeze({
      sharedSuccessRate: Number(sharedPremium.successRate ?? 0),
      isolatedSuccessRate: Number(isolatedPremium.successRate ?? 0),
      successRateGain: +(Number(isolatedPremium.successRate ?? 0) - Number(sharedPremium.successRate ?? 0)).toFixed(4),
      sharedContendedGoodputRps: Number(sharedWindow?.goodputRps ?? 0),
      isolatedContendedGoodputRps: Number(isolatedWindow?.goodputRps ?? 0),
      contendedGoodputRatio: ratio(isolatedWindow?.goodputRps, sharedWindow?.goodputRps),
      sharedContendedTtftP95Ms: Number(sharedWindow?.ttftP95Ms ?? 0),
      isolatedContendedTtftP95Ms: Number(isolatedWindow?.ttftP95Ms ?? 0),
      contendedTtftRatio: ratio(isolatedWindow?.ttftP95Ms, sharedWindow?.ttftP95Ms),
      classifiedResponses: classCount(isolated, "interactive", "premium"),
    }),
    noisy: Object.freeze({
      sharedSuccessRate: Number(sharedNoisy.successRate ?? 0),
      isolatedSuccessRate: Number(isolatedNoisy.successRate ?? 0),
      isolatedLocalRejects: Number(isolatedNoisy.localReject ?? 0),
      classifiedResponses: classCount(isolated, "batch", "noisy"),
    }),
  });
}

export function tenantFairnessProof(comparison) {
  const checks = Object.freeze({
    sameTrace: comparison.traceHashMatches === true,
    noSharedUpstream429s: comparison.upstream429s.shared === 0,
    noIsolatedUpstream429s: comparison.upstream429s.isolated === 0,
    premiumClassObserved: comparison.premium.classifiedResponses > 0,
    noisyClassObserved: comparison.noisy.classifiedResponses > 0,
    noisyClassBound: comparison.noisy.isolatedLocalRejects > 0,
    premiumServedUnderContention: comparison.premium.isolatedContendedGoodputRps > 0,
  });
  return Object.freeze({
    passed: Object.values(checks).every(Boolean),
    checks,
  });
}

export function aggregateAdmissionClassGrants(grants, poolName) {
  const total = {};
  for (const grant of grants) {
    if (grant?.pool !== poolName) continue;
    for (const [id, limits] of Object.entries(grant?.limits?.admissionClasses ?? {})) {
      const row = total[id] ?? { maxConcurrent: 0, maxInFlightTokens: 0 };
      row.maxConcurrent += Number(limits?.maxConcurrent ?? 0);
      row.maxInFlightTokens += Number(limits?.maxInFlightTokens ?? 0);
      total[id] = row;
    }
  }
  return total;
}

export function validateAdmissionClassGrantSet(grants) {
  const aggregate = aggregateAdmissionClassGrants(grants, "sim-isolated");
  const expected = TENANT_FAIRNESS_POLICY.admissionClasses;
  for (const id of Object.keys(expected)) {
    const actual = aggregate[id];
    if (actual === undefined) throw new Error(`sim-isolated grant set is missing class ${id}`);
    if (actual.maxConcurrent !== expected[id].globalMaxConcurrent) {
      throw new Error(
        `${id} class concurrency sums to ${actual.maxConcurrent}; expected ${expected[id].globalMaxConcurrent}`,
      );
    }
    if (actual.maxInFlightTokens !== expected[id].globalMaxInFlightTokens) {
      throw new Error(
        `${id} class token capacity sums to ${actual.maxInFlightTokens}; expected ${expected[id].globalMaxInFlightTokens}`,
      );
    }
  }
  if (Object.keys(aggregate).sort().join(",") !== Object.keys(expected).sort().join(",")) {
    throw new Error("sim-isolated grant set contains unexpected admission-class keys");
  }
  return aggregate;
}
