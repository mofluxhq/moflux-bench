# MoFlux Bench 0.34.0 verification

Verified 2026-09-04 in this build environment with Node.js 24.18.0, npm 12.0.1,
Docker 29.7.2, and the pinned Tyr 0.30.0 / Latchflo 0.15.0 / Ollama 0.12.3
images present locally.

MoFlux Bench 0.33.0 introduced the local-inference contention benchmark in
`demo/local-contention.mjs`; 0.33.1 corrected phase/proof semantics from the
first real seed and 0.33.2 corrected an H4 attribution false positive. 0.34.0 is
an **instrumentation, benchmark-semantics and reliability** release. Its purpose
is to make `demo:local:contention` trustworthy enough to decide whether the
MoFlux restoration policy needs changing, not to change it.

The experiment is deliberately unchanged: same workload timing, same interactive
and batch RPS, same 3/1 protected concurrency, same token floors, same physical
concurrency of 4, same 15 s grant TTL and 15 s restoration SLO, same H1
(+0.04 req/s SLO goodput) and H2 (1.2x) thresholds, and the same five
publication seeds.

## What changed, and why each was a correctness problem

| Area | 0.33.2 behaviour | 0.34.0 |
| --- | --- | --- |
| Sweep credentials | one JWT minted per process with a one-hour expiry; a five-seed sweep runs longer | re-minted on access as expiry approaches, distinct `jti` per mint |
| Warm-up failures | `(last HTTP 401)` and nothing else | structured, publishable diagnostics; one forced-refresh retry, both attempts recorded |
| Demand return | detected from admissions and in-flight only | also from rejections and the controller's demand state |
| Restoration episodes | could report `restoredAtMs` with `demandReturnedAtMs` null and count neither | four disjoint outcomes; passive returns never counted as restorations |
| Restoration latency | grant-side only | grant-side **and** occupancy-side, both SLO-checked |
| Post-demand borrowing | measured against the *applied* floor | measured against the *nominal* partition, with a ratcheting entitlement |
| Empty distributions | `ttftP95Ms: 0` | `null`; counts and rates stay numeric |
| H4 | one combined gate | H4a transfer safety, H4b post-demand borrowing; `h4` retained as their conjunction |
| Failed loadgen | non-zero exit collapsed to `exit N` | bounded stdout/stderr tail in error + persisted per-arm `.loadgen.log`, with argv excluded |


The host-supervision regression also exercises persistent child diagnostics: both stdout and stderr survive to the log, while an intentionally secret argv value does not. `demo/verify-local-contention.mjs` pins the local-contention runner to emitting a `.loadgen.log`, carrying `childOutputTail(child)` in the error, and naming the persisted log path.

A follow-up real sweep exposed the first non-zero loadgen exit through this path: seed 3 direct hit the unchanged 300 s drain ceiling with one batch stream still active. The child diagnostic was preserved, but the wrapper then called `repoRelative(diagnosticsFile)` without `ROOT` and threw a secondary `ERR_INVALID_ARG_TYPE`. The unreleased 0.34.0 tree now passes `ROOT` explicitly and the verifier pins the call so the original loadgen failure and persisted log path remain visible.

## Root causes established from the 0.33.2 evidence

The 0.33.2 five-seed run was used as diagnostic input. It is not publication
evidence, it was not promoted, and no result from it is rewritten as a passing
0.34.0 result.

1. **The HTTP 401 was an expired benchmark credential, not a control-plane
   fault.** `startIdentityFixture` minted with `exp = iat + 3600` once, before
   seed 1. The run began at 04:51:46Z; seed 5's MoFlux warm-up ran at 05:56:19Z,
   64 minutes later. The `direct` arm ran first in seed 5's counterbalanced
   order and needs no credential, which is why the failure surfaced on the first
   managed arm of the last seed.
2. **The seed-4 violation at 29.896 s was a false positive.** Batch's applied
   protected floor was 0 because batch's own one-slot floor had been lent away
   while batch was idle, so its first request of the borrow phase reported
   `borrowedConcurrent: 0 -> 1` while occupying nothing but the single slot batch
   owns outright. The interactive floor was whole at 3 with 1 in use. The 0.33.2
   allowance for contemporaneously released non-interactive capacity missed it by
   one sample because Latchflo had already withdrawn batch's release before Tyr
   applied the restored floor.
3. **`restorationRequiredEpisodes = 0` was an artifact of the demand predicate.**
   In every seed the interactive class returned at 60 s to a pool whose four
   slots were all held by batch requests admitted before the lend, was refused on
   every attempt, and so was never admitted and never in flight. Measured by
   admissions it looked idle for the entire contention window.

Re-analysing the same 0.33.2 sample series with the 0.34.0 accounting yields one
restoration-required episode per seed, a grant-side restoration latency of
0–394 ms, and an occupancy-side latency of 15.5–41.7 s — every one of them a
breach of the 15 s objective. That is the finding the release exists to make
visible, and it is a finding about the policy rather than about the benchmark.

## Local contention benchmark contract

Three arms replay one deterministic five-phase trace:

| Arm | Path | Policy |
| --- | --- | --- |
| `direct` | client → Ollama | no MoFlux admission control |
| `static` | client → Tyr → Ollama | fixed per-class protected floors, never lent |
| `moflux` | client → Tyr → Ollama | the same floors, lent while idle and restored on demand |

The workload is warm-up plus four measured phases: interactive-only 0–25 s,
batch with interactive idle 25–60 s, overlapping contention 60–85 s, then
recovery/drain to 105 s. Phase membership uses immutable trace arrival time.

The benchmark owns its acceptance result; the top-level `passed` mirrors
`localContentionProof` and nothing else. Per-seed gates cover validity and
safety only. Across seeds: H1 (+0.04 req/s interactive contention-window SLO
goodput over direct, TTFT <= 5 s and latency <= 30 s), H2 (>= 1.2x static batch
borrow-window completions), H3 (protected floor never violated), H4a (no unsafe
capacity transfer) and H4b (no new borrowing after protected demand returns).
H1 and H2 are allowed to fail honestly and the fixtures exercise them failing.

## Evidence boundary

Every summary carries explicit `evidenceLimits`. This release adds no new claim.
It does not establish GPU preemption, GPU utilization, KV-cache reclamation,
Ollama scheduler preemption, upstream compute reclamation, production-scale
behaviour, or generalization beyond `qwen3:0.6b` on a CPU-only container. It
makes **no claim that restoration performance improved**; the new
occupancy-side measurement makes the existing non-preemptive cost visible for
the first time and reports it as a cost.

No `results/local-inference-contention.json` artifact is created by the release.
A run writes only beneath `results/runs/local-inference-contention/<run-id>/`;
publication is a separate explicit promotion.

## Locality and credential safety

The runner still accepts no direct, Tyr, or Ollama endpoint override flag, reads
no hosted-provider credential, and passes every arm endpoint plus the Ollama
upstream and control plane through the locality guard before the first request.
Warm-up diagnostics name credentials by a twelve-character SHA-256 fingerprint
and by issue/expiry time; bearer tokens are never written to a summary, and the
verifier asserts it.
