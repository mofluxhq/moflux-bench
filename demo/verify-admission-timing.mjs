#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  ADMISSION_TIMING_FRAMING,
  measureAdmissionClockOverhead,
  summarizeTyrAdmissionTiming,
  tyrTimingExpected,
} from "./admission-timing-lib.mjs";

function tyrMetrics({ admitted = 0, rejected = 0, admittedSum = 0, rejectedSum = 0, rejectedQueueSum = 0 } = {}) {
  return [
    `tyr_admission_decision_seconds_sum{admission_class="none",outcome="admitted",pool="sim-interactive"} ${admittedSum}`,
    `tyr_admission_decision_seconds_count{admission_class="none",outcome="admitted",pool="sim-interactive"} ${admitted}`,
    `tyr_admission_queue_wait_seconds_sum{admission_class="none",outcome="admitted",pool="sim-interactive"} 0`,
    `tyr_admission_queue_wait_seconds_count{admission_class="none",outcome="admitted",pool="sim-interactive"} ${admitted}`,
    `tyr_admission_decisions_total{admission_class="none",outcome="admitted",pool="sim-interactive",priority="high"} ${admitted}`,
    `tyr_admission_decision_seconds_sum{admission_class="none",outcome="rejected",pool="sim-interactive"} ${rejectedSum}`,
    `tyr_admission_decision_seconds_count{admission_class="none",outcome="rejected",pool="sim-interactive"} ${rejected}`,
    `tyr_admission_queue_wait_seconds_sum{admission_class="none",outcome="rejected",pool="sim-interactive"} ${rejectedQueueSum}`,
    `tyr_admission_queue_wait_seconds_count{admission_class="none",outcome="rejected",pool="sim-interactive"} ${rejected}`,
    `tyr_admission_decisions_total{admission_class="none",outcome="rejected",pool="sim-interactive",priority="high"} ${rejected}`,
    "",
  ].join("\n");
}

assert.equal(tyrTimingExpected("0.26.9"), false);
assert.equal(tyrTimingExpected("0.27.0"), true);
assert.equal(tyrTimingExpected("0.29.0"), true);

const historical = summarizeTyrAdmissionTiming({ beforeTexts: [], afterTexts: [""], tyrVersion: "0.26.0" });
assert.equal(historical.status, "not-instrumented");
assert.equal(historical.totalDecisions, null);

assert.throws(
  () => summarizeTyrAdmissionTiming({ beforeTexts: [], afterTexts: [""], tyrVersion: "0.27.0" }),
  /claims admission timing support/,
);

const before = tyrMetrics({ admitted: 1, admittedSum: 0.00001 });
const after = tyrMetrics({ admitted: 4, rejected: 2, admittedSum: 0.00004, rejectedSum: 0.000012, rejectedQueueSum: 0 });
const summary = summarizeTyrAdmissionTiming({ beforeTexts: [before], afterTexts: [after], tyrVersion: "0.27.0" });
assert.equal(summary.status, "measured");
assert.equal(summary.outcomes.admitted.decisions, 3);
assert.equal(summary.outcomes.rejected.decisions, 2);
assert.equal(summary.totalDecisions, 5);
assert.equal(summary.outcomes.rejected.queueWaitSecondsSum, 0, "precheck reject queue-wait aggregate must preserve exact zero");
assert.equal(summary.outcomes.admitted.decisionMsAvg, 0.01);
assert.equal(summary.outcomes.rejected.decisionMsAvg, 0.006);
assert.match(summary.framing, /excludes queue wait/);
assert.equal(summary.framing, ADMISSION_TIMING_FRAMING);

const mismatch = after.replace(
  'tyr_admission_queue_wait_seconds_count{admission_class="none",outcome="rejected",pool="sim-interactive"} 2',
  'tyr_admission_queue_wait_seconds_count{admission_class="none",outcome="rejected",pool="sim-interactive"} 1',
);
assert.throws(
  () => summarizeTyrAdmissionTiming({ beforeTexts: [before], afterTexts: [mismatch], tyrVersion: "0.27.0" }),
  /population mismatch/,
);

const zero = tyrMetrics();
assert.throws(
  () => summarizeTyrAdmissionTiming({ beforeTexts: [zero], afterTexts: [zero], tyrVersion: "0.27.0" }),
  /recorded zero decisions/,
);

const overhead = measureAdmissionClockOverhead({ iterations: 10_000 });
assert.equal(overhead.subtractedFromDecisionMetric, false);
assert(Number.isFinite(overhead.runtimeTaxNsPerDecision));
assert(Number.isFinite(overhead.reportedTimerFloorNs));
assert(overhead.reportedTimerFloorNs > 0);

console.log(
  `PASS admission timing: admitted=${summary.outcomes.admitted.decisionMsAvg}ms ` +
    `rejected=${summary.outcomes.rejected.decisionMsAvg}ms; ` +
    `timer-floor=${overhead.reportedTimerFloorNs}ns`,
);
