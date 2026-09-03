# MoFlux Bench 0.32.0 verification

Verified 2026-09-03 with Node.js 24.18.0 and npm 12.0.1.

This release adds an unmetered local inference benchmark and repairs an
abandoned directory rename that had broken every live OpenAI demo. The new
benchmark was run end to end against the licensed `tyr-admission-controller:0.30.0`
image and a real `ollama/ollama:0.12.3` server, not only against its harness —
its central claim is a safety substitution (a locality guard standing in for a
spend guard), and that is the kind of claim that has to be exercised rather than
asserted.

## Passed

- `npm run check`: syntax check passed for 96 JavaScript modules.
- `npm run verify`: all 45 component checks passed, including the new
  `demo/verify-local-inference.mjs`. The long-standing intermittent failure in
  `demo/verify-presenter.mjs` was diagnosed and fixed in this release; see below.
- `npm run verify:publication`: publication hygiene passed for 292 files.
- `npm run sweep`: analytic simulator sweep passed within tolerance.

## The rename that had broken the live OpenAI demos

`demo/openai/` had been renamed to `demo/ollama/` in 0.31.0 and the rename was
never finished. The three files it moved are OpenAI stack configs, and both
callers still resolved the old path:

| Caller | Resolved | Existed |
|---|---|---|
| `demo/openai-live.mjs` | `demo/openai/compose.yaml` | no |
| `demo/openai-overload.mjs` | `demo/openai/compose-overload.yaml` | no |

So `npm run demo:openai`, `demo:openai:chat`, `demo:openai:responses`, and every
`demo:openai:overload*` command could not have started a stack from 0.31.0 until
now. `verify:publication` had been updated to the *new* paths, so it passed
throughout and the breakage was invisible to the release gate. That is the more
useful finding than the broken path itself: a hygiene check that follows a
rename rather than the callers will certify a half-done one.

The rename is reverted. `demo/openai/` again holds the OpenAI stacks, and
`demo/ollama/` now holds the Ollama stack its name implies.

## The local inference benchmark, run end to end

Against `tyr-admission-controller:0.30.0` and `ollama/ollama:0.12.3` serving
`qwen3:0.6b`, 20 pairs, 32 maximum output tokens:

| Arm | Success | TTFT p50 | Latency p50 | Decode p50 | Completion tokens |
|---|---|---|---|---|---|
| `direct` | 20/20 | 354.62 ms | 4035.51 ms | 9.09 tok/s | 640 |
| `moflux` | 20/20 | 288.07 ms | 4065.60 ms | 7.72 tok/s | 640 |

`deltas.latencyP50Ms` was **+30.09 ms** with `steadyState: true`. Both arms
completed exactly 640 tokens, which is the check that matters for whether the
comparison is fair at all: `temperature: 0` and a per-pair `seed` made the two
arms replay the same decode, so the delta is the proxy rather than two different
completions being compared.

The decode-rate gap is the honest cost of running the server on the benchmark's
own machine. Tyr and Ollama compete for the same cores here in a way they never
would against a hosted provider, so 9.09 → 7.72 tok/s is a property of this
topology and **must not be quoted as a general proxy-overhead figure**.

## A warm-up-only run reported a physically impossible delta

The first successful run used 3 pairs, below the 5 warm-up pairs the summary
already disclosed. It passed, and reported `deltas.latencyP50Ms: -1237.55` —
the proxied arm "beating" the direct one by 1.2 seconds, because pair 1's direct
request paid to load the weights into memory and nothing after it did.

Disclosing `caveats.warmupPairs` and leaving the reader to cross-check it was
not enough: the number that gets quoted is the delta, so the flag now rides on
the delta. `deltas.steadyState` and `acceptance.steadyStateMeasured` are false
whenever `requestsPerArm` does not exceed the warm-up count, and the run prints
that the deltas must not be quoted.

It deliberately still passes. Every request succeeded, which is a real
compatibility result; failing the run would discard the half that is valid, and
passing it silently would publish the half that is not.

## The locality guard, and a hole found in it

The local benchmark has no spend guard, because a self-hosted server has no
price to compute a worst-case bill from. What replaces it is a check that both
upstream URLs are local, enforced before the first request and not overridable
by any flag — `verify-publication` fails the release if such a flag appears.

The first implementation had a hole its own test caught. The rule admitting
single-label container names (`ollama`, `nas`) keyed on the absence of a dot,
and a public IPv6 address has no dot either, so `2606:4700::1111` classified as
local. IPv6 and dotted-quad literals are now decided entirely by their own range
rules and never reach the name-shaped ones. The guard fails closed: an
unusually written local address such as an IPv4-mapped `::ffff:7f00:1` is
refused rather than admitted.

Exercised in `demo/verify-local-inference.mjs`: 14 local forms accepted, 8
non-local forms refused including `api.openai.com`, `api.anthropic.com`, and
`172.15.0.1`/`172.32.0.1` immediately outside the RFC1918 block; and both
`--direct-url` and `--moflux-url` refuse a hosted host with **zero** requests
sent.

## Two defects found by running it rather than testing it

- **Port collision with a real Ollama.** The stack originally published the
  container on the host's default `11434`. The machine used for this
  verification already ran Ollama there, and `docker compose up` failed with
  `address already in use`. Anyone who wants a local inference benchmark is
  disproportionately likely to be in exactly that state, and the worse outcome
  than failing is not failing: binding the default port could measure the
  operator's own server, with their concurrency settings and their loaded model,
  while the summary named the pinned one. The stack now publishes `11435`; the
  container port is unchanged, so Tyr still reaches `http://ollama:11434`.
- **A test writing into the working tree.** `demo/local-inference.mjs` called
  `ensureDemoEnv` unconditionally, so `--manage-stack=false` runs — the
  verification suite's — created `demo/moflux/.env`, which `verify:publication`
  then refused. The env file is now created only by a run that actually starts
  containers.

## Not executed in this build environment

- Paid live `npm run demo:openai*` provider runs were not executed; no OpenAI
  API key was supplied. The compose paths they resolve are confirmed to exist
  again, and `docker compose config` accepts both files, but no request was sent
  to a metered provider.
- No local inference evidence is committed to `results/`. The runs above are a
  mechanism check on one machine, one model, and one topology, not a published
  measurement. `deltas.latencyP50Ms` from a single 20-pair run on a laptop is
  not a proxy-overhead claim.
- The multi-seed `npm run demo:restoration` sweep introduced in 0.31.0 remains
  unrun.

## The presenter flake was a real defect, and is fixed

`demo/verify-presenter.mjs` had been failing intermittently with
`replica <port> did not expose admission overhead sum/count metrics`, recorded
as a known flake in the 0.31.0 verification. It is not a flake. It is a race
that let the presenter measure the wrong server, and it is fixed here.

**What it actually was.** `arms/replica.mjs` binds `0.0.0.0`, while the test's
Tyr doubles bind `127.0.0.1`. The operating system treats those as two different
addresses, so the double's `listen` succeeds while a replica is still serving
the same port — no `EADDRINUSE`, and therefore no retry from a helper named
`listenWhenFree`. A connection to `127.0.0.1:8101` then goes to the more
specific bind, which is the double. The handoff was triggered by
`waitForFile(BASELINE_FILE)`, and the load generator writes that file before
`present.mjs` scrapes replica metrics, so the doubles routinely took the ports
mid-measurement.

**How it was established rather than assumed.** Two earlier explanations were
tested and discarded. Adding the scraped body to the error message showed
`status=200` with `tyr_pool_*` series, disproving "the replica recorded zero
decisions" — those metrics are emitted unconditionally, so a genuine zero would
still parse. Switching the scrape to a fresh unpooled connection did not help,
disproving a stale keep-alive socket. Capturing `docker ps` and `lsof` at the
point of failure showed no Tyr container running and **two node processes
listening on the same port**, which identified the test's own doubles as the
responder.

**The fix.** `listenWhenFree` now waits until nothing accepts a connection on
the address before binding it, because reachability rather than `EADDRINUSE` is
the property that actually matters here.

| | Passed |
|---|---|
| before the fix | 2 / 5 |
| after the fix | 6 / 6, then a full `npm run verify` at 45 / 45 |

**A second defect the same investigation exposed.** `readTyrMetricsTexts` and
`readLocalAdmissionDecision` scrape the identical URL on the identical ports and
expect different servers. The replica direction failed loudly because
`replica_*` series were absent; the Tyr direction would have found no `tyr_*`
series and aggregated them to **zero**, publishing a wrong measurement instead
of raising. Both scrapes now assert the responding server is the one intended,
so a misdirected scrape can never again be summarised as a result. That check is
what turned the original confusing message into one that named the cause.

## Unchanged

- The committed `results/` corpus keeps its recorded Tyr 0.17.0 / Latchflo 0.5.1
  metadata. Runs on Tyr 0.30.0 / Latchflo 0.15.0 are a new evidence set rather
  than a relabelling of the old one.
- The default four-arm tenant-fairness comparison and the opt-in
  `--restoration-ladder` are untouched.
- The Responses API arm has no local counterpart. Ollama implements only Chat
  Completions, and `--openai-api=responses` is refused rather than quietly
  served from the chat surface.

## OpenAI pricing basis

The bundled default model is `gpt-5.6-luna`. Pricing was reviewed on 2026-08-28 against OpenAI's model documentation at:

`https://developers.openai.com/api/docs/models/gpt-5.6-luna`

The reviewed rates are $0.20 per million input tokens and $1.20 per million output tokens. Both live harnesses require explicit input and output prices for any model not present in their reviewed pricing tables. The spend guards protect only the planned invocation; they do not know or enforce account-wide monthly spend.

The local inference benchmark has no pricing basis because it has no price. Its
upstream is pinned to a server this stack starts itself, and the locality guard
is what keeps that true.
