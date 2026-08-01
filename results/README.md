# Results

Generated benchmark output is written under this directory and ignored by Git. Intentionally published evidence belongs only under `results/curated/` after review.

Do not publish a single run as representative evidence. Use at least five seeds, report medians with spread, retain every paired raw result and immutable trace, and record the exact command, Node version, Docker image versions, seed list, capacity policy, and aggregation method. Runs with a saturated load generator are invalid.

## Licensed video seed sweep

`npm run demo` runs five matched seed pairs and writes:

- `video-seed-sweep.json` — aggregate medians, min/max spread, per-seed scenario metadata, and references to raw evidence;
- `video-seed-sweep/baseline-seed-N.json` — no-control arm output;
- `video-seed-sweep/moflux-enforce-seed-N.json` — managed arm output;
- `video-seed-sweep/comparison-seed-N.json` — same-seed calculated deltas;
- `video-seed-sweep/trace-seed-N.json` — immutable logical arrival and retry evidence.

Every pair must have the same `scenario.id` and trace hash, and each arm's logical request counts must equal the trace's planned counts. The sweep fails rather than aggregates when those checks differ, a required file is missing, or the load generator reports saturation.

The aggregate includes median, minimum, maximum, and sample count for arm-level metrics, paired changes, and token accounting. The underlying arms replay the same immutable logical request trace; real-clock execution timing may still vary.

Each MoFlux arm records the resolved capacity policy under `capacity`, including the 31/1 slot split, batch token percentage, token-funded concurrency, stranded concurrency, pool agent count, minimum usable local grant, reservation bounds, and the live grants observed before the run. `batchFloorPercent` is retained only when both shares are equal. Keep the complete policy with any published comparison.

The MoFlux result contains per-run token-accounting deltas:

- `grossRecoveryRate = refunded / reserved`
- `netRecovered = refunded - overrun`
- `netRecoveryRate = netRecovered / reserved`

A refund means unused safety reservation was returned for reuse; it is not newly created capacity.

## Curated evidence status

`curated/negative-fragmented-batch-floor/` preserves the version 0.5.0 five-seed failure that motivated the topology and determinism remediation. It is historical negative evidence, not a current comparison.

No valid version 0.9.0 four-arm licensed sweep is committed yet. The first
local run of Arm 2 used a non-finite semaphore cap and was intentionally
discarded rather than curated. Run `npm run demo:arms` again with the fixed
v0.9.0 harness, review all five same-trace arms, and only then add current
evidence under `curated/`.

## Public research replication

`npm run replicate` writes public-arm runs under `replicates/` and aggregates them with `scripts/aggregate.mjs`. This is separate from the licensed video seed sweep.
