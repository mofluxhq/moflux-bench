#!/usr/bin/env node
/** Regenerate reporting without rewriting input evidence or running inference. */
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertSafeOutputFile } from "./evidence-paths-lib.mjs";
import { summarizeVllmTelemetry, compareVllmArms, vllmSeedProof, vllmSweepProof } from "./vllm-contention-lib.mjs";
import { summarizeBorrowAccounting, correlateReturnEvidence } from "./vllm-reporting-lib.mjs";
const [input, output] = process.argv.slice(2);
if (!input || !output || process.argv.length !== 4) throw new Error("Usage: node demo/reanalyze-vllm-reporting.mjs INPUT_SUMMARY NEW_OUTPUT_SUMMARY");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = realpathSync(input);
const target = path.join(realpathSync(path.dirname(path.resolve(output))), path.basename(output));
assertSafeOutputFile(target, root);
const hashes = {};
const read = (file) => {
  const bytes = readFileSync(file);
  hashes[path.basename(file)] = createHash("sha256").update(bytes).digest("hex");
  return JSON.parse(bytes);
};
const summary = read(source);
const workload = summary.experiment.workload;
for (const row of summary.results) {
  for (const [id, arm] of Object.entries(row.arms)) {
    if (!/^[a-z-]+$/.test(id) || !Number.isSafeInteger(row.seed)) throw new Error("Invalid arm or seed");
    const loadgen = read(path.join(path.dirname(source), `${id}-seed-${row.seed}.json`));
    const telemetry = read(path.join(path.dirname(source), `${id}-telemetry-seed-${row.seed}.json`));
    if (loadgen.trace?.hash !== arm.trace?.hash || telemetry.arm !== id || telemetry.seed !== row.seed) {
      throw new Error("Raw evidence identity does not match summary");
    }
    // The old phase boundary already includes the measured load-generator skew.
    const phaseStart = arm.vllm?.phases?.contention?.fromMs;
    if (!Number.isFinite(phaseStart)) throw new Error("Missing sampler-aligned phase boundary");
    arm.vllm = summarizeVllmTelemetry({ samples: telemetry.vllm.vllmSamples,
      start: telemetry.vllm.start, end: telemetry.vllm.end, errors: telemetry.vllm.vllmErrors,
      workload, workloadSkewMs: phaseStart - workload.interactiveResumeStartMs });
    arm.batchBorrowAccounting = summarizeBorrowAccounting(loadgen, workload);
    if (arm.batchBorrowAccounting.arrivalCohort.goodputRps !== arm.classes.batch.windows.borrow.goodputRps) {
      throw new Error("Recomputed arrival cohort disagrees with the saved summary");
    }
    if (arm.managed) {
      row.evidence[id].engineCorrelation = correlateReturnEvidence(telemetry.vllm.vllmSamples,
        telemetry.managed?.samples, row.evidence[id].demandReturn);
    }
  }
  row.comparison = compareVllmArms(row.arms);
  row.proof = vllmSeedProof({arms:row.arms,evidence:row.evidence,backend:summary.backend,
    workload,policy:summary.experiment.policy,gpuMemoryUtilization:summary.experiment.engine.gpuMemoryUtilization});
}
summary.proof = vllmSweepProof({rows:summary.results,armOrder:summary.experiment.armOrder});
summary.passed = summary.proof.passed;
summary.reportingVersion = 2;
if (workload.engine) summary.question = "On one Apple-Silicon vLLM Metal server whose KV pool three long batch requests nearly fill, how do FCFS, native priority, a static protected partition, and MoFlux lending compare on SLO goodput, batch completion yield, and sampled admission and engine states?";
summary.reanalysis = {generatedAt:new Date().toISOString(),sourceSummary:source,sourceSha256:hashes,
  note:"Reporting-only reanalysis; original runtime and generatedAt retained. No new inference or changed hypothesis thresholds."};
writeFileSync(target, `${JSON.stringify(summary,null,2)}\n`, {flag:"wx"});
console.log(`Wrote ${target}; proof=${summary.proof.status}`);
