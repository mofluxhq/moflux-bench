import assert from "node:assert/strict";
import { summarizeBorrowAccounting, correlateReturnEvidence } from "./vllm-reporting-lib.mjs";
import { summarizeVllmTelemetry, VLLM_METAL_LONG_CONTEXT_WORKLOAD } from "./vllm-contention-lib.mjs";
const workload = { batchStartMs: 25_000, interactiveResumeStartMs: 60_000 };
const report = summarizeBorrowAccounting({ classes: { batch: { phaseSamples: [
  { arrivalMs: 24_000, completedAtMs: 25_000 },
  { arrivalMs: 25_000, completedAtMs: 59_999 },
  { arrivalMs: 59_999, completedAtMs: 70_000 },
  { arrivalMs: 30_000, completedAtMs: 60_000 },
  { arrivalMs: 60_000, completedAtMs: 80_000 },
] } } }, workload);
assert.equal(report.arrivalCohort.completed, 3);
assert.equal(report.completionWindow.completed, 2);
assert.equal(report.arrivalCohort.goodputRps, 0.086);
assert.equal(report.completionWindow.goodputRps, 0.057);
assert.equal(summarizeBorrowAccounting({}, workload).completionWindow.completed, null);
assert.equal(summarizeBorrowAccounting({classes:{batch:{phaseSamples:[]}}}, workload).completionWindow.completed, 0);
assert.equal(summarizeBorrowAccounting({classes:{batch:{phaseSamples:[{arrivalMs:30_000,completedAtMs:null}]}}}, workload).completionWindow.completed, null);
const sample = (atMs, waiting) => ({ atMs, snapshot: { gauges: { waiting, running: 3, kvCacheUsage: 0.9 } } });
const samples = [sample(60_000, null), sample(61_000, 0), sample(62_000, 2), sample(63_000, 0)];
const queue = summarizeVllmTelemetry({ samples, workload: VLLM_METAL_LONG_CONTEXT_WORKLOAD }).scheduledReturn;
assert.equal(queue.waiting, null);
assert.equal(queue.firstObservedEmptyQueueAtMs, 61_000);
assert.equal(queue.firstObservedEmptyQueueDelayMs, 1_000); // first zero, not sustained clearance
assert.equal(summarizeVllmTelemetry({samples:[sample(60_000,null)], workload:VLLM_METAL_LONG_CONTEXT_WORKLOAD}).scheduledReturn.firstObservedEmptyQueueAtMs, null);
const correlation = correlateReturnEvidence(samples, [{offsetMs:62_500,classes:{batch:{inFlight:2,borrowedConcurrent:1}}}], {benchmarkMarkedActiveAtMs:61_500,floorRestoredAtMs:62_500});
assert.equal(correlation.observedDemandReturn.engine.sampledAtMs,62_000);
assert.equal(correlation.observedDemandReturn.engine.waiting,2);
assert.equal(correlation.observedDemandReturn.engine.sampleLagMs,500);
assert.equal(correlation.observedDemandReturn.admission.batchBorrowedConcurrent,1);
assert.equal(correlation.grantFloorRestored.engine.sampledAtMs,63_000);
assert.equal(correlateReturnEvidence(samples,[],{}).observedDemandReturn,null);
assert.equal(correlateReturnEvidence([],[],{benchmarkMarkedActiveAtMs:60_000}).observedDemandReturn.engine,null);
console.log("PASS  vLLM reporting boundaries, missing evidence, queue semantics, and timestamp correlation");
