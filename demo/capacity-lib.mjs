export const TYR_CHAT_METADATA_TOKENS = 8;
export const INITIAL_ESTIMATOR_CHARS_PER_TOKEN = 4;

/**
 * Headroom-aware capacity profiles: the protected adaptive 28/4 policy plus a
 * sustained, capped interactive-to-batch lend while both classes demand.
 *
 * Each name fixes every value, so a profile name in a saved result identifies
 * exactly one policy. A new policy gets a new name rather than a changed one.
 */
export const HEADROOM_PROFILES = Object.freeze({
  "adaptive-headroom-28-4": Object.freeze({
    minConcurrentHeadroom: 4,
    minTokenHeadroom: 4000,
    demandingSustainMs: 3000,
    maxDemandingConcurrentLend: 2,
    maxDemandingTokenLend: 10_000,
  }),
  /**
   * One lent slot instead of two. In the headroom comparison the interactive
   * pool never queued or ran short of the slots it lent; its p95 cost tracked
   * the extra batch streams slowing the shared provider, about two with this
   * cap. One slot bounds that at about one extra stream.
   */
  "adaptive-headroom-28-4-lend1": Object.freeze({
    minConcurrentHeadroom: 4,
    minTokenHeadroom: 4000,
    demandingSustainMs: 3000,
    maxDemandingConcurrentLend: 1,
    maxDemandingTokenLend: 10_000,
  }),
});

export function reservationBounds({
  inputChars,
  maxTokens,
  providerInputCharRatio = 3.6,
  providerInputJitter = 0.04,
}) {
  const initial =
    Math.ceil(inputChars / INITIAL_ESTIMATOR_CHARS_PER_TOKEN) +
    TYR_CHAT_METADATA_TOKENS +
    maxTokens;
  const adaptiveCeiling =
    Math.ceil((inputChars / providerInputCharRatio) * (1 + providerInputJitter)) +
    TYR_CHAT_METADATA_TOKENS +
    maxTokens;
  return {
    initial,
    adaptiveCeiling,
    requiredLocalGrant: Math.max(initial, adaptiveCeiling),
  };
}

export function splitInteger(total, parts, index) {
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error("total must be a non-negative safe integer");
  }
  if (!Number.isInteger(parts) || parts < 1) {
    throw new Error("parts must be a positive integer");
  }
  if (!Number.isInteger(index) || index < 0 || index >= parts) {
    throw new Error("index must identify one partition");
  }
  const base = Math.floor(total / parts);
  return base + (index < total % parts ? 1 : 0);
}

export function minimumLocalGrant(globalLimit, agentCount) {
  return splitInteger(globalLimit, agentCount, agentCount - 1);
}

export function fundedConcurrency(pool, requirement) {
  let funded = 0;
  const local = [];
  for (let index = 0; index < pool.agentCount; index += 1) {
    const maxConcurrent = splitInteger(pool.maxConcurrent, pool.agentCount, index);
    const tokenBudget = splitInteger(pool.tokenBudget, pool.agentCount, index);
    const tokenFunded = Math.floor(tokenBudget / requirement.requiredLocalGrant);
    const effective = Math.min(maxConcurrent, tokenFunded);
    funded += effective;
    local.push({ index, maxConcurrent, tokenBudget, tokenFunded, effective });
  }
  return { funded, stranded: pool.maxConcurrent - funded, local };
}

export function validateCapacityPlan({ pools, requirements, requireFullyFundedConcurrency = true }) {
  const resolved = [];
  for (const pool of pools) {
    const requirement = requirements[pool.name];
    if (!requirement) throw new Error(`missing reservation requirement for ${pool.name}`);
    const localTokenGrant = minimumLocalGrant(pool.tokenBudget, pool.agentCount);
    const localConcurrencyGrant = minimumLocalGrant(pool.maxConcurrent, pool.agentCount);
    if (localConcurrencyGrant < 1) {
      throw new Error(
        `${pool.name} has ${pool.maxConcurrent} fleet concurrency across ${pool.agentCount} agents, ` +
          "leaving at least one agent with no usable slot",
      );
    }
    if (localTokenGrant < requirement.requiredLocalGrant) {
      throw new Error(
        `${pool.name} has ${pool.tokenBudget} fleet tokens across ${pool.agentCount} agents ` +
          `(minimum local grant ${localTokenGrant}), but one request can require ` +
          `${requirement.requiredLocalGrant} tokens. Increase that pool's token share, reduce the request, ` +
          "or register fewer agents for the pool.",
      );
    }
    const feasibility = fundedConcurrency(pool, requirement);
    if (requireFullyFundedConcurrency && feasibility.funded < pool.maxConcurrent) {
      throw new Error(
        `${pool.name} configures ${pool.maxConcurrent} concurrency slots but its token allocation funds ` +
          `only ${feasibility.funded}; ${feasibility.stranded} slot${feasibility.stranded === 1 ? " is" : "s are"} ` +
          `stranded. Increase that pool's token budget, lower its concurrency, or explicitly change the request shape.`,
      );
    }
    resolved.push({
      ...pool,
      minimumLocalConcurrencyGrant: localConcurrencyGrant,
      minimumLocalTokenGrant: localTokenGrant,
      tokenFundedConcurrency: feasibility.funded,
      strandedConcurrency: feasibility.stranded,
      localGrants: feasibility.local,
      reservation: requirement,
    });
  }
  return resolved;
}
