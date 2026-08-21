#!/usr/bin/env node
/**
 * coordinator-ladder.mjs — sweeps the distance to the coordination service.
 *
 * Runs the full paired seed sweep once per latency rung and reports how each
 * arm's admission cost responds. The comparison it exists to make honest:
 *
 *   Arm 4 consults Redis on every admission. That round trip sits on the
 *   request's critical path and is paid once per attempt, forever.
 *
 *   MoFlux holds a capacity grant and decides locally. Its round trip is paid
 *   on grant renewal, off the critical path, amortised across every admission
 *   the grant covers.
 *
 *   On loopback those two costs are indistinguishable, because a round trip is
 *   a few hundred microseconds. Every published comparison so far has been run
 *   that way, which quietly assumed the answer to the one question that
 *   separates the designs.
 *
 * Usage:
 *   node demo/coordinator-ladder.mjs --rungs=0,1,5,15,30,50 --seeds=1-5
 *
 * Each rung is a complete sweep, so this costs rungs x seeds x arms runs.
 * Start with fewer rungs and fewer seeds to size it before committing.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  admissionDecisionLabel,
  admissionDecisionStatus,
  ADMISSION_DECISION_STATES,
  armSensitivity,
  crossover,
  isCoordinatorIndependent,
  alternatingRungOrder,
  orderConfounding,
  pairedCrossover,
  pairedSensitivity,
} from "./coordination-lib.mjs";
import { runDir as runDirFor, runId as newRunId } from "./evidence-paths-lib.mjs";
import { parseSeedSpec } from "./seed-sweep-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS = path.join(ROOT, "results");

const rawArgs = new Map(
  process.argv.slice(2).map((arg) => {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    return match ? [match[1], match[2] ?? "true"] : [arg, "true"];
  }),
);
const str = (name, fallback) => rawArgs.get(name) ?? fallback;

const RUNGS_AS_GIVEN = str("rungs", "0,1,5,15,30,50")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value >= 0);
const RUNGS = [...new Set(RUNGS_AS_GIVEN)].sort((a, b) => a - b);
if (RUNGS.length < 2) {
  throw new Error("--rungs needs at least two distinct latencies to fit a trend");
}

const SEEDS = str("seeds", "1-5");

/**
 * The order the rungs are actually run in.
 *
 * Through 0.19.0 the ladder always ran ascending, which confounds coordinator
 * distance with run order: the largest rung is always measured last, so any
 * drift across the ladder's several hours — thermal, background load, a cache
 * warming — loads directly onto the fitted slope and is indistinguishable from
 * the effect being measured.
 *
 * The 20260813T054929Z ladder shows why that matters. Its 1ms rung, run
 * second, sits above both its 0ms and 5ms neighbours in *every arm*, including
 * baseline and static-cap, which never receive the coordinator flag. A rung
 * effect that appears in arms not under the manipulation is host state, not
 * coordination cost — and with ascending order there is no way to separate the
 * two after the fact.
 *
 *   ascending    (default) smallest rung first; preserves comparability with
 *                every ladder reported before this option existed
 *   alternating  smallest, largest, next smallest, next largest — decorrelates
 *                rung magnitude from run position while staying deterministic,
 *                so a ladder is still reproducible from its arguments
 *   given        exactly the order passed to --rungs
 *
 * The order actually executed is recorded in the report either way, so a
 * reader can see the confound rather than having to assume it away.
 */
const RUNG_ORDER = str("rung-order", "ascending");
if (!new Set(["ascending", "alternating", "given"]).has(RUNG_ORDER)) {
  throw new Error(`--rung-order must be ascending, alternating, or given, got "${RUNG_ORDER}"`);
}

function executionOrder(rungs) {
  if (RUNG_ORDER === "given") return RUNGS_AS_GIVEN;
  if (RUNG_ORDER === "ascending") return [...rungs];
  return alternatingRungOrder(rungs);
}

/**
 * Re-read an existing ladder's run directories and rebuild the report from
 * them, running nothing.
 *
 * A ladder costs rungs x seeds x arms measured runs — the 20260813T054929Z
 * ladder took just over two hours — so a change to the *analysis* must not
 * require re-paying for the *measurement*. The per-rung run directories added
 * in 0.19.0 hold every per-seed arm summary, which is everything the analysis
 * reads. Pass the ladder id, e.g. `--reanalyze=20260813T054929Z`.
 */
const REANALYZE = str("reanalyze", "").trim();
const RESUME = str("resume", "").trim();
if (REANALYZE && RESUME) {
  throw new Error("use either --reanalyze=<ladder-id> or --resume=<ladder-id>, not both");
}

/**
 * The capacity policy each rung runs under.
 *
 * The ladder's own default is the historical 31/1 profile it shipped with, so
 * an existing ladder stays comparable with itself. The coordinator ladder intentionally keeps
 * `adaptive-28-4` as its focused adaptive profile even though the canonical
 * heterogeneous adaptive benchmark now uses `adaptive-headroom-28-4`. The ladder
 * will not silently change what it measures, and every result records the policy.
 */
const CAPACITY_PROFILE = str("capacity-profile", "");

/**
 * The adaptive profile's full outcome gate is deliberately *not* part of the
 * coordinator ladder by default.
 *
 * `--require-adaptive-proof` proves batch-floor restoration, handoff commit,
 * batch success and other policy outcomes. Those are important for heterogeneous adaptive policy validation, but they are
 * not prerequisites for measuring how
 * TTFT responds to coordinator distance. Making them prerequisites censors a
 * rung for an unrelated handoff outcome and can bias the ladder toward seeds
 * that happened to restore the floor.
 *
 * The ladder still records the adaptive proof emitted by every rung as a
 * diagnostic. Use `--require-adaptive-proof` explicitly for the stricter
 * combined experiment; the normal adaptive ladder validates configuration,
 * trace parity, arm health and rung attribution without conditioning on the
 * policy outcome being measured elsewhere.
 */
const REQUIRE_ADAPTIVE_PROOF = str("require-adaptive-proof", "") === "true";
if (REQUIRE_ADAPTIVE_PROOF && CAPACITY_PROFILE !== "adaptive-28-4") {
  throw new Error("--require-adaptive-proof requires --capacity-profile=adaptive-28-4");
}
const BOLD = "\u001b[1m";
const OFF = "\u001b[0m";

const LADDER_ID = REANALYZE || RESUME || newRunId();
const SWEEP_NAME = "video-seed-sweep";
/** Each rung gets its own run directory, named for the rung that produced it. */
const rungRunId = (latencyMs) => `${LADDER_ID}-coord-${latencyMs}ms`;

function runSweep(latencyMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join(ROOT, "demo", "seed-sweep.mjs"),
        `--seeds=${SEEDS}`,
        "--pause-ms=0",
        "--size-distribution=lognormal",
        "--control-arms=all",
        `--coordinator-latency-ms=${latencyMs}`,
        // Named explicitly so this rung is read back from the directory it
        // wrote, rather than from whichever run the latest-run pointer happens
        // to name by the time the rung finishes.
        `--run-id=${rungRunId(latencyMs)}`,
        ...(CAPACITY_PROFILE ? [`--capacity-profile=${CAPACITY_PROFILE}`] : []),
        ...(REQUIRE_ADAPTIVE_PROOF ? ["--require-adaptive-proof"] : []),
      ],
      { cwd: ROOT, stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`sweep at ${latencyMs}ms exited ${code}`)),
    );
  });
}

/**
 * One rung's medians, per arm, read from the run directory that rung wrote.
 *
 * Reading the run by name rather than by latest-run pointer is what makes a
 * rung attributable: a pointer names whatever finished most recently, so a
 * failed or concurrent sweep could silently be attributed to this rung's
 * latency and fitted into the trend.
 */
function readRung(latencyMs) {
  const dir = runDirFor(RESULTS, SWEEP_NAME, rungRunId(latencyMs));
  const summaryPath = path.join(dir, "summary.json");
  if (!existsSync(summaryPath)) {
    // A ladder is hours long and can die between rungs — a host process taking
    // port 9000, a failed acceptance gate, a laptop lid. Re-reading what did
    // complete is the whole point of --reanalyze, so a missing rung is skipped
    // and named rather than throwing away the rungs that did run. Fitting
    // fewer rungs is honest; refusing to fit any is not.
    if (REANALYZE) {
      console.log(`   skipped: ${path.relative(ROOT, summaryPath)} does not exist`);
      return null;
    }
    throw new Error(`sweep at ${latencyMs}ms did not write ${path.relative(ROOT, summaryPath)}`);
  }
  const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  const expectedProfile = CAPACITY_PROFILE || "historical-31-1";
  const recordedProfile = summary.capacityPolicy?.profile ?? null;
  if (recordedProfile !== null && recordedProfile !== expectedProfile) {
    throw new Error(
      `sweep at ${latencyMs}ms records capacity profile ${recordedProfile}, not ${expectedProfile}`,
    );
  }
  // For the adaptive profile the sweep publishes an exact structural check of
  // the 28/4 policy — slots, envelope, token budget, pool guarantees and
  // ceilings — and records it whether or not the outcome gate is enforced.
  // Decoupling the ladder from the *outcome* gate is not a reason to stop
  // checking the *configuration*: a rung labelled adaptive-28-4 whose pool
  // guarantees had drifted would otherwise be fitted into the trend as though
  // it ran the same policy as every other rung.
  if (recordedProfile === "adaptive-28-4" && summary.adaptiveProof?.policyMatches !== true) {
    throw new Error(
      `sweep at ${latencyMs}ms is labelled adaptive-28-4 but its capacity policy does not match the profile`,
    );
  }
  const expectedSeeds = parseSeedSpec(SEEDS);
  if (JSON.stringify(summary.seeds ?? []) !== JSON.stringify(expectedSeeds)) {
    throw new Error(
      `sweep at ${latencyMs}ms records seeds ${JSON.stringify(summary.seeds ?? [])}, ` +
        `not ${JSON.stringify(expectedSeeds)}`,
    );
  }
  rungDiagnostics.set(latencyMs, {
    adaptiveProof: summary.adaptiveProof ?? null,
  });
  const arms = summary.aggregate?.arms ?? {};
  const rung = {};
  for (const [name, metrics] of Object.entries(arms)) {
    if (!metrics) continue;
    // Every arm records the rung it ran at. If it disagrees with the rung the
    // ladder believes it requested, the x-axis is wrong and the fitted slope is
    // meaningless, so it fails rather than being plotted.
    const recorded = metrics.coordinatorLadderRungMs?.median ?? null;
    if (recorded !== null && recorded !== latencyMs) {
      throw new Error(
        `arm ${name} in ${path.relative(ROOT, summaryPath)} records rung ${recorded}ms, not ${latencyMs}ms`,
      );
    }
    rung[name] = {
      coordinatorLatencyMs: latencyMs,
      ttftP50Ms: metrics.interactiveTtftP50Ms?.median ?? null,
      ttftP95Ms: metrics.interactiveTtftP95Ms?.median ?? null,
      successRate: metrics.interactiveSuccessRate?.median ?? null,
      admissionOverheadMs: metrics.admissionOverheadMs?.median ?? null,
      // Carried so a null average can be told apart from a measured zero and
      // from an arm nothing timed at all.
      admissionDecisionSamples: metrics.admissionDecisionSamples?.median ?? null,
      /** False for every arm but redis; recorded so the report can say so. */
      coordinatorOnAdmissionPath: metrics.coordinatorOnAdmissionPath?.median ?? null,
    };
  }

  // The per-seed values behind those medians. The sweep records the exact file
  // it wrote for each arm of each seed, so this reads what the run declared
  // rather than reconstructing filenames that only happen to match today.
  const perSeed = {};
  for (const run of summary.runs ?? []) {
    for (const [name, relative] of Object.entries(run.arms ?? {})) {
      const armPath = path.join(ROOT, relative);
      if (!existsSync(armPath)) {
        throw new Error(
          `sweep at ${latencyMs}ms names ${relative} for arm ${name} seed ${run.seed}, but it is missing`,
        );
      }
      const arm = JSON.parse(readFileSync(armPath, "utf8"));
      // Same guard as the aggregate above, applied one level down: a per-seed
      // file that ran at another rung would silently flatten the fitted slope.
      const recorded = arm.coordinatorLadderRungMs ?? null;
      if (recorded !== null && recorded !== latencyMs) {
        throw new Error(
          `${relative} records rung ${recorded}ms, not ${latencyMs}ms`,
        );
      }
      const interactive = arm.classes?.interactive ?? {};
      (perSeed[name] ??= []).push({
        seed: run.seed,
        coordinatorLatencyMs: latencyMs,
        ttftP50Ms: interactive.ttftMs?.p50 ?? null,
        ttftP95Ms: interactive.ttftMs?.p95 ?? null,
        successRate: interactive.successRate ?? null,
        admissionOverheadMs: arm.admissionDecision?.overheadMsAvg ?? null,
        admissionDecisionSamples: arm.admissionDecision?.decisions ?? null,
      });
    }
  }
  for (const [name, points] of Object.entries(perSeed)) {
    if (!rung[name]) continue;
    rung[name].perSeed = points;
  }
  // An instrumented run must show the coordinator arm actually paying for its
  // decisions. If any arm carries the counters and Redis does not, the
  // instrumentation was lost rather than the cost being zero — and a lost
  // counter reads, in every table downstream, exactly like a free coordinator.
  const instrumented = Object.values(rung).some(
    (arm) => admissionDecisionStatus(arm.admissionDecisionSamples) !== ADMISSION_DECISION_STATES.notInstrumented,
  );
  if (
    instrumented &&
    rung.redis &&
    admissionDecisionStatus(rung.redis.admissionDecisionSamples) !== ADMISSION_DECISION_STATES.measured
  ) {
    throw new Error(
      `sweep at ${latencyMs}ms instruments admission decisions but the redis arm timed none; ` +
        `the coordinator arm consults Redis on every admission, so this is lost instrumentation, not zero cost`,
    );
  }

  for (const required of ["redis", "moflux"]) {
    if (!rung[required]) {
      throw new Error(
        `sweep at ${latencyMs}ms produced no ${required} arm; the ladder compares those two and cannot fit a trend without both`,
      );
    }
  }
  return rung;
}

console.log(
  `${BOLD}Coordinator ladder${OFF} — ${RUNGS.length} rungs (${RUNGS.join(", ")}ms) x seeds ${SEEDS}` +
    `, capacity profile ${CAPACITY_PROFILE || "historical-31-1 (ladder default)"}.`,
);
console.log(`   each rung is a complete paired sweep; run evidence lands in results/runs/${SWEEP_NAME}/${LADDER_ID}-coord-*ms/\n`);

const ladder = new Map();
const rungDiagnostics = new Map();
const EXECUTION_ORDER = executionOrder(RUNGS);
const rungsExecuted = [];
if (RUNG_ORDER !== "ascending" && !REANALYZE) {
  console.log(`   rung order: ${RUNG_ORDER} — running ${EXECUTION_ORDER.join(", ")}ms in that sequence.\n`);
}
for (const latencyMs of EXECUTION_ORDER) {
  if (REANALYZE) {
    console.log(`\n${BOLD}=== coordinator latency ${latencyMs}ms (re-reading ${rungRunId(latencyMs)}) ===${OFF}`);
  } else if (
    RESUME &&
    existsSync(path.join(runDirFor(RESULTS, SWEEP_NAME, rungRunId(latencyMs)), "summary.json"))
  ) {
    console.log(`\n${BOLD}=== coordinator latency ${latencyMs}ms (resume: reusing completed rung) ===${OFF}`);
  } else {
    console.log(`\n${BOLD}=== coordinator latency ${latencyMs}ms ===${OFF}`);
    await runSweep(latencyMs);
  }
  const rung = readRung(latencyMs);
  if (!rung) continue;
  rungsExecuted.push(latencyMs);
  for (const [arm, metrics] of Object.entries(rung)) {
    if (!ladder.has(arm)) ladder.set(arm, []);
    ladder.get(arm).push(metrics);
  }
  // Written after every rung, so an interrupted ladder still leaves usable
  // evidence rather than nothing.
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(
    path.join(RESULTS, "coordinator-ladder.json"),
    JSON.stringify(buildReport(), null, 2),
  );
}

/**
 * Regroup a ladder's rungs into one series per seed.
 *
 * The measurement is paired — every seed replays a byte-identical trace at
 * every rung — so the analysis has to be paired too. Rungs-of-medians is the
 * shape the report used through 0.19.0 and it discards exactly the structure
 * the pairing exists to provide.
 */
function seriesBySeed(rungs) {
  const bySeed = new Map();
  for (const rung of rungs) {
    for (const point of rung.perSeed ?? []) {
      if (!bySeed.has(point.seed)) bySeed.set(point.seed, { seed: point.seed, rungs: [] });
      bySeed.get(point.seed).rungs.push(point);
    }
  }
  return [...bySeed.values()]
    .sort((a, b) => a.seed - b.seed)
    .map((entry) => ({
      ...entry,
      rungs: entry.rungs.sort((a, b) => a.coordinatorLatencyMs - b.coordinatorLatencyMs),
    }));
}

function buildReport() {
  const sensitivity = {};
  const series = new Map();
  for (const [arm, rungs] of ladder) {
    const armSeries = seriesBySeed(rungs);
    series.set(arm, armSeries);
    const unpaired = armSensitivity(rungs);
    sensitivity[arm] = {
      ...unpaired,
      /**
       * The paired analysis, and the verdict the report stands behind.
       *
       * It distinguishes "measured as flat" from "could not tell", which the
       * unpaired verdict below could not: that one returned true whenever the
       * fit was poor, so noise confirmed flatness for an arm predicted to be
       * flat and refuted degradation for an arm predicted to degrade. On the
       * 20260813T054929Z ladder that reported every arm — Redis included — as
       * coordinator-independent, from data in which Redis degraded on 5/5
       * seeds.
       */
      paired: armSeries.length > 0 ? pairedSensitivity(armSeries) : null,
      /**
       * Retained for continuity with ladders reported before the paired
       * analysis existed, and
       * because a reader comparing the two learns what the pairing is worth.
       * It is not the verdict.
       */
      unpairedCoordinatorIndependent: isCoordinatorIndependent(unpaired),
      /**
       * Whether this arm's admission decision was timed at all, kept separate
       * from what the timing said. `not-instrumented` is not a measurement of
       * zero: the MoFlux arm admits inside Tyr rather than the local replica
       * proxy, so no counter exists for it.
       */
      admissionDecision: {
        status: admissionDecisionStatus(rungs[0]?.admissionDecisionSamples),
        samplesPerRung: rungs.map((r) => ({
          coordinatorLatencyMs: r.coordinatorLatencyMs,
          decisions: r.admissionDecisionSamples ?? null,
        })),
      },
      rungDetail: rungs.map(({ perSeed, ...rest }) => rest),
      perSeed: armSeries,
    };
  }
  const redis = ladder.get("redis");
  const moflux = ladder.get("moflux");
  return {
    schemaVersion: 6,
    generatedAt: new Date().toISOString(),
    ladderId: LADDER_ID,
    reanalyzed: REANALYZE ? true : undefined,
    resumed: RESUME ? true : undefined,
    capacityProfile: CAPACITY_PROFILE || "historical-31-1",
    adaptiveProof:
      CAPACITY_PROFILE === "adaptive-28-4"
        ? {
            required: REQUIRE_ADAPTIVE_PROOF,
            perRung: [...rungDiagnostics.entries()]
              .sort((a, b) => a[0] - b[0])
              .map(([coordinatorLatencyMs, diagnostics]) => ({
                coordinatorLatencyMs,
                passed: diagnostics.adaptiveProof?.passed ?? null,
                policyMatches: diagnostics.adaptiveProof?.policyMatches ?? null,
                passedSeeds: diagnostics.adaptiveProof?.passedSeeds ?? null,
                seeds: diagnostics.adaptiveProof?.seeds ?? null,
                failures: diagnostics.adaptiveProof?.failures ?? [],
              })),
          }
        : null,
    rungs: RUNGS,
    /**
     * The sequence the rungs were measured in. Recorded because with
     * "ascending" — the default — rung
     * magnitude and run position are the same variable, so any drift across
     * the ladder's runtime is inseparable from the effect.
     */
    rungOrder: RUNG_ORDER,
    rungExecutionOrder: [...rungsExecuted],
    /**
     * Spearman correlation between rung magnitude and run position: 1 means
     * drift across the run is fully confounded with the measured effect.
     */
    rungOrderConfounding: orderConfounding(rungsExecuted),
    rungsCompleted: [...new Set([...ladder.values()].flatMap((r) => r.map((x) => x.coordinatorLatencyMs)))].sort((a, b) => a - b),
    seeds: SEEDS,
    sensitivity,
    crossover:
      redis && moflux
        ? {
            ttftP50: crossover(redis, moflux, "ttftP50Ms"),
            ttftP95: crossover(redis, moflux, "ttftP95Ms"),
          }
        : null,
    /**
     * The same head-to-head computed within each seed. A rung whose two arm
     * medians come from different seeds compares different workloads, so the
     * unpaired crossover above can move on a single seed changing rank. Here a
     * crossing requires a majority of seeds to change hands.
     */
    pairedCrossover:
      series.get("redis")?.length && series.get("moflux")?.length
        ? {
            ttftP50: pairedCrossover(series.get("redis"), series.get("moflux"), "ttftP50Ms"),
            ttftP95: pairedCrossover(series.get("redis"), series.get("moflux"), "ttftP95Ms"),
          }
        : null,
  };
}

const report = buildReport();

// A slope needs two rungs. If a partial re-read left fewer, say so instead of
// emitting a report whose every arm reads "inconclusive" for a reason that has
// nothing to do with coordinator distance.
if (report.rungsCompleted.length < 2) {
  throw new Error(
    `only ${report.rungsCompleted.length} rung(s) of ladder ${LADDER_ID} are on disk; ` +
      `at least two are needed to fit a trend`,
  );
}
if (report.rungsCompleted.length < RUNGS.length) {
  console.log(
    `\n${BOLD}   Partial ladder${OFF} — ${report.rungsCompleted.length} of ${RUNGS.length} rungs ` +
      `(${report.rungsCompleted.join(", ")}ms). Slopes are fitted on those rungs only.`,
  );
}
console.log(`\n${BOLD}   Sensitivity to coordinator distance${OFF}`);
console.table(
  Object.entries(report.sensitivity).map(([arm, s]) => {
    const p = s.paired?.ttftP50;
    return {
      arm,
      "TTFT p50 slope (median of seeds)": p ? `${p.medianSlope} ms/ms` : "—",
      "95% CI": p?.ci95 ? `[${p.ci95[0]}, ${p.ci95[1]}]` : "—",
      "seeds degrading": p ? `${p.seedsDegrading}/${p.seeds}` : "—",
      "positive-slope p": p?.directionalP ?? "—",
      // Never a bare dash: "not measured" and "measured zero" are different
      // claims, and printing both as "—" next to MoFlux invites a reader to
      // treat an absent counter as evidence of no admission overhead.
      "admission slope": s.paired?.admissionOverhead
        ? `${s.paired.admissionOverhead.medianSlope} ms/ms`
        : admissionDecisionLabel(s.admissionDecision?.status),
      verdict: s.paired?.verdict ?? "—",
    };
  }),
);

for (const [arm, s] of Object.entries(report.sensitivity)) {
  if (!s.paired) continue;
  if (s.paired.verdict === "inconclusive") {
    console.log(
      `   ${arm}: inconclusive at ${s.paired.ttftP50?.seeds ?? 0} seeds — the interval spans ` +
        `±${s.paired.resolutionMsPerMs} ms/ms, so flatness was not shown, only not disproved.`,
    );
  } else {
    console.log(`   ${arm}: ${s.paired.verdict} — ${s.paired.verdictBasis}.`);
  }
}

// Say plainly which arms the direct admission measurement covers, so its
// absence against an arm is never read as a zero for that arm.
const notMeasured = Object.entries(report.sensitivity)
  .filter(([, s]) => s.admissionDecision?.status === ADMISSION_DECISION_STATES.notInstrumented)
  .map(([arm]) => arm);
if (notMeasured.length > 0) {
  console.log(
    `   admission decision not timed for: ${notMeasured.join(", ")} — no counter exists for these arms, ` +
      `which is not a measurement of zero overhead.`,
  );
}

const cross = report.pairedCrossover?.ttftP50;
if (cross) {
  const transient = cross.transientMajorityLeadRungsMs ?? [];
  console.log(
    cross.observedCrossing
      ? `   MoFlux establishes a persistent majority TTFT p50 lead from ${cross.crossesAtMs}ms of coordinator distance.`
      : transient.length > 0
        ? `   No stable crossing inside the tested range. MoFlux held a transient majority lead at ${transient.join(", ")}ms, ` +
          `but it was not confirmed at a subsequent larger rung. The narrowest median deficit was ` +
          `${cross.narrowestMedianDeficitMs}ms.`
        : `   No stable crossing inside the tested range; the narrowest median deficit was ` +
          `${cross.narrowestMedianDeficitMs}ms. No crossing beyond the range is claimed.`,
  );
}
console.log(`   report: ${path.relative(ROOT, path.join(RESULTS, "coordinator-ladder.json"))}`);
