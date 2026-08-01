# moflux-bench

A synthetic benchmark harness for LLM admission control.

It exists to answer one question honestly: **when does reserving capacity before
a request starts actually beat the alternatives, and what does it cost?**

Most claims in this space are mechanism descriptions. A mechanism is a
hypothesis. This harness turns it into a measurement you can argue with.

## What you can and cannot reproduce here

Read this before anything else.

| Arm | Included | Reproducible by you |
|---|---|---|
| 1 — no admission control | yes | yes |
| 2 — static local cap, `envelope / replicas` | yes | yes |
| 3 — static local cap set to the full envelope | yes | yes |
| 4 — Redis shared concurrency + token budget | yes | yes |
| 5 — Tyr, observe mode | **no** | no |
| 6 — Tyr + Latchflo, enforce mode | **no** | no |

Tyr and Latchflo are proprietary and are not redistributed in this repository.
Arms 5 and 6 require a licensed image.

So the honest description of what this repo offers is: you can reproduce every
baseline, verify that the simulator matches its own stated model, and check
whether the MoFlux figures published in `results/` are plausible against the
arm-4 result you ran yourself. That is weaker than full reproducibility. It is
stated here rather than buried.

## Quickstart

### Licensed video presentation

The canonical presenter now runs a **paired five-seed sweep**. For each seed it
runs a fresh no-control baseline and then the corresponding Tyr + Latchflo arm.
For each seed, the presenter generates one immutable request trace containing
every logical arrival, retry-jitter draw, target selection, and provider sample
key. It replays that exact trace through both arms. Admission decisions still
change which attempts reach the provider and when, but the offered logical
workload no longer changes between arms or reruns.

All four Tyr replicas continue serving `sim-interactive`, while only replica 4
also registers for `sim-batch`. The canonical policy is now an exact
**31 interactive / 1 batch** concurrency split with 30,000 interactive tokens
and 10,000 batch tokens. This preserves one guaranteed batch admission while
keeping every provider slot usable: the interactive pool funds all 31 of its
slots and the batch pool funds its single 9,942-token reservation. Tyr enrollment uses a short lease first; after all
four agents are visible, the presenter promotes both pools to the long run lease
and waits for one simultaneously ready, correctly sized fleet-wide grant set.
Each accepted grant must also have enough remaining lifetime to finish the
configured MoFlux phase. Startup fails if any live local grant is too small or
too close to expiration. Pool creation also sends Latchflo 0.5.0's durable
minimum-grant invariants: one concurrency slot, 755 tokens for interactive, and
9,942 tokens for batch. Latchflo therefore rejects an unusable split before it
can issue a zero-capacity or sub-request grant.

The licensed path is pinned to **Tyr 0.16.0** and **Latchflo 0.5.0**. The
single canonical command can use images that already exist, pull configured
registry images, or build missing images from local source directories. Place
`tyr-admission-controller` and `latchflo-control-plane` beside this repository,
or set `MOFLUX_TYR_SOURCE_DIR` and `MOFLUX_LATCHFLO_SOURCE_DIR` in the local
environment file. Then run:

```bash
npm run demo
```

On first use, the command creates an ignored `demo/moflux/.env` with random
local-only tokens and the pinned image tags. For each missing image it first
looks for a matching local source repository, builds the exact pinned tag when
one is available, and otherwise attempts a registry pull. Existing env files
are never overwritten. `npm run demo:doctor` remains available as a standalone
preflight, but it is not required before the canonical command.

`npm run demo` is non-interactive: it runs seeds 1 through 5, resets
benchmark-local Latchflo/Tyr state before each pair, preserves every raw arm
result, and prints medians with min/max spread. The presenter rejects any pair
whose scenario fingerprints differ, whose load generator saturates, or whose
token allocation cannot fund every configured concurrency slot. Use
`npm run demo:record` for the step-through recording flow.

The aggregate is written to `results/video-seed-sweep.json`; raw evidence is
written under `results/video-seed-sweep/`. Rehearse the legacy one-pair flow
with `npm run demo:single`, or choose seeds explicitly:

```bash
node demo/seed-sweep.mjs --seeds=3,7,11 --step
```

Concurrency slots and in-flight tokens are separate resources. The canonical
policy uses `--batch-concurrency-slots=1` with `--batch-token-percent=25`.
`--batch-concurrency-percent` remains available for experiments, and the legacy
`--batch-floor-percent` still sets both dimensions, but exact slots cannot be
combined with either percentage-based concurrency flag.

```bash
MOFLUX_BENCH_RESULTS_DIR=results/interactive-first-31-1 \
  node demo/seed-sweep.mjs --seeds=1-5 --pause-ms=0 \
  --batch-concurrency-slots=1 --batch-token-percent=25
```

Use a separate results directory for every policy. Startup now rejects both
sub-request grants and nominal concurrency that the pool's token allocation
cannot actually fund. The old 24/8 policy therefore fails preflight with seven
stranded batch slots instead of silently reaching only 25/32 provider
concurrency.

The enrollment lease defaults to 5 seconds and can be changed for unusually
slow local Docker startup with `--enrollment-grant-ttl-ms`. It must remain
shorter than `--grant-ttl-ms`; no benchmark traffic begins during enrollment.

See `demo/VIDEO-DEMO.md` for the recording flow and narration. Stop the
containers afterward with `npm run demo:down`.

### Public research walkthrough

The public arms do not require Tyr or Latchflo:

```bash
docker compose -f demo/compose.yaml up -d
npm run verify
npm run demo:full
open http://localhost:3000
```

Requires Node 22+ and Docker Compose v2. There are no runtime npm dependencies —
the Redis client is a small RESP implementation in `arms/redis-client.mjs`.

## The provider simulator

`sim/provider-sim.mjs` models the constraint that actually bites a shared
inference pool: **per-stream token rate falls as batch concurrency rises.**

The curve is the Universal Scalability Law, chosen because it is a published
model with interpretable parameters rather than a shape invented to flatter a
result:

```
speedup(n)   = n / (1 + σ(n−1) + κ·n(n−1))
aggregate(n) = r1 · speedup(n)          tokens/sec pool-wide
perStream(n) = aggregate(n) / n
```

- **σ** (contention) — 0 is linear scaling, 1 is fully serialised
- **κ** (coherency) — above 0, aggregate throughput becomes retrograde past a peak

`σ=0, κ=0` is the null hypothesis: capacity is effectively free, so admission
control should show little benefit. **Any claimed benefit must grow with σ.** If
a result appears at σ=0, suspect a bug.

σ is the number a skeptic will attack, so it is swept rather than chosen:

```bash
npm run sweep
```

Measured against the analytic curve at n=40 concurrent streams, r1=90:

| σ | κ | predicted tok/s | observed | error |
|---|---|---|---|---|
| 0 | 0 | 3600 | 3595.7 | 0.1% |
| 0.05 | 0 | 1220.3 | 1215.0 | 0.4% |
| 0.15 | 0 | 525.5 | 522.6 | 0.6% |
| 0.25 | 0 | 334.9 | 335.7 | 0.3% |
| 0.35 | 0 | 245.7 | 255.7 | 4.1% |
| 0.6 | 0 | 147.5 | 143.8 | 2.5% |
| 0.15 | 0.005 | 245.7 | 242.4 | 1.4% |

The simulator also samples a heavy-tailed output length (p99/median ≈ 5.8) and
**never discloses it to the caller** — an estimator must not be able to see the
thing it is trying to predict. True input tokens use a character ratio distinct
from any estimator's assumed ratio, plus jitter, so input estimation error is
non-zero and measurable.

## The load generator

`load/loadgen.mjs` is **open-loop**. Arrivals follow a Poisson process on a
timer and do not wait for completions. A fixed worker pool cannot generate more
load than the system absorbs, so overload hides inside the generator instead of
appearing in the numbers — that is coordinated omission, and it is the most
common way a benchmark like this quietly lies in the vendor's favour.

If the generator itself runs out of headroom it increments
`generator_saturated_total`. **Any run where that is non-zero must be
discarded**, because the bottleneck was the instrument. The Grafana dashboard
has a panel for it that turns red.

Two competing classes: `interactive` (small, latency-sensitive, high priority)
and `batch` (large prompts, arriving as a step function partway through).
Retries use exponential backoff with jitter, which is what converts provider
rejection into retry amplification.

When a rejection carries a retry hint — `x-admission-retry-after-ms`, or
`Retry-After` — the generator waits that long instead of guessing. The hint is
a floor, never a licence to retry sooner: the wait is the larger of the blind
backoff and the server's estimate, spread by a fraction of itself so replicas
do not wake together. That mirrors how Tyr consumes `Retry-After` from
Latchflo, so the harness measures a well-behaved client rather than a bespoke
one. A no-control arm receives no hints and is unaffected.

`--honor-retry-hints=false` forces blind backoff over the **identical trace**,
which makes the hint's contribution an exact A/B rather than an inference. The
hint spread reuses the trace's pre-drawn `retryJitter` rather than drawing
fresh randomness, so the trace hash is unchanged and hint-aware runs stay
comparable to results recorded before this existed.

Reading the result: expect completion rate to rise and tail latency to look
worse. Requests that previously exhausted their attempt budget contributed no
latency sample at all; when they start succeeding they contribute slow ones. A
p95 increase alongside a completion increase is the fix working.

## Metrics that matter

The one that carries the argument is the **reject split**. A local reject costs
nothing. An upstream 429 was earned only after provider capacity had already
been spent on the request. Both look like a 429 to the caller; they are not the
same event, and the harness counts them separately. Local rejects are also
retained by pool and exact reason, including the observed `requested`,
`available`, and `budget` token ranges from Tyr's rejection detail.

The others: token goodput (not throughput — abandoned work does not count),
latency and TTFT percentiles **split by class**, retry amplification (with the
`retryHints` breakdown of how much waiting was informed rather than guessed),
peak
envelope occupancy against ground truth from the simulator, and the cost of the
admission decision itself. Latency and TTFT are client-observed benchmark
metrics, not Tyr-native telemetry. During demos the load generator pushes them
to a persistent relay, which lets Prometheus retain both the baseline and
MoFlux arm after each short-lived generator process exits.

## Sample result

Historical single-run example: four replicas, envelope 32, σ=0.25, r1=400,
20s phase, seed 7. Treat it as illustrative, not publishable; the canonical
licensed demo now reports a five-seed aggregate:

| arm | int success | int p99 | int TTFT p99 | batch success | retries | cheap rejects | upstream 429 |
|---|---|---|---|---|---|---|---|
| 1 — no control | 88% | 11.3s | 4.02s | 85% | 1.53× | 0 | 99 |
| 2 — cap = env/N | 96% | 12.9s | 8.50s | 95% | 1.54× | 73 | 0 |
| 4 — Redis coordinated | 97% | 7.0s | 2.41s | 11% | 1.34× | 144 | 0 |

Three things worth reading carefully, including the ones that are inconvenient:

1. **Arm 2 eliminates every upstream 429 but makes TTFT worse** (8.50s vs
   4.02s). Its bounded queue converts rejection into waiting. Unbounded queues
   hide overload until it surfaces as timeouts — a limiter that "improves
   success rate" by making everyone wait has not necessarily helped.
2. **Arm 4 wins on interactive latency and destroys batch** (11% success, 3.7×
   retry amplification). Token-aware admission protects small requests by
   aggressively refusing large ones, and with no priority reserve and no way to
   express "batch should wait rather than fail," batch traffic absorbs the whole
   cost.
3. **Arm 3 comes out close to identical to Arm 1.** A cap that never binds is
   not protection, it is configuration that resembles protection. That is the
   finding, not a harness bug.

## Known limitations

- **σ=1 is excluded.** At fully-serialised contention the simulator
  under-delivers ~11% against its own model, and the cause is not yet
  identified. Two hypotheses (tick quantisation, TTFT-base formulation) were
  tested and neither explained it. The sweep is bounded at σ≤0.6 and σ=1 results
  should not be reported until this is understood.
- **A synthetic provider is a model.** It does not capture real provider-side
  scheduling, noisy neighbours, or actual vLLM/TensorRT batching. This measures
  *decision quality and coordination*, not absolute performance against a real
  provider. Read every number that way.
- **Trace determinism does not make the real-time system deterministic.** The
  logical arrival schedule, retry jitter, target choices, and request-level
  provider samples are now immutable and replayed exactly. HTTP scheduling,
  timer wakeups, and service progress still use a real clock, so measured
  latency and saturation boundaries can vary. Publish medians with spread
  across at least five seeds; single-run numbers remain anecdotes.
- **Workload calibration is load-bearing and easy to get wrong.** Set r1 too low
  and nothing completes inside a phase; set offered load too low and the
  envelope never saturates, so every arm looks identical. Both failure modes
  were hit while building this. Check that peak occupancy reaches the envelope
  and that success rates are neither 0% nor 100% before trusting a comparison.
- **Streaming chunk granularity** is one SSE frame per simulator tick, not per
  token.

## Layout

```
sim/provider-sim.mjs   simulated provider with the parameterized curve
sim/verify-sim.mjs     self-test: curve fidelity, backpressure, output distribution
load/verify-loadgen.mjs regression: dropped SSE stream is retried without crashing
demo/verify-telemetry-relay.mjs verifies retained baseline/MoFlux p99 and TTFT
sim/sweep.mjs          sweeps σ and κ, fails if any point leaves tolerance
arms/replica.mjs       one replica; --arm selects the admission policy
arms/redis-client.mjs  dependency-free RESP client
load/loadgen.mjs       open-loop multi-class generator
demo/seed-sweep.mjs    canonical paired multi-seed presenter (licensed images)
demo/seed-sweep-lib.mjs pure aggregation helpers
demo/present.mjs       verified single-pair presenter used by the sweep
demo/run-demo.mjs      full narrated public research walkthrough
demo/compose.yaml      telemetry relay + Prometheus + Grafana + Redis
demo/prometheus/       Prometheus scrape configuration
demo/grafana/          provisioned datasource and dashboard
scripts/replicate.sh   multi-seed runs
scripts/aggregate.mjs  medians and spread across seeds
results/               generated and curated run data
.github/workflows/     Node 22/24 verification in CI
```

## License

Apache-2.0. See `LICENSE`.

This license covers the harness only. It does not extend to Tyr or Latchflo,
which are proprietary, are not included here, and are licensed separately.
