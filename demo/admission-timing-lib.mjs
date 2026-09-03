import { versionAtLeast } from "./version-lib.mjs";

export const ADMISSION_TIMING_FRAMING =
  "Redis's atomic Lua reserve round trip is its entire admission-decision cost. " +
  "MoFlux decision duration is Tyr/async-bulkhead-llm synchronous local decision work and explicitly excludes queue wait; " +
  "queue wait is reported separately and is not included in the overhead comparison.";

const TYR_TIMING_MIN_VERSION = [0, 27, 0];
const SERIES_LABELS = ["pool", "outcome", "admission_class"];

export function tyrTimingExpected(version) {
  return versionAtLeast(version, TYR_TIMING_MIN_VERSION);
}

function unescapeLabel(value) {
  return value.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function parseLabels(raw = "") {
  const labels = {};
  const re = /([A-Za-z_][A-Za-z0-9_]*)="((?:\\.|[^"\\])*)"/g;
  let match;
  while ((match = re.exec(raw)) !== null) labels[match[1]] = unescapeLabel(match[2]);
  return labels;
}

export function prometheusSamples(text, metricName) {
  const escaped = metricName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escaped}(?:\\{([^}]*)\\})?\\s+([-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?)$`, "gm");
  const rows = [];
  let match;
  while ((match = re.exec(String(text ?? ""))) !== null) {
    const value = Number(match[2]);
    if (Number.isFinite(value)) rows.push({ labels: parseLabels(match[1]), value });
  }
  return rows;
}

function seriesKey(labels) {
  return SERIES_LABELS.map((name) => `${name}=${labels[name] ?? ""}`).join("\u001f");
}

function aggregateMetric(texts, metricName) {
  const map = new Map();
  for (const text of texts ?? []) {
    for (const row of prometheusSamples(text, metricName)) {
      if (!new Set(["admitted", "rejected"]).has(row.labels.outcome)) continue;
      const labels = Object.fromEntries(SERIES_LABELS.map((name) => [name, row.labels[name] ?? "none"]));
      const key = seriesKey(labels);
      const current = map.get(key) ?? { labels, value: 0 };
      current.value += row.value;
      map.set(key, current);
    }
  }
  return map;
}

function aggregateAdmissionDecisions(texts) {
  // tyr_admission_decisions_total also has priority. Collapse priority so its
  // population is exactly comparable to the timing histograms' bounded label set.
  return aggregateMetric(texts, "tyr_admission_decisions_total");
}

function subtract(after, before, label) {
  const keys = new Set([...after.keys(), ...before.keys()]);
  const delta = new Map();
  for (const key of keys) {
    const afterRow = after.get(key);
    const beforeRow = before.get(key);
    const value = Number(afterRow?.value ?? 0) - Number(beforeRow?.value ?? 0);
    if (value < -1e-9) throw new Error(`${label} counter reset for ${key}; run timing is not comparable`);
    delta.set(key, { labels: afterRow?.labels ?? beforeRow?.labels, value: Math.max(0, value) });
  }
  return delta;
}

function countMetricFamily(texts, metricName) {
  return (texts ?? []).reduce((total, text) => total + prometheusSamples(text, metricName).length, 0);
}

function outcomeSummary(outcome, decisionSums, decisionCounts, queueSums, queueCounts) {
  let decisionSeconds = 0;
  let decisions = 0;
  let queueSeconds = 0;
  let queueDecisions = 0;
  const series = [];
  const keys = new Set([...decisionCounts.keys(), ...queueCounts.keys()]);
  for (const key of keys) {
    const countRow = decisionCounts.get(key);
    const labels = countRow?.labels ?? queueCounts.get(key)?.labels;
    if (labels?.outcome !== outcome) continue;
    const decisionCount = Number(countRow?.value ?? 0);
    const queueCount = Number(queueCounts.get(key)?.value ?? 0);
    const decisionSum = Number(decisionSums.get(key)?.value ?? 0);
    const queueSum = Number(queueSums.get(key)?.value ?? 0);
    decisionSeconds += decisionSum;
    decisions += decisionCount;
    queueSeconds += queueSum;
    queueDecisions += queueCount;
    series.push({
      pool: labels.pool,
      admissionClass: labels.admission_class,
      decisionCount,
      decisionSecondsSum: +decisionSum.toFixed(9),
      decisionMsAvg: decisionCount > 0 ? +((decisionSum * 1000) / decisionCount).toFixed(6) : null,
      queueWaitCount: queueCount,
      queueWaitSecondsSum: +queueSum.toFixed(9),
      queueWaitMsAvg: queueCount > 0 ? +((queueSum * 1000) / queueCount).toFixed(6) : null,
    });
  }
  return {
    decisions,
    decisionSecondsSum: +decisionSeconds.toFixed(9),
    decisionMsAvg: decisions > 0 ? +((decisionSeconds * 1000) / decisions).toFixed(6) : null,
    queueWaitCount: queueDecisions,
    queueWaitSecondsSum: +queueSeconds.toFixed(9),
    queueWaitMsAvg: queueDecisions > 0 ? +((queueSeconds * 1000) / queueDecisions).toFixed(6) : null,
    series: series.sort((a, b) => `${a.pool}/${a.admissionClass}`.localeCompare(`${b.pool}/${b.admissionClass}`)),
  };
}

export function summarizeTyrAdmissionTiming({ beforeTexts = [], afterTexts = [], tyrVersion }) {
  const metricPresent = countMetricFamily(afterTexts, "tyr_admission_decision_seconds_count") > 0;
  if (!metricPresent) {
    if (tyrTimingExpected(tyrVersion)) {
      throw new Error(`Tyr ${tyrVersion} claims admission timing support but exposed no decision histogram samples`);
    }
    return {
      status: "not-instrumented",
      source: "tyr_admission_decision_seconds",
      framing: ADMISSION_TIMING_FRAMING,
      outcomes: { admitted: null, rejected: null },
      totalDecisions: null,
    };
  }

  const delta = (name) => subtract(
    aggregateMetric(afterTexts, name),
    aggregateMetric(beforeTexts, name),
    name,
  );
  const decisionSums = delta("tyr_admission_decision_seconds_sum");
  const decisionCounts = delta("tyr_admission_decision_seconds_count");
  const queueSums = delta("tyr_admission_queue_wait_seconds_sum");
  const queueCounts = delta("tyr_admission_queue_wait_seconds_count");
  const admissionCounts = subtract(
    aggregateAdmissionDecisions(afterTexts),
    aggregateAdmissionDecisions(beforeTexts),
    "tyr_admission_decisions_total",
  );

  const keys = new Set([...decisionCounts.keys(), ...queueCounts.keys(), ...admissionCounts.keys()]);
  for (const key of keys) {
    const decision = Number(decisionCounts.get(key)?.value ?? 0);
    const queue = Number(queueCounts.get(key)?.value ?? 0);
    const admittedOrRejected = Number(admissionCounts.get(key)?.value ?? 0);
    if (decision !== queue || decision !== admittedOrRejected) {
      throw new Error(
        `Tyr admission timing population mismatch for ${key}: decision=${decision}, queue=${queue}, admission=${admittedOrRejected}`,
      );
    }
  }

  const admitted = outcomeSummary("admitted", decisionSums, decisionCounts, queueSums, queueCounts);
  const rejected = outcomeSummary("rejected", decisionSums, decisionCounts, queueSums, queueCounts);
  const totalDecisions = admitted.decisions + rejected.decisions;
  if (tyrTimingExpected(tyrVersion) && totalDecisions === 0) {
    throw new Error(`Tyr ${tyrVersion} exposed admission timing but recorded zero decisions; this is lost instrumentation, not zero cost`);
  }

  return {
    status: "measured",
    source: "tyr-prometheus-histogram-sum-count",
    framing: ADMISSION_TIMING_FRAMING,
    outcomes: { admitted, rejected },
    totalDecisions,
  };
}

export function measureAdmissionClockOverhead({ iterations = 100_000 } = {}) {
  let sink = 0;
  for (let index = 0; index < 1_000; index += 1) {
    const decisionStartedNs = process.hrtime.bigint();
    const waitStartedNs = process.hrtime.bigint();
    const waitEndedNs = process.hrtime.bigint();
    const decisionEndedNs = process.hrtime.bigint();
    sink += Number(waitStartedNs - decisionStartedNs + (decisionEndedNs - waitEndedNs));
  }
  const baselineStartedNs = process.hrtime.bigint();
  for (let index = 0; index < iterations; index += 1) sink += index & 1;
  const baselineNsPerIteration = Number(process.hrtime.bigint() - baselineStartedNs) / iterations;

  let timerFloorTotalNs = 0;
  const instrumentedStartedNs = process.hrtime.bigint();
  for (let index = 0; index < iterations; index += 1) {
    const decisionStartedNs = process.hrtime.bigint();
    const waitStartedNs = process.hrtime.bigint();
    const waitEndedNs = process.hrtime.bigint();
    const decisionEndedNs = process.hrtime.bigint();
    sink += Number(waitEndedNs - waitStartedNs);
    timerFloorTotalNs += Number(waitStartedNs - decisionStartedNs + (decisionEndedNs - waitEndedNs));
  }
  const instrumentedNsPerIteration = Number(process.hrtime.bigint() - instrumentedStartedNs) / iterations;
  return {
    iterations,
    runtimeTaxNsPerDecision: +Math.max(0, instrumentedNsPerIteration - baselineNsPerIteration).toFixed(1),
    reportedTimerFloorNs: +(timerFloorTotalNs / iterations).toFixed(1),
    source: "benchmark-host-four-hrtime-read-diagnostic",
    subtractedFromDecisionMetric: false,
    sink,
  };
}
