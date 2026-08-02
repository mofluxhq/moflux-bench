# Video demo: paired seed sweep

The canonical recording path runs the same benchmark comparison across five
seeds. Each seed is a fresh pair:

1. four transparent application replicas with no admission control;
2. four Tyr instances for interactive traffic, with replica 4 also carrying the batch pool, governed by Latchflo;
3. preservation of both raw results and their same-seed comparison.

After all pairs finish, the presenter reports medians with min/max spread. This
avoids presenting seed 7—or any other single run—as representative evidence.

For each seed, the presenter writes one immutable trace containing every
logical arrival, retry-jitter value, replica-selection draw, and request-level
provider sample key. The baseline and MoFlux arms replay that same trace.
Admission decisions can still change attempt timing and which attempts reach
the provider, but they cannot change the logical request population or random
request characteristics.

## Runtime compatibility and setup

The presenter is pinned to Tyr 0.18.0 and Latchflo 0.6.0. `npm run demo`
creates the ignored local env file and random demo credentials automatically.
Tyr capacity-aware routing is enabled across the four private replica addresses
with one generated local-only `TYR_ROUTING_SECRET`. Latchflo continues to
distribute grants; it does not distribute routing topology or the secret.
If a pinned image is missing, the command builds it from a matching sibling
source repository (or from `MOFLUX_TYR_SOURCE_DIR` /
`MOFLUX_LATCHFLO_SOURCE_DIR`) before attempting a registry pull.

The overlay defaults `MOFLUX_TYR_USER=0:0` so fresh Docker named volumes are
writable during a local screen recording. This is a demo convenience, not the
recommended production runtime identity.

## Record the five-seed comparison

```bash
npm run demo
```

The command uses seeds 1–5. Before each seed pair it clears benchmark-local
Latchflo/Tyr state, then the verified single-pair presenter:

1. validates Docker, Compose, licensed images, and configuration;
2. starts Latchflo, the telemetry relay, Prometheus, and Grafana;
3. creates or updates `sim-interactive` and `sim-batch` with a short enrollment lease, an exact 31/1 concurrency split, 30,000/10,000 token budgets, and Latchflo 0.6.0 minimum-grant floors (1 slot; 755 interactive tokens; 9,942 batch tokens);
4. runs the no-control arm;
5. replaces passthrough replicas with Tyr, waits for all four registrations,
   promotes the pools to the steady-state lease, and waits for one simultaneous
   fleet-wide grant set in which all four interactive grants and the single
   batch grant can each admit one request and remain valid through the run;
6. replays the exact baseline request trace through MoFlux;
7. rejects mismatched trace hashes, request counts, grant sizes, or generator-saturated runs;
8. reports interactive goodput, latency, TTFT, reject location, provider
   occupancy, batch success, and token reconciliation.

The sweep copies each successful run out of the presenter's scratch filenames
before continuing. At the end it writes:

- `results/video-seed-sweep.json` — aggregate statistics and per-seed references;
- `results/video-seed-sweep/baseline-seed-N.json` — raw baseline evidence;
- `results/video-seed-sweep/moflux-enforce-seed-N.json` — raw MoFlux evidence;
- `results/video-seed-sweep/comparison-seed-N.json` — paired deltas;
- `results/video-seed-sweep/trace-seed-N.json` — the immutable offered workload.

The canonical command runs without prompts. Use `npm run demo:record` when you
want to pause before each seed and each presenter scene.

## Choose a different sweep

```bash
node demo/seed-sweep.mjs --seeds=3,7,11 --step
node demo/seed-sweep.mjs --seeds=10-14 --pause-ms=2500
```

`--seed=7` remains available for a backward-compatible single-seed run. Use
`npm run demo:single` to invoke the underlying one-pair presenter directly.

The default is `--batch-concurrency-slots=1 --batch-token-percent=25`, producing
31 interactive slots and one funded batch slot. Percentage-based concurrency
flags remain available for experiments, but preflight rejects any policy whose
tokens cannot fund every nominal slot. Set `MOFLUX_BENCH_RESULTS_DIR` to a
distinct directory for each policy so one sweep does not overwrite another.

## Rehearse one arm

```bash
npm run demo:baseline
npm run demo:moflux
```

These remain quick, single-seed rehearsals. Explicit arm-only sweeps are also
available:

```bash
npm run demo:sweep:baseline
npm run demo:sweep:moflux
```

Only `mode=compare` produces paired deltas.

## Fault scene and fault sweep

```bash
npm run demo:fault
npm run demo:sweep:fault
```

The first command records one longer replica-failure scene. The second repeats
that comparison across five seeds. Both kill `bench-tyr-r3` without a clean
shutdown. Safe capacity handoff is lease-bounded, so the phase is intentionally
longer than the normal comparison.

## Demand-aware lending scene

```bash
npm run demo:lending
```

This is a separate five-seed comparison because it changes the control-plane
policy and lease cadence. The reference arm is an exact static 28/4 partition
with interactive caps of 7/7/7/7. The MoFlux arm creates a Latchflo 0.6.0 demand-aware capacity group, receives
live demand snapshots from Tyr 0.18.0, and uses short renewable leases so a
returning four-slot batch floor can be observed inside the contended window.
The lending command uses a 64,000-token envelope with 24,000 interactive and
40,000 batch guaranteed tokens so all 28 interactive and four batch slots are
funded for the current request shapes.

The command does not infer lending from configuration or a run-long 32/32 peak.
It requires idle-window occupancy above the static 28-slot ceiling and a
matching `capacity_group.lending_observed` event. Floor restoration requires
both controller evidence and completed batch work. Missing either proof makes
the run inconclusive or failed, not successful.

## Suggested narration

Opening:

> A single benchmark run can be lucky or unlucky, so this demo uses five
> matched seeds. For each seed I first run four transparent replicas with no
> admission control, then replay the exact same logical request trace through
> Tyr and Latchflo. I will report the median and the full min-to-max spread, not select
> the most favorable run.

Transition within a seed:

> That was this seed's no-control arm. The replicas forwarded every request and
> made no admission decision. I am replacing them with four Tyr instances. All
> four carry interactive traffic, and replica 4 also carries batch. Latchflo coordinates global concurrency and in-flight token capacity outside
> the request path; Tyr makes each admission decision locally.

Closing:

> These are medians across five paired seeds, with min and max shown beside
> every value. The raw run for every seed remains available for inspection.
> Local rejection avoids spending provider capacity on work the provider would
> reject later. Token refunds are unused safety reservations returned for
> reuse—not newly created capacity.

## Grafana and cleanup

Grafana opens during the first seed. The load generator pushes client-observed
latency, TTFT, goodput, retry, and rejection metrics into a persistent relay.
That relay keeps the baseline and MoFlux series visible together after each arm
exits; it resets when the next fresh seed pair starts. The dashboard's
**Benchmark telemetry pipeline** panel must read `1`, **Retained benchmark
arms** should reach `2` after the pair, and **Telemetry push failures** must stay
at `0`. Confirm the `loadgen-telemetry` target at
`http://localhost:9090/targets` when diagnosing blank panels.

Stop the stack afterward:

```bash
npm run demo:down
```

For debugging the underlying one-pair presenter with durable state preserved:

```bash
node demo/present.mjs --mode=compare --step --reuse-state
```
