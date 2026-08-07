export const TENANT_FAIRNESS_POLICY = Object.freeze({
  physical: Object.freeze({
    maxConcurrent: 32,
    tokenBudget: 64_000,
    minimumGrantTokenBudget: 750,
  }),
  workload: Object.freeze({
    minimumNoisyReservationTokensPerAgent: 8_000,
    minimumNoisyCompletionsPerSeed: 4,
  }),
  classPolicies: Object.freeze({
    ceilings: Object.freeze({
      premium: Object.freeze({
        globalMaxConcurrent: 8,
        globalMaxInFlightTokens: 64_000,
      }),
      noisy: Object.freeze({
        globalMaxConcurrent: 24,
        globalMaxInFlightTokens: 64_000,
      }),
    }),
    protected: Object.freeze({
      premium: Object.freeze({
        globalProtectedConcurrent: 4,
        globalMaxConcurrent: 8,
        globalProtectedInFlightTokens: 8_000,
        globalMaxInFlightTokens: 64_000,
      }),
      noisy: Object.freeze({
        globalProtectedConcurrent: 4,
        globalMaxConcurrent: 24,
        globalProtectedInFlightTokens: 36_000,
        globalMaxInFlightTokens: 64_000,
      }),
    }),
  }),
});

export function tenantPoolDefinition(name, grantTtlMs, { classPolicy = "shared" } = {}) {
  const policy = TENANT_FAIRNESS_POLICY;
  if (!["shared", "ceilings", "protected"].includes(classPolicy)) {
    throw new Error(`unknown tenant-fairness class policy ${classPolicy}`);
  }
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
    ...(classPolicy === "shared"
      ? {}
      : { admissionClassLimits: policy.classPolicies[classPolicy] }),
  });
}

function classCount(summary, workload, admissionClass) {
  return Number(summary?.classes?.[workload]?.admissionClassResponses?.[admissionClass] ?? 0);
}

function contended(summary, workload) {
  return summary?.classes?.[workload]?.windows?.contended ?? null;
}

function upstreamRejects(summary) {
  return Number(summary?.classes?.interactive?.upstreamReject ?? 0) +
    Number(summary?.classes?.batch?.upstreamReject ?? 0);
}

function ratio(numerator, denominator) {
  return Number(denominator) > 0
    ? +(Number(numerator) / Number(denominator)).toFixed(4)
    : null;
}

export function compareTenantFairness(shared, ceilings, protectedArm) {
  const summaries = { shared, ceilings, protected: protectedArm };
  const premium = Object.fromEntries(
    Object.entries(summaries).map(([arm, summary]) => {
      const values = summary?.classes?.interactive ?? {};
      const window = contended(summary, "interactive");
      return [arm, {
        successRate: Number(values.successRate ?? 0),
        contendedCompleted: Number(window?.completed ?? 0),
        contendedGoodputRps: Number(window?.goodputRps ?? 0),
        contendedTtftP95Ms: Number(window?.ttftP95Ms ?? 0),
        classifiedResponses: classCount(summary, "interactive", "premium"),
      }];
    }),
  );
  const noisy = Object.fromEntries(
    Object.entries(summaries).map(([arm, summary]) => {
      const values = summary?.classes?.batch ?? {};
      const window = contended(summary, "batch");
      return [arm, {
        successRate: Number(values.successRate ?? 0),
        contendedCompleted: Number(window?.completed ?? 0),
        contendedGoodputRps: Number(window?.goodputRps ?? 0),
        localRejects: Number(values.localReject ?? 0),
        classifiedResponses: classCount(summary, "batch", "noisy"),
      }];
    }),
  );

  return Object.freeze({
    traceHashMatches:
      shared?.trace?.hash === ceilings?.trace?.hash &&
      ceilings?.trace?.hash === protectedArm?.trace?.hash,
    upstream429s: Object.freeze({
      shared: upstreamRejects(shared),
      ceilings: upstreamRejects(ceilings),
      protected: upstreamRejects(protectedArm),
    }),
    premium: Object.freeze({
      ...premium,
      protectedVsSharedTtftRatio: ratio(
        premium.protected.contendedTtftP95Ms,
        premium.shared.contendedTtftP95Ms,
      ),
      protectedVsCeilingsTtftRatio: ratio(
        premium.protected.contendedTtftP95Ms,
        premium.ceilings.contendedTtftP95Ms,
      ),
      protectedVsCeilingsGoodputRatio: ratio(
        premium.protected.contendedGoodputRps,
        premium.ceilings.contendedGoodputRps,
      ),
    }),
    noisy: Object.freeze(noisy),
  });
}

export function tenantFairnessProof(comparison) {
  const minimumNoisyCompletions =
    TENANT_FAIRNESS_POLICY.workload.minimumNoisyCompletionsPerSeed;
  const checks = Object.freeze({
    sameTrace: comparison.traceHashMatches === true,
    noSharedUpstream429s: comparison.upstream429s.shared === 0,
    noCeilingsUpstream429s: comparison.upstream429s.ceilings === 0,
    noProtectedUpstream429s: comparison.upstream429s.protected === 0,
    ceilingPremiumClassObserved: comparison.premium.ceilings.classifiedResponses > 0,
    ceilingNoisyClassObserved: comparison.noisy.ceilings.classifiedResponses > 0,
    protectedPremiumClassObserved: comparison.premium.protected.classifiedResponses > 0,
    protectedNoisyClassObserved: comparison.noisy.protected.classifiedResponses > 0,
    protectedPolicyExercised: comparison.noisy.protected.localRejects > 0,
    premiumServedUnderContention: comparison.premium.protected.contendedGoodputRps > 0,
    noisyServedUnderContention: comparison.noisy.protected.contendedGoodputRps > 0,
    noisyMinimumCompletions:
      comparison.noisy.protected.contendedCompleted >= minimumNoisyCompletions,
  });
  const observations = Object.freeze({
    premiumTtftImprovedVsShared:
      comparison.premium.protected.contendedTtftP95Ms > 0 &&
      comparison.premium.shared.contendedTtftP95Ms > 0 &&
      comparison.premium.protected.contendedTtftP95Ms <
        comparison.premium.shared.contendedTtftP95Ms,
    premiumTtftImprovedVsCeilings:
      comparison.premium.protected.contendedTtftP95Ms > 0 &&
      comparison.premium.ceilings.contendedTtftP95Ms > 0 &&
      comparison.premium.protected.contendedTtftP95Ms <
        comparison.premium.ceilings.contendedTtftP95Ms,
  });
  return Object.freeze({
    passed: Object.values(checks).every(Boolean),
    checks,
    observations,
  });
}

export function aggregateAdmissionClassGrants(grants, poolName) {
  const total = {};
  for (const grant of grants) {
    if (grant?.pool !== poolName) continue;
    for (const [id, limits] of Object.entries(grant?.limits?.admissionClasses ?? {})) {
      const row = total[id] ?? {
        protectedConcurrent: 0,
        maxConcurrent: 0,
        protectedInFlightTokens: 0,
        maxInFlightTokens: 0,
      };
      row.protectedConcurrent += Number(limits?.protectedConcurrent ?? 0);
      row.maxConcurrent += Number(limits?.maxConcurrent ?? 0);
      row.protectedInFlightTokens += Number(limits?.protectedInFlightTokens ?? 0);
      row.maxInFlightTokens += Number(limits?.maxInFlightTokens ?? 0);
      total[id] = row;
    }
  }
  return total;
}

function expectedGrantLimits(policy) {
  return Object.fromEntries(
    Object.entries(policy).map(([id, limits]) => [id, {
      protectedConcurrent: Number(limits.globalProtectedConcurrent ?? 0),
      maxConcurrent: Number(limits.globalMaxConcurrent ?? 0),
      protectedInFlightTokens: Number(limits.globalProtectedInFlightTokens ?? 0),
      maxInFlightTokens: Number(limits.globalMaxInFlightTokens ?? 0),
    }]),
  );
}

export function validateAdmissionClassGrantSet(grants, poolName, classPolicy) {
  const configured = TENANT_FAIRNESS_POLICY.classPolicies[classPolicy];
  if (configured === undefined) throw new Error(`unknown class policy ${classPolicy}`);
  const aggregate = aggregateAdmissionClassGrants(grants, poolName);
  const expected = expectedGrantLimits(configured);
  for (const id of Object.keys(expected)) {
    const actual = aggregate[id];
    if (actual === undefined) throw new Error(`${poolName} grant set is missing class ${id}`);
    for (const field of [
      "protectedConcurrent",
      "maxConcurrent",
      "protectedInFlightTokens",
      "maxInFlightTokens",
    ]) {
      if (actual[field] !== expected[id][field]) {
        throw new Error(
          `${poolName} ${id} ${field} sums to ${actual[field]}; expected ${expected[id][field]}`,
        );
      }
    }
  }
  if (Object.keys(aggregate).sort().join(",") !== Object.keys(expected).sort().join(",")) {
    throw new Error(`${poolName} grant set contains unexpected admission-class keys`);
  }
  return aggregate;
}

export function validateNoisyRequestFitsEveryGrant(
  grants,
  poolName,
  { requireProtected = false } = {},
) {
  const minimum = TENANT_FAIRNESS_POLICY.workload.minimumNoisyReservationTokensPerAgent;
  const rows = grants.filter((grant) => grant?.pool === poolName);
  if (rows.length === 0) throw new Error(`${poolName} has no admission-class grants`);
  for (const [index, grant] of rows.entries()) {
    const noisy = grant?.limits?.admissionClasses?.noisy;
    if (Number(noisy?.maxInFlightTokens ?? 0) < minimum) {
      throw new Error(
        `${poolName} grant ${index + 1} gives noisy maxInFlightTokens ` +
          `${Number(noisy?.maxInFlightTokens ?? 0)}; one request needs at least ${minimum}`,
      );
    }
    if (requireProtected && Number(noisy?.protectedInFlightTokens ?? 0) < minimum) {
      throw new Error(
        `${poolName} grant ${index + 1} gives noisy protectedInFlightTokens ` +
          `${Number(noisy?.protectedInFlightTokens ?? 0)}; one protected request needs at least ${minimum}`,
      );
    }
  }
  return true;
}
