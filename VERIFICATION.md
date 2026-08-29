# MoFlux Bench 0.29.0 verification

Verified 2026-08-29 with Node.js 22.16.0 and npm 10.9.2.

## Passed

- `npm run check`: syntax check passed for 87 JavaScript modules.
- `npm run verify:publication`: publication hygiene passed after removing local-only `.env` state and generated `results/runs/` evidence from the release tree.
- All 42 component checks declared by `scripts/verify.mjs` passed. The one-shot runner was externally interrupted after its first six checks, so the remaining checks were executed in bounded batches; the long `demo/verify-presenter.mjs` check was then run separately to completion. No declared component check was skipped.
- `npm run sweep`: analytic simulator sweep passed with a worst observed deviation of 4.1% from the predicted curve.
- `node demo/verify-openai-live.mjs`: paired direct/Tyr compatibility execution, streamed usage accounting, API-key non-disclosure, fail-before-request cost refusal, and the absolute $1 per-run override ceiling passed against local mock OpenAI-compatible SSE servers.
- `node demo/verify-openai-overload.mjs`: deterministic matched traces, cross-seed prompt separation, fail-fast static-cap contention, Tyr admission-class attribution, separately sampled baseline behavior, sustained-RPS calibration pressure detection, drain-tail false-positive protection, mandatory per-stage/per-arm recovered-headroom gating including an actual depleted-bucket wait/reprobe path and fail-closed missing-header behavior, legacy burst compatibility, API-key non-disclosure, and fail-before-request spend refusal passed against local mock OpenAI-compatible SSE servers.
- `node demo/verify-openai-overload-sweep.mjs`: deterministic six-permutation counterbalanced arm ordering, 8-seed first/middle/last position balance, pooled raw-record aggregation across differing arm order, exact logical outcome counts, paired per-seed deltas, duplicate/configuration/inconclusive refusal, two-seed zero-request orchestration, and aggregate sweep spend refusal passed.
- `npm run demo:openai:dry-run`: sent zero API requests and calculated a conservative default worst-case cost of $0.001629 for 16 planned compatibility calls.
- `npm run demo:openai:overload:dry-run`: sent zero API requests and calculated a conservative default worst-case cost of $0.058926 for up to 204 planned requests: 186 workload requests plus 18 reserved recovery probes across direct, static-cap, and Tyr protected-class arms.
- `npm run demo:openai:overload:calibrate:dry-run`: sent zero API requests and calculated a conservative worst-case cost of $0.090868 for up to 1,054 requests: the 1,024-request sustained workload plus 30 reserved recovery probes.
- `npm run demo:openai:overload:sweep:dry-run -- --seeds=1-8 --interactive-rps=10 --batch-rps=70 --batch-start-ms=2000 --batch-duration-ms=8000 --interactive-input-chars=64 --batch-input-chars=64 --interactive-max-output-tokens=8 --batch-max-output-tokens=8 --static-cap=36 --moflux-max-concurrent=36 --interactive-floor=8 --batch-floor=4 --rate-limit-start-headroom-ratio=0.99 --max-usd-per-seed=0.18 --max-sweep-usd=1.50`: validated eight independent counterbalanced plans with zero API requests; seeds 1-6 exercised all six arm permutations, seeds 7-8 repeated the first two, each seed still reserves 1,998 requests and a $0.18 hard cap, and the sweep reserves at most $1.44 against its $1.50 aggregate ceiling.
- A default generated 8-concurrency / 6-interactive-floor / 2-batch-floor overload Tyr config was built from `renderTyrOverloadConfig` and accepted by the Tyr 0.28.0 CLI validator (`configuration valid`).
- The release archive was checked to contain no `.git`, `node_modules`, local `.env` files, `.DS_Store`, `__MACOSX`, or generated `results/runs/` artifacts.

## Not executed in this build environment

- The paid live `npm run demo:openai` and `npm run demo:openai:overload*` provider runs were not executed because no OpenAI API key was supplied to the build environment. Live validation used zero-request dry runs plus local OpenAI-compatible mock servers.
- The Docker-backed Tyr overload stack was not started because the `docker` command is not installed in this environment. Its generated default YAML was validated directly with the Tyr 0.28.0 CLI, and request/class behavior is covered by the local overload harness verifier.
- The overload comparison therefore has no real-OpenAI efficacy result in this release. A live run must not be described as conclusive unless its result JSON reports `interpretation.conclusiveProviderOverloadComparison=true`.

## OpenAI pricing basis

The bundled default model is `gpt-5.6-luna`. Pricing was reviewed on 2026-08-28 against OpenAI's model documentation at:

`https://developers.openai.com/api/docs/models/gpt-5.6-luna`

The reviewed rates are $0.20 per million input tokens and $1.20 per million output tokens. Both live harnesses require explicit input and output prices for any model not present in their reviewed pricing tables. The spend guards protect only the planned invocation; they do not know or enforce account-wide monthly spend.
