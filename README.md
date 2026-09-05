# moflux-bench

A synthetic and budget-capped live-provider benchmark harness for LLM admission control.

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
too small or too close to expiration. Pool creation also sends Latchflo 0.15.0's durable
minimum-grant invariants: one concurrency slot, 755 tokens for interactive, and
9,942 tokens for batch. Latchflo therefore rejects an unusable split before it
can issue a zero-capacity or sub-request grant.

The licensed path is pinned to **Tyr 0.30.0**, **Latchflo 0.15.0**,
**async-bulkhead-llm 3.17.0**, and **async-bulkhead-ts 1.0.1**. The canonical
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

Tyr 0.30.0 capacity-aware routing is enabled for the licensed four-replica
MoFlux arm. Managed Tyr configs start with `peers: []`: each replica advertises
its routable endpoint when it registers, Latchflo 0.15.0 publishes a durable,
versioned `routingTopology`, and Tyr applies only newer topology revisions. Tyr
then polls private capacity snapshots for the currently active peers and may
forward a request once to the peer with better request-specific headroom. Tyr
also reports bounded per-pool demand snapshots on the existing authenticated
heartbeat. The benchmark generates one local-only shared routing secret in
`demo/moflux/.env`; the secret is never committed or distributed by Latchflo.
Latchflo remains off the synchronous request path.

The committed `results/` corpus is deliberately unchanged. Those files are
historical evidence and retain their recorded Tyr 0.17.0/Latchflo 0.5.1 runtime
metadata. New licensed runs use Tyr 0.30.0/Latchflo 0.15.0 and should be compared
as a new evidence set rather than silently relabeling the old one.

Run the canonical progressive comparison:

```bash
npm run demo
# Equivalent explicit protocol selection:
npm run demo:progressive
```

For the retained **simulated** OpenAI-shaped protocol path:

```bash
npm run demo:openai:sim
```

Focused current demos validate fleet membership and OpenAI compatibility separately.
The fleet-membership benchmark is entirely local and free:

```bash
npm run demo:membership
```

It repeatedly proves four-member convergence, heartbeat revision stability,
timeout removal, replacement under a new identity/endpoint, topology agreement,
and monotonic revisioning against Latchflo 0.15.0.

The local inference benchmark is entirely self-hosted, unmetered, and needs no
API key:

```bash
npm run demo:local:dry-run   # prints the plan; sends nothing
npm run demo:local           # 8 direct + 8 Tyr requests against a local server
```

It starts an Ollama server and one Tyr in front of it from
`demo/ollama/compose.yaml`, pulls `qwen3:0.6b` into a named volume on first use,
and replays the same paired, alternating-order design as the OpenAI
compatibility path — so the two arms differ only by whether the request went
through the proxy. Override the weights with `--model=` or `MOFLUX_LOCAL_MODEL`;
anything the pool's `modelPrefixes` admits will do, and a bigger model changes
how long a run takes rather than what it measures.

Three things about this benchmark are worth stating plainly, because they are
what make it different from the hosted one rather than a cheaper version of it:

- **There is no spend guard, so there is a locality guard instead.** A
  self-hosted server has no price to compute a worst-case bill from. What
  replaces `--max-usd` is a check that `--direct-url` and `--moflux-url` both
  resolve to a loopback, private, or single-label address, applied before the
  first request and **not overridable by any flag**. Pointing this benchmark at
  a metered provider is refused rather than warned about; that run is
  `npm run demo:openai`, which enforces a cost ceiling.
- **The proxy and the model share the machine.** Against a hosted provider they
  contend for nothing. Here Tyr and the inference server compete for the same
  cores, so `deltas.latencyP50Ms` includes contention that no hosted run would
  ever show. That is the interesting part, and it is also why a local number
  must not be quoted as a general proxy-overhead figure.
- **The earliest pairs are warm-up, and the summary says so.** The first request
  after the stack starts pays to load the weights into memory, and Tyr's
  adaptive token estimator needs `minSamples` observations before it corrects
  its estimate. `caveats.warmupPairs` reports how many pairs that covers.
  Alternating arm order balances the effect across arms rather than removing it.

The pool in `demo/ollama/tyr.yaml` is pinned to `maxConcurrent: 1` to match
`OLLAMA_NUM_PARALLEL=1` in the compose file. An admission bound above the
server's real concurrency would be shedding against imaginary capacity. Like the
OpenAI compatibility path, this is **not** an overload benchmark. Workload-isolation
under local contention is measured by the separate 0.33.0 benchmark below.

### Local inference under contention

MoFlux Bench 0.33.0 added a second, separate local benchmark that *is* about
behaviour under load; 0.33.1 corrected its phase attribution and proof
semantics, 0.33.2 fixed H4 attribution for borrowing backed by another class's
explicitly released capacity, and **0.34.0 makes the benchmark trustworthy
enough to decide whether the restoration policy needs changing**. None of them
changes the workload, the capacity policy, the SLO thresholds, the grant TTL, or
the seed count. `demo/local-contention.mjs` asks one question:

> When interactive and batch requests contend for the same self-hosted inference
> capacity, does MoFlux preserve interactive service while still letting batch
> traffic use otherwise-idle capacity?

```bash
npm run demo:local:contention:dry-run    # prints the plan and arm order; sends nothing
npm run demo:local:contention:single     # one seed, development
npm run demo:local:contention            # five seeds with --require-proof
```

Three arms replay one immutable, five-phase trace against one Ollama container
serving one model: `direct` (no admission control, Ollama's own FIFO queue),
`static` (fixed per-class protected floors, never lent), and `moflux` (identical
floors, lent while idle and restored on demand). `static` and `moflux` partition
identical capacity and differ only in whether Latchflo's
`admissionClassDemandPolicy` is enabled, so any difference between them has
exactly one candidate cause.

The workload class is carried by signed identity rather than a client header,
and the trace contains a deliberate interval in which interactive demand is
absent — a control plane cannot lend a floor it never observes idle. That is why
`load/trace-lib.mjs` grew an optional second interactive arrival window
(trace version 3); without it every historical trace still hashes exactly as
before.

Its acceptance object is `localContentionProof` and the top-level `passed`
mirrors that and nothing else. Per seed it gates validity and safety only —
one trace across arms, warm-up excluded, measurable queueing in the control arm,
no unlent-floor/class/pool over-allocation, no new borrowing of a protected
floor after its owner has come back for it, and no unacknowledged handoff. Phase
membership is determined by immutable trace arrival time, not by when a slow
local decode finally completes. Across seeds it gates pre-registered
hypotheses: H1 requires at least +0.04 req/s of interactive contention-window
**SLO goodput** over unmanaged Ollama, where a useful request must succeed with
TTFT <= 5 s and completion latency <= 30 s; H2 requires at least 1.2x the static
arm's batch completions while interactive demand is idle; H3 requires the
protected floor never to be violated; **H4a** requires no unsafe capacity
transfer and **H4b** requires no new borrowing after protected demand returns.
Survivor-only TTFT/goodput remain descriptive and cannot by themselves make H1
pass. H1 and H2 can fail, and the harness tests exercise them failing.

#### What 0.34.0 changed about the evidence

Every item here is instrumentation, benchmark semantics, or reliability. The
experiment is deliberately unchanged so the corrected instrumentation evaluates
the same thing.

- **A failed load-generator arm is now diagnosable after the process is gone.** Each local-contention arm persists stdout/stderr to `<arm>-seed-<n>.loadgen.log` beside its JSON output. A non-zero exit includes the bounded child-output tail plus the repo-relative log path in the benchmark error instead of reducing every failure to `exit 1`. The log header does not copy argv, because managed-arm argv contains identity credentials.
- **Demand transitions are first-class evidence.** Each managed arm's summary
  carries every observed demand-state change for both classes, plus a
  `demandReturn` timeline that reconciles three clocks — the immutable trace,
  the load generator's own reject/admission records, and the 250 ms `/stats`
  sampler — onto one origin via a measured `loadgenSkewMs`. From the summary
  alone a reader can now answer when interactive demand resumed at the
  generator, when Tyr first decided anything about it, when the benchmark marked
  the class active, whether its capacity was lent at that instant, how much the
  other class held, whether any new borrowing followed, and when restoration
  began. A deduplicated per-sample digest of the 50–70 s interval ships with it.
- **Restoration episodes are accounted correctly.** A restoration-required
  episode now means capacity was lent, its owner returned while it was still
  lent, and the controller therefore had something to restore. Demand return is
  detected from the controller's demand state and from *rejections*, not only
  from admissions — the previous rule was blind in exactly the case restoration
  exists for, because a class returning to a fully-borrowed pool is refused on
  every attempt and is never admitted. Passive returns (a lease rolling a floor
  back with nobody asking) are counted separately and are never reported as
  restorations. Each episode carries both `restorationLatencyMs` for the grant
  and `occupancyRestorationLatencyMs` for the moment the owner could actually
  use its floor; on a non-preemptive policy those differ by the borrowers'
  remaining decode and quoting only the first prices restoration at nothing.
- **Empty distributions are `null`, not `0`.** A window in which every request
  was rejected used to report `ttftP95Ms: 0`, which reads as the fastest window
  in the run. Counts and rates stay numeric — zero completions really is zero
  goodput — and ratios built from a missing distribution are `null`.
- **H4 is split.** `h4a` is capacity-transfer safety (no ceiling, pool or
  floor-sum over-allocation, no unlent-slice breach, no handoff committed
  without acknowledgement). `h4b` is timing (no new borrowing after protected
  demand returns, grandfathered borrowers may drain but a slot they give back
  may not be refilled, restoration-required episodes converge). An
  acknowledged-and-aborted-safe handoff is no longer described as unsafe because
  borrow growth happened at a suspect instant. `hypotheses.h4` remains as the
  conjunction for one release.
- **Post-demand borrowing is measured against the nominal partition.** Tyr's
  `borrowedConcurrent` is occupancy above a class's *applied* floor, and a class
  whose own floor has been lent away while idle reports its first legitimate
  request as borrowing. That produced a false H4 failure at 29.896 s on the
  0.33.2 seed 4, inside the phase in which batch is supposed to be using idle
  capacity. Encroachment is now occupancy above a class's own *nominal* floor,
  which is the only occupancy that can be coming out of another class's reserve.
- **Managed-arm warm-up authentication is diagnosable.** The identity fixture
  re-mints its JWTs on access as they approach expiry instead of minting once
  per process; a five-seed sweep runs for over an hour and 0.33.2's died in seed
  5 on an expired one-hour token. Every warm-up failure now records seed, arm,
  workload class, request index, attempt, HTTP status, a bounded response body,
  whether a token was present, its fingerprint, issue and expiry times, elapsed
  benchmark time, and whether credentials were refreshed for that attempt. A 401
  is retried exactly once behind a forced re-mint, and both attempts are
  recorded. Bearer tokens are never written to a summary.

Schema compatibility: `hypotheses.h4` and the seed-level
`safety.noBorrowGrowthAfterRestoration` key remain as aliases for one release.
Latency and TTFT percentile fields that previously read `0` on an empty window
now read `null`, which is a deliberate and breaking change to a misleading
value.

**This is a different corpus from the 0.32.0 compatibility result and does not
restate it.** `results/local-inference-compatibility.json` measures a proxy in
front of an *unsaturated* server, one request at a time, and its deltas are
explicitly not quotable. Read `demo/LOCAL-CONTENTION.md` for the workload
parameters, the measured control-plane behaviour the design is built around, and
the full list of claims this evidence may not be used to support — no GPU
preemption, no GPU utilization, no KV-cache reclamation, no scheduler
preemption, and no generalization from `qwen3:0.6b` on a CPU-only container.

Two live OpenAI paths are opt-in and budget-capped. The compatibility path stays deliberately tiny:

```bash
export OPENAI_API_KEY='...'
npm run demo:openai:dry-run   # calculates the maximum planned cost; sends nothing
npm run demo:openai           # 8 direct + 8 Tyr requests by default
```

The compatibility default is the OpenAI **Responses API** (`POST /v1/responses`),
`gpt-5.6-luna`, 32 maximum output tokens, and a `$0.01` conservative per-run
budget. It measures provider compatibility plus direct-vs-Tyr latency/TTFT; it
is **not** overload evidence. Use `npm run demo:openai:chat` to retain the
legacy Chat Completions compatibility check, or `npm run demo:openai:responses`
for the explicit Responses form of the default.

The live overload experiment introduced in MoFlux Bench 0.29.0 uses sustained direct-provider calibration before the comparison. Calibrate first,
review the result and your account limits, then dry-run the matched comparison:

```bash
npm run demo:openai:overload:calibrate:dry-run
npm run demo:openai:overload:calibrate

npm run demo:openai:overload:dry-run
npm run demo:openai:overload
```

Calibration now establishes a 24-request baseline at 4 RPS, then offers bounded
10-second stages at 10, 20, 30, and 40 RPS by default. It reports the first
credible pressure signal from provider 429/5xx/transport failures, TTFT or
end-to-end p95 inflation, or persistent request/token rate-limit headroom at or
below 5%. The reported goodput/offered-rate ratio is diagnostic only because its
wall-clock denominator includes the final drain tail; it cannot by itself declare
provider pressure. Non-overload provider failures invalidate the pressure
inference instead of being counted as overload. Before the baseline and every
sustained stage, the harness also makes a tiny direct-provider probe and requires
at least 95% request and token headroom. If the bucket is depleted it waits using
the provider reset headers and reprobes; failure to recover within the bounded
recovery window invalidates the evidence instead of running from an unequal
starting state. Missing request/token limit headers also fail closed because the
starting condition cannot be proven. The conservative default reserves up to 1,054 requests including
recovery probes and remains below the $0.10 spend guard at the bundled model
pricing. Calibration is never mixed into arm-comparison evidence.

Useful overrides include:

```bash
npm run demo:openai:overload:calibrate -- \
  --calibration-rps-steps=10,20,30,40,50 \
  --calibration-stage-ms=10000 \
  --calibration-baseline-requests=24 \
  --calibration-baseline-rps=4
```

The old `--calibration-steps` / `--calibration-requests-per-worker` burst mode is
retained for backward compatibility and is selected automatically when either
legacy option is supplied. New runs should use sustained calibration.

Compare mode generates one immutable mixed interactive/batch request trace and
replays it through three arms: direct OpenAI, a fail-fast static local
concurrency cap, and Tyr protected admission classes using the same physical
concurrency cap. The canonical default trace runs for 10 seconds with a 10 RPS
interactive stream and a 70 RPS batch surge from 2-10 seconds, using 64-character
inputs and 8-token output reservations. Static and MoFlux both use a 36-request
physical cap; MoFlux protects 8 interactive and 4 batch slots, leaving 24 shared
slots available for cross-class borrowing. This avoids accidentally turning
protected floors into rigid static partitions when the provider is not under
pressure. The conservative worst-case plan is about $0.168 at the reviewed
default model pricing. The default overload budget is `$0.18`,
and every explicit live-OpenAI per-run override remains hard-capped at `$1.00`.
The harness also refuses more than 2,000 planned requests, including the maximum
configured rate-limit recovery probes, in one invocation.

For publication evidence across multiple independently guarded seeds, use the
sequential sweep wrapper. It always runs the same three arms (`direct`, `static`,
`moflux`) once per seed, but counterbalances their execution order with a
deterministic six-permutation schedule keyed by seed. Seeds 1-6 cover every
possible arm order once; seeds 7-8 repeat the first two permutations, leaving each
arm in each first/middle/last position either two or three times across the default
eight-seed sweep. The wrapper keeps the original per-seed request/spend and
recovered-headroom gates, then validates identical runtime/workload/policies before
pooling raw request records into one top-level `summary.json`. Per-seed summaries
remain next to it for provenance. The sweep itself has a separate aggregate spend
ceiling. A live sweep now aborts immediately after the first inconclusive seed,
because the pooled publication gate requires every included seed to be a
conclusive provider-overload comparison; continuing would only spend more money
on a sweep that could not qualify.

```bash
npm run demo:openai:overload:sweep:dry-run

# Remove --dry-run only after reviewing all eight per-seed plans.
npm run demo:openai:overload:sweep
```

Those bare commands use the reviewed 80-RPS canonical profile described above,
require 99% starting request/token headroom before every arm, reserve at most
`$0.18` per seed (`$1.44` across eight seeds), and retain the `$1.50` aggregate
sweep ceiling. Every workload and policy parameter remains explicitly
overridable for new calibration work.

Generated output lands under
`results/runs/openai-live-overload-sweep/<run-id>/summary.json`, with
`seed-1/summary.json` through `seed-8/summary.json` retained beneath the same
run directory. The pooled summary recomputes success counts, provider failures,
TTFT/latency percentiles, and goodput from the raw per-request records; it does
not average per-seed p95 values. It also records paired per-seed deltas, the
actual arm order and arm position for every seed, aggregate first/middle/last
position counts, and flags for conclusive
provider pressure, rate-limit isolation, zero controlled-arm 429s, counterbalanced
arm ordering, and a positive MoFlux interactive-success advantage on every seed.

The first live overload experiment intentionally isolates **single-node protected
concurrency**. It does not enable Tyr's in-flight token budget and does not run
Latchflo fleet coordination. That keeps the provider question separate from the
coordinator question already covered by simulator sweeps. Tyr request classes
are selected through short-lived benchmark JWTs served by an ephemeral local
JWKS endpoint; the OpenAI API key remains only in the caller process and is
forwarded as the provider `Authorization` header. Generated JWT signing keys
exist only in memory.

A completed run is not automatically an overload win. The JSON explicitly marks
`conclusiveProviderOverloadComparison=false` unless the direct arm shows a strict
provider-pressure signal, local admission contention is exercised, Tyr's bounded
admission-class attribution is proven, and every arm starts with verified recovered
provider rate-limit headroom. Before each arm, a direct-provider recovery probe
requires at least 95% request and token headroom; depleted buckets are allowed to
recover using provider reset headers, and failure to recover makes the comparison
inconclusive. `--runs` still rotates arm order across repetitions, while
`--arm-cooldown-ms` is only an optional minimum pause before the mandatory recovery
gate. Useful fairness overrides are `--rate-limit-start-headroom-ratio`,
`--rate-limit-recovery-timeout-ms`, and `--rate-limit-recovery-max-probes`.

For either live path, the API key is read only from `OPENAI_API_KEY`; it is not
copied into benchmark env files, Docker Compose, logs, or result JSON. Unknown
models require explicit current input/output prices. The spend guard protects one
planned run and does not know account-wide monthly spend. Pricing for the bundled
default was reviewed against OpenAI's model page on 2026-08-28.

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
npm run demo:hetero:adaptive        # headroom-aware 28/4 current adaptive policy
npm run demo:hetero:headroom        # headroom-aware 28/4 policy
npm run demo:headroom:compare       # paired old-vs-headroom policy experiment
npm run demo:hetero:adaptive:blind  # same adaptive traces, blind backoff
```

The adaptive commands combine heterogeneous request sizes and progressive token
reconciliation with a fixed 32-slot / 64,000-token envelope. `adaptive-28-4` is
the control policy: interactive and batch keep 28/4 concurrency entitlements and
24,000/40,000-token entitlements, and a demanding member retains its full
entitlement. `adaptive-headroom-28-4` keeps those same nominal entitlements but
uses Latchflo 0.15.0's demand-safe, non-stranding sustained headroom lending (introduced in 0.12.4) on
`sim-interactive`. Protected/no-current-demand telemetry may expose headroom as
before. A demanding interactive member may additionally lend only after safe
slack persists for 3,000 ms, and that active-demand release is hard-capped at
2 concurrency slots and 10,000 tokens. Under the current Latchflo 0.15.0 runtime, long-lived
pressure-free demand remains `demanding`; `starved` requires aged demand plus
pending or recent rejection pressure. Rejection pressure, starvation, stale or
incomplete telemetry, pending work, or loss of the sustained-safety condition
makes the active-demand slice ineligible immediately. Capacity released as
interactive headroom remains source-aware: another eligible demanding member
may consume it, but if nobody does, it stays usable by interactive instead of
becoming stranded. Batch itself has no headroom-lending configuration and
retains its protected 4-slot / 40,000-token entitlement.

The bounded local waiter behavior introduced in MoFlux Bench 0.27.0 remains enabled on every
`sim-interactive` Tyr replica. Latchflo grants `maxQueuePerAgent: 1` only to
`sim-interactive`; `sim-batch` remains `maxQueuePerAgent: 0`. Each interactive
replica pins `queueTimeoutMs: 750`, so the queue converts only short concurrency
transients into waiting rather than becoming a second backlog. Tyr continues to
report live `pending` demand on its authenticated Latchflo heartbeat. Sustained
pressure therefore makes interactive headroom ineligible under Latchflo 0.15.0,
while a single short wait can complete locally without taking capacity away from
the four-slot batch floor. If that bounded wait expires, Tyr returns an
attributable admission rejection as HTTP 504 with `x-admission-reason: timeout`;
the load generator records it as `localReject` (including its snapshot and retry
hint), while an unmarked 504 remains a harness/server fault.

Both profiles enable `--require-adaptive-proof`. The command exits unsuccessfully
if any seed falls below 90% interactive success, completes fewer than four batch
requests, lacks the required Latchflo lending/restoration evidence, cannot prove
the first handoff-lineage batch admission at or after `handoff_prepared` used the committed successor grant, fails to
restore the batch floor, double-allocates applied capacity, or produces an
upstream 429. The headroom profile additionally requires at least one seed to
prove an interactive-to-batch lending event at both Latchflo and Tyr's applied
capacity. Because request sizes are
stochastic, ordinary adaptive sweeps require idle-window occupancy above the static
28-slot floor somewhere in the five-seed sweep rather than on every seed.
`demo:headroom:compare` is the deliberate exception: its controlled low-pressure
trace is designed to prove active-demand headroom, so idle occupancy above 28 is
reported only as a diagnostic there. The paired comparison still requires the
normal per-seed safety proof plus its stricter in-window `demandState=demanding`
controller event and correlated bounded Tyr transfer. The complete failed run is
retained under `results/runs/` for inspection.

For both adaptive profiles, the presenter installs a bootstrap-safe capacity group while the Tyr fleet enrolls. Demand-aware lending stays disabled until fresh measured traffic is observed; for the headroom profile, the bootstrap copy also omits member-level `headroomLending` because Latchflo requires headroom lending and an enabled demand policy to be configured together. The full unchanged headroom policy is installed when measured demand arms lending.

`demo:headroom:compare` is the direct policy outcome experiment. It runs MoFlux-only
five-seed sweeps for both profiles, verifies that every same-seed trace hash is
identical, and writes a paired summary of absolute and delta batch success versus
interactive success, p95 latency, TTFT p95, local rejects, and upstream 429s. This
paired command deliberately uses a controlled 3 interactive RPS, uniform-size trace
while batch still begins at 60% of the 45-second phase. That keeps interactive demand
continuously active but leaves deterministic room below the protected 28-slot /
24,000-token entitlement for longer than the 3,000 ms demanding-state sustain window.
The canonical `demo:hetero:adaptive` command now selects that same headroom-aware
profile on the ordinary 6-RPS lognormal workload; `demo:hetero:headroom` remains a
compatibility alias. Both retain the idle-occupancy-above-28 proof requirement.
Only the paired headroom exercise marks that older occupancy proof diagnostic, because
its relevant lending evidence is the stricter in-window demanding-headroom correlation.
The paired experiment then answers one explicit question:
after the protected 4-slot batch floor is restored, does headroom-aware lending turn
that bounded active-demand slack into more completed batch work without giving back
interactive protection?

A child sweep that completes all seeds and preserves `summary.json` is still a usable
policy result even when `--require-adaptive-proof` makes that child exit nonzero. The
paired runner now continues in that case so the final comparison records *why* the
policy failed. A crash, signal termination, or missing/unreadable summary still stops
the comparison immediately.

The default release gate now sizes the batch-payoff requirement from the headroom
that the configured policy can actually fund. It computes the demanding-state
increment as `min(maxDemandingConcurrentLend,
floor(maxDemandingTokenLend / batchRequiredLocalGrant))` and evaluates the batch
completion gain only on seeds with joint controller plus correlated Tyr
headroom-transfer evidence. For the default 2-slot / 10,000-token lend and the
current batch reservation, that funds one additional batch reservation, so the
default exercised-seed gate requires a median gain of at least one completion
and a median headroom completion count at least one above the exercised control
median. The safety gates are unchanged: joint headroom proof is still required
on at least 60% of seeds; exact successor-grant admission proof is required on
every seed; upstream 429s must remain zero; median interactive-success regression
must be no worse than 2 percentage points; and median interactive-p95 regression
must be no worse than 10%. Explicit overrides remain available with
`--min-median-batch-successes`, `--min-median-batch-success-delta`,
`--min-headroom-evidence-seed-fraction`,
`--max-interactive-success-regression-pp`, and
`--max-interactive-p95-regression-percent`. A raw 26/6 Tyr split is diagnostic
only. Joint headroom proof requires the controller event to occur during the measured
workload, report `demandState=demanding` and `reason=headroom`, stay within the
configured active-demand slot/token caps, and be followed by a matching Tyr applied-
capacity transfer that is also observed before the measured workload ends. Protected
or post-workload lending remains visible as diagnostic evidence but cannot satisfy the
headroom gate. If either underlying adaptive gate or
the outcome gate fails, the comparison is preserved but the command exits
unsuccessfully rather than presenting it as a passing result. The named adaptive
capacity profiles are valid in MoFlux-only mode because this paired experiment
runs each policy as its own MoFlux sweep. The legacy `--lending` flag remains
compare-only because its idle-window presentation is defined against a control
arm.

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

The four-arm admission-class benchmark introduced in MoFlux Bench 0.16.0 and
upgraded in 0.18.0 now runs against **Tyr 0.30.0** and **Latchflo 0.15.0**. Every seed replays the same immutable
trace through equal 32-request / 64,000-token physical pools:

- `sim-shared` applies only the fleet-wide pool envelope.
- `sim-ceilings` classifies traffic and applies 8/24 premium/noisy concurrency
  ceilings, but reserves no class capacity.
- `sim-protected` keeps those ceilings and adds static fleet-wide floors: premium
  gets 4 concurrent / 8,000 tokens; noisy gets 4 concurrent / 36,000 tokens.
- `sim-adaptive` uses the same nominal floors and ceilings but enables Latchflo
  0.11.0 demand-aware class-floor lending from Tyr 0.30.0 per-class heartbeats.

Noisy traffic starts five seconds after premium traffic. All four arms now use
the same 240-second steady lease. Each seed starts from a fresh Latchflo/Tyr
control-plane state so a restored 240-second grant from an earlier seed cannot
prevent the next seed from exercising idle-floor lending. Before the adaptive
trace begins, the runner explicitly waits until the quiet noisy floor is proven
lent. The adaptive arm keeps a 1-second idle threshold and relies on Tyr 0.30.0
plus Latchflo 0.15.0's acknowledged class handoff to restore that floor before
the lent lease expires. (The 0.12.0 successor-authority change applies to physical
capacity-group handoffs; class-only handoffs retain their predecessor-lease proof.) After workload sampling ends, the runner keeps a bounded
15-second synchronization window and actively reconciles until Tyr has actually
applied the restored floor; a Latchflo handoff commit alone is not treated as
data-plane restoration. The benchmark no longer shortens the adaptive TTL to
make restoration observable.

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
noisy demand appeared after lending, Tyr later applied the restored
4-concurrent / 36,000-token floor, and Latchflo recorded a class handoff whose
drain grants were acknowledged and committed before the source lease expired.

Success rate, goodput, TTFT, and restoration latency are reported outcomes, not
acceptance thresholds. The benchmark therefore tests whether adaptive floors are
work-conserving without assuming in advance that they must beat static floors on
every performance metric. See `demo/TENANT-FAIRNESS.md` for the exact policy,
lease semantics, security model, proof contract, and schema-version-4 output.

### Restoration enforceability ladder

Every capacity control plane in this space says "protected floor". The question
that decides whether one is worth deploying is what happens at the moment the
floor is demanded back while a borrower is still holding it. MoFlux Bench 0.31.0
adds two arms that make the three possible answers distinguishable, using
Latchflo 0.15.0's per-resource restoration contracts and Tyr 0.30.0's bounded
borrowed-slot deadline:

```bash
npm run demo:restoration          # five seeds, ladder arms plus the existing four
npm run demo:restoration:single   # one seed
```

The arms replay the same trace as `sim-adaptive` through pools whose numeric
floors are identical, so the release mechanism is the only variable:

| Arm | Admission slots | Upstream tokens | What it can honestly claim |
|---|---|---|---|
| `sim-adaptive` | `lease_safe_handoff` | `non_preemptive` | Both are wall-clock objectives. The floor returns when the borrower finishes. |
| `sim-unlent` | `lease_safe_handoff` | `unlent_floor` | Half of each protected token floor is allocation-enforced: Latchflo never lends it, so it needs no reclamation. |
| `sim-deadline` | `deadline_abandonment` | `unlent_floor` | The above, plus Tyr bounds how long any borrowed slot may be held at all. |

Three things this benchmark is careful about, because each is easy to overstate:

**The deadline is unconditional.** Measured directly against
`tyr-admission-controller:0.30.0`: a borrowed request is abandoned `deadlineMs`
after admission even with zero contention and nothing waiting on the floor. It
bounds how long a borrowed slot may be held, *not* how long it may be held after
the owner asks for it back. That is precisely what makes the owner's worst-case
wait enforceable, and it means the bill is paid by every borrower that
legitimately runs longer than the deadline, needed or not. `deadlineMs` is a
workload parameter, not a safety margin; a rising `releasedByCause.deadline`
share in Tyr's `/stats` is the signal that it was set too tight.

**Enforced restoration is never free, so it is always reported with its bill.**
An enforced slot is bought with a shed request; an unlent token floor is bought
with capacity no borrower could use for the entire idle window. A mechanism that
restores instantly by never lending anything has not beaten lending — it has
declined to lend, and the benchmark refuses a configuration whose unlent floors
cover the whole guarantee for exactly that reason.

**No configuration here reclaims upstream tokens.** Nothing in this stack can
make a provider forget an in-flight request. Tyr sends an abort signal and
reports the outcome as `unverified`; `unlent_floor` withholds a slice *before*
lending, which is strictly weaker than reclamation. Every summary carries
`upstreamReclamation: "not-claimed"`, and the analysis raises rather than
summarizing a response that claims otherwise.

One further finding worth knowing before reading a deadline result: the
abandonment has two client-visible shapes. Tyr can only write its clean
`504 borrowed_admission_deadline` while it still owns the response; once a stream
has begun it destroys the connection instead. On this benchmark's canonical
streaming workload the caller therefore usually gets a truncated body with no
error at all, so the summary reports `byOutcome` and `silentTruncationRate`
rather than one total.

That last point is measured, not predicted. On a single-seed run against the
licensed stack, Tyr released 26 borrowed slots to the deadline and all 26
reached the caller as destroyed streams — `silentTruncationRate` 1.0, not one
clean `504`. Against the same trace the deadline arm completed 40 of 89 premium
requests where the otherwise-identical unlent arm completed 58. The bounded
restoration is real, and so is its bill.

**No multi-seed ladder result is published yet.** 0.31.0 ships the arms, the
analysis, and the end-to-end evidence above that the mechanisms behave as
described — not a statistical claim about what they are worth. One seed at one
duration is a mechanism check. Treat `--restoration-ladder` as a measurement you
can now take, not one already taken.

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
npm run demo:handoff           # five-seed exact handoff proof
npm run demo:hetero:adaptive   # mixed-size, all-arm headroom-aware adaptive policy
npm run demo:hetero:headroom   # compatibility alias for the same headroom-aware workload
npm run demo:headroom:compare  # paired 28/4 policy comparison
```

`demo:handoff` is the shortest release-level proof for the current Latchflo 0.15.0 /
Tyr 0.30.0 physical-capacity handoff: five lognormal seeds, the exact classic `adaptive-28-4` profile,
and the full adaptive safety gate without spending time on the extra control
arms. Demand-aware runs use a 120-second steady-state grant TTL and do not start
load until the fleet has at least 55 seconds of grant runway remaining for the
default 45-second phase. The acknowledged drain + fresh occupancy + commit path therefore has ample
time to complete by attrition. Before every restrictive drain is ACKed, the
predecessor lease remains authoritative; after that ACK barrier, Latchflo 0.15.0
uses the prepared successor-grant expiry as the safety deadline. Natural source
lease expiry after the ACK barrier no longer invalidates restoration. This
removes the old 11-second lease-cycle timing dependency without weakening the
no-double-allocation proof.
`demo:hetero:adaptive` uses the headroom-aware `adaptive-headroom-28-4` variant
with the same 28/4 protected entitlements and proof gate while adding all control arms.
Its summary carries a top-level `headroomPolicy` object with the exact configured
thresholds/caps and exercised-seed evidence. Conflicting envelope, concurrency, or
token settings are rejected. `demo:lending` remains the focused static-partition scene.

`--lending` widens the idle window from 35% to 60% of the phase so Tyr 0.30.0
can report an idle batch pool and Latchflo 0.15.0 can safely lend its protected
floor. The presenter creates a demand-aware capacity group with 28/4 protected
concurrency and 24,000/40,000-token guarantees, while both pools may borrow up
to the shared 32-slot/64,000-token envelope. The larger token envelope is
required because four current batch requests can reserve up to 39,768 tokens;
a 40,000-token group would make the four-slot floor nominal rather than usable.
The run is split at the configured batch arrival, not the observed first request, because an observed boundary
lands differently in each arm and makes the windows incomparable.

The reference is a dedicated local `static-partition` arm with per-replica
interactive caps of 7/7/7/7 and a four-slot batch cap. It cannot exceed 28
interactive requests before batch arrives. The MoFlux arm is judged with controller events, independently sampled Tyr
admission/capacity state, provider-dispatch timestamps, and client-visible
response timing:

| Question | Required evidence |
|---|---|
| Did interactive borrow? | Idle-window occupancy above 28 **and** a Latchflo `capacity_group.lending_observed` event |
| Did the floor come back? | A Latchflo 0.15.0 restoration handoff commits **and** a post-lending Tyr `/stats` sample shows the full 4-slot / 40,000-token batch floor applied |
| Was transfer ordered safely? | `handoff_prepared` → the **first** `applied` ACK for every unique drain grant → `handoff_committed`; later duplicate ACKs are diagnostic only |
| Did the commit actually precede batch admission? | Tyr 0.30.0 exact admission provenance is scoped to the causal restoration handoff: only admissions at or after that handoff's `handoff_prepared` event and belonging to its predecessor/successor grant lineage are considered. The first relevant batch admission must use a staged successor grant ID. A lineage-matched predecessor admission is a proved violation; unrelated or pre-handoff admissions are ignored; dropped/capture-failed provenance is inconclusive. |
| Did handoff stay within its safety authority? | Before drain ACKs, the predecessor lease is authoritative; after every restrictive drain is ACKed, commit must occur before the prepared successor-grant deadline |
| Was capacity ever double allocated? | 500 ms Tyr `/stats` samples never exceed the 32-slot / 64,000-token physical envelope |
| How long did each stage take? | Reliable demand timing when available, drain → first complete unique-ACK barrier → commit → first data-plane-restored sample. The sampled first-admission interval remains a latency diagnostic; exact grant provenance supplies the ordering proof. Client response headers and completion are reported separately. |

Configuration is not proof. A run-long 32/32 peak can occur under a static
28/4 split after batch starts, and occupancy without a matching controller
event can be a measurement artifact. The exact-proof gate introduced in MoFlux Bench 0.23.0 therefore fails the
adaptive proof if the restoration handoff is missing, the unique drain-ACK
barrier is unordered, the full concurrency **and token** floor is not observed
at Tyr after lending, exact Tyr provenance is incomplete, the first measured
batch admission is not proven to use a staged successor grant, the handoff
reaches its safety deadline, or applied-capacity sampling cannot prove that the
envelope was never double allocated. The older sampled admission interval is
retained for latency analysis but is no longer the safety-ordering authority. A
policy that borrows but never restores the batch guarantee is starvation, not
lending.

Version 0.21.0 corrects an important measurement error in earlier releases.
The load generator's first 2xx is **not** an admission timestamp: Tyr cannot
send those response headers until the provider has completed prefill and sent
its own headers. Client timing is therefore named `firstResponseHeadersAtMs`
and `responseHeadersGapMs`. MoFlux admission timing is reported as a bounded
interval using Tyr's sampled monotonic admitted counter and the provider's
model-scoped first request receipt. Seed aggregates expose
`batchFloorAdmissionGapMinMs` / `batchFloorAdmissionGapMaxMs` separately from
`batchFloorResponseHeadersGapMs`; completion remains
`batchFloorFirstSuccessGapMs`. The load generator also emits
`startedAtEpochMs`, allowing relative client timestamps to share the same
wall-clock timeline as Latchflo events.

Tyr 0.30.0 removes that ordering ambiguity for the safety gate. MoFlux Bench
0.23.0 establishes a per-replica admission-provenance sequence baseline before
load starts and retains each newly measured provenance event once. For a
restoration handoff, the benchmark first binds the proof to the handoff that
precedes the first data-plane-observed restoration of the protected batch
floor. It then reads that handoff's predecessor/successor grant lineage and
considers only lineage-matched admissions at or after `handoff_prepared`. This
prevents a later post-workload handoff from retroactively reclassifying earlier
valid batch admissions. The first relevant admission must name a staged
successor grant. `dropped` or `captureFailures` deltas make the proof
incomplete; they are never silently treated as success. The old 500 ms admitted
counter/provider-dispatch window remains in the result only as a timing bound.


Each run is written below `results/runs/<sweep>/<run-id>/`; the seed summary
aggregates borrowed slots, controller proof, the complete handoff timeline,
lease time avoided, sampled applied-capacity safety, bounded batch admission,
response-header/completion gaps, batch service, and an explicit adaptive
pass/fail record. Reviewed
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
npm run demo:hetero:adaptive    # lognormal sizes with headroom-aware adaptive 28/4 policy
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

Since 0.19.0, provider-sim readiness is taken from its own `server.listen()`
callback banner rather than from an HTTP client probe. The ladder repeatedly
stops and rebinds port 9000 between arms and rungs, so startup must not depend on
Node's fetch connection pool, HTTP parser, or proxy configuration. Tyr and
replica readiness still use their application-level `/healthz` checks.

A bound socket is not the same as owning the address the replicas will dial, so
the banner is followed by an identity probe: provider-sim publishes an instance
id in that banner and serves `service` and `instance` from `/admin/stats`, and
each arm confirms the two match over the same global fetch the load generator
uses. This catches a foreign process holding `127.0.0.1:9000` while the
simulator binds `0.0.0.0` (macOS allows both, and the specific bind wins
loopback), an HTTP proxy intercepting loopback, and a simulator left over from an
earlier arm — each before a measured phase is spent rather than after.

Each rung writes its own run directory under
`results/runs/video-seed-sweep/<ladder-id>-coord-<rung>ms/` and is read back from
it, so a rung is attributable to the sweep that produced it. Every arm records
the rung it ran at; only the Redis arm records having *paid* it. The ladder's own default capacity policy is the historical 31/1 profile. The
`demo:coordinator:adaptive` command explicitly selects classic
`adaptive-28-4` to isolate coordinator-distance behavior; it intentionally does
not inherit the heterogeneous benchmark's headroom-aware policy.

On Node 24, the arm proxy also treats caller disconnects from the response side.
After the request body has been consumed, `IncomingMessage.close` may represent a
normal completed request; only a `ServerResponse.close` before `writableEnded`
cancels the in-flight provider fetch. This keeps the four comparison arms on the
same forwarding path without turning successful admissions into transport errors.

### The prediction, and how it can fail

Per-request coordination should degrade roughly linearly with distance,
multiplied by attempts per request. Lease-based coordination should be flat.

`results/coordinator-ladder.json` reports, per arm, a linear fit of added
latency against coordinator distance **within each seed**, then aggregates
those slopes across seeds. Every seed replays a byte-identical trace at every
rung, so the seed is the natural unit of pairing and the slope is the effect
the pairing isolates.

Through 0.19.0 the report did something else: it fitted six cross-seed medians,
one per rung. On the 20260813T054929Z ladder the between-seed spread was
194-505ms against a 132ms effect, and the median landed on a different seed at
different rungs, so a single rank swap read as an outlier, r² collapsed to
0.0487, and every arm — Redis included — was reported as
coordinator-independent. That failure is asymmetric and worth stating plainly:
under an r² gate, noise confirms flatness for an arm predicted to be flat and
refutes degradation for an arm predicted to degrade, so an unpaired fit over
noisy medians can only ever report "no coordination cost", whichever way the
data points. The unpaired figures are still published as
`unpairedCoordinatorIndependent` for continuity, and are not the verdict.

Four verdicts are possible per arm, and **"insensitive" is not the default**:

| verdict | meaning |
| --- | --- |
| `degrades` | 95% interval excludes zero from above, or the exact two-sided sign test establishes a positive direction at p < 0.05 |
| `improves` | 95% interval excludes zero from below, or the exact two-sided sign test establishes a negative direction at p < 0.05 |
| `insensitive` | interval lies wholly inside ±0.1 ms/ms — an effect worth caring about is positively ruled out. Tested **before** the interval's sign, so a negligible-but-measurable slope reads as negligible rather than directional |
| `inconclusive` | interval contains both zero and a real effect |

`inconclusive` is a normal outcome at five seeds. It is not evidence of
flatness and must not be published as any. `resolutionMsPerMs` reports the
smallest slope the ladder could have ruled out, so a reader can tell
"measured as flat" from "could not tell" without reading this file.

Direction is counted both ways. A slope of exactly zero is neither degrading
nor improving, so `seedsDegrading`, `seedsImproving` and `seedsTied` are all
published and the sign test runs over the seeds that actually moved — five
rising and three tied is a test on five, not on eight. Testing direction as
"not the other side" would read eight motionless seeds as eight seeds agreeing
on improvement, and at six seeds or more that clears the sign test.

`verdictBasis` names the rule that fired, because the two rules are not equally
strong. An interval excluding zero is the better evidence. Unanimous direction
across five seeds is a sign test at two-sided p = 0.0625 — the most extreme
result five seeds can produce, and still short of 0.05 — so **five unanimous
seeds remain `inconclusive` when the interval also spans zero**. Six unanimous
seeds reach 0.031 and eight reach 0.008. The report also publishes a
`directionalP` for the pre-specified positive-slope t test, but that diagnostic
does not override the two-sided verdict threshold.

The ladder also records admission-decision cost directly for both Redis and
MoFlux. Redis exports per-outcome decision sum/count metrics around its atomic
Lua reserve; MoFlux reads Tyr 0.30.0's per-outcome decision histogram
`_sum`/`_count` deltas. Paired sensitivity therefore fits admitted and rejected
decision cost separately against coordinator distance rather than pooling
outcomes. Redis's slope measures the coordinator round-trip dependency; MoFlux's
slope tests whether its local synchronous decision work remains independent of
that distance. TTFT remains the user-visible consequence, with provider
latency, retries and queueing left visible rather than mistaken for decision
cost.

The crossover is reported only when it is **observed and stable inside the
tested ladder**. A paired crossing requires a majority of *seeds* to change
hands, be confirmed at at least one subsequent larger rung, and keep that
majority through every larger tested rung. A one-rung majority flip — including
a lead that appears only at the final rung — is retained as
`transientMajorityLeadRungsMs`, not promoted to a crossover. This prevents the
old "first sign flip wins" behavior from calling a noisy 1ms lead a crossing
when the arm falls behind again at 5, 15 or 30ms, or calling an unconfirmed
50ms endpoint a stable crossing. If the two arms never establish a persistent
lead, the report says so and gives the narrowest median deficit rather than
extrapolating beyond the tested range.

Sizing note: each rung is a complete paired sweep, so the cost is
rungs × seeds × arms runs — the six-rung, five-seed ladder above took just over
two hours. Start with two or three rungs before committing to the full ladder.

```bash
npm run demo:coordinator:reanalyze -- --reanalyze=20260813T054929Z
```

Re-reads an existing ladder's per-rung run directories and rebuilds the report
from them, running nothing. A change to the analysis must not require re-paying
for the measurement; every per-seed arm summary the analysis reads is already
on disk, named by the sweep that wrote it. A ladder that died partway is re-read
on the rungs that completed, with the missing ones named and the partial fit
declared; fewer than two rungs is refused outright.

To continue an interrupted ladder instead of only analysing it, pass
`--resume=<ladder-id>` with the same rung, seed, profile and order arguments.
Completed rung summaries are validated before reuse; missing rungs run normally.
For example, the adaptive ladder can resume with:

```bash
npm run demo:coordinator:adaptive -- --resume=20260813T201610Z
```

### What the admission-decision measurement covers

The admission-cost measurement introduced in MoFlux Bench 0.27.0 measures both sides directly. Redis times its atomic Lua
reserve round trip, which grants or refuses immediately and therefore has no
separate queue-wait component. Tyr 0.30.0 exports
`tyr_admission_decision_seconds` and `tyr_admission_queue_wait_seconds`; the
benchmark reads histogram `_sum` / `_count` values before and after each run so
startup traffic cannot enter the result.

The comparison is intentionally **per outcome**. `admitted` and `rejected` get
separate decision means because Redis and MoFlux can reject at different rates
for different reasons; pooling them would compare different mixtures. Tyr's
`decisionDuration` is synchronous local admission work and explicitly excludes
the awaited concurrency queue. Queue wait is retained as a separate diagnostic
and is never added to the MoFlux decision-cost headline.

For every Tyr pool/outcome/admission-class series, the benchmark requires the
decision histogram count, queue-wait histogram count, and
`tyr_admission_decisions_total` count to agree after baseline subtraction. Tyr
0.30.0 with an absent metric or zero total decisions is a hard error: lost
instrumentation must never become a reported zero. Historical pre-0.27.0 runs
remain `not-instrumented`. The Redis arm likewise checks its per-outcome timing
counts against its admitted and local-rejected counters.

The MoFlux result also records a diagnostic four-`hrtime.bigint()` clock
overhead measurement alongside the decision number. It is not subtracted from
the measured decision duration; the reported value therefore remains
conservative. The benchmark asserts the managed arm is actually running
`admissionMode: enforce` from Tyr `/stats` before collecting any timing claim.

The report framing is explicit: **Redis's atomic reserve round trip is its total
decision cost; MoFlux's decision duration is local synchronous Tyr/ABL work and
excludes queue wait.** No quantile interpolation is used for the headline.

### Rung order is a variable

```bash
npm run demo:coordinator:adaptive          # 0/5/20/50ms x 8 seeds, adaptive-28-4
npm run demo:coordinator:adaptive:strict   # same ladder + full adaptive outcome gate
```

`--rung-order` is `ascending` by default, which is fully confounded: the largest rung is always measured last,
so drift over the ladder's several hours — thermal, background load, a warming
cache — is collinear with coordinator distance and cannot be separated from it
afterwards. `rungOrderConfounding` in the report is the Spearman correlation
between rung magnitude and run position; ascending scores 1.

`--rung-order=alternating` runs smallest, largest, next smallest, next largest,
which drops that to 0.26 for a six-rung ladder while staying deterministic, so
the ladder is still reproducible from its arguments. `given` uses the order
passed to `--rungs`.

This is not hypothetical. On the 20260813T054929Z ladder the 1ms rung, run
second, sits above both its 0ms and 5ms neighbours in **every arm** — including
baseline and static-cap, which never receive the coordinator flag at all. A
rung effect appearing in arms not under the manipulation is host state rather
than coordination cost, and ascending order gives no way to tell them apart
after the fact.

The adaptive ladder is useful as a **secondary realism run**, not as a
replacement for the historical 31/1 ladder. It puts MoFlux under the current
28/4 demand-aware policy used by the adaptive benchmark, which makes the result
easier to compare with current product evidence. It also introduces real
lending and handoff dynamics that are unrelated to coordinator distance and can
add variance, so the simpler historical ladder remains the cleaner isolation of
the coordinator-path effect.

The adaptive ladder spends its budget differently on purpose: **seeds are the
replicate, rungs are not.** The interval is taken over per-seed slopes, so its
width is governed by seed count; rungs buy within-seed precision the interval
cannot report. At the measured cost of roughly four minutes per seed per rung,
six rungs by five seeds and four rungs by eight seeds cost about the same two
hours.

The normal adaptive ladder does **not** require the full
`--require-adaptive-proof` gate. That gate asserts batch-floor restoration,
handoff commit, batch completions and other policy outcomes that are important
for the heterogeneous adaptive benchmark, but orthogonal to the ladder's coordinator-latency
question. Conditioning each rung on those outcomes can censor an otherwise
valid measurement and bias the fitted sample. Every rung still records its
`adaptiveProof` status and failures in `coordinator-ladder.json`. Use
`demo:coordinator:adaptive:strict` only when the intended experiment really is
"coordinator sensitivity among runs that also pass the complete adaptive
acceptance gate."

### An arm that measured nothing is not a result

Every other assertion on an arm checks that the right workload was *offered*:
the trace hash matches, the logical request counts match, the generator never
saturated. None of them checks that the workload produced an *outcome*. An arm
whose replicas are healthy but whose upstream is not the provider simulator
satisfies all three while reporting:

```
success 0.0%   goodput 0.00 req/s   p50 0.00s   local rejects 0
upstream 429 0   peak active ?/32   interactive retries 4.00x
```

Percentiles read `0.00s` because there are no successful samples, and retry
amplification pins to `--max-attempts` because every attempt failed. Aggregated
across seeds it becomes a published median.

The load generator already separates outcomes a policy decided (`success`,
`localReject`, `upstreamReject`) from outcomes nobody decided (`transportError`,
`serverError`). `demo/arm-health-lib.mjs` gates on that split: an arm with no
successes **and** no admission decisions is refused, as is one whose
unattributable failures exceed 1% of attempts. All 42 committed arm summaries
under `results/` carry zero of either, so that tolerance is headroom rather than
an allowance the published numbers depend on. A policy that legitimately refuses
every request, or a provider that 429s throughout, is a result and still passes.

## Metrics that matter

The one that carries the argument is the **reject split**. A local reject costs
nothing. An upstream 429 was earned only after provider capacity had already
been spent on the request. Both look like a 429 to the caller; they are not the
same event, and the harness counts them separately.

Since 0.22.0, every local rejection is also preserved as a full admission-time
evidence record in `classes.<class>.localRejectSnapshots`. The record is keyed
back to the immutable trace request and includes the target replica, attempt,
rejection timestamp, Tyr pool/reason/type, admission class and revision, retry
hint, Latchflo grant provenance, and Tyr's complete `error.detail` object. That
object carries the global concurrency state, token-budget state, shared
capacity, class-protected/borrowed capacity, and the capacity constraint that
bound the decision. It is intentionally retained as an object rather than
flattened so new Tyr detail fields survive without a benchmark release.

For compact analysis, local rejects remain aggregated by pool and exact reason
with the observed `requested`, `available`, and `budget` token ranges.
`localRejectConstraints` additionally counts `global`, `admission_class`,
`admission_class_protection`, and `unspecified` decisions, and Prometheus exports
those counts as `bench_local_reject_constraint_total`. Seed preservation requires
`localRejectSnapshots.length === localReject`, so missing rejection evidence
invalidates the run instead of disappearing from the result.

A snapshot looks like this (values are illustrative):

```json
{
  "requestId": "batch-17",
  "requestClass": "batch",
  "attempt": 1,
  "rejectedAtMs": 18432.1,
  "target": "http://127.0.0.1:8104",
  "type": "admission_rejected",
  "pool": "sim-batch",
  "reason": "budget_limit",
  "admissionClass": "batch",
  "admissionRevision": 17,
  "retryAfterMs": 1250,
  "grant": { "id": "...", "controllerEpoch": 3 },
  "detail": {
    "limitRevision": 17,
    "constraint": "admission_class_protection",
    "inFlight": 4,
    "maxConcurrent": 8,
    "pending": 0,
    "maxQueue": 0,
    "tokenBudget": { "budget": 2500, "inFlightTokens": 2500, "effectiveBudget": 2500, "available": 0, "requested": 9008 },
    "sharedCapacity": { "concurrency": { "capacity": 4, "inUse": 4, "available": 0, "requestedBorrowed": 1 } },
    "admissionClass": { "id": "batch", "inFlight": 1, "protectedConcurrent": 1, "borrowedConcurrent": 0 }
  }
}
```

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
- **Adaptive capacity-floor restoration is acknowledged and non-preemptive.**
  Tyr 0.30.0 reports bounded per-class demand plus ordered class occupancy
  evidence. Latchflo 0.15.0 transfers physical handoff safety authority to the
  restrictive successor grants after every drain ACK, so natural expiry of the
  predecessor lease no longer aborts an otherwise safe restoration. Running
  borrowers are never revoked; the lower shared authority drains by attrition,
  Tyr acknowledges the shrink, and Latchflo commits only after fresh occupancy
  proves the transfer safe. Prepared-successor expiry remains the conservative
  fallback after ACK; before ACK, the predecessor lease remains authoritative.
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
demo/tenant-fairness.mjs authenticated admission-class arms and the restoration ladder
demo/local-inference.mjs unmetered self-hosted benchmark against a local Ollama server
demo/local-inference-lib.mjs locality guard, Ollama request body, per-arm aggregation
demo/local-contention.mjs unmetered workload-isolation benchmark under local contention
demo/local-contention-lib.mjs arm partitions, capacity invariants, localContentionProof
demo/LOCAL-CONTENTION.md contention benchmark: arms, phases, acceptance, claim boundary
demo/ollama/          local inference stacks: compatibility, and contention with Latchflo
demo/openai/          live OpenAI stacks for the compatibility and overload paths
demo/restoration-contract-lib.mjs Latchflo 0.15.0 per-resource restoration contracts
demo/restoration-enforceability-lib.mjs what a restoration mechanism guarantees, and its bill
demo/version-lib.mjs   shared runtime capability gating
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
