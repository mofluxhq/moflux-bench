# MoFlux Bench verification

## 0.46.0 two-slot interactive reserve profile

`demo/verify-vllm-contention.mjs` requires the following of
`unlent-concurrency-2`:
- both default policies remain `unlent-concurrency-1` with a one-slot reserve,
  and the default Metal profile returns the published policy object;
- the new policy differs from the published Metal policy only in its profile
  name and its interactive reserve of 2;
- the lending pool sends `globalUnlentProtectedConcurrent: 2`, and the batch
  class and static pool are identical to the published ones;
- the profile runs only with `metal-long-context-v1`, writes to
  `vllm-metal-long-context-unlent-concurrency-2`, and an unknown name, including
  an inherited property name, is refused;
- the existing two-slot-lend fixture passes under the published profile but
  counts two reserve breaches under this one. A one-slot lend still counts as
  lending, restores in 2s and does not breach;
- a long-context seed proof passes with two withheld slots on Latchflo's gauges,
  fails only `allocatorUnlentReserve` with one, and fails only
  `nativeUnlentFloor` with the two-slot-lend samples;
- the published profile's reserve gates keep their exact thresholds and wording,
  and the hypothesis thresholds are unchanged.

A dry-run subprocess plans `results/runs/vllm-metal-long-context-unlent-concurrency-2/`
with a reserve of 2, and the runner refuses the profile on the default Metal
workload. `demo/verify-evidence-paths.mjs` requires the new corpus to be
protected.

All 50 modules in `npm run verify` passed, and the syntax check passed for all
113 JavaScript modules. `npm run verify:publication` reported only local files
that are never published: `.DS_Store` files, `demo/moflux/.env` and
git-ignored run output under `results/runs/`. No sweep has been run with this
profile, and no Latchflo instance has yet been sent the two-slot reserve.

## 0.45.1 reporting corrections

The saved five-seed `20260925T001105Z` long-context run was reanalyzed offline.
All validity and hypothesis gates still pass with their original thresholds.
Across five seeds, static and MoFlux each completed 12 batch requests during
25–60s, while eventual completions of requests arriving during that interval
were 15 and 23 respectively. Overall batch completions remain 21 and 29.
The separate reporting-v2 summary preserves original runtime metadata and
records SHA-256 hashes of the source summary and all 40 raw input files.

Reporting regression tests cover arrival versus completion boundaries, late
completions, missing timestamps, missing queue gauges, a queue forming after
an initial zero, and engine/admission samples aligned to observed demand and
restoration with explicit sampling lag. The reanalysis refuses to overwrite
existing files and verifies raw arm/seed/trace identity and cohort totals.
No new inference was run; engine gauges still cannot identify per-class KV
residency or interactive waiting after restoration.


## 0.45.0 long-context KV pressure on vLLM Metal

A probe on an M1 with 16 GB (vLLM and vllm-metal 0.29.0, Qwen2.5-1.5B) confirmed
the mechanism before the workload was fixed. vLLM Metal allocated 1,933 blocks
from the 0.4 memory setting. vLLM core logged `Overriding num_gpu_blocks=1933
with num_gpu_blocks_override=320`, and `vllm:cache_config_info` reported
`block_size="16"` and `num_gpu_blocks="320"`. Under priority scheduling, three
7,100-character batch requests (1,607 prompt tokens, 64 output tokens) and ten
interactive requests arriving every two seconds drove KV usage to 100%. The
engine queued up to two requests and preempted one. Interactive TTFT was
1.2-3.3s against 0.35s alone, and all ten met the 5s TTFT and 30s latency SLO.
A first probe with 12,000-character prompts took 28s per request alone and up
to 95s with four concurrent, too slow for the 105s trace.

`demo/verify-vllm-contention.mjs` requires the following of the new workload:
- the default Metal workload is unchanged, and its interactive settings are
  identical to `metal-balanced-v1`;
- it runs only on Metal and writes to its own corpus;
- the pinned pool holds a 4,096-token request and three batch requests but not
  four;
- four Tyr batch reservations fit the batch token floor;
- seeds 1-5 each place at least three batch arrivals in the 20s before demand
  returns.

It parses `vllm:cache_config_info` and the demand-return snapshot. It requires
the long-context seed proof to pass with a pinned, filled pool, and to fail
`kvPoolPinned` on an unpinned or missing pool and `kvPressureExercised` below
0.9. It also requires that a `metal-balanced-v1` result cannot pass as a
long-context one. `demo/verify-evidence-paths.mjs` requires
`results/vllm-metal-long-context` to be protected. `node
demo/vllm-contention.mjs --backend=metal --workload=metal-long-context-v1
--dry-run` plans a 320-block pool and `results/runs/vllm-metal-long-context/`.
It refuses the workload on NVIDIA and refuses an unknown profile.

All 50 modules in `npm run verify` passed. The suite run stopped at
`demo/verify-presenter.mjs`, which needs 127.0.0.1:18080, while a Docker demo
stack held that port. The 34 modules before it passed in that run. The
presenter test and the 15 modules after it passed individually once the port
was free. Syntax checks passed for all 110 JavaScript modules.
`npm run verify:publication` reported only local files that are never
published. At release preparation, no sweep had been run with `metal-long-context-v1`.

## 0.44.0 one-slot headroom profile

`demo/verify-adaptive-profile.mjs` requires the presenter to accept
`adaptive-headroom-28-4-lend1` and to list it in the unknown-profile error. It
must refuse `--headroom-max-demanding-concurrent-lend=2` on that profile, and
refuse `=1` on `adaptive-headroom-28-4`. `demo/verify-seed-sweep.mjs` requires
the sweep's adaptive-proof policy check to match the one-slot profile with a cap
of 1 and to reject the same name carrying a cap of 2.
`demo/verify-headroom-compare.mjs` requires the comparison to record the one-slot
profile by name, count one concurrency-funded lend, and refuse a non-headroom
profile. `npm run verify:publication` requires `adaptive-headroom-28-4` to keep
its published 4/4000/3000/2/10000 headroom policy.

All 50 modules in `npm run verify` passed. The suite run stopped at
`demo/verify-presenter.mjs`, whose Latchflo test double needs 127.0.0.1:18080,
while the Docker demo stack held that port. The 34 modules before it passed in
that run, and the 15 after it passed individually. `demo/verify-presenter.mjs`
passed in its own run once the port was free. Syntax checks passed for all 110
JavaScript modules. `npm run verify:publication` reported only local
files that are never published. No sweep or headroom comparison has been run on
the one-slot profile; its expected p95 effect is a contention-model prediction.

## 0.43.0 Latchflo runtime upgrade

Runtime pins target Latchflo 0.19.0. Environment migration from 0.18.0,
seed-sweep rejection of mixed 0.18.0/0.19.0 runtimes, and syntax checks pass.
Publication hygiene passes on a clean tracked-file copy. The live repository
contains local environment and generated run artifacts excluded from that check.
No benchmark run or container validation of this release has been performed.

## 0.42.0 whole-run percentiles

`load/verify-summary-percentiles.mjs` replays eight interactive requests. The
first four are held for 400 ms and the last four answer immediately. It scrapes
`/metrics` after the slow ones have left a 200 ms window, both with and without
`--emit-phase-samples`. The summary must declare `percentileScope: "run"`, keep
p95 latency and TTFT at or above 400 ms, and match the nearest-rank percentiles
of `phaseSamples` exactly. Against the 0.41.1 `load/loadgen.mjs`, 8 of 14 checks
fail. The summary had no scope and reported p95 latency of 10.9 ms and 4.1 ms,
where the samples give 424.6 ms. `demo/verify-seed-sweep.mjs` requires sweep
`schemaVersion` 10 and a recorded scope, and rejects arms that mix scopes.
`demo/verify-arm-health.mjs` requires the coordinator ladder's rung and resume
guards.

Every module in `npm run verify` passed (50 checks), including
`demo/verify-presenter.mjs`, along with syntax checks for all 110 JavaScript
modules. `npm run verify:publication` reported only local files that are never
published: unpublished run output under `results/runs/`, `.DS_Store` files and
`demo/moflux/.env`. No sweep has been run on 0.42.0. The motivating 0.41.1
blind adaptive sweep, `20260924T172752Z`, recomputed from its `phaseSamples`,
gives a median interactive p95 of 10.9 s for baseline and 10.7 s for MoFlux, a
-5.1% paired change. Its summary reports -17.9%. Saved results are unchanged
and keep the rolling basis.

## 0.41.1 per-request samples

`demo/verify-loadgen-args.mjs` requires `loadgenArgs` to forward
`--emit-phase-samples=`, both sides to default it to false, and the option to
stay out of the scenario and trace. Run against the 0.41.0 `demo/present.mjs`,
the forwarding and defaults checks fail. Every module in `npm run verify`
passed. That includes `demo/verify-presenter.mjs`, which 0.41.0 could not run:
the presenter records the Tyr 0.33.0/Latchflo 0.19.0 runtime and completes its
full comparison with the option forwarded at its default. No run with the option
enabled has been made; the generator's own emission is the path the local
contention benchmark already uses.

## 0.41.0 runtime alignment

`npm run verify:publication` requires the Tyr 0.33.0 and Latchflo 0.19.0 image
tags in `demo/moflux/.env.example` and Tyr 0.33.0 metadata in every
`demo/moflux` and `demo/classes` replica config. It also requires
`VLLM_TYR_VERSION = "0.33.0"` and `VLLM_LATCHFLO_VERSION = "0.19.0"`.
`demo/verify-env.mjs` proves that a generated `.env` pinned to Tyr 0.31.0/Latchflo
0.17.1 migrates its image tags and compatibility line, keeps its tokens and
routing secret, and is unchanged by a second pass. `demo/verify-topology.mjs`
and `demo/verify-tenant-fairness.mjs` require the new replica metadata.
`node demo/vllm-contention.mjs --backend=metal --dry-run` plans
`tyr-admission-controller:0.33.0` and `latchflo-control-plane:0.19.0`.

Every other module in `npm run verify` passed, along with syntax checks for all
109 JavaScript modules. `demo/verify-presenter.mjs` was updated to require the
new runtime but was not run for this release: its telemetry-relay test double
needs 127.0.0.1:8200, which a running local demo stack held. No image was built
and no live sweep was run. Saved results remain unchanged.

## 0.40.1 handoff and headroom evidence

The retained seed 2 fixture from sweep `20260923T184716Z` also covers a batch
drain successor (revision 571) of the committed expansion (revision 561).
Both handoff selection and admission proof follow that restrictive lineage.
Regressions reject larger limits, owner/pool changes, missing or cyclic ancestry,
duplicate definitions, missing commits, and admissions before preparation.
Offline proof reanalysis of the five retained seeds passes all five, without
changing the recorded run or executing a new workload.

`demo/verify-lending.mjs` reproduces two handoffs within one sampling interval
using synthetic controller history. It verifies that restoration proof follows
the observed batch grant's issuing handoff, and that a restrictive lender
successor preserves the original headroom transfer's proof. Missing or ambiguous
origins, unrelated grants, expanding successors, and future grants remain
unproven; actual predecessor admissions still fail.

The lending, admission-provenance, adaptive-profile, seed-sweep,
headroom-comparison, restoration-enforceability, and adaptive-seed-sweep checks
passed, along with syntax checks for all 109 JavaScript modules. The new
regression fails against the previous implementation. The historical seed 4
controller history was not retained, so its original commit cannot be verified
retroactively. Saved results remain unchanged; no live sweep was rerun.

## 0.40.0 runtime alignment

`npm run verify:publication` requires the Tyr 0.31.0 and Latchflo 0.17.1 image
tags in `demo/moflux/.env.example` and Tyr 0.31.0 metadata in every
`demo/moflux` and `demo/classes` replica config. `demo/verify-env.mjs` proves a
generated `.env` pinned to Tyr 0.30.0/Latchflo 0.16.0 migrates its image tags
and compatibility line, keeps its tokens and routing secret, and is unchanged by
a second pass. `demo/verify-presenter.mjs` requires a presenter result to record
the new runtime. `demo/verify-seed-sweep.mjs` checks that a sweep summary
records the MoFlux runtime and rejects a seed that ran another Latchflo release.

The ladder guard was exercised against synthetic ladders in a scratch copy of
`demo/`. Rungs on one runtime were fitted and the runtime was reported. A rung on
a different runtime was refused. So was resuming a ladder recorded on Tyr
0.30.0/Latchflo 0.16.0, before any sweep started.

## 0.39.0 Metal memory headroom

`npm run verify:vllm` pins the per-backend memory defaults (NVIDIA 0.85, Metal
0.4). It shows that the runtime gate accepts an explicitly declared override
and rejects an observed value that differs from the declared one. It also proves
that `hostMemoryHeadroom` fails a Metal seed when any single arm:
- swaps out 6,000 MiB;
- records one `critical` pressure sample;
- has no pressure evidence;
- has a pressure-sampling error.

255.9 MiB of swap-out is tolerated, and a healthy seed still passes every gate.
`node demo/vllm-contention.mjs --dry-run` shows 0.4 for Metal and 0.85 for
NVIDIA, and it rejects values outside 0.05–0.95. `npm run verify:publication`
requires the gate, the defaults, and the 256 MiB limit.

## 0.38.0 upstream-failure and host-pressure diagnostics

`npm run verify:vllm` checks the host-pressure parsers against `vm_stat`,
`sysctl` and `pmset -g therm` output recorded on the Apple M1 development host:
- page size, gauges and cumulative counters;
- pressure-level mapping;
- swap usage;
- the quiet and warned thermal forms.

The per-arm summary must report 6,400 swapped-out 16 KiB pages as 100 MiB and
count pressure levels and thermal-warning samples. It must keep sampling errors
without failing. The same verifier requires `noEngineOrTransportErrors` evidence
to carry `serverErrorCauses`. `demo/verify-local-contention.mjs` checks the cause
key for a Tyr 0.30.0 body, a Tyr 0.31.0 body with `cause.code`, and a
non-JSON 503. `npm run verify:publication` requires the Tyr 0.31.0 and
Latchflo 0.17.1 pins. The parsers were also run against this host's live
commands.

## 0.37.1 Latchflo pin

`npm run verify:publication` requires `VLLM_LATCHFLO_VERSION = "0.17.1"`.
`node demo/vllm-contention.mjs --dry-run` prints the pinned
`latchflo-control-plane:0.17.1` image. It exits non-zero for any other release
unless `MOFLUX_ALLOW_UNPINNED_IMAGES=true`. Latchflo 0.17.1's own suite covers
the lending fix:
- unit tests for immediate lending and for lending that becomes due by elapsed
  idle time;
- a packaged Tyr 0.25.0 test that fails if Tyr ever installs a zero-capacity
  revision while a floor is lent.

## 0.37.0 vLLM experiment verification

`npm run verify:vllm` is a GPU-free fixture check. It verifies the four-arm
matrix, 3/1 protected policy, native one-slot unlent reserve, counterbalanced
order, the bounded `metal-balanced-v1` traces for all five publication seeds,
backend-specific fixed-token proof, Prometheus parsing and histogram deltas,
required vLLM metric set,
`nvidia-smi` parsing, Apple process-tree CPU/RSS parsing, separate
grant/occupancy restoration timing, three-state proof result, CUDA and Metal
Compose topology, and the load generator's actual authenticated OpenAI request
for priority plus fixed output length without leaking the provider key. It also
proves that CUDA includes `min_tokens`, Metal omits the unsupported field, and
both unexpected HTTP 422 responses and structured errors inside an HTTP 200 SSE
stream remain failed requests with bounded diagnostics. A dash-prefixed API-key
fixture also proves the Metal server receives `--api-key=<value>` as one argv
token instead of an option followed by an ambiguously option-shaped value.
It pins the shared 65,536-token envelope for CUDA and Metal, fully reserved by
the 49,152/16,384-token protected floors, the dynamic 12,288-token
unlent-floor gate, compact rejection/token-state diagnostics, fresh
authenticated metrics connection, asynchronous Metal process sampling, and
support for both `HF_TOKEN` and its legacy alias. It also proves that
`managedGrantContinuity` fails a seed whose static arm refused work under Tyr's
even fail-closed revision, without counting those refusals as token pressure.

Zero-envelope classification is verified at three layers:
- `load/verify-trace.mjs` drives the real load generator over HTTP. Half the
  refusals carry Tyr's zero-envelope `budget_limit` detail. `budgetLimited`,
  `grantUnavailable`, the split detail aggregates, and the snapshot flags must
  each count only their own kind.
- `demo/verify-local-contention.mjs` checks the shared summarizer against a
  refusal in Tyr's exact zero-envelope form, beside a real concurrency refusal.
- `demo/verify-vllm-contention.mjs` checks the proof gate.

`npm run demo:vllm:dry-run` must print the full plan and create no directory.
`npm run demo:vllm:doctor` checks Docker, the rendered Compose configuration,
OpenSSL and access to the selected GPU without issuing inference. The real
five-seed run is intentionally not part of CI: it requires an NVIDIA runtime,
model weights, and the licensed Tyr/Latchflo images.

`npm run demo:vllm:metal:dry-run` is portable and creates nothing.
`npm run demo:vllm:metal:doctor` additionally requires Apple Silicon, macOS 15+,
native vLLM/vllm-metal, and Docker Desktop. The Metal proof substitutes required
host-process telemetry and pinned Mac/plugin identity for NVIDIA device gates;
it does not weaken the required vLLM metric or queueing gates. The doctor reads
`vllm serve --help=all` because current vLLM's plain grouped help omits engine
options. It also extracts a uniquely marked runtime-identity record so vLLM
import logs cannot corrupt JSON parsing. The GPU-free fixture pins both
preflight behaviours, including a synthetic leading `INFO` line. Doctor is a
prerequisite/capability check and intentionally issues no inference request;
the excluded warm-up is the first live request-shape check.

The Metal defaults deliberately reduce evidence pressure on unified-memory
hosts: one-second vLLM/Tyr sampling and asynchronous five-second process-tree
sampling, with longer bounded timeouts. A single scrape or process-sample error
still makes the seed inconclusive; the fix changes collection pacing, not the
integrity gate.

Publication verification requires all vLLM source/config/documentation files,
the pinned `vllm/vllm-openai:v0.18.0` example value, immutable-revision capture,
safe-run-directory guards, and the explicit evidence-limit block. Reviewed
vLLM paths are registered in the same central guard used by the runtime. This
overlay contains no `results/runs/` output and no reviewed CUDA or Metal JSON.

The experiment's validity gate requires all documented vLLM metrics, positive
measured TTFT/end-to-end histogram populations, exact fixed completion-token
totals, prompt-token usage for every success, GPU/process telemetry, an observed
waiting queue, identical trace hashes and runtime identity, correct scheduler
selection, positive SLO goodput in at least one direct arm, generator headroom,
and zero engine, request-protocol or transport faults. A valid negative
hypothesis is `fail`; missing evidence is
`inconclusive`. Neither is rewritten as a passing result.

Verified 2026-09-22 in this build environment with Node.js 24.19.0 and npm
11.9.0: syntax, publication hygiene, all 48 GPU-free checks, and the simulator
sweep passed. A live Metal run is deliberately not claimed from this Linux
environment; validating `metal-balanced-v1` still requires a fresh Apple-
Silicon development seed and then the five counterbalanced publication seeds.

MoFlux Bench 0.33.0 introduced the local-inference contention benchmark in
`demo/local-contention.mjs`; 0.33.1 corrected phase/proof semantics from the
first real seed and 0.33.2 corrected an H4 attribution false positive. 0.34.0 is
an **instrumentation, benchmark-semantics and reliability** release. Its purpose
is to make `demo:local:contention` trustworthy enough to decide whether the
MoFlux restoration policy needs changing, not to change it.

The experiment is deliberately unchanged: same workload timing, same interactive
and batch RPS, same 3/1 protected concurrency, same token floors, same physical
concurrency of 4, same 15 s grant TTL and 15 s restoration SLO, same H1
(+0.04 req/s SLO goodput) and H2 (1.2x) thresholds, and the same five
publication seeds.

## What changed, and why each was a correctness problem

| Area | 0.33.2 behaviour | 0.34.0 |
| --- | --- | --- |
| Sweep credentials | one JWT minted per process with a one-hour expiry; a five-seed sweep runs longer | re-minted on access as expiry approaches, distinct `jti` per mint |
| Warm-up failures | `(last HTTP 401)` and nothing else | structured, publishable diagnostics; one forced-refresh retry, both attempts recorded |
| Demand return | detected from admissions and in-flight only | also from rejections and the controller's demand state |
| Restoration episodes | could report `restoredAtMs` with `demandReturnedAtMs` null and count neither | four disjoint outcomes; passive returns never counted as restorations |
| Restoration latency | grant-side only | grant-side **and** occupancy-side, both SLO-checked |
| Post-demand borrowing | measured against the *applied* floor | measured against the *nominal* partition, with a ratcheting entitlement |
| Empty distributions | `ttftP95Ms: 0` | `null`; counts and rates stay numeric |
| H4 | one combined gate | H4a transfer safety, H4b post-demand borrowing; `h4` retained as their conjunction |
| Failed loadgen | non-zero exit collapsed to `exit N` | bounded stdout/stderr tail in error + persisted per-arm `.loadgen.log`, with argv excluded |


The host-supervision regression also exercises persistent child diagnostics: both stdout and stderr survive to the log, while an intentionally secret argv value does not. `demo/verify-local-contention.mjs` pins the local-contention runner to emitting a `.loadgen.log`, carrying `childOutputTail(child)` in the error, and naming the persisted log path.

A follow-up real sweep exposed the first non-zero loadgen exit through this path: seed 3 direct hit the unchanged 300 s drain ceiling with one batch stream still active. The child diagnostic was preserved, but the wrapper then called `repoRelative(diagnosticsFile)` without `ROOT` and threw a secondary `ERR_INVALID_ARG_TYPE`. The unreleased 0.34.0 tree now passes `ROOT` explicitly and the verifier pins the call so the original loadgen failure and persisted log path remain visible.

## Root causes established from the 0.33.2 evidence

The 0.33.2 five-seed run was used as diagnostic input. It is not publication
evidence, it was not promoted, and no result from it is rewritten as a passing
0.34.0 result.

1. **The HTTP 401 was an expired benchmark credential, not a control-plane
   fault.** `startIdentityFixture` minted with `exp = iat + 3600` once, before
   seed 1. The run began at 04:51:46Z; seed 5's MoFlux warm-up ran at 05:56:19Z,
   64 minutes later. The `direct` arm ran first in seed 5's counterbalanced
   order and needs no credential, which is why the failure surfaced on the first
   managed arm of the last seed.
2. **The seed-4 violation at 29.896 s was a false positive.** Batch's applied
   protected floor was 0 because batch's own one-slot floor had been lent away
   while batch was idle, so its first request of the borrow phase reported
   `borrowedConcurrent: 0 -> 1` while occupying nothing but the single slot batch
   owns outright. The interactive floor was whole at 3 with 1 in use. The 0.33.2
   allowance for contemporaneously released non-interactive capacity missed it by
   one sample because Latchflo had already withdrawn batch's release before Tyr
   applied the restored floor.
3. **`restorationRequiredEpisodes = 0` was an artifact of the demand predicate.**
   In every seed the interactive class returned at 60 s to a pool whose four
   slots were all held by batch requests admitted before the lend, was refused on
   every attempt, and so was never admitted and never in flight. Measured by
   admissions it looked idle for the entire contention window.

Re-analysing the same 0.33.2 sample series with the 0.34.0 accounting yields one
restoration-required episode per seed, a grant-side restoration latency of
0–394 ms, and an occupancy-side latency of 15.5–41.7 s — every one of them a
breach of the 15 s objective. That is the finding the release exists to make
visible, and it is a finding about the policy rather than about the benchmark.

## Local contention benchmark contract

Three arms replay one deterministic five-phase trace:

| Arm | Path | Policy |
| --- | --- | --- |
| `direct` | client → Ollama | no MoFlux admission control |
| `static` | client → Tyr → Ollama | fixed per-class protected floors, never lent |
| `moflux` | client → Tyr → Ollama | the same floors, lent while idle and restored on demand |

The workload is warm-up plus four measured phases: interactive-only 0–25 s,
batch with interactive idle 25–60 s, overlapping contention 60–85 s, then
recovery/drain to 105 s. Phase membership uses immutable trace arrival time.

The benchmark owns its acceptance result; the top-level `passed` mirrors
`localContentionProof` and nothing else. Per-seed gates cover validity and
safety only. Across seeds: H1 (+0.04 req/s interactive contention-window SLO
goodput over direct, TTFT <= 5 s and latency <= 30 s), H2 (>= 1.2x static batch
borrow-window completions), H3 (protected floor never violated), H4a (no unsafe
capacity transfer) and H4b (no new borrowing after protected demand returns).
H1 and H2 are allowed to fail honestly and the fixtures exercise them failing.

## Evidence boundary

Every summary carries explicit `evidenceLimits`. This release adds no new claim.
It does not establish GPU preemption, GPU utilization, KV-cache reclamation,
Ollama scheduler preemption, upstream compute reclamation, production-scale
behaviour, or generalization beyond `qwen3:0.6b` on a CPU-only container. It
makes **no claim that restoration performance improved**; the new
occupancy-side measurement makes the existing non-preemptive cost visible for
the first time and reports it as a cost.

No reviewed local-contention artifact is created as a side effect of a run.
Baseline output lands beneath `results/runs/local-inference-contention/<run-id>/`;
the native one-slot-reserve follow-up lands beneath
`results/runs/local-inference-contention-unlent-concurrency/<run-id>/`. Each has
its own reviewed target and requires explicit promotion.

`npm run verify:local:contention:unlent` additionally proves that the follow-up
keeps physical capacity at four, protected floors at 3/1, and both class ceilings
at four. It requires the lending pool to carry
`globalUnlentProtectedConcurrent: 1` on interactive while the non-lending static
pool carries no such field. Synthetic capacity samples also prove that an
applied interactive floor below one is rejected by the benchmark safety gate.

## Locality and credential safety

The runner still accepts no direct, Tyr, or Ollama endpoint override flag, reads
no hosted-provider credential, and passes every arm endpoint plus the Ollama
upstream and control plane through the locality guard before the first request.
Warm-up diagnostics name credentials by a twelve-character SHA-256 fingerprint
and by issue/expiry time; bearer tokens are never written to a summary, and the
verifier asserts it.


## 0.36.0 native unlent-concurrency proof

The local one-slot-reserve experiment now runs against Latchflo 0.16.0 and uses
its native admission-class concurrency subfloor. The benchmark no longer caps
batch at three. Both classes keep their baseline maxConcurrent=4 ceilings, and
only the lending arm sends `globalUnlentProtectedConcurrent: 1` for interactive.
The control-plane policy therefore withholds one interactive slot from lending
while allowing the other two to enter shared capacity.

The runtime proof is deliberately independent of the configuration assertion.
`capacityInvariantViolations` checks each usable Tyr sample and fails if the
applied protected concurrency for a class falls below its configured native
unlent slice. The runner also scrapes Latchflo's native unlent-concurrency gauge
and requires allocator-side evidence on every native-unlent seed. The existing
token-unlent check remains separate evidence in the same gate. Lease-gap
samples are still excluded because no grant exists to violate during a gap.

## 0.35.0 direct-arm drain censoring

`load/verify-drain.mjs` now covers both hard-drain outcomes. The historical
default still exits non-zero when an endless stream reaches `--drain-max-ms`.
With `--drain-timeout-mode=censor`, the same origin must exit zero with a
`drain.outcome` of `censored`, preserve every survivor snapshot, leave those
logical requests unsuccessful, emit no synthetic latency sample for them, and
avoid reclassifying the deliberate abort as a transport failure.

`demo/verify-local-contention-unlent.mjs` also pins the runner wiring: only the
unmanaged arm selects censor mode, and a censored direct tail must force-
recreate Ollama before another arm can run. Managed-arm drain semantics are
unchanged.

## 0.35.0 higher-resolution H4 proof

`demo/verify-local-contention.mjs` now pins exact event ordering on both halves
of H4. For H4b, a synchronous pre-load Tyr `admission-provenance.v1` baseline
provides sequence windows and exact `admittedAt` timestamps. A sampler-observed
borrow increase is cleared only when every newly attributed batch admission is
proved to predate protected demand; an admission proved after demand remains a
hard violation, while incomplete or non-unique provenance fails
`borrowOrderingProofComplete`.

For H4a, Latchflo events are correlated by `handoffId`. The verifier requires
the prepare record, every drain grant named by that prepare, the first ACK for
each required drain grant, and commit ordering after the resulting ACK barrier.
Commit-before-ACK remains unsafe. If the bounded event history cannot establish
the predecessor records, `handoffProofComplete` fails instead of converting an
unknown ordering into either a pass or a fabricated safety violation. The local
contention runner requests Latchflo's 1000-event maximum and records whether the
window covers the measured arm.
