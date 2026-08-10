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
For demand-aware runs, the same 28/4 capacity group is installed during this
bootstrap with lending temporarily disabled so pre-benchmark idle heartbeats
cannot release the protected floor. Once the measured load generator is running,
the presenter waits for a fresh interactive demand report and then arms the
configured demand policy. Each accepted grant must also have enough remaining
lifetime for a stable benchmark start. Startup fails if any live local grant is
too small or too close to expiration. Pool creation also sends Latchflo 0.10.0's durable
minimum-grant invariants: one concurrency slot, 755 tokens for interactive, and
9,942 tokens for batch. Latchflo therefore rejects an unusable split before it
can issue a zero-capacity or sub-request grant.

The licensed path is pinned to **Tyr 0.24.0**, **Latchflo 0.10.0**,
**async-bulkhead-llm 3.15.1**, and **async-bulkhead-ts 1.0.1**. The canonical
comparison uses Anthropic-shaped streaming because that protocol exposes input
usage at `message_start` and cumulative output usage while the response is still
active. Tyr enables progressive reconciliation on every benchmark pool with a
256-token update step and a 256-token future-output safety margin. This lets the
benchmark measure capacity returned before completion rather than conflating it
with the ordinary final refund. An explicit OpenAI compatibility path remains
available, but OpenAI-shaped usage in this simulator arrives only at completion
and therefore cannot demonstrate early release.

The single canonical command can use images that already exist, pull configured
registry images, or build missing images from local source directories. Place
`tyr-admission-controller` and `latchflo-control-plane` beside this repository,
or set `MOFLUX_TYR_SOURCE_DIR` and `MOFLUX_LATCHFLO_SOURCE_DIR` in the local
environment file.

Tyr 0.24.0 capacity-aware routing is enabled for the licensed four-replica
MoFlux arm. Each Tyr polls the private capacity snapshots of the other three
replicas and may forward a request once to the peer with better headroom for
that request's concurrency and token reservation. Tyr also reports bounded
per-pool demand snapshots to Latchflo 0.10.0 on the existing authenticated
heartbeat. The benchmark generates one local-only shared routing secret in
`demo/moflux/.env`; the secret is never committed. Latchflo owns grants, demand-
aware lending, starvation prevention, and lease safety. It does not distribute
peer topology or the routing secret.

The committed `results/` corpus is deliberately unchanged. Those files are
historical evidence and retain their recorded Tyr 0.17.0/Latchflo 0.5.1 runtime
metadata. New licensed runs use Tyr 0.24.0/Latchflo 0.10.0 and should be compared
as a new evidence set rather than silently relabeling the old one.

Run the canonical progressive comparison:

```bash
npm run demo
# Equivalent explicit protocol selection:
npm run demo:progressive
```

To retain the OpenAI-shaped compatibility benchmark instead:

```bash
npm run demo:openai
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

Each MoFlux result separates final settlement from capacity returned while the
stream was active. It records total reserved, consumed, refunded, and overrun
tokens; progressive usage reports; applied and coalesced updates; tokens released
before completion; and `progressiveEarlyReleaseRate`, the early-release share of
all refunds. The Grafana dashboard charts both that share and reconciliation
activity. A refund is unused safety reservation returned for reuse, not newly
created capacity.

The aggregate is written to `results/runs/video-seed-sweep/<run-id>/summary.json`
and raw evidence alongside it, with `results/runs/video-seed-sweep/latest.json`
pointing at the newest run. That whole tree is generated and git-ignored.
Reviewed evidence in `results/video-seed-sweep.json` and
`results/video-seed-sweep/` is never written by a run — promoting a run to
reviewed evidence is a separate, deliberate step that refuses to replace an
existing copy without `--force`:

```bash
npm run evidence:list
node demo/publish-evidence.mjs --as=video-seed-sweep
```

Rehearse the legacy one-pair flow with `npm run demo:single`, or choose seeds
explicitly:

```bash
node demo/seed-sweep.mjs --seeds=3,7,11 --step
```

MoFlux is the only local-admission arm that returns `Retry-After` /
`x-admission-retry-after-ms`, so its measured TTFT includes waiting the static
cap and Redis arms never do. `--honor-retry-hints=false` forces blind
exponential backoff for every arm; the trace is identical either way, so the
pair of runs isolates the hint's contribution:

```bash
npm run demo:hetero                 # historical 31/1 policy; hints honored
npm run demo:hetero:blind           # historical 31/1 policy; blind backoff
npm run demo:hetero:adaptive        # recommended demand-aware 28/4 policy
npm run demo:hetero:adaptive:blind  # same adaptive traces, blind backoff
```

The adaptive commands combine heterogeneous request sizes, progressive token
reconciliation, all control arms, and a named `adaptive-28-4` capacity profile.
They also enable `--require-adaptive-proof`. The command exits unsuccessfully
if any seed falls below 90% interactive success, completes fewer than four
batch requests, lacks a matching Latchflo lending event, fails to restore the
batch floor, or produces an upstream 429. Because request sizes are stochastic,
idle-window occupancy above the static 28-slot floor is required somewhere in
the five-seed sweep rather than on every seed. The complete failed run is
retained under `results/runs/` for inspection.

Concurrency slots and in-flight tokens are separate resources. The historical
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

The enrollment lease defaults to 5 seconds for static runs and 2 seconds for
demand-aware runs, and can be changed for unusually slow local Docker startup
with `--enrollment-grant-ttl-ms`. It must remain shorter than `--grant-ttl-ms`;
no benchmark traffic begins during enrollment. Demand-aware lending is armed
only after fresh demand from the measured run is visible to Latchflo.

See `demo/VIDEO-DEMO.md` for the recording flow and narration. Stop the
containers afterward with `npm run demo:down`.

### Authenticated admission-class benchmark

The four-arm admission-class benchmark introduced in MoFlux Bench 0.16.0 is
retained in 0.17.0 for **Tyr 0.24.0** and **Latchflo 0.10.0**. Every seed replays the same immutable
trace through equal 32-request / 64,000-token physical pools:

- `sim-shared` applies only the fleet-wide pool envelope.
- `sim-ceilings` classifies traffic and applies 8/24 premium/noisy concurrency
  ceilings, but reserves no class capacity.
- `sim-protected` keeps those ceilings and adds static fleet-wide floors: premium
  gets 4 concurrent / 8,000 tokens; noisy gets 4 concurrent / 36,000 tokens.
- `sim-adaptive` uses the same nominal floors and ceilings but enables Latchflo
  0.10.0 demand-aware class-floor lending from Tyr 0.24.0 per-class heartbeats.

Noisy traffic starts five seconds after premium traffic. The adaptive pool uses
a short 3-second benchmark lease and a 1-second idle threshold so the runner can
observe an idle noisy floor being released and then safely restored after noisy
demand begins. The other three control pools retain long steady leases. This
short adaptive TTL is benchmark instrumentation, not a production recommendation.

Two ephemeral RS256 identities drive the workloads. Tyr maps the premium tenant
to `premium`; the noisy worker uses the fixed default class. Latchflo receives
only bounded class demand and numeric limits for fixed class IDs, not caller
identity. Generated keys, JWTs, and the local CA are deleted after the run.

```bash
npm run demo:classes         # five four-arm seeds with the proof gate
npm run demo:classes:single  # one diagnostic seed
npm run demo:classes:doctor  # prerequisites only
```

The proof gate requires matching trace hashes, zero provider 429s, correct class
attribution, bounded shedding, premium and noisy service under contention, and
at least four noisy completions in the adaptive arm. It also samples both
Latchflo and Tyr during the adaptive arm and requires: the noisy nominal floor
was actually lent, its 24-concurrent / 64,000-token hard ceilings stayed intact,
noisy demand appeared after lending, and Tyr later applied the restored
4-concurrent / 36,000-token floor.

Success rate, goodput, TTFT, and restoration latency are reported outcomes, not
acceptance thresholds. The benchmark therefore tests whether adaptive floors are
work-conserving without assuming in advance that they must beat static floors on
every performance metric. See `demo/TENANT-FAIRNESS.md` for the exact policy,
lease semantics, security model, proof contract, and schema-version-3 output.

### Public research walkthrough

The public arms do not require Tyr or Latchflo:

```bash
npm run verify
npm run demo:full
```

`demo:full` starts and validates its telemetry relay, Prometheus, Grafana, and
Redis services before the first narrated phase. It waits for the provisioned
`moflux-bench` dashboard and opens its direct URL automatically. Use
`node demo/run-demo.mjs --step --no-open-grafana` for headless runs. Pass
`--no-stack-start` only when the support services are already managed
externally. External or test-managed services can be selected with
`--telemetry-relay-url`, `--prometheus-url`, and `--grafana`; the normal
defaults remain ports 8200, 9090, and 3000. A failed startup includes Compose
status plus telemetry-relay and Grafana logs instead of reporting only that
port 8200 was unhealthy.

Requires Node 22+ and Docker Compose v2. There are no runtime npm dependencies —
the Redis client is a small RESP implementation in `arms/redis-client.mjs`.

### Host processes and their ports

The provider simulator, the four replicas, and the load generator run on the
host rather than in Compose, because the demo kills a replica mid-run and doing
that through the host process tree is far less fragile than through Docker. The
consequence is that `npm run demo:down` cannot clean them up: it stops
containers, and these are not containers.

The simulator needs TCP **9000**, and the preflight refuses to start if
something else already holds it. If a run was interrupted hard enough that the
presenter could not run its own cleanup, find the survivor with:

```bash
lsof -nP -iTCP:9000 -sTCP:LISTEN
```

A host process that fails to start is reported with the exit code or signal
that ended it, how long the wait lasted, whether the process was still running
at that point, and its own last output. Startup failures that produce no output
say so explicitly, so silence is never confused with a missing check.

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

## Comparing against the alternatives, not against nothing

A sweep that only runs MoFlux against no admission control answers a question
nobody is choosing between. The decision a reader actually faces is MoFlux
against a static per-replica cap or a Redis token bucket — policies they could
write themselves in an afternoon. Arms 2 and 4 exist precisely so that
comparison can be made, and they are now runnable inside the same paired sweep:

```bash
npm run demo:arms      # baseline, static cap, Redis, MoFlux — five seeds
```

Every arm sits in the same request-path position, uses the same four replicas
and the same provider, and replays the same immutable trace. Only the admission
policy changes. Tyr is stopped for the duration of each control arm so no grant
or admission decision from the managed path can leak into a control
measurement, and the Redis keys are flushed before arm 4 so a leaked lease from
an earlier seed cannot silently shrink the capacity this seed sees.

Arm 2 derives its local cap from the actual replica topology: with a 32-slot
provider envelope and four replicas, every local semaphore receives 8 slots.
The presenter and replica both fail before traffic starts if that calculation
is missing, non-finite, or would give a replica zero capacity; an invalid arm is
never aggregated as benchmark evidence.

The aggregate gains two sections:

- `aggregate.versusBaseline` — every policy against no control. Answers "does
  this help at all", which is the easy question.
- `aggregate.mofluxVersus` — MoFlux against each alternative, paired per seed
  and then medianed. Answers "is this worth deploying over the thing I would
  otherwise build", which is the one that decides anything.

Raw evidence per seed is preserved as `static-cap-seed-N.json`,
`redis-coordinated-seed-N.json`, and `arm-comparisons-seed-N.json`. The
existing `video-comparison.json` keeps its exact baseline-versus-MoFlux shape,
so nothing downstream of it changes.

Expect the control arms to do well. Arm 2 eliminates every upstream 429 with a
local semaphore and no coordination at all; arm 4 is a properly built Redis
reserve. If MoFlux cannot beat them on something that matters, that is the
result, and it is better to find it here than in a customer's cluster.

## The lending benchmark

A static split gives batch a permanent floor. While batch is idle that floor is
dead capacity: interactive cannot touch it and the provider runs below its
envelope for no reason. Two API keys with separate quotas have exactly this
shape and cost nothing to operate — so a capacity control plane that only
reproduces a static split is not worth deploying.

Lending is the claim that justifies one: while batch has no active work,
interactive borrows batch's reserved slots; when batch arrives, the floor comes
back. That is a temporal property, and **no cumulative counter can show it**. A
run-long peak-occupancy high-water mark of 32/32 is equally consistent with
"borrowed all four idle batch slots" and "sat at 28 until batch arrived, then
hit 32 together". Both policies produce the same headline number.

```bash
npm run demo:lending           # focused demand-aware vs static 28/4 proof
npm run demo:handoff           # five-seed baseline vs MoFlux handoff proof
npm run demo:hetero:adaptive   # recommended mixed-size, all-arm comparison
```

`demo:handoff` is the shortest release-level proof for the Latchflo 0.10.0 /
Tyr 0.24.0 handoff: five lognormal seeds, the exact `adaptive-28-4` profile,
and the full adaptive safety gate without spending time on the extra control
arms. Demand-aware runs use an 11-second steady-state grant TTL and do not start
load until the fleet has a fresh grant set with at least 9.5 seconds remaining.
At the default 27-second batch arrival this guarantees at least 4.5 seconds of
lease runway for the acknowledged drain + fresh occupancy + commit path, rather
than making success depend on where the run happens to land in a lease cycle.
`demo:hetero:adaptive` uses the same profile and proof gate while adding
all control arms. Conflicting envelope, concurrency, or token settings are
rejected. `demo:lending` remains the focused static-partition scene.

`--lending` widens the idle window from 35% to 60% of the phase so Tyr 0.24.0
can report an idle batch pool and Latchflo 0.10.0 can safely lend its protected
floor. The presenter creates a demand-aware capacity group with 28/4 protected
concurrency and 24,000/40,000-token guarantees, while both pools may borrow up
to the shared 32-slot/64,000-token envelope. The larger token envelope is
required because four current batch requests can reserve up to 39,768 tokens;
a 40,000-token group would make the four-slot floor nominal rather than usable.
The run is split at the configured batch arrival, not the observed first request, because an observed boundary
lands differently in each arm and makes the windows incomparable.

The reference is a dedicated local `static-partition` arm with per-replica
interactive caps of 7/7/7/7 and a four-slot batch cap. It cannot exceed 28
interactive requests before batch arrives. The MoFlux arm is judged with controller events, load-generator admission
timestamps, and independently sampled Tyr applied capacity:

| Question | Required evidence |
|---|---|
| Did interactive borrow? | Idle-window occupancy above 28 **and** a Latchflo `capacity_group.lending_observed` event |
| Did the floor come back? | A Latchflo 0.10.0 restoration handoff commits **and** batch work completes |
| Was transfer ordered safely? | `handoff_prepared` → every drain grant `applied` ACK → `handoff_committed` |
| Did the commit actually precede batch admission? | Wall-clock controller commit occurs no later than the load generator's first batch 2xx |
| Did handoff beat the fallback? | Commit occurs before `floorRestorationDeadline` / old-lease expiry |
| Was capacity ever double allocated? | 500 ms Tyr `/stats` samples never exceed the 32-slot / 64,000-token physical envelope |
| How long did each stage take? | Demand → drain → ACK → commit → first batch admission, reported separately |

Configuration is not proof. A run-long 32/32 peak can occur under a static
28/4 split after batch starts, and occupancy without a matching controller
event can be a measurement artifact. MoFlux Bench 0.17.0 therefore fails the
adaptive proof if the restoration handoff is missing, drain acknowledgements
are unordered, batch is admitted before an observed commit, the handoff reaches
its lease fallback, or applied-capacity sampling cannot prove that the envelope was
never double allocated. A policy that borrows but never restores the batch
guarantee is starvation, not lending.

`batchFloorAdmissionGapMs` is now strictly an admission-layer metric: first
batch attempt to first batch **2xx**. `batchFloorFirstSuccessGapMs` separately
measures first attempt to first fully completed response. Version 0.16.0 used
the first completion as its "admission gap", which mixed provider execution
time into the reclaim measurement. The load generator also emits
`startedAtEpochMs`, allowing those relative timestamps to share one wall-clock
timeline with Latchflo events.

Each run is written below `results/runs/<sweep>/<run-id>/`; the seed summary
aggregates borrowed slots, controller proof, the complete handoff timeline,
lease time avoided, sampled applied-capacity safety, batch admission/completion
gaps, batch service, and an explicit adaptive pass/fail record. Reviewed
evidence is not overwritten. A failed `--require-adaptive-proof` run keeps its
summary and per-seed files but does not update the latest successful pointer.
Two implementation notes are load-bearing:

- Phase windows are computed by the load generator from a record that is never
  pruned. The rolling `samples` array exists for the Prometheus percentiles and
  is trimmed to `windowMs` on every scrape — deriving windows from it would
  lose the entire idle window on any run longer than 30 seconds and report zero
  idle goodput instead of failing.
- `idle + contended + drainCompleted` equals the class's total successes.
  Requests admitted before the offered-load window closes can complete after
  it; counting those in the contended window would inflate its goodput with
  work the window never offered, so they are reported separately and the split
  can be checked rather than trusted.

## Request size heterogeneity

Until version 0.10.0 every request in a class was the same size: 1,200 chars
and 400 max tokens for interactive, on every request and every seed. That makes
the benchmark unable to measure its own subject.

With a single fixed size per class, **token-aware admission and a plain
concurrency semaphore are the same algorithm**. N slots times one constant is a
fixed token ceiling, so there is no admission decision token accounting can
make that a counter cannot. Measured on the committed policy, the interactive
pool had 31 concurrency slots against 36 token-funded ones — the token budget
never decided a single admission, on any seed. Any advantage claimed for token
awareness was unattributable, and a static per-replica cap was expected to
match it.

Real traffic in one class spans one to two orders of magnitude, because context
length, retrieved documents, and conversation history vary per call.

```bash
npm run demo:hetero             # lognormal sizes with historical 31/1 policy
npm run demo:hetero:adaptive    # lognormal sizes with demand-aware 28/4 policy
```

Use the historical command to reproduce the reviewed 31/1 corpus. Use the
adaptive command for the current product claim: interactive can borrow idle
batch capacity, and the four-slot batch floor must return when demand arrives.

`--size-distribution=lognormal` draws an input size and a max-token count per
request. `--interactive-size-sigma` (default 0.75) and `--batch-size-sigma`
(default 0) control the spread. Sizes are clamped to a bounded multiple of the
class median, because an unclamped tail produces requests whose reservation
exceeds any single grant — reproducing the stranded-capacity failure through
the workload rather than the configuration.

### Version 1 results are preserved

`--size-distribution` defaults to `uniform`, which reproduces the version-1
trace **bit for bit**. Seed 3 still hashes to
`14745a767634923c7d42d626df4d541b98ff66372c5d84ebe1f33b33ebe9c02b`, asserted on
every verify run. Sizes are drawn from a separate seeded stream, so arrival
times and retry jitter are identical between a v1 trace and its v2 counterpart;
only the sizes are new.

A version-1 trace cannot replay under a heterogeneous configuration, or the
reverse. Mixing them would offer different work to the two arms of a pair while
both reported a matching scenario.

### Reading the result

Every class summary now carries `bindingConstraint`:

```json
"bindingConstraint": {
  "budgetLimited": 0,
  "concurrencyLimited": 13,
  "tokenBoundShare": 0,
  "exercisedTokenAwareness": false
}
```

`exercisedTokenAwareness: false` means the token budget refused nothing, so
nothing in that run is attributable to token-aware admission — whatever the
configuration claims. Check it before reading any comparison between MoFlux and
a concurrency-limited arm. A run where it is false is measuring two
concurrency limiters.

`requestSizes` reports the realised min, p50, p95, max, and spread of the
replayed trace, so a claimed distribution can be checked against what actually
ran.

Both are aggregated across seeds. `aggregate.arms.<arm>` carries
`budgetLimitedRejects`, `concurrencyLimitedRejects`, `tokenBoundShare`, and the
realised sizes; a top-level `tokenAwareness` block reports how many seeds each
arm's token budget refused work on, distinguishing "one seed exercised it" from
"every seed did". The sweep prints this above the head-to-head table and names
any arm whose budget refused nothing.

## Coordinator distance

Every admission-control design answers "may this request proceed" against state
shared across replicas, and there are two ways to do it.

**Per-request coordination** (arm 4, Redis) consults the shared store on every
admission. The decision is always exact. The cost is one round trip per
attempt, on the request's critical path, forever.

**Lease-based coordination** (MoFlux) holds a grant of capacity and decides
locally against it. The round trip is paid on grant renewal, off the critical
path, amortised across every admission the grant covers. The decision is exact
within the grant and approximate across the fleet.

On loopback these are indistinguishable, because a round trip costs a few
hundred microseconds. Every comparison in this harness was run that way until
0.10.0, which gave the per-request design the most favourable condition it can
have and one that does not exist in production — a same-AZ hop is roughly
0.5-1ms, cross-AZ 1-3ms, and a contended instance considerably more.

```bash
npm run demo:coordinator      # full sweep at 0, 1, 5, 15, 30, 50ms
```

`--coordinator-latency-ms` is applied to the Redis client's every command.
Only arm 4 receives it, because only arm 4 consults a coordinator while
admitting; sending it to the others would make them look sensitive to a service
they never call. `demo/verify-loadgen-args.mjs` enforces that routing.

### The prediction, and how it can fail

Per-request coordination should degrade roughly linearly with distance,
multiplied by attempts per request. Lease-based coordination should be flat.

`results/coordinator-ladder.json` reports a least-squares slope per arm in
milliseconds of added latency per millisecond of coordinator distance, with an
r² so a slope fitted to noise is not read as a trend. A flat Redis line, or a
rising MoFlux line, refutes the prediction — and `isCoordinatorIndependent`
will say so, because it judges the fit rather than the architecture.

The crossover is reported only when it is **observed inside the tested ladder**.
If the two arms never cross, the report says so and gives the narrowest deficit
rather than extrapolating a crossing beyond the last rung.

Sizing note: each rung is a complete paired sweep, so the cost is
rungs × seeds × arms runs. Start with two or three rungs before committing to
the full ladder.

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
- **Adaptive class-floor restoration is lease-safe, not instantaneous.**
  Tyr 0.24.0 reports bounded per-class demand and Latchflo 0.10.0 can lend a fully
  observed idle class floor. Returning demand stops new lending immediately, but
  running borrowers are not revoked; the nominal floor is restored after the
  outstanding lent-allocation lease expires plus normal reconcile/poll delay.
  The class benchmark therefore reports restoration latency explicitly.
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
