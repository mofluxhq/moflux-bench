# MoFlux Bench 0.33.2 verification

Verified 2026-09-04 in this build environment with Node.js 22.16.0 and npm 10.9.2.

MoFlux Bench 0.33.0 introduced the local-inference contention benchmark in
`demo/local-contention.mjs`; 0.33.1 corrected phase/proof semantics from the first
real seed, and 0.33.2 corrects a remaining H4 attribution false positive exposed
by the next seed-1 rerun. The workload, SLO thresholds, and runtime pins remain
unchanged. H4 now distinguishes new borrowing backed by another class's explicitly
released capacity from new borrowing that would consume restored protected capacity.
The benchmark remains separate from the 0.32.0 local compatibility path.

## Passed

- `npm run check`: syntax check passed for 99 JavaScript modules.
- `npm run verify:local:contention`: passed, including a regression fixture for the
  0.33.1 H4 false positive where batch borrowing is backed by its own explicitly
  released concurrency rather than by the restored interactive floor.
- All 46 component verifiers listed by `scripts/verify.mjs` passed. The suite was
  executed in groups in this build environment so the outer command runner did
  not terminate the long integration sequence; this included
  `demo/verify-local-contention.mjs`, `demo/verify-local-inference.mjs`,
  `demo/verify-tenant-fairness.mjs`, `demo/verify-restoration-enforceability.mjs`,
  `demo/verify-presenter.mjs`, `demo/verify-seed-sweep-runner.mjs`, and
  `demo/verify-demo-command.mjs`.
- `npm run verify:publication`: publication hygiene passed for 300 files.
- The contention `:doctor` path was checked to remain side-effect free: when
  Docker is unavailable it reports the preflight failure without creating
  `demo/moflux/.env`, so running doctor no longer poisons the publication check.
- `npm run sweep`: analytic simulator sweep passed within tolerance; worst
  deviation from the analytic curve was 4.1%.
- `npm run demo:local:contention:dry-run`: passed. The five-seed plan is
  counterbalanced across `direct`, `static`, and `moflux`, and no inference
  request is sent by the dry run.

## Local contention benchmark contract

The contention benchmark replays one deterministic five-phase trace against three arms:

| Arm | Path | Policy |
| --- | --- | --- |
| `direct` | client → Ollama | no MoFlux admission control |
| `static` | client → Tyr → Ollama | fixed per-class protected floors, never lent |
| `moflux` | client → Tyr → Ollama | the same floors, lent while idle and restored on demand |

`static` and `moflux` use the same physical ceiling and the same class floors.
The intended policy variable is Latchflo's `admissionClassDemandPolicy`.

The workload is warm-up plus four measured phases: interactive-only from 0–25 s,
batch with interactive idle from 25–60 s, overlapping interactive + batch
contention from 60–85 s, then recovery/drain to 105 s. The optional second
interactive arrival window is trace version 3; the verification suite confirms
that historical version-1 and version-2 trace hashes remain unchanged.

The benchmark owns its acceptance result. The top-level `passed` mirrors
`localContentionProof` rather than borrowing an unrelated proof object. Per-seed
gates cover trace validity, actual contention, protected-floor and allocation
invariants, lending/restoration evidence, lease-gap bounds, and handoff safety.
Across seeds, H1 and H2 are allowed to fail honestly. H1 requires at least
+0.04 req/s of interactive contention-window SLO goodput over direct Ollama; a
useful request must succeed with TTFT <= 5 s and completion latency <= 30 s.
H2 requires at least 1.2x the static arm's batch completions while interactive
demand is idle. Phase membership uses immutable trace arrival time, so long
queued requests cannot disappear into a later phase merely because they finish
late.

## Evidence boundary

Every local-contention summary carries explicit `evidenceLimits`. The benchmark
may support claims about admission behaviour, protected capacity, lending,
restoration at the admission layer, goodput, and caller-visible latency. It does
not establish GPU preemption, GPU utilization, KV-cache reclamation, Ollama
scheduler preemption, upstream compute reclamation, production-scale behaviour,
or generalization beyond the tested local model and host.

No `results/local-inference-contention.json` evidence artifact is created by the
release itself. A run writes only beneath
`results/runs/local-inference-contention/<run-id>/`; publication is a separate
explicit promotion:

```bash
npm run demo:local:contention
npm run evidence:publish -- --as=local-inference-contention
npm run verify:publication
```

The reviewed publication paths are registered separately from
`results/local-inference-compatibility*`, so compatibility evidence cannot be
silently replaced by contention evidence.

## Locality and credential safety

The local contention runner does not accept direct, Tyr, or Ollama endpoint
override flags. Its arm endpoints, Ollama endpoint, and Latchflo endpoint are
local constants and are passed through the locality guard before any benchmark
request. It reads no OpenAI or Anthropic provider credential. Publication
verification fails if a hosted-provider credential or a remote-endpoint override
is introduced into this path.

The contention compose stack publishes Ollama on host port 11436, distinct from
the host default 11434 and the compatibility benchmark's 11435. The model volume
is external so teardown can remove control-plane state without deleting the
weights cache.

## Not executed in this build environment

- The user-provided real seed runs were used as diagnostic input for 0.33.1 and
  0.33.2, but neither is publication evidence. No diagnostic result is promoted
  or rewritten as a passing 0.33.2 result.
- `npm run demo:local:contention:doctor` reached its environment preflight and
  correctly failed because Docker is not installed in this sandbox. Therefore
  no real Ollama/Tyr/Latchflo contention run was executed here, and this
  verification does not claim an H1/H2 workload-isolation result.
- No new `results/local-inference-contention*` evidence was published or
  manufactured.
- Paid live OpenAI provider runs were not executed; no provider API key was
  supplied.

The implementation-level local-contention verifier is intentionally Docker-free
and passed. A publication-quality workload-isolation claim still requires the
real five-seed `npm run demo:local:contention` run on a host with Docker and the
licensed Tyr/Latchflo images available.
