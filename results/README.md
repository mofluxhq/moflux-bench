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

## Admission-class lending runs

`npm run demo:classes` writes four matched arms under
`results/runs/tenant-fairness/<run-id>/`: pool-only, class ceilings, static
protected floors, and adaptive protected floors. Each seed also writes
`adaptive-lending-seed-N.json`, which samples Latchflo class-demand/lending state
and the aggregate class limits actually applied by Tyr. The schema-version-3
`summary.json` records the lend -> demand -> restore proof and restoration
latency separately from performance observations. These runs are generated
evidence and are not automatically promoted into the reviewed corpus.

## Published evidence status

`video-seed-sweep.json` and `video-seed-sweep/` hold the reviewed five-seed
heterogeneous four-arm run published at 0.10.0. Each per-seed file records the
runtime that produced it in its own `runtime` field; those read **Tyr 0.17.0 and
Latchflo 0.5.1**. Read that field rather than any prose description — prose drifts,
and an earlier revision of this file and of `.gitignore` both described this
corpus as Tyr 0.16.0 / Latchflo 0.5.0, which the files themselves contradict.

New licensed runs use Tyr 0.24.0, Latchflo 0.10.0,
async-bulkhead-llm 3.15.1, and async-bulkhead-ts 1.0.1. The main sweep retains
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
