# Curated evidence

Only intentionally reviewed evidence belongs here. Generated benchmark output elsewhere under `results/` is ignored by Git.

## Historical negative result

`negative-fragmented-batch-floor/` preserves the five-seed version 0.5.0 failure that exposed batch-token fragmentation and baseline nondeterminism. It is retained because the failure informed the corrected topology and trace-replay design.

This directory contains historical negative evidence only; it is **not** the current licensed MoFlux performance corpus. Do not treat these files as evidence for the current harness. Current reviewed comparisons live under their explicitly published top-level `results/<evidence-name>.json` and companion directories, and new runs become reviewed evidence only through deliberate promotion.
