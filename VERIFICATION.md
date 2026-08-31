# MoFlux Bench 0.30.0 verification

Verified 2026-08-30 with Node.js 22.16.0 and npm 10.9.2.

## Passed

- `npm run check`: syntax check passed for 89 JavaScript modules.
- `npm run verify:publication`: publication hygiene passed after removing the generated local-only `demo/moflux/.env`. Generated `results/runs/` output remains outside the release archive. The historical `results/curated/README.md` wording was deliberately refreshed as documentation only; the retained negative-evidence data files were not rewritten.
- All 43 component checks declared by `scripts/verify.mjs` passed on the corrected 0.30.0 code. They were executed in bounded batches because the one-shot runner can exceed this build environment's command window at the intentionally long drain verifier. After the final documentation-only cleanup, a one-shot rerun again reached the long drain verifier before the external timeout; the code under test had not changed since the complete 43-check pass.
- `node sim/verify-openai-responses.mjs`: provider-simulator `POST /v1/responses` compatibility passed for non-streaming responses, semantic Responses SSE events, and `input_tokens`/`output_tokens` usage accounting.
- `node demo/verify-openai-live.mjs`: both the default Responses API and retained Chat Completions compatibility paths passed against local mock OpenAI-compatible SSE servers, including direct/Tyr request shape, streamed usage accounting, API-key non-disclosure, fail-before-request cost refusal, and the absolute $1 per-run override ceiling.
- `node demo/verify-openai-overload.mjs`: canonical 80-RPS shared-capacity defaults, the explicit full-floor warning, deterministic matched traces, cross-seed prompt separation, fail-fast static-cap contention, Tyr admission-class attribution, separately sampled baseline behavior, sustained-RPS calibration pressure detection, drain-tail false-positive protection, mandatory per-stage/per-arm recovered-headroom gating including an actual depleted-bucket wait/reprobe path and fail-closed missing-header behavior, legacy burst compatibility, API-key non-disclosure, and fail-before-request spend refusal passed against local mock OpenAI-compatible SSE servers. The reviewed overload methodology intentionally remains on Chat Completions for continuity with the 0.29.0 evidence corpus.
- `node demo/verify-openai-overload-sweep.mjs`: deterministic six-permutation counterbalanced arm ordering, 8-seed first/middle/last position balance, pooled raw-record aggregation across differing arm order, exact logical outcome counts, paired per-seed deltas, duplicate/configuration/inconclusive refusal, canonical-profile zero-request orchestration, and aggregate sweep spend refusal passed.
- `npm run sweep`: final analytic simulator sweep passed with a worst observed deviation of 2.6% from the predicted curve.
- `npm run demo:openai:dry-run`: default Responses compatibility sent zero API requests and calculated a conservative default worst-case cost of $0.001629 for 16 planned calls.
- `npm run demo:openai:chat -- --dry-run`: retained Chat Completions compatibility sent zero API requests and calculated the same conservative $0.001629 worst-case cost for 16 planned calls.
- `npm run demo:openai:overload:dry-run`: sent zero API requests and calculated a conservative default worst-case cost of $0.168320 for 1,998 planned requests: 1,980 workload requests plus 18 reserved recovery probes across direct, static-cap, and Tyr protected-class arms. The canonical policy is 36 physical slots with 8 interactive + 4 batch protected floors, leaving 24 shared slots for borrowing.
- `npm run demo:openai:overload:calibrate:dry-run`: sent zero API requests and calculated a conservative worst-case cost of $0.090868 for up to 1,054 requests: the 1,024-request sustained workload plus 30 reserved recovery probes.
- `npm run demo:openai:overload:sweep:dry-run`: validated all eight default counterbalanced seed plans with zero API requests. Every seed plans the same 1,998-request / $0.168320 canonical comparison; the default sweep reserves at most $1.44 across eight $0.18 per-seed ceilings against its $1.50 aggregate ceiling.
- Tyr 0.29.0 CLI validation accepted the managed four-replica config, tenant-class config, and a generated 36-concurrency / 8-interactive-floor / 4-batch-floor OpenAI overload config. The validator reports `/v1/messages`, `/v1/chat/completions`, and `/v1/responses` as active routes for the updated benchmark configs.

## Not executed in this build environment

- Paid live `npm run demo:openai` and `npm run demo:openai:overload*` provider runs were not executed because no OpenAI API key was supplied to the build environment. Live-path validation used zero-request dry runs plus local OpenAI-compatible mock servers.
- The Docker-backed licensed stack was not started because the `docker` command is not installed in this environment. Its current Tyr 0.29.0 YAML was validated directly with the Tyr CLI, and request/class behavior is covered by the local harness verifiers.
- This release does not replace the reviewed 0.29.0 real-OpenAI overload evidence with Responses API efficacy evidence. `/v1/responses` is added as the default compatibility path and simulator surface; the overload experiment remains on Chat Completions so protocol changes do not silently invalidate longitudinal comparison. A future paid Responses overload run must satisfy the same conclusive-evidence gates before being presented as efficacy evidence.

## OpenAI pricing basis

The bundled default model is `gpt-5.6-luna`. Pricing was reviewed on 2026-08-28 against OpenAI's model documentation at:

`https://developers.openai.com/api/docs/models/gpt-5.6-luna`

The reviewed rates are $0.20 per million input tokens and $1.20 per million output tokens. Both live harnesses require explicit input and output prices for any model not present in their reviewed pricing tables. The spend guards protect only the planned invocation; they do not know or enforce account-wide monthly spend.
