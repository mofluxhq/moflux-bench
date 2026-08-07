const PROTECTED_CLASS_LIMITS = Object.freeze({
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
});

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
  adaptive: Object.freeze({
    grantTtlMs: 3_000,
    reportStaleAfterMs: 5_000,
    idleAfterMs: 1_000,
    observeIntervalMs: 500,
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
    protected: PROTECTED_CLASS_LIMITS,
    adaptive: PROTECTED_CLASS_LIMITS,
  }),
});

export function tenantPoolDefinition(
  name,
  grantTtlMs,
  { classPolicy = "shared" } = {},
) {
  const policy = TENANT_FAIRNESS_POLICY;
  if (!["shared", "ceilings", "protected", "adaptive"].includes(classPolicy)) {
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
    ...(classPolicy === "adaptive"
      ? {
          admissionClassDemandPolicy: {
            enabled: true,
            reportStaleAfterMs: policy.adaptive.reportStaleAfterMs,
            idleAfterMs: policy.adaptive.idleAfterMs,
          },
        }
      : {}),
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

export function compareTenantFairness(shared, ceilings, protectedArm, adaptiveArm) {
  const summaries = { shared, ceilings, protected: protectedArm, adaptive: adaptiveArm };
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
      ceilings?.trace?.hash === protectedArm?.trace?.hash &&
      protectedArm?.trace?.hash === adaptiveArm?.trace?.hash,
    upstream429s: Object.freeze({
      shared: upstreamRejects(shared),
      ceilings: upstreamRejects(ceilings),
      protected: upstreamRejects(protectedArm),
      adaptive: upstreamRejects(adaptiveArm),
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
      adaptiveVsProtectedTtftRatio: ratio(
        premium.adaptive.contendedTtftP95Ms,
        premium.protected.contendedTtftP95Ms,
      ),
      adaptiveVsProtectedGoodputRatio: ratio(
        premium.adaptive.contendedGoodputRps,
        premium.protected.contendedGoodputRps,
      ),
      adaptiveVsSharedGoodputRatio: ratio(
        premium.adaptive.contendedGoodputRps,
        premium.shared.contendedGoodputRps,
      ),
    }),
    noisy: Object.freeze(noisy),
  });
}

function floorEquals(actual, expected) {
  return Number(actual?.protectedConcurrent ?? 0) === Number(expected?.protectedConcurrent ?? 0) &&
    Number(actual?.protectedInFlightTokens ?? 0) === Number(expected?.protectedInFlightTokens ?? 0);
}

function hardCeilingsEqual(actual, expected) {
  return Number(actual?.maxConcurrent ?? 0) === Number(expected?.maxConcurrent ?? 0) &&
    Number(actual?.maxInFlightTokens ?? 0) === Number(expected?.maxInFlightTokens ?? 0);
}

function controllerNoisy(sample) {
  return sample?.controller?.classes?.find((entry) => entry?.admissionClass === "noisy") ?? null;
}

function sampleHasDemand(sample) {
  const noisy = controllerNoisy(sample);
  const demand = noisy?.demand ?? {};
  return ["demanding", "starved", "protected"].includes(String(demand.state ?? "")) &&
    (
      Number(demand.inFlight ?? 0) > 0 ||
      Number(demand.recentAdmissions ?? 0) > 0 ||
      Number(demand.recentRejections ?? 0) > 0
    );
}

export function summarizeAdaptiveLendingSamples(samples) {
  const nominal = expectedGrantLimits(TENANT_FAIRNESS_POLICY.classPolicies.adaptive).noisy;
  const ordered = [...samples].sort((a, b) => Number(a.offsetMs ?? 0) - Number(b.offsetMs ?? 0));
  const lentIndex = ordered.findIndex((sample) => {
    const noisy = controllerNoisy(sample);
    const applied = sample?.applied?.noisy;
    return Number(noisy?.released?.protectedConcurrent ?? 0) === nominal.protectedConcurrent &&
      Number(noisy?.released?.protectedInFlightTokens ?? 0) === nominal.protectedInFlightTokens &&
      floorEquals(applied, { protectedConcurrent: 0, protectedInFlightTokens: 0 }) &&
      hardCeilingsEqual(applied, nominal);
  });
  const demandingIndex = ordered.findIndex((sample, index) => index > lentIndex && sampleHasDemand(sample));
  const restoredIndex = ordered.findIndex((sample, index) => {
    if (index <= demandingIndex) return false;
    const noisy = controllerNoisy(sample);
    const applied = sample?.applied?.noisy;
    return Number(noisy?.released?.protectedConcurrent ?? -1) === 0 &&
      Number(noisy?.released?.protectedInFlightTokens ?? -1) === 0 &&
      floorEquals(applied, nominal) &&
      hardCeilingsEqual(applied, nominal);
  });
  const restorationPendingIndex = ordered.findIndex((sample, index) =>
    index > lentIndex && controllerNoisy(sample)?.restorationPending === true,
  );
  const first = (index) => index < 0 ? null : Number(ordered[index]?.offsetMs ?? 0);
  return Object.freeze({
    sampleCount: ordered.length,
    noisyFloorLent: lentIndex >= 0,
    noisyDemandObservedAfterLending: demandingIndex >= 0,
    noisyRestorationPendingObserved: restorationPendingIndex >= 0,
    noisyFloorRestored: restoredIndex >= 0,
    hardCeilingsPreservedWhileLent: lentIndex >= 0 &&
      hardCeilingsEqual(ordered[lentIndex]?.applied?.noisy, nominal),
    hardCeilingsPreservedAfterRestoration: restoredIndex >= 0 &&
      hardCeilingsEqual(ordered[restoredIndex]?.applied?.noisy, nominal),
    lentAtMs: first(lentIndex),
    demandObservedAtMs: first(demandingIndex),
    restorationPendingAtMs: first(restorationPendingIndex),
    restoredAtMs: first(restoredIndex),
    restorationLatencyMs:
      demandingIndex >= 0 && restoredIndex >= 0
        ? first(restoredIndex) - first(demandingIndex)
        : null,
  });
}

export function tenantFairnessProof(comparison, adaptiveLending = {}) {
  const minimumNoisyCompletions =
    TENANT_FAIRNESS_POLICY.workload.minimumNoisyCompletionsPerSeed;
  const checks = Object.freeze({
    sameTrace: comparison.traceHashMatches === true,
    noSharedUpstream429s: comparison.upstream429s.shared === 0,
    noCeilingsUpstream429s: comparison.upstream429s.ceilings === 0,
    noProtectedUpstream429s: comparison.upstream429s.protected === 0,
    noAdaptiveUpstream429s: comparison.upstream429s.adaptive === 0,
    ceilingPremiumClassObserved: comparison.premium.ceilings.classifiedResponses > 0,
    ceilingNoisyClassObserved: comparison.noisy.ceilings.classifiedResponses > 0,
    protectedPremiumClassObserved: comparison.premium.protected.classifiedResponses > 0,
    protectedNoisyClassObserved: comparison.noisy.protected.classifiedResponses > 0,
    adaptivePremiumClassObserved: comparison.premium.adaptive.classifiedResponses > 0,
    adaptiveNoisyClassObserved: comparison.noisy.adaptive.classifiedResponses > 0,
    protectedPolicyExercised: comparison.noisy.protected.localRejects > 0,
    adaptivePolicyExercised: comparison.noisy.adaptive.localRejects > 0,
    premiumServedUnderContention: comparison.premium.adaptive.contendedGoodputRps > 0,
    noisyServedUnderContention: comparison.noisy.adaptive.contendedGoodputRps > 0,
    noisyMinimumCompletions:
      comparison.noisy.adaptive.contendedCompleted >= minimumNoisyCompletions,
    adaptiveNoisyFloorLent: adaptiveLending.noisyFloorLent === true,
    adaptiveNoisyDemandObservedAfterLending:
      adaptiveLending.noisyDemandObservedAfterLending === true,
    adaptiveNoisyFloorRestored: adaptiveLending.noisyFloorRestored === true,
    adaptiveHardCeilingsPreservedWhileLent:
      adaptiveLending.hardCeilingsPreservedWhileLent === true,
    adaptiveHardCeilingsPreservedAfterRestoration:
      adaptiveLending.hardCeilingsPreservedAfterRestoration === true,
  });
  const observations = Object.freeze({
    premiumTtftImprovedVsShared:
      comparison.premium.adaptive.contendedTtftP95Ms > 0 &&
      comparison.premium.shared.contendedTtftP95Ms > 0 &&
      comparison.premium.adaptive.contendedTtftP95Ms <
        comparison.premium.shared.contendedTtftP95Ms,
    premiumTtftImprovedVsProtected:
      comparison.premium.adaptive.contendedTtftP95Ms > 0 &&
      comparison.premium.protected.contendedTtftP95Ms > 0 &&
      comparison.premium.adaptive.contendedTtftP95Ms <
        comparison.premium.protected.contendedTtftP95Ms,
    premiumGoodputImprovedVsProtected:
      comparison.premium.adaptive.contendedGoodputRps >
        comparison.premium.protected.contendedGoodputRps,
    restorationPendingObserved:
      adaptiveLending.noisyRestorationPendingObserved === true,
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

export function validateAdmissionClassCeilings(grants, poolName, classPolicy) {
  const configured = TENANT_FAIRNESS_POLICY.classPolicies[classPolicy];
  if (configured === undefined) throw new Error(`unknown class policy ${classPolicy}`);
  const aggregate = aggregateAdmissionClassGrants(grants, poolName);
  const expected = expectedGrantLimits(configured);
  for (const id of Object.keys(expected)) {
    const actual = aggregate[id];
    if (actual === undefined) throw new Error(`${poolName} grant set is missing class ${id}`);
    for (const field of ["maxConcurrent", "maxInFlightTokens"]) {
      if (actual[field] !== expected[id][field]) {
        throw new Error(
          `${poolName} ${id} ${field} sums to ${actual[field]}; expected ${expected[id][field]}`,
        );
      }
    }
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
