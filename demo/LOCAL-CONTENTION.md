# Local inference contention benchmark

`npm run demo:local:contention`

Interactive and batch requests share one self-hosted Ollama server. The
question is whether MoFlux keeps interactive traffic served while still letting
batch traffic use capacity nobody else wants.

This is **not** the 0.32.0 local benchmark with more requests. That one
(`npm run demo:local`, published as `results/local-inference-compatibility.json`)
measures compatibility against an *unsaturated* server, one request at a time,
and `results/README.md` records at length why its latency deltas are not
quotable. This benchmark deliberately offers more work than the machine can
decode and measures admission behaviour under that pressure. The two corpora are
separate on purpose and neither restates the other.

## Why this workload is contended at all

The premise only holds if concurrency on this server is genuinely scarce. It is,
and that was measured before the benchmark was designed rather than assumed.
On the reference host — 8 CPUs available to Docker, no GPU passthrough,
`ollama/ollama:0.12.3` serving `qwen3:0.6b` — aggregate decode throughput is
roughly flat in concurrency:

| concurrent requests | wall time | aggregate output tok/s |
| --- | --- | --- |
| 1 | 3.0 s | 10.5 |
| 2 | 7.6 s | 10.6 |
| 3 | 11.3 s | 10.0 |
| 4 | 12.8 s | 12.5 |

Four concurrent requests take about four times as long as one. Admitting a batch
request therefore really does cost an interactive one, which is the precondition
for any isolation result to mean anything. On a GPU-backed server with real
batching the same workload would not be contended in this way, and nothing here
transfers to that case.

## Arms

All three replay the same immutable trace, with the same request bodies, against
the same Ollama container.

| arm | path | policy |
| --- | --- | --- |
| `direct` | client → Ollama | none. Ollama's FIFO queue over `OLLAMA_NUM_PARALLEL=4` is the only control. |
| `static` | client → Tyr → Ollama | fixed per-class protected floors, never lent. |
| `moflux` | client → Tyr → Ollama | identical floors, lent while idle and restored on demand. |

`static` and `moflux` are numerically identical partitions of identical
capacity. The single variable between them is whether Latchflo's
`admissionClassDemandPolicy` is enabled. Any difference between those two arms
has exactly one candidate cause.

There is one Tyr container per managed arm rather than one Tyr with two pools.
Tyr routes to a pool by model prefix, so two pools in one process would force
the arms to send two different model strings — and the premise of the benchmark
is that both workload classes share one model on one server.

### Capacity policy

Pool ceiling `maxConcurrent: 4`, pinned to `OLLAMA_NUM_PARALLEL=4`. An admission
bound above the server's real parallelism sheds against capacity that does not
exist; one below it wins by leaving the machine idle.

| class | protected concurrent | max concurrent | protected tokens | unlent tokens |
| --- | --- | --- | --- | --- |
| interactive | 3 | 4 | 2,400 | 1,200 |
| batch | 1 | 4 | 1,600 | 800 |

The floors sum to the physical ceiling, so under the static policy there is no
unreserved shared capacity and **neither class can exceed its own floor**. Batch
is pinned at one slot even while three interactive slots sit empty. That wasted
capacity is what the lending arm is asked to recover.

Token floors are configured, real, and **not the binding constraint**. A
measured interactive request reserves on the order of 130 tokens and a batch
request about 460, so four concurrent requests never approach the 4,000-token
budget. They are configured because Latchflo's `unlent_floor` mechanism is
defined over token capacity and cannot be exercised at all on a concurrency-only
policy. Each arm reports `bindingConstraint` so a reader can see which limit
actually decided admissions rather than inferring it.

Workload class is carried by signed identity (the shared
`demo/identity-fixture-lib.mjs` JWKS fixture), not by a client header.
`priority.trustHeader` is `false` precisely because the load generator sends
`x-priority`: a benchmark that let the client name its own admission class would
be measuring the client.

## Workload phases

One deterministic trace per seed, replayed by every arm. Warm-up is issued
before the trace starts and never enters a measured distribution.

| phase | window | offered |
| --- | --- | --- |
| 1 warm-up | before the trace | 5 requests per class per arm, excluded from every distribution |
| 2 interactive with spare capacity | 0 – 25 s | interactive 0.25 rps, no batch |
| 3 batch uses idle capacity | 25 – 60 s | interactive quiet, batch 0.25 rps |
| 4 interactive contention | 60 – 85 s | interactive 0.5 rps **and** batch 0.25 rps |
| 5 recovery / drain | 85 – 105 s | no new arrivals |

Phase 3 is the reason the trace format grew a second interactive arrival window.
A control plane cannot lend a floor it never observes idle, so the workload has
to contain an interval in which interactive demand is genuinely absent while
batch traffic runs. `load/trace-lib.mjs` gained an optional
`interactiveResume*` window for this; without it the trace is byte-identical to
version 1 or 2 and every historical hash still reproduces.

The measured windows used by the hypotheses are fixed trace offsets, identical
in every arm:

- **borrow window** — phase 3. Batch running against an idle interactive floor.
- **contention window** — phase 4. Both classes offered simultaneously.

## How lending actually behaves, and why the grant TTL is short

Measured directly against `latchflo-control-plane:0.15.0`, the two directions
are **not** symmetric, and the benchmark is built around the measured behaviour
rather than around the documented intent:

- **Restoration is accelerated.** Raising a protected floor requires the
  borrower to drain, so it takes the acknowledged-handoff path and commits as
  soon as every drain grant is applied and occupancy-ready — sub-second in
  practice, without waiting for the lease.
- **Lending is not.** Lowering a floor strands nobody, so it requires no drain,
  the handoff path is skipped, and the change is deferred to the next grant
  issuance — which happens only when the current lease expires.

That asymmetry is a safety property, not a defect: capacity comes back fast and
goes out slowly. But it means a lend cannot land inside a run shorter than the
grant TTL. This benchmark therefore uses a **15-second** `grantTtlMs` rather
than the 240 seconds the tenant-fairness scenario uses, and phase 3 is 30
seconds so a lend has time to materialise and still be observed. Both managed
arms use the same TTL, so it is not a variable between them.

## Metrics

Per arm and per workload class: requests attempted, successes, success rate,
goodput, TTFT p50/p95, completion latency p50/p95, prompt/completion/total
tokens, rejected admissions with their reasons and binding constraints, deadline
abandonments, torn streams, server errors, and per-window completions.

For the lending arm additionally: the applied per-class grant sampled from Tyr
every 250 ms, merged with Latchflo's own demand view; lending and restoration
episodes derived from that series; Latchflo's own per-resource restoration
episodes; the `unlent_floor` gauges; and the handoff event log.

Three independent sources on purpose. Tyr says what it enforced, Latchflo says
what it withheld and whether each resource met its objective, and the load
generator says what the caller lost. A verdict built from the controller's side
alone would report a restoration without ever pricing it.

### Missing is not zero

A distribution with no observations reports `null`, never `0`. A contention
window in which every interactive request was rejected has no TTFT p95; before
0.34.0 it reported `0` and read as the fastest window in the run. Counts and
rates stay numeric, because zero completions really is zero goodput and that is
a measurement rather than an absence. Ratios built from a missing distribution
are `null` too: an undefined comparison must not be readable as "no difference".

### Demand transitions

Both classes' demand-state changes are recorded from the sampled series, with
the grant, occupancy, released capacity and admission/rejection counters that
were true at the instant of each change.

Alongside them each managed arm carries a `demandReturn` object built for the
one moment the experiment turns on — interactive coming back at 60 s — and
reconciling three clocks onto one origin:

| source | what it knows | timebase |
| --- | --- | --- |
| the trace | when the workload *asked* | workload offsets |
| the load generator | Tyr's first decision, refusals included | its own start |
| the `/stats` sampler | applied grant, occupancy, controller demand | arm start |

`loadgenSkewMs` is the measured difference between the generator's epoch and the
sampler's, and every generator-side instant is reported shifted onto the
sampler's clock. When that skew is unknown the shifted values are `null` rather
than aligned by assumption. The object answers, from the summary alone:

- `generatorResumedAtMs` — when interactive demand actually resumed
- `tyrFirstDecisionAtMs` / `tyrFirstDecisionWasRejection` — when Tyr first
  decided anything about it, and which way
- `benchmarkMarkedActiveAtMs` / `benchmarkMarkedActiveEvidence` — when this
  benchmark called the class active, and what proved it
- `capacityLentAtMark` / `lentConcurrentAtMark` — whether its floor was lent
  at that instant, and by how much
- `borrowedConcurrentAtMark` / `borrowerEncroachmentAtMark` — how much the
  other class was holding
- `borrowerAdmissionsDuringResumeWindow` — whether any *new* borrowing followed
- `restorationStartedAtMs`, `floorRestoredAtMs`, `occupancyRestoredAtMs`

A deduplicated per-sample digest of the 50–70 s interval ships next to it, with
identical consecutive samples collapsed and both borders always retained.

### Restoration episodes

A **restoration-required** episode is one where capacity belonging to a
protected class was lent, its owner returned while that capacity was still lent,
and the controller therefore had something meaningful to restore. Every lending
episode lands in exactly one outcome:

| outcome | meaning |
| --- | --- |
| `restored` | demand returned while lent, and the grant came back |
| `unrestored` | demand returned while lent, and it did not |
| `passive-return` | the floor came back with nobody asking. Not a restoration |
| `open-at-end-of-run` | still lent when sampling stopped. Not inferred either way |

A lease expiring, or a grant happening to return to its nominal allocation, is
never counted as a restoration.

Demand return is detected from the controller's demand state and from
**rejections**, not only from admissions. That distinction is the whole point:
a class returning to a pool whose every slot is held by borrowers is refused on
every attempt, so it is never admitted and never in flight. Measured by
admissions it looks idle. The 0.33.2 run produced eight lending episodes and
zero restoration-required episodes for exactly that reason, while its samples
showed interactive being refused for twenty-five seconds straight.

Two latencies are reported, and they are not the same number:

- `restorationLatencyMs` — from demand return to the **grant** being whole.
  This is the controller's reaction time.
- `occupancyRestorationLatencyMs` — from demand return to the protected class
  being able to **use** its floor, i.e. to no borrower still sitting on it.

Restoration here is non-preemptive, so the second is bounded by the borrowers'
remaining decode rather than by the control plane. On the 0.33.2 diagnostic
seeds the first was 0–394 ms and the second was 15–42 seconds. Quoting only the
first would price restoration at nothing, so both are carried and both are
checked against `restorationSloMs`.

## Acceptance

The run's own proof object is `localContentionProof`, and the top-level `passed`
mirrors it and nothing else.

Per seed, **validity and safety only** — these are absolute and one failure
fails the sweep:

- one trace hash across every arm; every arm ran; warm-up excluded
- phase membership is keyed by each request's immutable trace arrival time, not
  completion time, so a request offered during contention remains a contention
  sample even if Ollama finishes it during the drain
- the idle window contained interactive work and no batch work
- batch was actually admitted and completed work under `moflux`
- the direct arm's contention-window tail exceeded its idle-window tail, i.e.
  there was measurable queueing to protect against
- the static arm actually refused batch work
- no unlent-floor violation, class-ceiling violation, ceiling over-allocation,
  pool over-allocation, or floor-sum over-allocation at any sample
- once protected interactive demand returns, batch does not take **more** of
  interactive's nominal floor than it already held; already-running borrowers
  are grandfathered because non-preemptive restoration does not retroactively
  make their original admission unsafe, and the entitlement ratchets down as
  they drain so a freed slot may not be refilled while its owner is still asking
- no capacity handoff committed without the required acknowledgement; an
  aborted handoff is a safe refusal to reallocate and is reported as restoration
  cost, not as an unsafe commit
- every lending episode for which protected demand actually returned was
  restored; an end-of-run lend with no returning owner demand is not a failure

Encroachment is measured against the **nominal** partition, not against the
applied grant. Tyr's `borrowedConcurrent` is occupancy above a class's applied
floor, and a class whose own floor has been lent away while it was idle reports
its first perfectly legitimate request as borrowing. That produced a false H4
failure at 29.896 s on the 0.33.2 seed 4 — inside the phase in which batch is
supposed to be using idle capacity, with the interactive floor whole and
untouched at three slots. Because the floors sum to the physical ceiling,
occupancy above a class's own nominal floor is exactly the occupancy that must
be coming out of some other class's reserve, whoever lent it and whenever the
applied grant catches up.
- no borrowed-slot deadline abandonment (no arm configures one)

Across seeds, the **hypotheses**, evaluated on medians against thresholds
pre-registered in `HYPOTHESIS_THRESHOLDS`:

- **H1** — interactive contention-window **SLO goodput** improves over
  `direct` by at least 0.04 req/s. A useful interactive completion must succeed
  with TTFT <= 5 s and completion latency <= 30 s. Successful-request TTFT and
  raw goodput remain descriptive only so a policy cannot win by rejecting most
  requests and reporting a fast survivor tail.
- **H2** — batch borrow-window completions versus `static` ≥ 1.2×.
- **H3** — the configured interactive protected floor was never violated.
- **H4a** — *capacity transfer safety*: no class-ceiling violation, no pool or
  floor-sum over-allocation, no unlent-slice breach, and no handoff committed
  without its required acknowledgement.
- **H4b** — *no new borrowing after protected demand returns*: demand return is
  recognised, new loans stop, grandfathered borrowers may drain but the slots
  they give back are not refilled, and every restoration-required episode
  converges.

H4a and H4b were one gate before 0.34.0, which meant a run could report "unsafe
capacity handoff" when what had actually happened was borrow growth at a suspect
instant and every handoff was acknowledged or safely aborted. `hypotheses.h4`
remains as the conjunction of the two for one release.

H1 and H2 can fail, and the fixtures in `demo/verify-local-contention.mjs`
exercise them failing. A MoFlux arm that does not beat unmanaged Ollama is a
negative result and the benchmark reports it as one.

## What this evidence may not be used to claim

Carried in every summary as `evidenceLimits`, because prose gets summarised away
and the numbers travel:

- **GPU preemption, GPU utilization, KV-cache reclamation, Ollama scheduler
  preemption** — none are observed or controlled. A shed request is one that
  never arrived, not one that was preempted.
- **Upstream reclamation** — no arm configures a borrowed-slot deadline, so no
  in-flight upstream request is ever cancelled. Restoration is by borrower
  attrition plus withheld allocation. The honest bound on an interactive
  request's wait for a lent slot is one batch request's remaining decode, and
  `occupancyRestorationLatencyMs` measures what that bound actually cost rather
  than assuming it away. Restoring the *grant* quickly is not the same as
  restoring the *capacity*, and a summary that reports only the first is
  describing the controller rather than the caller.
- **Decode determinism** — temperature is 0 and each attempt carries a
  trace-derived seed, but arms differ in retry count and therefore in attempt
  seeds, and the server's prefix-cache state differs. Equal token totals would
  not evidence equal text and are not presented as doing so.
- **Generalization** — `qwen3:0.6b` on a CPU-only containerised Ollama. The
  concurrency scaling that makes this workload contended is a property of that
  configuration.
- **Production scale** — single host, single model, one replica per arm, tens of
  requests per arm per seed.

## Credentials

Workload class is carried by a signed JWT from the shared identity fixture. The
fixture re-mints on access as a token approaches expiry rather than minting once
per process, and each mint carries a distinct `jti` so a forced refresh cannot
hand back the credential the server just refused.

This is not a hypothetical. A five-seed sweep runs for over an hour of wall
clock; the 0.33.2 fixture minted once at t=0 with a one-hour expiry, and the run
died in seed 5's MoFlux warm-up on `HTTP 401` at 64 minutes with no evidence
beyond that status code. Lengthening the lifetime would only move the cliff to
whichever sweep outgrows the new guess.

Every managed-arm warm-up failure is recorded in `diagnostics.managedArmWarmupFailures`
with the seed, arm, workload class, request index, attempt, HTTP status, a
bounded response body, whether a token was present, its fingerprint, its issue
and expiry times, elapsed benchmark time, and whether credentials were refreshed
for that attempt. A 401 or 403 is retried exactly once behind a forced re-mint —
so the retry is a hypothesis being tested rather than a loop papering over the
failure — and both attempts are recorded either way. Bearer tokens are never
written to a summary; a twelve-character fingerprint identifies a credential
across log lines and reveals nothing.

## Locality and spend safety

Preserved from 0.32.0 and strengthened. There is no spend guard because a
self-hosted server has no price; the guard is on the address instead, it covers
every arm endpoint plus the Ollama upstream and the control plane, and it runs
before the first request.

Unlike `demo/local-inference.mjs`, this benchmark has **no endpoint flag at
all**. Arm endpoints are derived from constants on loopback, so there is nothing
to point elsewhere. No provider credential is read or sent.
`demo/verify-local-contention.mjs` asserts the runner's source contains no
`--direct-url`-style override and no `OPENAI_API_KEY`, and
`scripts/verify-publication.mjs` fails the release if one appears.

## Commands

```bash
npm run demo:local:contention:dry-run    # prints the plan and arm order; sends nothing
npm run demo:local:contention:doctor     # prerequisites only
npm run demo:local:contention:single     # one seed, development
npm run demo:local:contention            # five seeds with --require-proof
npm run verify:local:contention          # harness tests; no Docker, no weights

npm run evidence:publish -- --as=local-inference-contention
npm run verify:publication
```

A run writes only to `results/runs/local-inference-contention/<run-id>/` and
never to reviewed evidence. Promotion is the separate, deliberate step.

## Stack

`demo/ollama/compose-contention.yaml` publishes Ollama on **11436** — neither
the host default 11434 (likely an operator's own server) nor 11435 (the
compatibility stack, which `--keep-stack` may have left running). Measuring a
different server than the summary names is the failure those port choices exist
to prevent.

The model volume is declared external and named `moflux-bench-ollama-models`.
Every run tears the stack down with `--volumes` so no grant, agent token, or
pool row survives into the next one; a volume compose does not own is one that
teardown will not collect, so the weights are pulled once rather than per run.
