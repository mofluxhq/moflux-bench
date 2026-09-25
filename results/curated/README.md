# Curated evidence

Only intentionally reviewed evidence belongs here. Generated benchmark output elsewhere under `results/` is ignored by Git.

## vLLM Metal long-context paired runs (0.45.0 / 0.45.1)

[vllm-metal-long-context/](vllm-metal-long-context/README.md) retains both the
passing five-seed run and its valid but failing repeat. The repeat fails H2:
median paired interactive SLO goodput is 0.20 req/s below native priority,
outside the 0.04 req/s allowance. Batch arrival-cohort yield improves over static
in both runs. The paired README documents counts, spread, reporting corrections,
source hashes, and the recorded macOS change; the first pass was not reliably
reproduced.

## Historical negative result

`negative-fragmented-batch-floor/` preserves the five-seed version 0.5.0 failure that exposed batch-token fragmentation and baseline nondeterminism. It is retained because the failure informed the corrected topology and trace-replay design.

## One-slot headroom lend (0.44.0)

`headroom-policy-comparison-v0.44.0-20260924T225251Z-lend1.json` compares plain `adaptive-28-4` with `adaptive-headroom-28-4-lend1` over five seeds of the headroom exercise workload, on Tyr 0.33.0 and Latchflo 0.19.0. Its input sweeps are `moflux-seed-sweep-v0.44.0-20260924T225251Z-adaptive` and `moflux-seed-sweep-v0.44.0-20260924T225251Z-headroom-lend1`, each with a `.json` summary and per-seed directory. The comparison fails two checks. Median interactive p95 rose 11.5% against a 10% limit. Median headroom batch completions were 11 where 12 were needed; two seeds completed fewer batch requests than the plain profile.

The profile was added on a wrong premise. The two-slot profile's p95 cost was attributed to about two extra batch streams on the shared simulated provider. The extra active-stream count also includes interactive requests, which accumulate as each one slows down. A Little's-law estimate puts about half of the increase on interactive. Both profiles add about one batch stream: a median of +0.9 with one slot and +0.8 with two. That is what `effectiveFundedDemandingLend: 1` predicts for both, since the lent tokens fund one extra batch reservation either way, so a one-slot cap had nothing to remove. Three unpublished two-slot comparisons gave whole-run p95 changes of +13.4% to +15.6%. This run's +11.5% is 1.9 points below the lowest of them, a gap one run cannot separate from noise. Its contended-window p95 change, +9.6%, lies inside the two-slot range of +8.4% to +15.1%.

What the result does show: on this provider at this load, one extra batch stream during contention costs interactive roughly 10-15% p95. That includes the added load from interactive requests piling up.

The historical artifacts above retain their recorded harness versions. The paired vLLM corpus includes a pass and a failed repeat; it is not a claim of reliable current performance. Current reviewed comparisons live under their explicitly published top-level `results/<evidence-name>.json` and companion directories, and new runs become reviewed evidence only through deliberate promotion.
