import fs from "node:fs";
import { blindBackoffMs } from "./load/retry-policy.mjs";

const traceFile = process.argv[2];

if (!traceFile) {
  console.error("usage: node .check-batch-retries.mjs TRACE_FILE");
  process.exit(1);
}

const trace = JSON.parse(fs.readFileSync(traceFile, "utf8"));

const baseMs = 250;

// Derived from:
// run start ~= 09:04:18.134Z
// first Tyr sample with restored batch grant = 09:05:03.553Z
const restoredAtMs = 45419;

const rows = trace.entries
  .filter((entry) => entry.class === "batch")
  .map((entry) => {
    // Attempts are numbered 0..3.
    // Only the sleeps after attempts 0, 1, and 2 determine when
    // the fourth/final attempt can begin.
    const waits = [0, 1, 2].map((attempt) =>
      blindBackoffMs(
        baseMs,
        attempt,
        entry.retryJitter[attempt],
      ),
    );

    const waitBeforeFourthMs = waits.reduce(
      (sum, wait) => sum + wait,
      0,
    );

    return {
      id: entry.id,
      arrivalMs: Number(entry.arrivalMs.toFixed(3)),
      wait1: waits[0],
      wait2: waits[1],
      wait3: waits[2],
      waitBeforeFourthMs,
      fourthAttemptLowerBoundMs: Number(
        (entry.arrivalMs + waitBeforeFourthMs).toFixed(3),
      ),
    };
  })
  .sort(
    (a, b) =>
      a.fourthAttemptLowerBoundMs -
      b.fourthAttemptLowerBoundMs,
  );

console.table(rows.slice(-15));

const after = rows.filter(
  (row) => row.fourthAttemptLowerBoundMs >= restoredAtMs,
);

console.log({
  batchRequests: rows.length,
  restoredAtMs,
  fourthAttemptLowerBoundAtOrAfterRestoration: after.length,
  earliestFourthAttemptLowerBoundMs:
    rows[0]?.fourthAttemptLowerBoundMs ?? null,
  latestFourthAttemptLowerBoundMs:
    rows.at(-1)?.fourthAttemptLowerBoundMs ?? null,
});

if (after.length > 0) {
  console.log("\nRequests whose fourth-attempt lower bound is after restoration:");
  console.table(after);
}
