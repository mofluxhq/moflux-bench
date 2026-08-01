# Changelog

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
