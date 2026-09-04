# Results

Generated benchmark output is written under this directory and ignored by Git unless it is explicitly designated as reviewed evidence. Curated historical cases live under `results/curated/`; the named `video-seed-sweep` corpus is also intentionally retained.

**A run never writes reviewed evidence.** Every sweep writes to
`results/runs/<sweep>/<run-id>/` — generated, ignored, safe to delete. Reviewed
paths change only through an explicit promotion:

```
npm run demo:hetero                              # writes results/runs/video-seed-sweep/<run-id>/
npm run evidence:list                            # what runs exist
node demo/publish-evidence.mjs --as=video-seed-sweep   # promote one, refuses to clobber without --force
```

`demo/evidence-paths-lib.mjs` is the single declaration of which paths are
reviewed. The sweep and the presenter refuse to start when pointed at one, and
`npm run verify:publication` fails when reviewed bytes differ from the committed
copy. Approving a path is not the same as protecting its contents; both are
needed, because a JSON file replaced by a later run still parses and still sits
at an approved path.

Do not publish a single run as representative evidence. Use at least five seeds, report medians with spread, retain every paired raw result and immutable trace, and record the exact command, Node version, Docker image versions, seed list, capacity policy, and aggregation method. Runs with a saturated load generator are invalid.

## Licensed video seed sweep

`npm run demo` runs five matched seed pairs and writes, under
`results/runs/video-seed-sweep/<run-id>/`:

- `summary.json` — aggregate medians, min/max spread, per-seed scenario metadata, and references to raw evidence;
- `baseline-seed-N.json` — no-control arm output;
- `moflux-enforce-seed-N.json` — managed arm output;
- `comparison-seed-N.json` — same-seed calculated deltas;
- `trace-seed-N.json` — immutable logical arrival and retry evidence.

`results/runs/video-seed-sweep/latest.json` points at the newest run. Promotion
copies these to `video-seed-sweep.json` and `video-seed-sweep/` under their
published names.

Every pair must have the same `scenario.id` and trace hash, and each arm's logical request counts must equal the trace's planned counts. The sweep fails rather than aggregates when those checks differ, a required file is missing, or the load generator reports saturation.

The aggregate includes median, minimum, maximum, and sample count for arm-level metrics, paired changes, and token accounting. The underlying arms replay the same immutable logical request trace; real-clock execution timing may still vary.

Each MoFlux arm records the resolved capacity policy under `capacity`, including the slot split, batch token percentage, token-funded concurrency, stranded concurrency, pool agent count, minimum usable local grant, reservation bounds, and the live grants observed before the run. `batchFloorPercent` is retained only when both shares are equal. Keep the complete policy with any published comparison.

The MoFlux result contains per-run token-accounting deltas:

- `grossRecoveryRate = refunded / reserved`
- `netRecovered = refunded - overrun`
- `netRecoveryRate = netRecovered / reserved`

A refund means unused safety reservation was returned for reuse; it is not newly created capacity.

## Headroom-aware policy runs

The current `adaptive-headroom-28-4` path retains the sustained active-demand lending semantics introduced with Latchflo 0.12.4 in MoFlux Bench 0.24.0. Under the current Latchflo 0.15.0 runtime, long-lived pressure-free interactive demand remains `demanding`, while `starved` is reserved for aged demand with pending/rejection pressure. MoFlux Bench 0.23.0 introduced the profile without replacing the existing
`adaptive-28-4` control policy. `npm run demo:hetero:headroom` writes an ordinary
five-seed sweep for the new policy. `npm run demo:headroom:compare` runs the two
policies over the same ordered seed set and verifies same-seed immutable trace
hashes before writing `results/runs/headroom-policy-comparison/<run-id>/summary.json`.
That paired summary reports all-seed batch-success changes alongside interactive
success, p95/TTFT changes, rejects, and upstream 429s, plus a separate
exercised-seed batch-payoff aggregate over seeds with joint headroom proof. The
default payoff threshold is derived from the configured demanding-state lend and
the batch reservation size rather than a fixed completion count. Data-plane
headroom evidence is correlated: a temporary Tyr split below/above the nominal
28/4 partition is retained as a raw diagnostic but counts as headroom only when
an in-window Latchflo interactive-to-batch event reports `demandState=demanding`,
`reason=headroom`, stays within the configured active-demand lend caps, and
precedes a bounded Tyr applied-capacity transfer observed before the measured
workload ends. `demo:headroom:compare` uses a dedicated 3-RPS uniform interactive
trace for both policies so this sustained-slack state is intentionally exercised;
the heterogeneous headroom command keeps the ordinary 6-RPS lognormal workload.
The summary also retains exact successor-grant admission proof coverage, first added with Tyr 0.26.0 and exercised by current licensed runs on Tyr 0.30.0.
Seed-sweep schema version 7 carries the strict in-window evidence semantics;
headroom-policy comparison schema version 4 adds the capacity-derived threshold
basis and exercised-seed aggregates. A failed
adaptive gate is preserved as evidence but is not a publishable passing
comparison.

## Admission-class lending runs

`npm run demo:classes` writes four matched arms under
`results/runs/tenant-fairness/<run-id>/`: pool-only, class ceilings, static
protected floors, and adaptive protected floors. Each seed also writes
`adaptive-lending-seed-N.json`, which samples Latchflo class-demand/lending state
and the aggregate class limits actually applied by Tyr. The schema-version-4
`summary.json` records the lend -> demand -> acknowledged pre-expiry handoff ->
restore proof, lease time avoided, and restoration latency separately from
performance observations. These runs are generated
evidence and are not automatically promoted into the reviewed corpus.

## Local inference compatibility

`results/local-inference-compatibility.json` holds a single `npm run demo:local`
run promoted with `npm run evidence:publish -- --as=local-inference-compatibility`.
It records Tyr 0.30.0 in front of `ollama/ollama:0.12.3` serving `qwen3:0.6b`
over 8 alternating-order pairs, both arms on loopback.

**This corpus is a compatibility result only. Do not quote its deltas.** What it
establishes is that every request succeeded (16/16 HTTP 200 across both arms),
that token accounting matched exactly between arms (216 prompt / 512 completion
each), that Ollama honoured `max_tokens` (every request stopped at the 64-token
cap), and that the non-overridable locality guard held with no metered provider
reachable.

What it does not establish is proxy overhead, for four reasons recorded here so
the numbers in the file are not read as a measurement:

- `deltas.steadyState` is `true`, but the flag only asserts
  `requestsPerArm > warmupPairs`. Warm-up pairs are **not** excluded from the
  aggregation, so 5 of these 8 pairs feed the very deltas the flag appears to
  vouch for.
- `deltas.latencyP50Ms` is negative (-334.46 ms): the proxied arm reads as
  faster than direct, which is not a physically meaningful overhead figure. The
  paired spread is ±878 ms at n=8, so the interval comfortably spans zero.
- The dominant effect is within-pair ordering, which alternation balances but
  does not remove: the request that runs second in a pair is ~700 ms faster on
  average, and the sign of each pair's delta tracks arm order almost perfectly.
- `decodeTokensPerSecondP50` favours the proxied arm (12.85 vs 12.00 tok/s) on
  the same server, so it is measuring the same ordering artifact rather than the
  proxy/model CPU contention it is meant to expose.

Two further caveats apply to reading the file itself. `ttftMs.p95` and
`latencyMs.p95` are the maximum observation at n=8 under nearest-rank, not a
tail statistic — `direct.ttftMs.p95` of 2033.29 ms is precisely pair 1's weight
load. And per-arm decode determinism is **unverified**: the arms share a prompt,
a seed and `temperature: 0`, but `outputChars` differs between arms in 7 of the
8 pairs, so the two arms did not replay identical text. The equal
`completionTokens` totals do not evidence otherwise — they are forced by every
request hitting the output cap.

A quotable proxy-overhead figure needs warm-up excluded from the aggregation,
many more post-warm-up pairs, a reported spread, and recorded output hashes
proving the arms decoded identically. None of those hold here.

## Local inference contention

`results/local-inference-contention.json` is the reviewed publication target for a
five-seed `npm run demo:local:contention` run promoted with
`npm run evidence:publish -- --as=local-inference-contention`. It is intentionally
absent until a publication-quality run is explicitly promoted; 0.33.0 ships the
harness and proof contract without manufacturing a workload-isolation result.

**This is a separate corpus from `local-inference-compatibility.json` above and
does not replace or reinterpret it.** The compatibility corpus measures a proxy
in front of an unsaturated server and establishes nothing about workload
protection. This one measures admission behaviour when interactive and batch
traffic contend for one saturated local server.

Three arms — `direct` (no admission control), `static` (fixed protected floors,
never lent), and `moflux` (identical floors, lent while idle and restored on
demand) — replay one immutable five-phase trace per seed against
`ollama/ollama:0.12.3` serving `qwen3:0.6b`, with Tyr 0.30.0 and Latchflo
0.15.0 managing the two partitioned arms. Arm order is rotated and reversed
across seeds so no arm sits in one position.

The summary carries its own acceptance object, `localContentionProof`, and the
top-level `passed` mirrors that and nothing else. Per seed the gates are
validity and safety only and are absolute; the H1/H2 performance hypotheses are
evaluated across seeds on medians against thresholds pre-registered in
`HYPOTHESIS_THRESHOLDS`, and both can fail. Every failed gate records its
observed value, its threshold, and why the gate exists.

Two properties of the run are recorded because they shape what it can show, and
both were measured rather than assumed:

- **Lending and restoration are asymmetric in Latchflo 0.15.0.** Raising a
  protected floor requires the borrower to drain, so it takes the acknowledged
  handoff path and commits without waiting for the grant lease. Lowering one
  strands nobody, needs no drain, and is deferred to the next grant issuance —
  which happens only after the lease expires. The benchmark therefore runs a
  15-second lease rather than the 240-second lease the tenant-fairness scenario
  uses; at 240 seconds a released floor is correctly computed and never applied
  inside a run of this length.
- **A short lease costs a brief ungranted window at each expiry.** Latchflo
  issues the replacement only after the old grant is gone, so the pool
  momentarily holds nothing and Tyr admits nothing. `leaseGapSamples` and
  `leaseGapShare` report it per run, a gate fails the run if it grows past 10%
  of samples, and both managed arms carry the identical lease so it is never a
  variable between them.

An aborted capacity handoff is recorded as the safe outcome it is — the control
plane declining a reallocation whose preconditions lapsed — and priced as slower
restoration. Only a commit whose drain grants were never acknowledged counts
against the safety gate.

`evidenceLimits` travels inside every summary. This corpus may not be used to
claim GPU preemption, GPU utilization, KV-cache reclamation, Ollama scheduler
preemption, upstream request reclamation, identical decoded text across arms,
production-scale performance, or generalization from `qwen3:0.6b` on a CPU-only
containerised server. The measured layer is admission: which requests Tyr let
through, when, and what the caller then experienced.

## Published evidence status

`video-seed-sweep.json` and `video-seed-sweep/` hold the reviewed five-seed
heterogeneous four-arm run published at 0.10.0. Each per-seed file records the
runtime that produced it in its own `runtime` field; those read **Tyr 0.17.0 and
Latchflo 0.5.1**. Read that field rather than any prose description — prose drifts,
and an earlier revision of this file and of `.gitignore` both described this
corpus as Tyr 0.16.0 / Latchflo 0.5.0, which the files themselves contradict.

New licensed runs use Tyr 0.30.0, Latchflo 0.15.0,
async-bulkhead-llm 3.17.0, and async-bulkhead-ts 1.0.1. The main sweep retains
one-hop capacity-aware routing, per-pool demand heartbeats, pool-level lending,
and progressive reconciliation for Anthropic-shaped streams. Demand-aware pool
lending now records the acknowledged restoration handoff and samples Tyr's
applied capacity; `demo:classes` remains the separate four-arm admission-class
benchmark. The current runtime is a distinct evidence set; existing reviewed
JSON is not relabeled or rewritten.
Normal `npm run demo` and `npm run demo:arms` runs retain the static 31/1,
40,000-token policy. `npm run demo:lending` uses a fully funded 28/4 protected
split with 24,000/40,000-token guarantees inside a 64,000-token group envelope,
enables the demand-aware capacity group, and writes controller and occupancy
evidence into its run directory. Lending output is generated like everything
else; it is not reviewed evidence until it is published under a name.

Do not edit recorded runtime metadata to make old evidence appear new. To
replace a published corpus, promote the new run with `--force` and commit the
diff deliberately, so the change is visible in history rather than absorbed into
a file that already existed.

`curated/negative-fragmented-batch-floor/` preserves the version 0.5.0 five-seed
failure that motivated the topology and determinism remediation. It is
historical negative evidence, not a current comparison.

## Public research replication

`npm run replicate` writes public-arm runs under `replicates/` and aggregates them with `scripts/aggregate.mjs`. This is separate from the licensed video seed sweep.
