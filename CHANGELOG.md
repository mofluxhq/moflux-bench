# Changelog

## 0.20.0

- Analyse the coordinator ladder as the paired experiment it runs. Every seed
  replays a byte-identical trace at every rung, so the slope is now fitted
  within each seed and aggregated across seeds, rather than fitted to six
  cross-seed medians.
- Fix the verdict this produced. On the 20260813T054929Z ladder the
  between-seed spread was 194-505ms against a 132ms effect, and the cross-seed
  median landed on seed 2 at every rung except 1ms, where it landed on seed 3.
  That rank swap read as an outlier, r2 collapsed to 0.0487, and
  `isCoordinatorIndependent` returned true because r2 < 0.25 — reporting every
  arm, Redis included, as coordinator-independent. Re-read paired, the same
  data shows positive Redis slopes on 5/5 seeds at a median 1.18 ms/ms and
  +132.2ms across the ladder. The positive-direction t test is p=0.0255, but
  the 95% slope interval still crosses zero and the exact two-sided sign test
  is p=0.0625, so the five-seed verdict is now correctly `inconclusive` rather
  than promoted past its own 0.05 threshold.
- Record why that failure was one-directional: under an r2 gate, noise
  confirms flatness for an arm predicted to be flat and refutes degradation for
  an arm predicted to degrade, so an unpaired fit over noisy medians can only
  ever report "no coordination cost" whichever way the data points.
- Separate "measured as flat" from "could not tell". `pairedVerdict` returns
  `degrades`, `improves`, `insensitive` or `inconclusive`, and `insensitive`
  now requires the interval to lie wholly inside ±0.1 ms/ms rather than being
  the fallback when a fit is poor. The measured MoFlux arm is `inconclusive` at
  five seeds, not `insensitive`: its interval spans ±2.49 ms/ms and cannot
  exclude an effect the size of the one Redis shows.
- Publish `resolutionMsPerMs` and `verdictBasis` so a reader can tell which of
  the verdict rules fired and how small an effect the ladder could have ruled
  out. Five unanimous seeds remain inconclusive when the 95% interval spans
  zero because their exact two-sided sign test is p=0.0625; six reach 0.03125
  and eight reach 0.0078125. Fix the positive-direction t diagnostic so a
  negative mean slope produces a large p-value instead of becoming significant
  through `abs(mean)`.
- Pair the head-to-head as well. A crossover now requires a majority of seeds
  to change hands, be confirmed at at least one subsequent larger rung, and
  keep that majority through every larger tested rung. Isolated majority flips
  — including a lead first seen at the final rung — are retained as transient
  leads rather than reported as a crossover.
- Record Redis admission decision time directly using cumulative sum/count
  metrics from every replica, aggregate them with decision-count weighting,
  and fit that direct overhead within seed alongside TTFT. TTFT remains the
  user-visible consequence; the admission metric is the causal measurement of
  the injected coordinator delay.
- Add `--reanalyze=<ladder-id>` and `npm run demo:coordinator:reanalyze`,
  rebuilding the report from an existing ladder's per-rung run directories
  without running anything. A ladder costs rungs x seeds x arms measured runs —
  the six-rung, five-seed ladder took just over two hours — so an analysis fix
  must not require re-paying for the measurement.
- Guard the per-seed read the same way the aggregate is guarded: a per-seed arm
  file recording a different rung than the one being read now fails rather than
  flattening the fitted slope, and a seed with fewer than two usable rungs is
  dropped by name rather than folded in.
- Add a Student's t implementation and an exact binomial sign test, verified in
  `demo/verify-coordination.mjs` against published critical values rather than
  against themselves.
- Rebuild the coordination fixtures around the real measured matrix. The
  previous ones used ±12ms of scatter on a 40ms signal, a signal-to-noise ratio
  of 3.3, where real ladder noise runs at 0.33 — which is why they passed while
  the verdict was wrong. `verify-coordination.mjs` now reproduces the failure
  from the measured numbers before checking the fix, and asserts the measured
  MoFlux arm is still not reported as degrading.
- Treat rung order as a variable. `--rung-order` accepts `ascending` (default,
  and the pre-0.20.0 behaviour), `alternating`, or `given`, and the report now
  records `rungOrder`, `rungExecutionOrder` and `rungOrderConfounding` — the
  Spearman correlation between rung magnitude and run position, which is 1 for
  an ascending ladder. Ascending order measures the largest rung last, so drift
  across the ladder's runtime is collinear with the effect. On the
  20260813T054929Z ladder the 1ms rung, run second, sits above both its 0ms and
  5ms neighbours in every arm including baseline and static-cap, which never
  receive the coordinator flag; `alternating` drops the confounding to 0.26 for
  six rungs while staying deterministic.
- Add `npm run demo:coordinator:adaptive`: 0/5/20/50ms x 8 seeds under
  `adaptive-28-4` in alternating order, so a ladder is comparable with the
  published sweeps. Eight seeds rather than five because the interval is taken
  over per-seed slopes — five unanimous seeds cannot beat p=0.0625 however
  clean the effect — and four rungs rather than six so the two cost the same
  wall clock.
- Keep `demo:coordinator:adaptive` on the current `adaptive-28-4` policy, but
  do not condition coordinator-latency measurement on the full adaptive outcome
  gate. Batch-floor restoration, handoff commit and batch completions are
  orthogonal outcomes; aborting a rung on them censors valid coordinator data
  and can bias the fitted sample. Every rung records its `adaptiveProof`
  diagnostics, while `demo:coordinator:adaptive:strict` explicitly opts into
  the full gate.
- Add `--resume=<ladder-id>` so a failed multi-hour ladder can reuse completed
  rungs after validating their seed set, capacity profile and rung attribution,
  then continue only the missing measurements.
- Re-read partial ladders. `--reanalyze` now skips and names rungs that never
  completed rather than failing on the first missing one, declares the partial
  fit, and refuses to report a verdict from fewer than two rungs. A ladder is
  hours long and can die between rungs.
- Count seeds in both directions and drop ties from the sign test. A slope of
  exactly zero is neither degrading nor improving; testing direction as "not
  the other side" reads eight motionless seeds as eight seeds agreeing on
  improvement, which clears the sign test at six seeds or more and hands a
  directional verdict to the arm the ladder most wants to characterise as
  flat. `seedsImproving` and `seedsTied` are published, and the sign test runs
  over the seeds that moved — five rising and three tied is a test on five,
  not on eight.
- Test the negligibility band before the interval's sign. An interval of
  [0.02, 0.08] excludes zero but reports a direction of no practical size, and
  tested the other way round an arm measured tightly enough to prove it is flat
  could never earn `insensitive`, because an interval clearing zero by four
  thousandths of a millisecond per millisecond would claim a direction first.
- Assert `adaptiveProof.policyMatches` per rung rather than only recording it.
  Decoupling the ladder from the adaptive *outcome* gate is not a reason to
  stop checking the *configuration*: a rung labelled adaptive-28-4 whose pool
  guarantees had drifted would otherwise be fitted into the trend as though it
  ran the same policy as every other rung.
- Distinguish "not measured" from "measured zero" in the direct
  admission-decision metric. Three states reached the report as a null average:
  the Redis arm times its coordinator round trip, the other local arms are
  instrumented and make no coordinator calls at all, and the MoFlux arm admits
  inside Tyr rather than the local replica proxy so nothing times it — as do
  all runs predating the counters. Printed as a bare dash for all three, an
  absent counter next to MoFlux reads as evidence that MoFlux has no admission
  overhead, which this ladder has not measured. `admissionDecisionSamples` is
  carried through both read paths, each arm records an
  `admissionDecision.status`, and the table prints `measured`, `none made` or
  `not measured` rather than a dash.
- Refuse a run that instruments admission decisions but records none for the
  Redis arm. That arm consults Redis on every admission, so an empty counter
  there is lost instrumentation, and a lost counter reads downstream exactly
  like a free coordinator.
- Bump the ladder report to `schemaVersion` 4.
- Update the publication verifier to require package version 0.20.0 and
  enforce the adaptive ladder/strict-ladder script split.

## 0.19.0 - 2026-08-12

### Fixed

- Fix Node 24/macOS replica forwarding so a completed incoming request body does
  not abort its own provider call. `IncomingMessage.close` is no longer used as
  a post-body client-disconnect signal; a premature `ServerResponse.close` now
  cancels the upstream fetch instead. This preserves cancellation for real
  caller disconnects without turning every admitted request into a transport
  failure.
- Fix provider startup on Node 24/macOS when an HTTP readiness probe can fail
  with `Parse Error: Expected HTTP/, RTSP/ or ICE/` even though provider-sim has
  already bound port 9000. Provider readiness now waits for the startup banner
  emitted from provider-sim's `server.listen()` callback, which is the
  authoritative signal that its listening socket is ready.
- Keep application-level HTTP health checks for Tyr and replica processes; only
  provider-sim uses the listen-callback marker because its health route is
  installed synchronously before `listen()` and has no later initialization
  phase.
- Add regressions for host-process readiness and replica forwarding lifecycle.
- Correct current licensed-run documentation to Tyr 0.25.1 and Latchflo 0.11.4,
  and identify admission-class summaries as schema version 4.
- Refuse a benchmark arm that measured nothing. An arm whose replicas were
  healthy but whose upstream was not the provider simulator previously completed
  and passed every assertion while reporting 0.0% success, zero local rejects,
  zero upstream 429s, `peak active ?/32` and retry amplification pinned at
  `maxAttempts` — then aggregated into a five-seed median. New
  `demo/arm-health-lib.mjs` classifies each attempt as decided (success, local
  reject, upstream 429) or unattributable (transport error, non-2xx), and
  `assertValidRun` now rejects an arm with no successes and no admission
  decisions, or with unattributable failures above 1% of attempts. All 42
  committed arm summaries have zero of either, so the tolerance is headroom
  rather than an allowance the published runs rely on. The counts are recorded
  on every summary as `health` and aggregated as `unattributedFailures`.
- Prove the provider simulator's identity before running an arm. Readiness by
  startup banner (introduced earlier in this release) shows that a socket bound,
  not that the base URL the replicas are given reaches that process — on macOS a
  listener bound to `127.0.0.1:9000` coexists with the simulator's `0.0.0.0`
  bind and wins loopback. provider-sim now emits an instance id in its banner
  and serves `service`/`instance` from `/admin/stats`; each arm probes that
  endpoint over the same global fetch the load generator uses, before spending a
  measured phase. A foreign process, an intercepting proxy, and a stale
  simulator from an earlier arm each fail with a distinct message.
- Stop discarding unknown provider occupancy. `readProviderCounters` swallowed
  every error and returned null, which the presenter rendered as `?/32` and the
  sweep aggregate converted to `peakActive: 0`. It now fails the arm.
- Record coordinator latency only on an arm that consults a coordinator while
  admitting. `attachScenario` stamped `--coordinator-latency-ms` on every arm, so
  at a 30ms ladder rung the uncontrolled baseline, both static arms and MoFlux
  all claimed to have paid 30ms per admission to a service they never call. The
  rung is now carried separately as `coordinatorLadderRungMs`.
- Make `--control-arms=all` mean the same thing to the presenter and the sweep
  wrapper. The wrapper expanded it to arms 2 and 4; the presenter expanded it to
  every registered spec, so it ran the `static-partition` lending control on
  every seed of every sweep and the wrapper then discarded the file. Resolution
  moved to `demo/control-arm-lib.mjs`. `demo:lending` still selects that arm by
  name, and every published `--control-arms=all` sweep was already reporting
  only arms 2 and 4.
- Attribute each coordinator-ladder rung to the run it produced. Each rung now
  writes a named run directory and is read back from it rather than through the
  latest-run pointer, and a rung whose evidence records a different latency
  fails instead of being fitted into the trend. The ladder also stopped passing
  `--keep-stack`, which neither script reads (both keep the stack unless
  `--cleanup` is given), gained `--capacity-profile` passthrough, and states
  which capacity policy it is running under — its default remains the historical
  31/1 profile, which is not the `adaptive-28-4` profile every published sweep
  uses.

## 0.18.0 - 2026-08-11

### Added

- Upgrade the authenticated admission-class benchmark to collect Latchflo 0.11.4
  class-handoff evidence from `/v1/events` and `/v1/grants`, joining each
  restoration handoff to the source grants whose leases would otherwise bound
  reclamation.
- Add a structural proof that every required class drain grant was acknowledged,
  the restoration handoff committed, no matching abort occurred, and commit
  preceded the latest source-grant expiration. Record per-seed lease time avoided
  and aggregate its median in schema-version-4 tenant-fairness summaries.
- Require the Tyr fleet used by `demo:classes` to advertise
  `admissionClassOccupancyAck`, preventing the benchmark from silently falling
  back to the lease-bound Tyr 0.23/Latchflo 0.10 behavior.

### Changed

- Move demand-aware heterogeneous demos from the old 11-second steady grant cadence to a 120-second steady lease and require enough initial runway to cover the measured phase plus a safety margin. Acknowledged handoff is now expected to restore capacity by drain/ACK/fresh-occupancy proof rather than racing rolling lease expiry under long heterogeneous requests.
- Pin active licensed benchmark paths to Tyr 0.25.1 and Latchflo 0.11.4 while
  retaining async-bulkhead-llm 3.15.1 and async-bulkhead-ts 1.0.1.
- Give all four admission-class arms the same 240-second steady grant TTL. The
  adaptive arm no longer uses the old 3-second benchmark-only lease; it must
  demonstrate acknowledged pre-expiry floor restoration under the same lease
  duration as the controls.
- Keep success rate, goodput, TTFT, local rejects, and restoration latency as
  measured outcomes. The new acceptance gate remains structural: matching trace,
  bounded admission, data-plane-applied floors/ceilings, and ordered safe handoff.
- Update current runtime metadata, local image defaults, topology assertions,
  documentation, and publication checks to 0.18.0 / Tyr 0.25.1 / Latchflo 0.11.4.

### Fixed

- Roll the demand-aware heterogeneous benchmark companion controller to Latchflo
  0.11.4. Physical floor-restoration retry is now capacity-group-wide: while any
  demanding member remains below its guarantee, a fresh heartbeat from any group
  member can retrigger reconciliation. This closes the remaining seed-dependent
  liveness gap where the borrower heartbeat made drain evidence fresh but the
  controller waited for another batch heartbeat before preparing the handoff.
  Workload, 120-second lease, and acceptance thresholds are unchanged.
- Roll the class benchmark companion controller to Latchflo 0.11.4. The patch
  retries a pending adaptive class restoration on subsequent same-state Tyr
  heartbeats, closing a lost-reconcile window that could leave a seed with
  `lent=true`, observed noisy demand, and no prepared class handoff. Benchmark
  workload, trace, policy, and proof thresholds are unchanged.
- Fix a seed-dependent class-proof race where Latchflo could commit an acknowledged restoration after the fixed post-run sampler stopped. The adaptive runner now uses a bounded 15-second synchronization phase, actively reconciles, and waits until Tyr itself reports the restored noisy protected floor; controller commit and data-plane application are proven separately.
- Isolate `demo:classes` control-plane state per seed. A restored adaptive grant
  carries the same 240-second steady lease as every other arm, so reusing one
  Latchflo/Tyr stack could leave the noisy floor protected into the next seed and
  make that seed unable to exercise lending. Each seed now recreates the stack
  and explicitly proves the noisy floor is lent before starting the adaptive
  trace.
- Make adaptive lending summaries causal: demand-after-lending, restoration, and
  restoration latency now remain false/null when no lent sample was observed.
  This prevents an impossible `lent=false, restored=true` report.
- Build the final scenario ID from the retained cross-seed class-grant snapshot
  instead of the loop-local `fleet` binding, avoiding a `ReferenceError` after a
  successful multi-seed run.
- Roll the Tyr runtime pin forward to 0.25.1. Tyr 0.25.1 preserves the 0.25
  class-handoff protocol and fixes the source/Docker release bundle by including
  the vendored runtime tarballs required by its lockfile, so local benchmark image
  builds can complete with `npm ci --omit=dev`.
- Replace the class benchmark's dependence on artificially short lease expiry
  with direct source-lease and handoff evidence, so a restored floor can no
  longer pass merely because the benchmark waited long enough for the old grant
  to expire.

## 0.17.2 - 2026-08-11

### Fixed

- Advance the package metadata, publication verifier, and current benchmark
  documentation to 0.17.2 so the release version is consistent everywhere.
- Carry forward the 0.17.1 publication-hygiene fixes without changing benchmark
  policy semantics or relabeling historical evidence.

## 0.17.1 - 2026-08-10

### Changed

- Republish the video seed-sweep evidence (`results/video-seed-sweep.json` and
  `results/video-seed-sweep/*.json`) from a fresh `demo:handoff` run against
  the demand-aware `adaptive-28-4` policy, upgrading the committed dataset
  from schema version 1 to version 2. This replaces the prior
  `interactive-first-static` snapshot with the restoration-handoff and
  admission-timing evidence introduced in 0.17.0.

### Fixed

- Update the publication verifier and current benchmark documentation for
  version 0.17.1 so a clean 0.17.1 source tree passes the release gate.
- Ignore local Claude settings alongside editor/OS state so developer-machine
  configuration does not become release-source noise.

## 0.17.0 - 2026-08-08

### Added

- Add a focused `demo:handoff` five-seed release proof for the demand-aware
  `adaptive-28-4` policy without the additional control arms.
- Record the load generator's wall-clock start and first accepted response per
  class so Latchflo events and request admission share one timeline.
- Collect the Latchflo 0.10.0 restoration handoff chain: demand detection, drain
  preparation, every drain-grant `applied` acknowledgement, commit, lease
  fallback deadline, and the first batch admission.
- Sample Tyr applied pool capacity every 500 ms during lending runs and require
  that aggregate concurrency and token allocations never exceed the physical
  envelope.
- Report per-stage handoff latency, lease time avoided, batch admission delay,
  and first-completion delay separately in seed and aggregate results.

### Changed

- Pin active licensed benchmark paths to Tyr 0.24.0 and Latchflo 0.10.0 while
  retaining async-bulkhead-llm 3.15.1 and the async-bulkhead-ts 1.0.1 runtime
  shipped by Tyr. Historical committed evidence is not relabeled.
- Strengthen `--require-adaptive-proof`: every seed must observe a restoration
  handoff, prove ordered drain ACKs before commit, prove commit before first
  batch admission and before lease fallback, and prove no sampled applied
  capacity over-allocation.
- Bump the heterogeneous seed-sweep result schema to version 2 for the new
  handoff and admission-timing evidence.

### Fixed

- Prevent demand-aware startup from deadlocking on legitimate pre-benchmark idle heartbeats. Adaptive runs now install the 28/4 capacity group with lending temporarily disabled, wait for a simultaneous usable Tyr grant set, and arm the measured demand policy only after a fresh interactive demand report from the running load generator. Slow Docker enrollment can no longer turn an idle pre-run period into zero-token grants such as `sim-interactive on Tyr 8101 received 0 tokens`.
- Stabilize the acknowledged-handoff proof without weakening its safety gate: demand-aware runs now use an 11-second grant TTL and wait for a fresh steady-state grant set with at least 9.5 seconds remaining before load starts. With the default 27-second batch arrival, this leaves at least 4.5 seconds on the contemporaneous lease for the ACK + fresh-occupancy + commit path instead of randomly landing just before expiry.
- Report an observed-but-uncommitted or aborted handoff directly. Missing commit evidence no longer cascades into misleading `batch admitted before handoff commit` and `handoff did not beat lease expiry` diagnostics when those comparisons were never observable.
- Make `batchFloorAdmissionGapMs` end at the first batch 2xx response instead of
  the first fully completed request. Version 0.16.0 mixed provider execution
  time into the admission/reclamation measurement; completion delay is now
  reported separately as `batchFloorFirstSuccessGapMs`.
- Reconcile the capacity group before reading final controller events so a
  handoff committed by that rebalance cannot race the evidence fetch and vanish
  from the proof record.
- Treat any Tyr applied-capacity sampling error as incomplete safety evidence
  instead of allowing a partially observed run to pass the no-double-allocation
  gate.
- Keep ignored local `.env`, macOS metadata, and generated `results/runs/**`
  trees out of the release source so publication verification operates on a
  reproducible repository rather than developer-machine artifacts.

## 0.16.0 - 2026-08-07

### Added

- Extend `demo:classes` to a four-arm matched-trace benchmark: pool-only, class
  ceilings, static protected floors, and demand-aware protected floors.
- Add end-to-end adaptive class-lending proof collection against Tyr 0.23.0 and
  Latchflo 0.9.0. The runner samples both Latchflo class-demand status and the
  class limits actually applied by Tyr.
- Require every adaptive seed to prove that the idle noisy floor was lent, hard
  class ceilings stayed fixed, noisy demand returned after lending, and the
  nominal noisy floor was restored without starving the class or causing an
  upstream 429.
- Add schema-version-3 tenant summaries with adaptive success/goodput/TTFT,
  per-seed lending/restoration evidence, and restoration-latency measurements.

### Changed

- Pin active licensed benchmark paths to Tyr 0.23.0 and Latchflo 0.9.0 while
  retaining async-bulkhead-llm 3.15.1 and the async-bulkhead-ts 1.0.1 runtime
  shipped by Tyr. Historical committed evidence is not relabeled.
- Give only the adaptive class arm a 3-second benchmark grant TTL, 1-second idle
  threshold, and 5-second stale-report bound so lease-safe restoration can be
  observed inside a 30-second seed. The three control arms retain long steady
  leases.
- Treat success rate, goodput, TTFT, and restoration latency as measured
  outcomes rather than acceptance thresholds; the hard gate remains structural
  and safety-oriented.

### Fixed

- Verify adaptive floor changes at the data-plane boundary rather than accepting
  controller intent alone. A seed now fails if Latchflo reports lending or
  restoration but Tyr's aggregate applied class grants do not reflect it.
- Keep adaptive hard ceilings under proof while protected floors are temporarily
  zero, preventing work conservation from being mistaken for relaxed isolation.
- Make simulator-sweep startup and shutdown bounded: allocate a free local port,
  fail if a provider exits before readiness, abort and settle streaming requests,
  and escalate child termination when needed so `npm run sweep` / `verify:all`
  cannot hang on a stale stream or startup-port collision.

## 0.15.0 - 2026-08-06

### Added

- Add a three-arm tenant benchmark that replays each immutable trace through a
  pool-only control, a class-ceiling control, and protected admission-class
  floors.
- Add fleet-wide and per-replica validation for protected concurrency and token
  grants. The runner refuses to start unless every protected replica grant can
  fund at least one noisy request.
- Add schema-version-2 tenant summaries with ceiling and protected outcomes,
  protected-to-control TTFT ratios, noisy contended completions, and separate
  proof checks versus non-gating performance observations.

### Changed

- Pin active licensed paths to Tyr 0.22.0, Latchflo 0.8.0,
  async-bulkhead-llm 3.15.1, and the async-bulkhead-ts 1.0.1 dependency actually
  shipped inside Tyr 0.22.0.
- Replace the former 36,000-character noisy request with a 15,000-character
  shape that can fit one protected per-replica token floor while still allowing
  ceiling-only traffic to exhaust unprotected token headroom.
- Configure managed admission-class tables at zero capacity until Latchflo's
  first Tyr 0.22.0 grant atomically supplies the physical envelope, hard
  ceilings, and protected floors.

### Fixed

- Fail the tenant-fairness proof when the noisy class completes no work. The
  0.14.0 gate accepted classification plus rejection and could therefore report
  fairness while all noisy requests were starved.
- Prevent class-token fragmentation from invalidating the benchmark. The old
  48,000-token noisy ceiling was divided into 12,000-token replica grants, less
  than one approximately 14,000-token noisy reservation.
- Keep active runtime metadata, local-image discovery, topology verification,
  presenter assertions, documentation, and publication checks aligned with the
  Tyr 0.22.0 / Latchflo 0.8.0 release train. Historical committed evidence is
  not relabeled.
- Harden the drain verifier so a missing child-process close event cannot hang
  the repository release gate after a forced timeout.

## 0.14.0 - 2026-08-05

### Added

- Add `npm run demo:classes`, a paired five-seed noisy-neighbor benchmark for
  Tyr 0.21.0 and Latchflo 0.7.2. Every seed replays one immutable trace through
  equal pool-only and identity-aware class-isolated physical envelopes.
- Add an ephemeral HTTPS JWKS fixture with per-run RSA signing keys and a
  generated local CA. Premium and noisy workloads use authenticated tenant
  identities without checking in credentials or disabling TLS verification.
- Add bounded fleet-wide `premium` and `noisy` class policy fixtures: 8/24
  concurrent requests and 16,000/48,000 in-flight tokens beneath a shared
  32-request / 64,000-token physical pool.
- Record `x-admission-class` response attribution in load-generator summaries,
  add per-seed structural proof results, and aggregate premium success,
  contended goodput, TTFT ratios, noisy-class shedding, and upstream 429 totals.
- Add `demo/TENANT-FAIRNESS.md` and verification for class topology, grant
  aggregation, identity-token transport, output redaction, and proof logic.

### Changed

- Pin licensed demo defaults to Tyr 0.21.0, Latchflo 0.7.2,
  async-bulkhead-llm 3.14.0, and async-bulkhead-ts 1.0.2. Existing committed
  benchmark evidence remains byte-for-byte historical and is not relabeled.
- Extend the load generator with optional per-workload identity tokens. Results
  persist only `provided`/empty markers; bearer tokens never enter result JSON.
- Align every active runtime pin, Tyr control-plane metadata field, local-image
  build check, presenter assertion, and publication check with the supported
  Tyr 0.21.0 / Latchflo 0.7.2 release train. Tyr 0.21.0 is the minimum
  runtime that consumes Latchflo-distributed admission-class ceilings.
- Update the benchmark dependency record to async-bulkhead-ts 1.0.2 while
  retaining async-bulkhead-llm 3.14.0.
- Remove local environment state, generated run output, and macOS archive
  metadata from the 0.14.0 source package.

### Fixed

- Fix `npm run demo:classes` hanging and failing with `Tyr /stats returned
  HTTP 401`. The tenant-fairness Tyr fleet requires an authenticated
  `tyr.operator` identity on `/stats`, but the readiness poller sent no
  identity token at all. The ephemeral identity fixture now mints an
  operator token alongside the premium/noisy tenant tokens, and the poller
  sends it.
- Fix every `x-tyr-identity-token` header (the fleet readiness poller and
  the load generator's premium/noisy request traffic) to send `Bearer
  <token>` instead of the raw JWT. Tyr rejects a bare token on that header
  with `identity_invalid`, so no authenticated tenant-fairness request
  could previously be admitted end to end.

## 0.13.1 - 2026-08-04

### Fixed

- Make `demo/verify-full-stack-bootstrap.mjs` use operating-system-assigned
  ephemeral ports for its fake telemetry relay, Prometheus, and Grafana
  services. `npm run verify` no longer waits for hard-coded ports 8200, 9090,
  and 3000 to become free when a real demo stack is already running.
- Add `--telemetry-relay-url` and `--prometheus-url` overrides to
  `demo/run-demo.mjs`, and use the existing `--grafana` override consistently
  for readiness checks. All defaults remain unchanged for normal demo runs.
- Remove local environment state and generated run output from the release
  archive so publication hygiene passes without exposing credentials or
  packaging transient benchmark artifacts.

## 0.13.0

### Added

- Add `npm run demo:hetero:adaptive` and
  `npm run demo:hetero:adaptive:blind` as the canonical mixed-workload
  comparisons. Both combine lognormal request sizes, progressive token
  reconciliation, a demand-aware 28/4 protected capacity profile, and all
  comparison arms on the same five traces.
- Add the named `adaptive-28-4` capacity profile. It fixes the shared envelope
  at 32 concurrency slots and 64,000 in-flight tokens, with 28/4 protected
  concurrency and 24,000/40,000 protected tokens. Conflicting overrides are
  rejected instead of silently changing the policy a result claims to measure.
- Add a per-seed adaptive acceptance record to sweep summaries. It reports
  upstream 429s, batch completions, borrowed slots, controller lending proof,
  floor restoration, restoration duration, and first batch service latency.
- Add the `--require-adaptive-proof` gate with per-seed interactive, batch,
  controller-event, floor-restoration, and upstream-overload checks. The gate
  requires the protected four-slot batch floor to complete at least four
  requests per seed and treats occupancy above 28 as sweep-level corroboration.
  Failed-run evidence remains available for diagnosis.
- Add a preflight check that TCP 9000 is free before a run starts. The provider
  simulator is a host process, so no Compose command and no `npm run demo:down`
  can release that port; an orphan from an interrupted run previously surfaced
  as a startup timeout part-way into an arm. The check tolerates a socket that
  is still being released between seeds.
- Add `demo/host-process-lib.mjs` and `demo/verify-host-supervision.mjs`,
  extracting host child supervision from the presenter so its failure reporting
  is covered by the verification suite without Docker.

### Changed

- Record the selected capacity profile in every new MoFlux result and aggregate
  summary. Historical 31/1 runs are labeled `historical-31-1`; existing
  `--lending` experiments remain available as `custom-demand-aware` policies.
- Keep `demo:hetero` and `demo:hetero:blind` unchanged for historical 31/1
  reproduction. The adaptive commands are additive and do not relabel or
  overwrite reviewed evidence.

### Fixed

- Validate the adaptive batch guarantee using at least four completed batch
  requests per seed rather than a workload-dependent success percentage.
- Treat idle-window occupancy above 28 as sweep-level corroboration while
  retaining Latchflo's `capacity_group.lending_observed` event as the per-seed
  source of truth.
- Remove local `.env`, macOS metadata, scratch arm JSON, and generated run
  directories from the release copy so publication hygiene passes without
  deleting reviewed evidence.
- Keep the slow-drain and full-presenter verification checks bounded while
  allowing enough time for them to complete on slower CI hosts.
- Report why a host process failed to start instead of reporting only that it
  did. The liveness guard tested `child.exitCode !== null`, which stays `null`
  when a process is terminated by a signal, so a killed simulator or replica
  was mistaken for a slow one: the poll ran to its full deadline and reported
  `timed out waiting for <label>; last result: fetch failed`, the same sentence
  a slow start, a crash, and a taken port all produced. Startup failures now
  name the exit code or signal, report elapsed time and whether the process was
  still running, and carry the child's own last output — including the case
  where it produced none.
- Report a bind failure in the provider simulator and the replicas as one line
  naming the port, rather than an unhandled `error` event stack from
  `node:net` that identifies neither component nor collision.
- Route the provider simulator's port through a single constant shared by the
  preflight, the launch arguments, and the replica upstream.

## 0.12.0

### Added

- Add an Anthropic-shaped streaming path across the provider simulator, load
  generator, licensed presenter, Tyr configuration, and verification suite.
  The simulator emits input usage at `message_start` and monotonic cumulative
  output usage during the stream, which gives Tyr 0.19.0 the live usage signal
  required to exercise async-bulkhead-llm 3.13.0 progressive reconciliation.
- Add `npm run demo:progressive` as the explicit progressive benchmark command
  and `npm run demo:openai` as the retained OpenAI-shaped compatibility path.
  The canonical `npm run demo` path now defaults to Anthropic-shaped streams;
  OpenAI-shaped usage still settles at completion and is not represented as
  evidence of early release.
- Record progressive usage reports, applied and coalesced updates, tokens
  released before completion, the early-release share of all refunds, and the
  pinned reconciliation policy in every MoFlux result.
- Add Grafana panels for progressive early-release share and reconciliation
  activity, plus simulator and load-generator contract tests for Anthropic SSE
  usage events.

### Changed

- Pin the licensed stack to Tyr 0.19.0, Latchflo 0.6.1,
  async-bulkhead-llm 3.13.0, and async-bulkhead-ts 1.0.1.
- Enable progressive reconciliation on every benchmark Tyr pool with a
  256-token update step and a 256-token future-output safety margin. Presenter
  startup now rejects a live pool that does not report that exact policy.
- Keep using Latchflo's existing `inFlightTokens` and `availableTokens` demand
  snapshot fields. No benchmark-side control-plane protocol extension is
  required: progressively reduced Tyr occupancy flows through the existing
  authenticated heartbeat.
- Preserve every previously reviewed result at its committed bytes. The
  existing corpus records Tyr 0.17.0 and Latchflo 0.5.1; this release does not
  claim new performance numbers or relabel historical evidence for the new
  runtime.

### Fixed

- Correct the video documentation to describe generated run directories and
  explicit evidence promotion instead of implying normal sweeps overwrite the
  reviewed `results/video-seed-sweep*` paths.
- Correct stale prose that described the reviewed corpus as Tyr 0.16.0 /
  Latchflo 0.5.0 despite the recorded runtime fields reading 0.17.0 / 0.5.1.
- Make the canonical `npm run demo` command explicitly select Anthropic
  streaming rather than relying only on the presenter's default.
- Keep Anthropic requests protocol-shaped by carrying the deterministic replay
  key in `metadata.user_id` instead of an unsupported top-level `seed` field.
- Emit standard Anthropic `event:` lines and parse SSE `data:` lines regardless
  of their position within a frame, preserving both Anthropic and OpenAI stream
  handling.
- Refuse to aggregate a seed sweep when any MoFlux run omits or changes the
  pinned progressive-reconciliation policy.

## 0.11.0

### Fixed

- Bound the load generator's end-of-run drain by lack of progress rather than
  by elapsed time. The drain deadline was a fixed 20 seconds, which is not a
  bound on the slowest request any arm can produce: one batch call carries
  roughly 6,700 prefill tokens and can draw up to `--batch-max-tokens` of
  decode, and the simulator's per-stream rate falls by close to an order of
  magnitude at a full 32-slot envelope, so a late batch request legitimately
  needs tens of seconds to finish. Two runs of the identical seed-5 trace
  drained in 13.2s and 20.0s — same requests, different host load — so which
  side of the constant a run landed on was decided by the machine, not by the
  benchmark. When it landed on the wrong side the whole seed was thrown away,
  and it was thrown away in the uncontrolled baseline first, because that arm
  has the longest tail by construction. The drain now waits while requests are
  completing or streaming, stops on `--drain-idle-ms` (default 20,000) when
  nothing advances, and stops absolutely on `--drain-max-ms` (default 180,000).
  Recorded results are unaffected: a run that previously finished inside 20
  seconds recorded exactly what it records now. Runs that previously crashed
  now complete, and the tail they were hiding lands in the arm's own latency
  percentiles.
- Name the straggler when a drain does fail. The error reported only a count,
  which cannot distinguish a slow decode from a dead socket — the distinction
  that decides whether a run is a bad result or a bad harness. It now reports
  each unfinished request's trace id, class, arrival, attempt, phase, last
  status, size and age.
- Stop sweeps from overwriting reviewed evidence. Every run now writes to
  `results/runs/<sweep>/<run-id>/` and nothing else; `results/<sweep>.json` and
  `results/<sweep>/` are written only by the new `demo/publish-evidence.mjs`.
  Previously `npm run demo:hetero` replaced the published five-seed sweep in
  place, and nothing detected it: the JSON stayed valid, the path stayed
  approved, and only the `runtime.tyr.version` recorded inside each per-seed
  file revealed that a different runtime had produced the numbers.
- Add `scripts/verify-publication.mjs` coverage that reviewed evidence is
  byte-identical to its committed copy, naming the exact paths to restore. This
  is the check that would have caught the overwrite; approving a path is not the
  same as protecting its contents.
- Forward `--honor-retry-hints` from the presenter to the load generator, and
  record the mode in `scenario.workload.honorRetryHints`. The generator has
  parsed the flag since 0.7.0 but nothing ever sent it, so the exact A/B it
  exists for could not be run from any entry point. MoFlux is the only
  local-admission arm that emits `Retry-After` / `x-admission-retry-after-ms`,
  so its measured TTFT carries the cost of hint-imposed waiting that the static
  cap and Redis arms never pay — and until now that contribution could not be
  isolated. `npm run demo:hetero:blind` is the paired blind-backoff run; the
  trace hash is unchanged either way, so the pair is exact.
- Correct two false provenance comments in `.gitignore`. The preserved sweep was
  labelled Tyr 0.16.0 / Latchflo 0.5.0 when the per-seed files it describes
  record 0.17.0 / 0.5.1, and `results/lending.json` was labelled historical
  pre-0.11.0 output when it is generated by this release. Generated lending
  output is no longer unignored or treated as approved evidence; it lands in a
  run directory like everything else.

### Added

- Add `load/verify-drain.mjs` to the verification suite: a slow but streaming
  drain completes and records every request, a stream that goes silent still
  fails the run and names the straggler, and a stream that never ends is
  stopped by the hard cap.
- Add `demo/evidence-paths-lib.mjs` as the single declaration of which paths
  hold reviewed evidence. The sweep, the presenter and the publication check all
  read it, so the guard and the gate cannot drift apart.
- Add `demo/publish-evidence.mjs` (`npm run evidence:publish`,
  `npm run evidence:list`) to promote one completed run to reviewed evidence. It
  refuses to replace an existing copy without `--force`, retargets the per-seed
  pointers in the summary, and repairs `scenario.trace.evidence`, which
  previously named a scratch file the sweep deleted on the way out.
- Add `--publish-as=<name>` to the sweep for the case where promotion is
  intended up front, and `--run-id=<id>` for reproducing a run directory name.
- Add `results/runs/<sweep>/latest.json`, a stable pointer to the newest run.
  `demo/coordinator-ladder.mjs` follows it instead of reading
  `results/video-seed-sweep.json`, which would otherwise have reported whatever
  was last published rather than the rung that just ran.
- Add `demo/verify-evidence-paths.mjs` to the verification suite: the guards
  reject reviewed paths, and the sweep computes its output somewhere else.
- Add a real demand-aware lending path for `npm run demo:lending`. The presenter
  creates a Latchflo 0.6.0 capacity group with protected 28/4 concurrency and
  24,000/40,000-token guarantees, raises both pool ceilings to the shared
  32-slot/64,000-token envelope, and relies on Tyr 0.18.0 demand heartbeats to
  decide when idle guarantees may be lent.
- Add `static-partition`, a dedicated 28/4 local control arm for the lending
  scenario. The lending run no longer compares MoFlux with a generic 32-slot
  static cap and can expose consumption of up to four borrowed slots.
- Add `demo/lending-evidence-lib.mjs` and controller-backed lending evidence.
  A run now requires both idle-window occupancy above the static partition and
  a `capacity_group.lending_observed` audit event before reporting lending as
  proven.
- Record Latchflo demand snapshots, floor-restoration events and deadlines,
  restoration duration, borrowed slots, and per-seed lending proof in the
  aggregate sweep output.

### Changed

- Pin the licensed benchmark path to Tyr 0.18.0 and Latchflo 0.6.0.
- Keep normal comparisons on the existing static 31/1 policy so historical
  benchmark interpretation remains stable. The dedicated lending command now
  uses a fully token-funded 28/4 protected policy. Demand-aware capacity groups
  are enabled only by `--lending` / `npm run demo:lending`.
- Use short renewable leases in the lending scenario so floor restoration is
  observable inside the contended window. Normal benchmark runs retain the
  long grant runway required for a complete phase.
- Keep every pre-0.11.0 JSON result artifact at its committed bytes. Those files
  record Tyr 0.17.0 / Latchflo 0.5.1 in their own `runtime` fields and are not
  relabeled as evidence for Tyr 0.18.0, Latchflo 0.6.0, or demand-aware lending.
  This is no longer a convention a run could break by accident: sweeps cannot
  write those paths, and `npm run verify:publication` fails if their bytes
  differ from the committed copy. Numbers measured under 0.18.0 / 0.6.0 belong
  in a run directory until they are deliberately published.

### Fixed

- Stop treating run-long peak occupancy as proof of lending. A 32/32 peak after
  batch arrives is compatible with a static 28/4 split; the benchmark now
  measures the interactive-only window against the exact static partition.
- Stop treating configuration alone as proof that the batch floor returned.
  Floor restoration now requires controller evidence and observed batch
  service after demand appears.

## 0.10.0

### Added

- Add heterogeneous request sizes: `--size-distribution=lognormal` draws an
  input size and a max-token count per request instead of using one constant
  per class. Exposed as `npm run demo:hetero`. Spread is controlled by
  `--interactive-size-sigma` (default 0.75) and `--batch-size-sigma`
  (default 0).
- Add `bindingConstraint` to every class summary: how many local rejections
  came from the token budget versus concurrency, and `exercisedTokenAwareness`.
  This is the instrument that says whether a run tested token-aware admission
  at all.
- Add `requestSizes` to every class summary — the realised min, p50, p95, max,
  and spread of the replayed trace.
- Aggregate both across seeds. The sweep summary now carries
  `budgetLimitedRejects`, `concurrencyLimitedRejects`, `tokenBoundShare`, and
  the realised request sizes per arm, plus a top-level `tokenAwareness` block
  reporting how many seeds each arm's token budget actually refused work on.
  Recording these per seed but not aggregating them meant answering "did the
  token budget decide anything" required opening five files by hand — and
  until that is answered, a comparison between a token-aware arm and a
  concurrency-only one cannot be read at all. The sweep prints the verdict
  above the head-to-head table, and warns by name about any arm whose budget
  refused nothing.
- Add the coordinator-distance ladder: `--coordinator-latency-ms` simulates
  network distance to the coordination service, applied to every Redis command
  round trip. `npm run demo:coordinator` runs a full paired sweep at each rung
  and reports a per-arm sensitivity slope with an r², plus the crossover
  between per-request and lease-based coordination. Only the Redis arm receives
  the flag, since only it consults a coordinator while admitting.
- Add `demo/coordination-lib.mjs` and `demo/verify-coordination.mjs`. The
  crossover is reported only when observed inside the tested ladder; a ladder
  that never crosses does not license a claim that it would.
- Add `load/verify-trace-sizes.mjs` and `demo/verify-loadgen-args.mjs` to the
  `verify` chain. The second derives the flags the load generator must receive
  from `traceWorkload()` rather than from a hand-written list, so a key added
  to the trace in future is covered without anyone remembering to update it,
  and checks that the generator actually parses each forwarded flag — an
  unknown argument is ignored rather than rejected, so forwarding a flag the
  generator never reads would fail the same way and just as quietly. It also
  asserts both sides declare the same `size-distribution` default, and that the
  default is `uniform`.

### Changed

- Pin the licensed benchmark path to Tyr 0.17.0 and Latchflo 0.5.1.
- Enable Tyr 0.17.0 capacity-aware one-hop routing across the four benchmark
  replicas. Each replica polls the private capacity snapshots of its three peers
  and can forward a request to the replica with better request-specific
  concurrency and token headroom.
- Generate one local-only `TYR_ROUTING_SECRET` for the demo fleet and pass it to
  every Tyr container. Latchflo remains responsible for grants and lease safety;
  this release does not make Latchflo distribute Tyr topology or routing secrets.
- Preserve the committed result corpus byte for byte. Existing JSON evidence
  retains its recorded Tyr 0.16.0 and Latchflo 0.5.0 provenance; rerunning the
  licensed arms produces new evidence under Tyr 0.17.0 and Latchflo 0.5.1.
- Treat the named `results/video-seed-sweep` corpus as reviewed published
  evidence while continuing to reject arbitrary generated JSON elsewhere under
  `results/`.
- Trace format is now versioned by distribution. A uniform trace remains
  **version 1 and hashes exactly as before**; a heterogeneous trace is version
  2. Sizes are drawn from a separate seeded stream, so arrival times and retry
  jitter are byte-identical between a v1 trace and its v2 counterpart — only
  the sizes are new.
- A version-1 trace cannot be replayed under a heterogeneous configuration, or
  the reverse. Mixing them would offer different work to the two arms of a
  pair while both reported a matching scenario.
- Under `lognormal`, the capacity plan no longer requires every concurrency
  slot to be funded for a worst-case request. Provisioning every slot for a
  tail most requests never reach would defeat the point; tokens are expected to
  bind sometimes, and that is the property being measured. The floor still
  holds: a grant must fund at least one worst-case request.

### Notes

- The presenter forwards `--size-distribution`, `--interactive-size-sigma`, and
  `--batch-size-sigma` to the load generator. Without them the generator parses
  its own configuration as uniform, rebuilds the expected workload from that,
  and rejects the version-2 trace the presenter just wrote — both files
  individually correct, only the handshake between them missing. Anything
  included in `traceWorkload()` has to be forwarded, which is what
  `demo/verify-loadgen-args.mjs` enforces.
- **On loopback, a per-request coordinator looks free.** A Redis round trip on
  localhost is a few hundred microseconds, so consulting it on every admission
  costs almost nothing — the most favourable condition that design can be given
  and one that does not exist in production. Every comparison here was run that
  way before 0.10.0, which quietly assumed the answer to the question that
  actually separates the two designs.
- **Why this matters.** With one fixed size per class, token-aware admission
  and a concurrency semaphore are the same algorithm: N slots times a constant
  is a fixed token ceiling, so there is no decision token accounting can make
  that a counter cannot. Every result previously attributed to token awareness
  was unattributable, and a static per-replica cap was expected to match it.
  Real traffic in one class spans one to two orders of magnitude.
- **Version-1 results are preserved, not archived.** `--size-distribution`
  defaults to `uniform`, so `npm run demo` and every existing script reproduce
  the previous traces bit for bit. Seed 3 still hashes to `14745a76…`, which is
  asserted on every verify run.
- Drawn sizes are clamped to a bounded multiple of the class median. An
  unclamped tail would produce requests whose reservation exceeds any single
  grant, reproducing the stranded-capacity failure through the workload rather
  than the configuration.

## 0.9.0

### Added

- Add arms 2 and 4 to the paired seed sweep via `--control-arms=static-cap,redis`
  (or `all`), exposed as `npm run demo:arms`. Every arm replays the same
  immutable trace in the same request-path position; only the admission policy
  differs. Tyr is stopped for each control arm and Redis keys are flushed
  before arm 4, so no managed-path grant or stale lease can leak into a control
  measurement.
- Add `aggregate.versusBaseline` and `aggregate.mofluxVersus` to the sweep
  summary. The second is the comparison that decides deployment: MoFlux against
  each alternative, paired per seed and then medianed.
- Add `results/arm-comparisons.json` with pairwise deltas for every arm.
  `video-comparison.json` keeps its exact baseline-versus-MoFlux shape, so
  existing consumers are unaffected.
- Add the capacity-lending benchmark: `--lending`, exposed as
  `npm run demo:lending`. Widens the idle batch window, splits the run at the
  configured batch arrival, and reports whether interactive borrowed the idle
  floor, whether the floor was reasserted when batch arrived, and what the
  handover cost. Written to `results/lending.json`.
- Add `demo/lending-lib.mjs` with the pure window arithmetic, plus
  `demo/verify-lending.mjs`, `demo/verify-control-arms.mjs`, and
  `demo/verify-arm-services.mjs` to the `verify` chain.
- Start `redis` from the paired presenter, and wait for it to answer `PING`,
  whenever a selected control arm needs it. The service is only brought up when
  arm 4 is actually in the run, so the two-arm demo is unchanged.
- Record per-class `firstAttemptAtMs`, `firstSuccessAtMs`, `admissionGapMs`,
  and a `windows` phase split in every load-generator summary.
- Record `peakActiveBySecond` in the provider simulator so occupancy can be
  scored over a window rather than only as a run-long high-water mark.

### Fixed

- **Arm 2 no longer launches with a `NaN` concurrency ceiling.** The paired
  presenter divided the provider envelope by `OPT.replicas`, but that option
  does not exist in the presenter path. Every semaphore comparison against
  `NaN` was false, so the arm rejected every attempt and produced a misleading
  all-zero result. Arm 2 now derives its replica count from the actual four
  configured replica endpoints, yielding an 8-slot local cap for a 32-slot
  envelope. The replica process also rejects non-finite or non-positive caps
  before traffic starts, and a dedicated regression covers the exact failure.

- **Phase windows are no longer derived from the pruned sample array.**
  `pruneWindows()` trims `samples` to `windowMs` on every metrics scrape, so on
  a 45-second run with batch arriving at 27 seconds the entire idle window was
  discarded before the summary was written. The generator now keeps a separate
  unpruned record and emits the split itself; the previous path reported zero
  idle goodput instead of failing.
- **Occupancy is no longer recorded as zero for seconds with no admission
  event.** A full pool can pass a whole second without an admission or a
  completion; those seconds were being backfilled with 0, claiming the provider
  had gone idle. Gaps now carry the occupancy that actually held, occupancy is
  recorded on completion as well as admission, and a 200ms sampler covers the
  rest.
- Reject an `interactiveCeiling` above the provider envelope. Passing a
  per-replica `maxConcurrent` where the fleet-wide slot count is required made
  a static cap report borrowing that never happened.
- **The Redis-coordinated arm could not run from the paired presenter.**
  `redis` is defined in `demo/compose.yaml` and was started by the standalone
  research walkthrough, but the paired presenter had never needed it and so
  never brought it up. Arm 4 failed at its first state flush. It is now started
  on demand and awaited with a real command rather than a socket connect,
  because a fresh container accepts TCP before it serves. Readiness failure and
  flush failure are also reported as distinct faults; previously a genuine
  flush error was indistinguishable from a missing container.
- Fail Redis readiness during startup rather than mid-sweep, so a missing
  container costs seconds instead of several minutes of completed arms.

### Notes

- A static split and a lending split both reach full occupancy over a whole
  run, so a cumulative peak cannot distinguish them. That case is a named test
  in `verify-lending.mjs`.
- The canonical `npm run demo` remains the two-arm sweep. The four-arm and
  lending runs are separate commands because they cost materially more wall
  clock.
- `demo/verify-arm-services.mjs` checks statically that every arm's declared
  infrastructure is actually started, awaited, and flushed. The rest of this
  chain is pure-function tests that never launch Docker, which is precisely why
  the missing Redis service was not caught before it shipped. It strips
  whole-line comments before checking call sites, so a commented-out call
  cannot pass as a live one.

## 0.8.2

### Changed

- Make `npm run demo:full` start and validate the public telemetry, Prometheus, Grafana, and Redis support stack automatically.
- Increase the support-stack readiness window to 45 seconds for cold Docker Desktop starts.
- Start the support stack before the first narrated phase, wait for the provisioned `moflux-bench` Grafana dashboard, and open its direct URL automatically.
- Add `--no-open-grafana` for headless or externally managed browser sessions.

### Fixed

- Prevent the narrated public walkthrough from failing at `http://127.0.0.1:8200` when users did not manually run `npm run stack:up` first.
- Include Docker Compose status, telemetry-relay logs, and Grafana logs when the support stack genuinely fails to start or provision the dashboard.
- Allow the public walkthrough results directory to be overridden for isolated verification runs.

## 0.8.1

### Changed

- Pin the licensed integration path and local image auto-build to Latchflo 0.5.0 while retaining Tyr 0.16.0.
- Update the example environment, runtime guard, documentation, publication checks, and mocked image-build fixtures to the new Latchflo release.

### Fixed

- Accept `latchflo-control-plane:0.5.0` as the canonical image instead of failing with the stale 0.4.2 compatibility guard.
- Migrate generated local default image tags when the benchmark runtime baseline changes, while preserving custom registry-qualified image references and credentials.
- Remove local environment, macOS metadata, and generated trace output from the publishable archive.

## 0.8.0

### Added

- Add exact `--batch-concurrency-slots` control and make one funded batch slot
  the canonical policy.
- Build missing Tyr 0.16.0 and Latchflo 0.4.2 images automatically from
  matching local source directories before falling back to a registry pull.
- Add regression coverage for local image builds and exact policy propagation.

### Changed

- **Breaking benchmark default.** Replace the nominal 24-interactive / 8-batch
  split with a fully funded 31-interactive / 1-batch split. Token budgets remain
  30,000 / 10,000, so all 32 provider slots can now be exercised.
- Make `npm run demo` fully automatic across seeds 1-5. The prior step-through
  behavior is available as `npm run demo:record`.
- Record exact interactive and batch slot counts, token-funded concurrency, and
  stranded concurrency in every MoFlux result and sweep summary.

### Fixed

- Reject policies whose token allocation funds fewer requests than their
  configured concurrency. The old 24/8 policy now fails preflight with seven
  stranded batch slots instead of silently capping provider occupancy at 25.
- Remove generated sweep output, local credentials, and macOS metadata from the
  publishable tree.

## 0.7.0

### Added

- Pin the licensed integration path to Tyr 0.16.0 and Latchflo 0.4.2.
- Generate the ignored local demo environment automatically on first
  `npm run demo`, using random credentials and the pinned image tags. Existing
  environment files are never overwritten.
- Add release-hygiene, bounded verification, and demo-environment regressions
  to the public CI path.
- Honor admission retry hints in the load generator. A rejection carrying
  `x-admission-retry-after-ms` (preferred) or `Retry-After` now sets the wait
  before the next attempt, instead of the client guessing on a blind
  exponential schedule. Pairs with Tyr 0.16.0, which emits both.
- Add `--honor-retry-hints` (default `true`). Setting it `false` forces blind
  backoff over the identical trace, so the hint's contribution can be measured
  in isolation as an exact A/B rather than inferred.
- Report `retryHints` per traffic class in the result summary: hints received,
  hints that moved the wait off blind backoff, and time spent waiting under
  each policy. `config.honorRetryHints` records the setting in every result.
- Add `load/verify-retry-hints.mjs` to the `verify` chain, covering both header
  forms, the absent-header case, the ignored HTTP-date form, the A/B switch,
  and trace stability.

### Changed

- Send Latchflo 0.4.2 `minimumGrantMaxConcurrent` and
  `minimumGrantTokenBudget` invariants whenever the presenter creates or
  promotes a pool. The values are derived from the same reservation bounds
  used by live-grant validation: 755 tokens for interactive and 9,942 for
  batch.
- Require configured image tags to identify Tyr 0.16.0 and Latchflo 0.4.2 by
  default. Registry-qualified tags are supported; digest-pinned custom names
  require the explicit `MOFLUX_ALLOW_UNPINNED_IMAGES=true` escape hatch.
- Move reviewed historical evidence under `results/curated/`; keep generated
  benchmark output ignored.
- A hint is treated as a floor, never a licence to retry sooner: the wait is
  the larger of the blind backoff and the server's estimate, spread by a
  fraction of itself so replicas do not wake together. This matches how Tyr
  itself consumes `Retry-After` from Latchflo, so the harness measures a
  well-behaved client rather than a bespoke one.

### Fixed

- Remove the committed local `.env`, macOS metadata, machine-specific result
  paths, and stale generated result files from the publishable tree.
- Align `package-lock.json` with package version 0.7.0 and restore repository
  metadata and bounded verification so the advertised release checks finish
  deterministically.
- Update all four Tyr runtime metadata declarations from 0.15.1 to 0.16.0.
- Make load-generator shutdown explicit and lossless: outstanding requests are
  aborted and awaited if the drain deadline is exceeded, the metrics server is
  closed deliberately, and the CLI no longer relies on `process.exit()` to hide
  open HTTP handles.

### Notes

- The hint spread reuses the trace's pre-drawn `retryJitter` rather than
  drawing fresh randomness. Any new draw would shift the PRNG sequence and
  change the trace hash; reusing it keeps hint-aware runs directly comparable
  to existing results. Verified: seed 3 still hashes to `14745a76...`.
- Expect completion rate to rise and tail latency to look worse. Requests that
  previously exhausted their attempts contributed no latency sample at all;
  when they start succeeding they contribute slow ones. A p95 increase
  alongside a completion increase is the fix working, not failing.

## 0.6.1

### Fixed

- Prevent first-registration lease skew from leaving later Tyr replicas without grants until the full steady-state TTL expires.
- Bootstrap Tyr enrollment with a short 5-second grant, promote both pools to the configured steady-state TTL only after all four agents are registered, and then wait for the safe rebalance.
- Validate readiness and live capacity across the entire Tyr fleet simultaneously, including a second readiness check after stats are read, so an early replica cannot expire unnoticed while later replicas become ready.
- Require every accepted grant to retain enough lease runway to finish the benchmark phase; a still-valid 5-second enrollment grant can no longer be mistaken for the promoted steady-state grant.
- Give the long fault-demo phase a 240-second lease so it cannot expire mid-run.
- Add a presenter regression that recreates the observed `sim-interactive on Tyr 8101 received 0 tokens` race and the brief all-ready overlap with a nearly expired batch enrollment grant.

## 0.6.0

### Added

- Generate and preserve one immutable request trace per seed, including logical arrival times, retry jitter, deterministic target choices, and request-level provider sample keys.
- Record exact local rejection reasons and pools, plus requested/available/budget token ranges from Tyr rejection details.
- Validate both the planned capacity split and the live Tyr grants against the initial and bounded adaptive reservation required by one request.
- Add regressions for token-fragmentation detection, trace replay, rejection diagnostics, request-keyed provider sampling, and the topology-aware pool registration.
- Preserve the original five-seed failure under `results/negative-fragmented-batch-floor*`, clearly separated from current canonical output.

### Changed

- **Breaking.** Keep `sim-interactive` on all four Tyr replicas, but register `sim-batch` only on replica 4; the no-control arm uses the same class-specific routing.
- Preserve the 32-concurrency/40,000-token fleet envelope while preventing the 10,000-token batch floor from being fragmented into four unusable 2,500-token grants.
- Decouple the batch concurrency share from the batch token share through `--batch-concurrency-percent` and `--batch-token-percent`; `--batch-floor-percent` remains a compatibility shortcut that sets both.
- Key provider input jitter, output length, and injected fault draws to the trace request seed rather than a shared arrival-order PRNG.
- Require both arms to replay the same trace hash and exact logical request counts before a paired result can be accepted.

### Fixed

- Fix the batch floor preflight, which compared a fleet-wide budget to one request instead of comparing the minimum per-agent grant.
- Fix seeded runs whose realized logical request counts and provider random draws changed with event-loop ordering.
- Isolate the presenter integration test in temporary result and environment files so an interrupted test cannot overwrite the local demo configuration.

## 0.5.0

### Added

- Add `--batch-floor-percent` to partition the fleet envelope between an interactive and a batch pool, giving batch capacity it always has regardless of interactive demand.
- Record the resolved capacity policy (`capacity.batchFloorPercent` and per-pool concurrency and token budgets) in every MoFlux arm result, so runs at different floors cannot be silently compared.
- Reject a batch floor smaller than one batch reservation at startup, rather than reporting a zero batch success rate that looks like starvation but is a misconfiguration.
- Assert fleet-wide token accounting exactly in the presenter regression, so a summary that reads one pool and omits another now fails instead of reporting a partial total.

### Changed

- **Breaking.** Replace the single shared `sim-openai` pool with partitioned `sim-interactive` and `sim-batch` pools across all four Tyr replica configs. Existing `sim-openai` state is not migrated.
- **Breaking.** The load generator now sends `sim-model-interactive` and `sim-model-batch` instead of `sim-model`, because Tyr routes to pools by model prefix only. Override with `--interactive-model` / `--batch-model`.
- Partitioned capacity is not work-conserving: an idle batch pool no longer lends capacity back to interactive. This is the cost of the floor and is stated in the narration.

### Fixed

- Token accounting summed only the single configured pool. With more than one pool it under-reported reservations, consumption, refunds, and overrun.

## 0.4.1

### Added

- Add a persistent benchmark telemetry relay inside the Compose network.
- Label client-side benchmark metrics by both arm and seed.
- Add Grafana health panels for relay scrape status, retained arms, and failed telemetry pushes.
- Add an end-to-end regression that proves baseline and MoFlux interactive p99 latency and TTFT remain exposed together after both load generators exit.
- Make the presenter verify Prometheus target health and arm-specific p99 latency/TTFT ingestion before reporting success.

### Changed

- Have the load generator push snapshots to the relay while retaining its standalone `/metrics` mode for non-demo use.
- Make Prometheus scrape the stable relay service rather than racing an ephemeral host process on port 8200.
- Show the arm and seed in the p99 latency and TTFT panel legends.

### Fixed

- Preserve MoFlux client-observed latency and TTFT telemetry in Grafana after the MoFlux load-generator process exits.

## 0.4.0

### Added

- Add `demo/seed-sweep.mjs` as the canonical licensed presentation path.
- Run fresh same-configured-scenario baseline/MoFlux pairs across seeds 1–5 by
  default, while supporting explicit lists and ranges through `--seeds`.
- Preserve raw baseline, MoFlux, and paired comparison evidence for every seed.
- Write an aggregate JSON report with medians, min/max spread, and sample counts
  for arm metrics, paired deltas, and token reconciliation.
- Add pure aggregation helpers and regression coverage for seed parsing and
  summary calculations.

### Changed

- Make `npm run demo` report a five-seed aggregate instead of a single seed-7
  observation.
- Keep `demo/present.mjs` as the verified single-pair primitive and expose it as
  `npm run demo:single`.
- Update the recording guide and results contract around paired seed sweeps.

### Fixed

- Wait for simulator self-test child processes to exit after termination so the
  next regression cannot inherit a briefly occupied benchmark port.

## 0.3.0

### Added

- Run the no-control benchmark directly inside the video presenter instead of
  delegating to the longer research walkthrough.
- Define the workload once and pass the exact same arrival schedule, request
  sizes, retry policy, provider settings, and seed to both benchmark arms.
- Stamp both result files with a shared scenario fingerprint and fail the
  comparison if the fingerprints differ.
- Report interactive goodput, p50, p95, p95/p50 tail ratio, TTFT, local rejects,
  upstream 429s, provider occupancy, and batch success in video-friendly tables.
- Write `results/video-comparison.json` with calculated same-run deltas.
- Add `npm run demo:baseline` and an end-to-end comparison regression.

### Changed

- `npm run demo` is now the canonical one-command recording path: uncontrolled
  baseline, Tyr + Latchflo enforcement, then an observed comparison.

## 0.2.2

- Reset benchmark-local Latchflo and Tyr volumes before each presenter run so stale unexpired grants cannot block successor grants.
- Add `npm run demo:reset` for explicit recovery from stale local demo state.
- Preserve state only when the presenter is deliberately invoked with `--reuse-state`.

## 0.2.1

- Scrape Tyr directly through Compose service DNS instead of host-loopback port publications that Prometheus could not reliably reach.
- Force-recreate Prometheus and Grafana at presenter startup so updated scrape and dashboard configuration is always loaded.
- Clarify that panels remain blank until a workload phase begins.

## 0.2.0

### Added

- Add a one-command presenter flow: `npm run demo` now runs a short uncontrolled
  baseline, initializes Latchflo, starts four Tyr instances, waits for active
  grants, runs the identical workload, and prints a comparison plus token
  recovery.
- Add `demo:moflux`, `demo:fault`, `demo:doctor`, `demo:full`, and `demo:down`
  commands.
- Add Tyr-native Grafana panels for in-flight requests, in-flight tokens, token
  reconciliation, capacity recovery, and grant revisions.
- Add a video-specific runbook and narration in `demo/VIDEO-DEMO.md`.

### Fixed

- Classify Tyr responses containing `x-admission-reason` as local admission
  rejections rather than upstream provider 429s.
- Create or update the Latchflo pool before starting Tyr, eliminating the
  permanent `unknown pool` registration failure.
- Default the local video overlay to a writable Tyr runtime user so a fresh
  named volume does not fail to persist the rotated Latchflo agent token.
- Measure token recovery as a per-run delta rather than reporting lifetime
  counters left by earlier presentations.

## 0.1.1

### Fixed

- Treat an SSE response that terminates after headers as a retryable transport
  failure. Killing a replica during a fault-injection phase no longer crashes
  the load generator with Undici's `TypeError: terminated`.
- Delete an arm's previous result before starting it and stop the walkthrough
  when the load generator exits unsuccessfully. A failed run can no longer be
  reported using stale sample JSON.

### Added

- Regression coverage that drops active streaming sockets and verifies that the
  load generator records transport errors, retries, writes its summary, and
  exits normally.

## 0.1.0

- Initial public benchmark harness.
