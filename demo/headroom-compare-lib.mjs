import { readFileSync } from "node:fs";
import { summarize } from "./seed-sweep-lib.mjs";

export function readCompletedSweepSummary(file, result, profile) {
  if (result?.error) {
    throw new Error(`${profile} sweep could not start: ${result.error.message}`);
  }
  if (result?.status === null || result?.status === undefined) {
    throw new Error(
      `${profile} sweep terminated by ${result?.signal ?? "an unknown signal"}; ` +
      "refusing to treat any partial summary as a completed policy result",
    );
  }

  let summary;
  try {
    summary = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    const suffix = result.status === 0
      ? "completed without a readable summary"
      : `failed (exit code ${result.status}) before preserving a readable summary`;
    throw new Error(
      `${profile} sweep ${suffix}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { summary, nonZeroExit: result.status !== 0 };
}

export const HEADROOM_ACCEPTANCE_DEFAULTS = Object.freeze({
  maximumMedianInteractiveSuccessRegressionPp: 2,
  maximumMedianInteractiveP95RegressionPercent: 10,
  minimumHeadroomEvidenceSeedFraction: 0.6,
});

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function delta(a, b) {
  const x = finite(a);
  const y = finite(b);
  return x === null || y === null ? null : y - x;
}

function percentagePointDelta(a, b) {
  const value = delta(a, b);
  return value === null ? null : value * 100;
}

function percentChange(a, b) {
  const x = finite(a);
  const y = finite(b);
  return x === null || y === null || x === 0 ? null : ((y - x) / x) * 100;
}

function bySeed(summary) {
  return new Map((summary?.runs ?? []).map((run) => [Number(run.seed), run]));
}

function proofBySeed(summary) {
  return new Map((summary?.adaptiveProof?.perSeed ?? []).map((row) => [Number(row.seed), row]));
}

function median(metric) {
  return metric?.median ?? null;
}

function headroomCapacityExpectation(summary) {
  const policy = summary?.capacityPolicy ?? {};
  const members = policy?.capacityGroup?.members ?? [];
  const interactive = members.find((member) => member?.pool === "sim-interactive");
  const batch = members.find((member) => member?.pool === "sim-batch");
  const headroom = interactive?.headroomLending ?? null;
  const batchPool = (policy?.pools ?? []).find((pool) => pool?.name === "sim-batch");
  const maxDemandingConcurrentLend = finite(headroom?.maxDemandingConcurrentLend);
  const maxDemandingTokenLend = finite(headroom?.maxDemandingTokenLend);
  const batchRequiredLocalGrant = finite(batchPool?.reservation?.requiredLocalGrant);
  const concurrencyFundedDemandingLend = maxDemandingConcurrentLend === null
    ? null
    : Math.floor(maxDemandingConcurrentLend);
  const tokenFundedDemandingLend =
    maxDemandingTokenLend === null || batchRequiredLocalGrant === null || batchRequiredLocalGrant <= 0
      ? null
      : Math.floor(maxDemandingTokenLend / batchRequiredLocalGrant);
  const effectiveFundedDemandingLend =
    concurrencyFundedDemandingLend === null || tokenFundedDemandingLend === null
      ? null
      : Math.min(concurrencyFundedDemandingLend, tokenFundedDemandingLend);
  return {
    interactiveGuaranteedMaxConcurrent: finite(interactive?.guaranteedMaxConcurrent),
    interactiveGuaranteedTokenBudget: finite(interactive?.guaranteedTokenBudget),
    batchGuaranteedMaxConcurrent: finite(batch?.guaranteedMaxConcurrent),
    batchGuaranteedTokenBudget: finite(batch?.guaranteedTokenBudget),
    maxDemandingConcurrentLend,
    maxDemandingTokenLend,
    batchRequiredLocalGrant,
    concurrencyFundedDemandingLend,
    tokenFundedDemandingLend,
    effectiveFundedDemandingLend,
  };
}

function normalizeThresholds(seedCount, comparison, overrides = {}) {
  const defaults = HEADROOM_ACCEPTANCE_DEFAULTS;
  const threshold = (name, fallback) => {
    const value = finite(overrides[name] ?? fallback);
    if (value === null) throw new Error(`headroom acceptance threshold ${name} must be finite`);
    return value;
  };
  const fundedLend = finite(comparison?.headroomCapacityExpectation?.effectiveFundedDemandingLend);
  if (fundedLend === null || fundedLend < 1) {
    throw new Error(
      "adaptive-headroom-28-4 must fund at least one additional batch reservation during demanding-state lending",
    );
  }
  const baselineMedian =
    median(comparison?.aggregate?.exercisedBaselineBatchSuccess) ??
    median(comparison?.aggregate?.baselineBatchSuccess);
  if (baselineMedian === null) {
    throw new Error("headroom comparison is missing baseline batch-success evidence");
  }
  const derivedMinimumDelta = Math.max(1, fundedLend);
  const minimumMedianBatchSuccessDelta = threshold(
    "minimumMedianBatchSuccessDelta",
    derivedMinimumDelta,
  );
  const minimumMedianBatchSuccesses = threshold(
    "minimumMedianBatchSuccesses",
    baselineMedian + minimumMedianBatchSuccessDelta,
  );
  const maximumMedianInteractiveSuccessRegressionPp = threshold(
    "maximumMedianInteractiveSuccessRegressionPp",
    defaults.maximumMedianInteractiveSuccessRegressionPp,
  );
  const maximumMedianInteractiveP95RegressionPercent = threshold(
    "maximumMedianInteractiveP95RegressionPercent",
    defaults.maximumMedianInteractiveP95RegressionPercent,
  );
  const fraction = threshold(
    "minimumHeadroomEvidenceSeedFraction",
    defaults.minimumHeadroomEvidenceSeedFraction,
  );
  if (minimumMedianBatchSuccesses < 0 || minimumMedianBatchSuccessDelta < 0) {
    throw new Error("headroom batch acceptance thresholds must be >= 0");
  }
  if (maximumMedianInteractiveSuccessRegressionPp < 0 ||
      maximumMedianInteractiveP95RegressionPercent < 0) {
    throw new Error("headroom interactive regression tolerances must be >= 0");
  }
  if (fraction <= 0 || fraction > 1) {
    throw new Error("minimumHeadroomEvidenceSeedFraction must be > 0 and <= 1");
  }
  return {
    minimumMedianBatchSuccesses,
    minimumMedianBatchSuccessDelta,
    maximumMedianInteractiveSuccessRegressionPp,
    maximumMedianInteractiveP95RegressionPercent,
    minimumHeadroomEvidenceSeedFraction: fraction,
    minimumHeadroomEvidenceSeeds: Math.max(1, Math.ceil(seedCount * fraction)),
    batchThresholdBasis: {
      mode: overrides.minimumMedianBatchSuccessDelta === undefined &&
        overrides.minimumMedianBatchSuccesses === undefined
        ? "bounded-headroom-capacity"
        : "explicit-override",
      baselineMedianBatchSuccesses: baselineMedian,
      effectiveFundedDemandingLend: fundedLend,
    },
  };
}

export function evaluateHeadroomAcceptance(comparison, overrides = {}) {
  const seedCount = comparison?.seeds?.length ?? 0;
  if (seedCount <= 0) throw new Error("headroom comparison has no seeds to evaluate");
  const thresholds = normalizeThresholds(seedCount, comparison, overrides);
  const aggregate = comparison.aggregate ?? {};
  const allSeedMetrics = [
    aggregate.headroomBatchSuccess,
    aggregate.batchSuccessDelta,
    aggregate.interactiveSuccessPercentagePointDelta,
    aggregate.interactiveP95LatencyChangePercent,
  ];
  const headroomEvidenceSeeds = comparison.headroomEvidenceSeeds ?? 0;
  const exercisedBatchMetricsComplete =
    aggregate.exercisedHeadroomBatchSuccess?.n === headroomEvidenceSeeds &&
    aggregate.exercisedBatchSuccessDelta?.n === headroomEvidenceSeeds;
  const observed = {
    outcomeMetricsComplete:
      allSeedMetrics.every((metric) => metric?.n === seedCount) && exercisedBatchMetricsComplete,
    exercisedOutcomeSeeds: aggregate.exercisedBatchSuccessDelta?.n ?? 0,
    medianHeadroomBatchSuccesses: median(aggregate.exercisedHeadroomBatchSuccess),
    medianBatchSuccessDelta: median(aggregate.exercisedBatchSuccessDelta),
    allSeedMedianHeadroomBatchSuccesses: median(aggregate.headroomBatchSuccess),
    allSeedMedianBatchSuccessDelta: median(aggregate.batchSuccessDelta),
    medianInteractiveSuccessPercentagePointDelta: median(
      aggregate.interactiveSuccessPercentagePointDelta,
    ),
    medianInteractiveP95LatencyChangePercent: median(
      aggregate.interactiveP95LatencyChangePercent,
    ),
    headroomEvidenceSeeds,
    exactAdmissionProofSeeds: comparison.exactAdmissionProofSeeds ?? 0,
    zeroUpstream429Seeds: comparison.zeroUpstream429Seeds ?? 0,
  };

  const checks = {
    outcomeMetricsComplete: observed.outcomeMetricsComplete,
    baselineAdaptiveProofPassed: comparison.baselineAdaptiveProofPassed === true,
    headroomAdaptiveProofPassed: comparison.headroomAdaptiveProofPassed === true,
    enoughHeadroomEvidence:
      observed.headroomEvidenceSeeds >= thresholds.minimumHeadroomEvidenceSeeds,
    exactAdmissionProofComplete: observed.exactAdmissionProofSeeds === seedCount,
    zeroUpstream429s: observed.zeroUpstream429Seeds === seedCount,
    materiallyMoreBatchCompletions:
      observed.medianHeadroomBatchSuccesses !== null &&
      observed.medianHeadroomBatchSuccesses >= thresholds.minimumMedianBatchSuccesses &&
      observed.medianBatchSuccessDelta !== null &&
      observed.medianBatchSuccessDelta >= thresholds.minimumMedianBatchSuccessDelta,
    interactiveSuccessPreserved:
      observed.medianInteractiveSuccessPercentagePointDelta !== null &&
      observed.medianInteractiveSuccessPercentagePointDelta >=
        -thresholds.maximumMedianInteractiveSuccessRegressionPp,
    interactiveP95Preserved:
      observed.medianInteractiveP95LatencyChangePercent !== null &&
      observed.medianInteractiveP95LatencyChangePercent <=
        thresholds.maximumMedianInteractiveP95RegressionPercent,
  };

  const failures = [];
  if (!checks.outcomeMetricsComplete) failures.push("paired outcome metrics are incomplete for one or more seeds");
  if (!checks.baselineAdaptiveProofPassed) failures.push("control adaptive 28/4 safety gate failed");
  if (!checks.headroomAdaptiveProofPassed) failures.push("headroom adaptive 28/4 safety gate failed");
  if (!checks.enoughHeadroomEvidence) {
    failures.push(
      `headroom transfer proved on ${observed.headroomEvidenceSeeds}/${seedCount} seeds; ` +
      `need at least ${thresholds.minimumHeadroomEvidenceSeeds}`,
    );
  }
  if (!checks.exactAdmissionProofComplete) {
    failures.push(
      `exact successor-grant admission proof complete on ${observed.exactAdmissionProofSeeds}/${seedCount} seeds`,
    );
  }
  if (!checks.zeroUpstream429s) {
    failures.push(`zero upstream 429s on only ${observed.zeroUpstream429Seeds}/${seedCount} seeds`);
  }
  if (!checks.materiallyMoreBatchCompletions) {
    failures.push(
      `among ${observed.exercisedOutcomeSeeds} headroom-evidence seed(s), median headroom batch completions ` +
      `${observed.medianHeadroomBatchSuccesses ?? "n/a"} (need >= ${thresholds.minimumMedianBatchSuccesses}) ` +
      `and median gain ${observed.medianBatchSuccessDelta ?? "n/a"} ` +
      `(need >= ${thresholds.minimumMedianBatchSuccessDelta})`,
    );
  }
  if (!checks.interactiveSuccessPreserved) {
    failures.push(
      `median interactive success change ${observed.medianInteractiveSuccessPercentagePointDelta ?? "n/a"} pp ` +
      `(maximum allowed regression ${thresholds.maximumMedianInteractiveSuccessRegressionPp} pp)`,
    );
  }
  if (!checks.interactiveP95Preserved) {
    failures.push(
      `median interactive p95 change ${observed.medianInteractiveP95LatencyChangePercent ?? "n/a"}% ` +
      `(maximum allowed regression ${thresholds.maximumMedianInteractiveP95RegressionPercent}%)`,
    );
  }

  return {
    question:
      "When bounded headroom is actually applied, does it produce the capacity-funded batch gain without giving back interactive protection?",
    thresholds,
    observed,
    checks,
    passed: Object.values(checks).every(Boolean),
    failures,
  };
}

export function buildHeadroomPolicyComparison(baseline, headroom, acceptanceOverrides = {}) {
  if (baseline?.capacityPolicy?.profile !== "adaptive-28-4") {
    throw new Error("baseline sweep must use capacity profile adaptive-28-4");
  }
  if (headroom?.capacityPolicy?.profile !== "adaptive-headroom-28-4") {
    throw new Error("headroom sweep must use capacity profile adaptive-headroom-28-4");
  }
  const baselineSeeds = baseline?.seeds ?? [];
  const headroomSeeds = headroom?.seeds ?? [];
  if (JSON.stringify(baselineSeeds) !== JSON.stringify(headroomSeeds)) {
    throw new Error("baseline and headroom sweeps must use the same ordered seeds");
  }
  if (JSON.stringify(baseline?.scenarioTemplate ?? null) !== JSON.stringify(headroom?.scenarioTemplate ?? null)) {
    throw new Error("baseline and headroom sweeps changed the scenario template");
  }

  const baselineRuns = bySeed(baseline);
  const headroomRuns = bySeed(headroom);
  const baselineProof = proofBySeed(baseline);
  const headroomProof = proofBySeed(headroom);

  const perSeed = baselineSeeds.map((seed) => {
    const baseRun = baselineRuns.get(Number(seed));
    const headRun = headroomRuns.get(Number(seed));
    const baseMetrics = baseRun?.mofluxMetrics;
    const headMetrics = headRun?.mofluxMetrics;
    if (!baseMetrics || !headMetrics) throw new Error(`seed ${seed} is missing MoFlux policy metrics`);
    if (baseRun?.scenario?.trace?.hash && headRun?.scenario?.trace?.hash &&
        baseRun.scenario.trace.hash !== headRun.scenario.trace.hash) {
      throw new Error(`seed ${seed} did not replay the same immutable request trace`);
    }
    const baseProof = baselineProof.get(Number(seed));
    const headProof = headroomProof.get(Number(seed));
    const headroomLendingObserved = headProof?.headroomLendingObserved ?? null;
    const dataPlaneHeadroomObserved = headProof?.dataPlaneHeadroomObserved ?? null;
    return {
      seed: Number(seed),
      traceHash: headRun?.scenario?.trace?.hash ?? baseRun?.scenario?.trace?.hash ?? null,
      baselinePassed: baseProof?.passed ?? null,
      headroomPassed: headProof?.passed ?? null,
      headroomLendingObserved,
      dataPlaneHeadroomObserved,
      headroomEvidence: headroomLendingObserved === true && dataPlaneHeadroomObserved === true,
      exactAdmissionProof: headProof?.handoffExactAdmissionProof ?? null,
      baselineBatchSuccess: finite(baseProof?.batchSuccess),
      headroomBatchSuccess: finite(headProof?.batchSuccess),
      batchSuccessDelta: delta(baseProof?.batchSuccess, headProof?.batchSuccess),
      baselineBatchSuccessRate: finite(baseMetrics.batchSuccessRate),
      headroomBatchSuccessRate: finite(headMetrics.batchSuccessRate),
      batchSuccessRatePercentagePointDelta: percentagePointDelta(
        baseMetrics.batchSuccessRate,
        headMetrics.batchSuccessRate,
      ),
      baselineInteractiveSuccessRate: finite(baseMetrics.interactiveSuccessRate),
      headroomInteractiveSuccessRate: finite(headMetrics.interactiveSuccessRate),
      interactiveSuccessPercentagePointDelta: percentagePointDelta(
        baseMetrics.interactiveSuccessRate,
        headMetrics.interactiveSuccessRate,
      ),
      interactiveP95LatencyChangePercent: percentChange(
        baseMetrics.interactiveP95Ms,
        headMetrics.interactiveP95Ms,
      ),
      interactiveTtftP95ChangePercent: percentChange(
        baseMetrics.interactiveTtftP95Ms,
        headMetrics.interactiveTtftP95Ms,
      ),
      localRejectDelta: delta(baseMetrics.localRejects, headMetrics.localRejects),
      baselineUpstream429s: finite(baseMetrics.upstream429s),
      headroomUpstream429s: finite(headMetrics.upstream429s),
      upstream429Delta: delta(baseMetrics.upstream429s, headMetrics.upstream429s),
    };
  });

  const headroomCapacity = headroomCapacityExpectation(headroom);
  const exercisedRows = perSeed.filter((row) => row.headroomEvidence === true);
  const comparison = {
    schemaVersion: 4,
    generatedAt: new Date().toISOString(),
    kind: "headroom-policy-comparison",
    seeds: baselineSeeds,
    baselineProfile: "adaptive-28-4",
    headroomProfile: "adaptive-headroom-28-4",
    sameScenarioTemplate: true,
    headroomEvidenceDefinition:
      "in-window demanding controller event + bounded correlated Tyr transfer",
    headroomCapacityExpectation: headroomCapacity,
    baselineAdaptiveProofPassed: baseline?.adaptiveProof?.passed === true,
    headroomAdaptiveProofPassed: headroom?.adaptiveProof?.passed === true,
    headroomObservedSeeds: perSeed.filter((row) => row.headroomLendingObserved === true).length,
    dataPlaneHeadroomObservedSeeds: perSeed.filter((row) => row.dataPlaneHeadroomObserved === true).length,
    headroomEvidenceSeeds: perSeed.filter((row) => row.headroomEvidence === true).length,
    exactAdmissionProofSeeds: perSeed.filter((row) => row.exactAdmissionProof === true).length,
    zeroUpstream429Seeds: perSeed.filter((row) => row.headroomUpstream429s === 0).length,
    aggregate: {
      baselineBatchSuccess: summarize(perSeed.map((row) => row.baselineBatchSuccess)),
      headroomBatchSuccess: summarize(perSeed.map((row) => row.headroomBatchSuccess)),
      batchSuccessDelta: summarize(perSeed.map((row) => row.batchSuccessDelta)),
      baselineBatchSuccessRate: summarize(perSeed.map((row) => row.baselineBatchSuccessRate)),
      headroomBatchSuccessRate: summarize(perSeed.map((row) => row.headroomBatchSuccessRate)),
      batchSuccessRatePercentagePointDelta: summarize(
        perSeed.map((row) => row.batchSuccessRatePercentagePointDelta),
      ),
      baselineInteractiveSuccessRate: summarize(
        perSeed.map((row) => row.baselineInteractiveSuccessRate),
      ),
      headroomInteractiveSuccessRate: summarize(
        perSeed.map((row) => row.headroomInteractiveSuccessRate),
      ),
      interactiveSuccessPercentagePointDelta: summarize(
        perSeed.map((row) => row.interactiveSuccessPercentagePointDelta),
      ),
      interactiveP95LatencyChangePercent: summarize(
        perSeed.map((row) => row.interactiveP95LatencyChangePercent),
      ),
      interactiveTtftP95ChangePercent: summarize(
        perSeed.map((row) => row.interactiveTtftP95ChangePercent),
      ),
      localRejectDelta: summarize(perSeed.map((row) => row.localRejectDelta)),
      upstream429Delta: summarize(perSeed.map((row) => row.upstream429Delta)),
      exercisedBaselineBatchSuccess: summarize(
        exercisedRows.map((row) => row.baselineBatchSuccess),
      ),
      exercisedHeadroomBatchSuccess: summarize(
        exercisedRows.map((row) => row.headroomBatchSuccess),
      ),
      exercisedBatchSuccessDelta: summarize(
        exercisedRows.map((row) => row.batchSuccessDelta),
      ),
    },
    perSeed,
  };
  comparison.acceptance = evaluateHeadroomAcceptance(comparison, acceptanceOverrides);
  return comparison;
}
