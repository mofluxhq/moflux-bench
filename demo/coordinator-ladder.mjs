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
import { armSensitivity, crossover, isCoordinatorIndependent } from "./coordination-lib.mjs";
import { runDir as runDirFor, runId as newRunId } from "./evidence-paths-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS = path.join(ROOT, "results");

const rawArgs = new Map(
  process.argv.slice(2).map((arg) => {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    return match ? [match[1], match[2] ?? "true"] : [arg, "true"];
  }),
);
const str = (name, fallback) => rawArgs.get(name) ?? fallback;

const RUNGS = str("rungs", "0,1,5,15,30,50")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value >= 0)
  .sort((a, b) => a - b);
if (RUNGS.length < 2) {
  throw new Error("--rungs needs at least two distinct latencies to fit a trend");
}

const SEEDS = str("seeds", "1-5");
/**
 * The capacity policy each rung runs under.
 *
 * The ladder's own default is the historical 31/1 profile it shipped with, so
 * an existing ladder stays comparable with itself. Every published sweep uses
 * `adaptive-28-4`, so a ladder meant to be read alongside those results should
 * pass `--capacity-profile=adaptive-28-4` — the ladder will not silently change
 * what it measures, but it says which policy it used.
 */
const CAPACITY_PROFILE = str("capacity-profile", "");
const BOLD = "\u001b[1m";
const OFF = "\u001b[0m";

const LADDER_ID = newRunId();
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
    throw new Error(`sweep at ${latencyMs}ms did not write ${path.relative(ROOT, summaryPath)}`);
  }
  const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
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
      /** False for every arm but redis; recorded so the report can say so. */
      coordinatorOnAdmissionPath: metrics.coordinatorOnAdmissionPath?.median ?? null,
    };
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
for (const latencyMs of RUNGS) {
  console.log(`\n${BOLD}=== coordinator latency ${latencyMs}ms ===${OFF}`);
  await runSweep(latencyMs);
  const rung = readRung(latencyMs);
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

function buildReport() {
  const sensitivity = {};
  for (const [arm, rungs] of ladder) {
    sensitivity[arm] = {
      ...armSensitivity(rungs),
      coordinatorIndependent: isCoordinatorIndependent(armSensitivity(rungs)),
      rungDetail: rungs,
    };
  }
  const redis = ladder.get("redis");
  const moflux = ladder.get("moflux");
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    ladderId: LADDER_ID,
    capacityProfile: CAPACITY_PROFILE || "historical-31-1",
    rungs: RUNGS,
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
  };
}

const report = buildReport();
console.log(`\n${BOLD}   Sensitivity to coordinator distance${OFF}`);
console.table(
  Object.entries(report.sensitivity).map(([arm, s]) => ({
    arm,
    "TTFT p50 slope": s.ttftP50 ? `${s.ttftP50.slope} ms/ms` : "—",
    fit: s.ttftP50?.r2 ?? "—",
    "change across ladder": s.ttftP50ChangeMs === null ? "—" : `${s.ttftP50ChangeMs} ms`,
    independent: s.coordinatorIndependent === null ? "—" : String(s.coordinatorIndependent),
  })),
);

const cross = report.crossover?.ttftP50;
if (cross) {
  console.log(
    cross.observedCrossing
      ? `   MoFlux overtakes Redis on TTFT p50 at ${cross.crossesAtMs}ms of coordinator distance.`
      : `   No crossing inside the tested range. Redis stays ahead on TTFT p50 through ${RUNGS[RUNGS.length - 1]}ms; ` +
          `the narrowest deficit was ${cross.narrowestDeficitMs}ms. No crossing beyond the range is claimed.`,
  );
}
console.log(`   report: ${path.relative(ROOT, path.join(RESULTS, "coordinator-ladder.json"))}`);
