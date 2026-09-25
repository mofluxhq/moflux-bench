# vLLM Metal long-context: passing run and failed repeat

Two five-seed runs of the same `metal-long-context-v1` workload are retained
here together. The first passes the configured gates; the second is valid but
fails interactive SLO-goodput non-inferiority against native priority (H2).
The passing result was not reliably reproduced. Neither run establishes
physical KV reclamation or class-specific engine waiting after restoration.

| Run (UTC) | Harness | Recorded macOS | Valid seeds | Verdict |
| --- | --- | --- | --- | --- |
| [20260925T001105Z](../vllm-metal-long-context/20260925T001105Z.json) | 0.45.0 | 26.6.2 | 5/5 | Pass |
| [20260925T164229Z](../vllm-metal-long-context/20260925T164229Z.json) | 0.45.1 | 27.0 | 5/5 | Fail: H2 |

Both use an Apple M1 with 16 GiB, Tyr 0.33.0, Latchflo 0.19.0, vLLM and
vllm-metal 0.29.0, and Qwen2.5-1.5B-Instruct at revision
`989aa7980e4cf806f80c7fef2b1adb7bc71aa306`. Model, workload, policy, thresholds,
arm order, and per-seed request trace hashes match. The operating-system change
and real-clock scheduling variability prevent a controlled attribution of the
performance difference to the harness version. Version 0.45.1 corrects reporting;
it does not change these hypothesis thresholds or the H2 calculation.

## Method

Each seed replays the same offered request trace across FCFS, native priority,
static protected admission, and MoFlux lending. Each arm recreates the engine
and excludes warm-up. Seeds 1–4 rotate every arm through every position; seed 5
uses the recorded reverse order. Interactive demand returns during 60–85s;
batch arrives during 25–85s, leaving a borrow phase of 25–60s. The scheduler's
KV pool is pinned at 320 blocks of 16 tokens (5,120 tokens), verified from the
engine. Three long batch requests nearly fill that pool. The override controls
scheduler capacity, not the amount of physical memory allocated by Metal.

Interactive SLO goodput counts successful requests arriving in the return
window with TTFT <=5s and end-to-end latency <=30s, divided by 25 seconds.
Rejected work contributes no SLO goodput. There is one attempt per request.
Successful-request latency percentiles exclude rejections and must be read
alongside completion counts. Direct arms can retain requests until completion
while admission arms shed work; aggregate completion totals alone do not measure
interactive service quality. This is real local inference, not a synthetic
provider, but a small model on one host with small samples and real-clock noise.
Five-seed median gates are descriptive checks, not confidence-bound statistical
non-inferiority tests. No seeds were dropped.

## Results

All differences below are paired by seed, in requests/second. Brackets show
minimum and maximum across the five seeds, not confidence intervals.

| Hypothesis metric | First run: median [min, max] | Repeat: median [min, max] | Gate |
| --- | --- | --- | --- |
| Priority minus FCFS interactive SLO goodput | 0.280 [0.040, 0.480] | 0.360 [0.280, 0.640] | >=0 |
| MoFlux minus priority interactive SLO goodput | 0.000 [-0.040, 0.080] | -0.200 [-0.480, 0.120] | >=-0.040 |
| MoFlux minus static batch arrival-cohort goodput | 0.057 [0.000, 0.086] | 0.057 [0.028, 0.114] | >=0.020 |

| Counts across five seeds | First static | First MoFlux | Repeat static | Repeat MoFlux |
| --- | --- | --- | --- | --- |
| Interactive completions (99 offered) | 79 | 75 | 86 | 71 |
| All batch completions (60 offered) | 21 | 29 | 21 | 28 |
| Eventual completions of borrow-phase arrivals | 15 | 23 | 14 | 24 |
| Batch completions timestamped within borrow phase | 12 | 12 | 11 | 12 |

In the repeat, native priority serves 54 contention requests within SLO,
static 53, and MoFlux 35. MoFlux's paired SLO-goodput differences against
priority for seeds 1–5 are -0.20, -0.48, +0.04, +0.12, and -0.24 req/s.
The repeat gains seven batch completions over static but loses 15 interactive
completions. Its within-borrow-window batch gain is only one completion.

Both runs observe lending in all five seeds and require restoration in four.
All required grant floors meet the 15s gate with no observed unlent reserve
breaches. In the first run, sampled floor restoration is 1.006–1.015s, while
occupancy takes 18.144s and 17.175s in two seeds. In the repeat, the floor is
already present at the demand mark or restored within 1.010s; occupancy takes
16.100s and 20.135s in two seeds. A zero sampled floor latency means the floor
was present at the mark, not instantaneous physical restoration. The grant
restoration gate deliberately does not gate occupancy recovery. No unsafe or
indeterminate handoffs were reported.

## Reporting and provenance

Each timestamp has a promoted summary and companion directory containing all
original JSON evidence: request traces, per-arm load-generator records, raw
telemetry, per-seed comparisons, and diagnostic JSON. Text logs are omitted by
the standard publisher. `original-summary.json` preserves the exact input
summary; the top-level summary adds publication metadata. `provenance.json`
contains SHA-256 hashes for all 156 original JSON files in each run.

For the older run, use
[reporting-v2.json](20260925T001105Z/reporting-v2.json) for corrected diagnostics.
Its original 0.45.0 summary retains historical labels. Reanalysis preserves
runtime, generatedAt, original metric values and verdict; its own timestamp
and source hashes are separate. Its source-summary reference is relative to
its companion directory. The repeat natively contains reporting version 2.

`scheduledReturn.firstObservedEmptyQueueDelayMs` is the time to the first
sampled engine-wide empty queue after the scheduled boundary. It includes
sampling delay, can precede actual demand or grant restoration, and does not
establish sustained clearance. Later queues may form. The old
`demandReturn.waitingClearanceMs` label must not be interpreted as interactive
waiting after restoration. Engine/admission correlations retain separate sample
timestamps and lag; aggregate KV gauges cannot establish batch residency.
Offered arrivals before return do not guarantee that borrowed work is resident.

The historical H3 field `batchBorrowGoodputRps` means eventual successful
completions attributed to borrow-phase arrivals, divided by phase duration.
It is distinct from `batchBorrowAccounting.completionWindow`, which counts
completions timestamped inside the phase. Neither interpretation nor gate was
changed after observing the failed repeat.

These files were promoted with `publishRun` into reviewed evidence. Original
local run directories were left unchanged. Reproduce the workload with:

```bash
npm run demo:vllm:metal:long-context
```
