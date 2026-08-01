# Negative result: fragmented batch floor

These files preserve the five-seed `moflux-bench` 0.5.0 run that exposed the
batch-floor defect. They are evidence of the failure, not results produced by
the corrected 0.8.x harness.

In this run, all four Tyr replicas registered for `sim-batch`. Latchflo divided
the 10,000-token fleet budget into approximately 2,500 tokens per replica,
while one batch request required an initial 9,008-token reservation. Every
batch attempt was therefore rejected locally and batch success was 0% in all
five seeds. Peak provider concurrency stopped at 24 because the eight batch
concurrency slots could not be used.

The baseline arm also drifted between separate sweeps despite matching
configuration fingerprints. Version 0.6.0 and later address that measurement defect by
creating one immutable request trace per seed, replaying it through both arms,
and keying provider samples to request-level seeds.

Do not compare these files directly with a current 0.8.x run as though only the capacity
policy changed. The workload realization and provider sampling methodology also
changed. Re-run `npm run demo` to produce current evidence under the canonical
`results/video-seed-sweep*` paths.
