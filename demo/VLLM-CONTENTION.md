# vLLM contention experiment (NVIDIA CUDA and Apple Silicon Metal)

This experiment answers a narrower question than the Ollama benchmark:

> On one GPU-backed vLLM server, how do FCFS, native priority scheduling, a
> rigid protected admission partition, and MoFlux lending compare on SLO
> goodput and observed engine/GPU pressure?

It is a single-host mechanism experiment, not a general vLLM performance
benchmark. The canonical NVIDIA backend and the Apple-Silicon companion use
separate output/evidence names and are never pooled. Every result records an
immutable model revision, engine identity and arguments, hardware identity,
trace hash, arm order, and telemetry completeness.

## Arms and controlled variables

| Arm | Request path | vLLM policy | Admission policy |
| --- | --- | --- | --- |
| `vllm-fcfs` | client → vLLM | `fcfs`; no request priority field | none |
| `vllm-priority` | client → vLLM | `priority`; interactive `0`, batch `10` | none |
| `static` | client → Tyr → vLLM | same priority policy | fixed interactive/batch floors of 3/1 |
| `moflux` | client → Tyr → vLLM | same priority policy | same 3/1 floors; two interactive slots lendable, one natively unlent |

vLLM documents FCFS as the default and its priority scheduler as lower numeric
values first, with arrival time breaking ties. It also documents the top-level
OpenAI `priority` field and the `ignore_eos`/`min_tokens` extensions used by the
CUDA fixed-output workload:

- [vLLM serve scheduling policy](https://docs.vllm.ai/en/v0.18.0/cli/serve/)
- [vLLM OpenAI-compatible server](https://docs.vllm.ai/en/v0.18.0/serving/openai_compatible_server/)

The runner recreates the vLLM service before **every** arm. On NVIDIA this is a
container; on Apple Silicon it is a native vLLM Metal process. The model commit,
served-model alias, hardware, `max-num-seqs=4`, `max-model-len=4096`,
`gpu-memory-utilization=0.85`, and disabled prefix caching stay fixed. Only the
declared scheduler and admission path change. A symbolic Hugging Face revision
such as `main` is resolved once to an immutable commit before the stack starts;
that same commit is supplied to all four processes.

## Workload

Five deterministic seeds are required for a publication-quality result. Arm
order is rotated so each arm occupies every ordinal position before any order
is repeated. Each arm performs five sequential warm-up calls per class; warm-up
loads the model and gives Tyr's adaptive estimator its required five samples,
but is excluded from every measured distribution.

The measured 105-second trace has the same four phases on both backends, but
uses a backend-specific offered-load envelope. Raw CUDA and Metal throughput is
not a controlled comparison, so forcing the much larger CUDA jobs through an
M1 would only create hundreds of queued requests and starve evidence sampling.

| Time | NVIDIA `nvidia-decode-heavy-v1` | Metal `metal-balanced-v1` | Purpose |
| --- | --- | --- | --- |
| 0–25 s | interactive at 1 req/s | interactive at 0.25 req/s | uncontended baseline and protected demand |
| 25–60 s | batch at 6 req/s | batch at 0.75 req/s | interactive floor becomes idle and lendable |
| 60–85 s | batch continues; interactive returns at 4 req/s | batch continues; interactive returns at 0.5 req/s | contention and restoration |
| 85–105 s | no new arrivals | no new arrivals | drain and recovery observation |

NVIDIA interactive calls use 400 input characters and decode exactly 128
tokens; NVIDIA batch calls use 1,600 characters and decode exactly 768. Metal
interactive calls use 400 input characters and decode exactly 16 tokens; Metal
batch calls use 800 characters and decode exactly 32. The shorter Metal work is
sized so an M1 can exercise queueing, priority, lending and demand return
without turning a 15-second restoration experiment into a multi-minute drain.
Every summary records the selected workload profile and exact parameters.

CUDA sends `ignore_eos=true` and `min_tokens=max_tokens`. vLLM Metal 0.29.0
explicitly rejects the `min_tokens` logits-processor control, so the Metal path
omits that field and uses `ignore_eos=true` with `max_tokens`; no separate stop
sequence is configured. The proof computes the expected token total from the
selected backend profile and requires positive vLLM TTFT/end-to-end histogram
populations in every arm, so a rejected or empty stream cannot masquerade as
fixed work. Prefix caching is disabled so identical prompt prefixes do not
become an unmeasured cache allocation policy.

Both profiles remain deliberately contentious for a four-sequence 1.5B model.
A result is rejected as **inconclusive** unless a direct arm records a non-empty
`vllm:num_requests_waiting` queue. Faster hardware therefore cannot silently
turn a non-contention run into evidence about contention.

## Run it on NVIDIA

Prerequisites are Docker Compose, an NVIDIA GPU visible to `nvidia-smi`, the
NVIDIA container runtime, OpenSSL, Node.js 22+, the licensed Tyr 0.30.0 and
Latchflo 0.17.0 images, and network access for the first model download. vLLM's
official container image is `vllm/vllm-openai`; this release pins `v0.18.0`.
See the [official vLLM Docker guide](https://docs.vllm.ai/en/v0.18.0/deployment/docker/).

```bash
npm run demo:vllm:dry-run   # prints design; creates nothing
npm run demo:vllm:doctor    # Docker/Compose/OpenSSL/GPU preflight; no inference
npm run demo:vllm:single    # one development seed
npm run demo:vllm           # five seeds, fails unless the full proof passes
```

Useful explicit overrides:

```bash
node demo/vllm-contention.mjs \
  --seeds=1-5 \
  --model=Qwen/Qwen2.5-1.5B-Instruct \
  --model-revision=<immutable-hugging-face-commit> \
  --gpu-index=0 \
  --dcgm-url=http://127.0.0.1:9400/metrics \
  --require-proof
```

`--dcgm-url` is optional and must be local/private. Host `nvidia-smi` samples
are mandatory. The optional DCGM scrape adds profiler counters without making
the harness depend on a separately versioned exporter image.

The model cache is the external Docker volume
`moflux-bench-vllm-hf-cache`. Control-plane volumes are destroyed on teardown;
the model cache is retained. Use normal Docker volume management if you
explicitly want to remove downloaded weights.

## Run it on Apple Silicon

The companion backend requires Apple Silicon, macOS 15+, native arm64 Python
3.12, Docker Desktop for Tyr/Latchflo, and the community-maintained vLLM Metal
plugin. Install the plugin's stable channel with its official installer:

```bash
curl -fsSL https://raw.githubusercontent.com/vllm-project/vllm-metal/main/install.sh \
  | bash -s -- --stable
```

The default executable paths are `~/.venv-vllm-metal/bin/vllm` and
`~/.venv-vllm-metal/bin/python`; override them with `--metal-bin` and
`--metal-python` or `MOFLUX_VLLM_METAL_BIN` and
`MOFLUX_VLLM_METAL_PYTHON`.

Authentication is optional for this public model. To avoid anonymous Hub rate
limits, export `HF_TOKEN` in the invoking shell before the run. The legacy
`HUGGING_FACE_HUB_TOKEN` name is also accepted; neither token is written to a
summary.

The prerequisite check reads `vllm serve --help=all`, not the abbreviated
default help. Current vLLM releases group engine arguments, so plain
`vllm serve --help` does not enumerate options such as
`--scheduling-policy` even when they are installed. To inspect that option
directly, run:

```bash
~/.venv-vllm-metal/bin/vllm serve --help=scheduling-policy
```

The runtime-identity probe tolerates informational output from vLLM imports and
parses only its uniquely marked JSON record. Unmarked or duplicate records fail
closed before a run directory is created.

```bash
npm run demo:vllm:metal:dry-run
npm run demo:vllm:metal:doctor  # prerequisites/capabilities only; no inference
npm run demo:vllm:metal:single
npm run demo:vllm:metal
```

vLLM runs natively while Tyr and Latchflo remain in Docker. The server listens
on Docker Desktop's host bridge only for the lifetime of the run and requires a
random ephemeral API key; the runner passes it through Tyr's forwarded
`Authorization` header and redacts it from logs and summaries. The key has a
fixed alphabetic prefix and is bound to vLLM as one `--api-key=<value>` argv
token, so base64url punctuation cannot be misparsed as a CLI option. Metal
paged attention is enabled with `VLLM_METAL_USE_PAGED_ATTENTION=1`. Do not use
Xcode GPU frame capture during a measured run: vLLM Metal documents 50–100× overhead.
See the [vLLM Metal installation](https://docs.vllm.ai/projects/vllm-metal/en/latest/installation/)
and [configuration](https://docs.vllm.ai/projects/vllm-metal/en/latest/configuration/)
guides.

## Measurements and proof

The client records logical attempts, successful completions, TTFT, end-to-end
latency, SLO goodput, rejection attribution, errors, and censored direct-arm
tails. Unexpected non-2xx responses and structured OpenAI error frames inside a
200 stream are failures with bounded diagnostics, not completions. Fixed-output
requests with no observable output tokens also fail. A request counts toward
interactive contention-window SLO goodput only when TTFT is at most 5 seconds
and end-to-end latency at most 30 seconds.

The runner requires the documented vLLM running/waiting request gauges,
KV-cache usage, preemption counter, and TTFT, ITL, queue, prefill, decode,
inference, and end-to-end histograms. These are the
[vLLM production metrics](https://docs.vllm.ai/en/v0.18.0/usage/metrics/).
Histogram values are reported as deltas after warm-up. NVIDIA scrapes vLLM
every 250 ms and samples host GPU utilization, memory, power and temperature
every second. Metal scrapes vLLM and managed admission state every second, uses
a fresh authenticated metrics connection after each native-server recreation,
and samples the process tree asynchronously every five seconds. That lower-rate
Metal schedule preserves one-second restoration resolution without allowing a
synchronous `ps` call to block the evidence loop. Any scrape or process-sample
error still invalidates the seed. Metal CPU/RSS is host-process pressure, not a
fabricated CUDA-equivalent GPU utilization value.

For the MoFlux arm, data-plane sampling is cross-checked against Latchflo's
per-resource restoration episodes, native unlent-floor gauges, and correlated
handoff event order. A run is invalid if the bounded event window is incomplete,
an unsafe commit precedes a required drain acknowledgement, or allocator gauges
do not confirm the configured one-slot/12,288-token unlent reserve. Both
backends use the same 65,536-token pool, fully reserved by the 49,152/16,384
protected floors: concurrency must be the admission constraint, while the token
subfloor exists so Latchflo's allocation-enforced upstream contract is exercised
and observable. Any token-budget rejection still invalidates the seed. When that
happens, `classes.*.rejectionDetails` retains the aggregate
requested/available/budget ranges, `classes.*.budgetRejectionSnapshots` retains
its exact global binding state, and `evidence.*.criticalWindow` retains token
grants and occupancy; the failure is investigated, not reclassified as
concurrency.

A refusal made with a zero capacity envelope (zero concurrency, queue, and
token budget) is not token pressure, even though Tyr reports it as
`budget_limit`. It is Tyr's even-revision fail-closed state between Latchflo
grants. Summaries classify it as `grantUnavailable`: it is excluded from
`budgetLimited` and `concurrencyLimited`, counted in
`classes.*.grantUnavailableRejections`, and listed with its revision and grant
ID in `classes.*.grantUnavailableSnapshots`. The `managedGrantContinuity` gate
makes any such refusal invalidate the seed. Before 0.37.0 shipped, four
development Metal runs recorded 178 `budget_limit` refusals; all 178 were zero
envelopes on a roughly 15-second lease cycle, and none were token pressure.
Latchflo 0.17.0 renews a live lease before it expires, so this experiment pins
`latchflo-control-plane:0.17.0` independently of the other experiments. If the
image is missing, the runner builds it from a `latchflo-control-plane` 0.17.0
checkout beside `moflux-bench` or from `MOFLUX_LATCHFLO_SOURCE_DIR`. To use a
differently tagged build of the same release, set
`MOFLUX_VLLM_LATCHFLO_IMAGE`.

After every arm, and again before `docker compose down --volumes`, the runner
saves diagnostics to `diagnostics/<label>/` inside the run directory:
- the Compose logs;
- the newest 1,000 Latchflo grants and events, including `grant.expired`,
  `grant.issued` and `grant.renewed`;
- each managed Tyr's `/stats`.

Files are owner-only, and credentials are redacted. Each managed sample also
records Tyr's applied `limitsRevision` and grant provenance. Together these tie
any zero-capacity window to a specific expiry and reissue instead of leaving it
to inference.

The top-level result has three states:

- `inconclusive`: a validity gate failed, including missing or unpopulated
  request metrics, missing token evidence, missing NVIDIA GPU or Metal process
  samples, no observed queue, zero SLO goodput in both direct arms, trace
  mismatch, generator saturation, runtime identity drift, a managed-arm refusal
  with no live grant, or an engine/request/transport error.
- `fail`: the run was valid but at least one preregistered performance or
  restoration hypothesis failed.
- `pass`: the run was valid and every preregistered hypothesis passed.

The hypotheses are median native-priority SLO goodput no worse than FCFS;
MoFlux no more than 0.04 req/s below native priority; MoFlux batch borrow-window
goodput at least 0.02 req/s above static; lending observed in at least three of
five seeds; restoration actually required in at least three seeds; and every
required grant-side restoration within 15 seconds with no native unlent reserve
breach. Raw occupancy restoration is reported separately. A fast grant
return does not mean vLLM has stopped, preempted, or reclaimed an already
admitted batch request.

## Evidence is never overwritten by a run

Every invocation creates a new directory:

```text
results/runs/vllm-contention/<run-id>/
results/runs/vllm-metal-contention/<run-id>/
```

An existing directory is refused even when `--out` is explicit. The reviewed
targets for both `vllm-contention` and `vllm-metal-contention` are guarded before
a byte is written. A completed run reaches its matching corpus only through an
explicit, non-overwriting publication command:

```bash
npm run evidence:publish -- --run=results/runs/vllm-contention/<run-id> --as=vllm-contention
npm run evidence:publish -- --run=results/runs/vllm-metal-contention/<run-id> --as=vllm-metal-contention
```

Do not use `--force` unless the intent is specifically to replace reviewed
evidence. The overlay ships no generated run output and no result JSON.

## Interpretation boundary

MoFlux controls **admission**. vLLM controls scheduling, execution, KV-cache
allocation, and any engine preemption. The experiment observes both layers so
their timing can be compared; it does not collapse them into one mechanism.
In particular:

- a restored Latchflo/Tyr grant is not GPU reclamation;
- a falling KV-cache gauge is not proof MoFlux evicted KV blocks;
- `vllm:num_preemptions` is an engine observation, not a MoFlux action; and
- a result generalizes only to the recorded image, model commit, GPU, engine
  arguments, and offered workload.

Metal and CUDA results answer the same within-backend arm comparison, but they
are not cross-backend performance evidence. Apple unified memory, MLX/Metal,
native host-process telemetry, and the vLLM Metal plugin are materially
different from an NVIDIA container and CUDA device telemetry.

The validity proof also requires the managed arms to record at least one
concurrency-limited admission and zero token-budget-limited admissions. If the
loose token budget unexpectedly becomes the binding treatment, the experiment
is invalid rather than reinterpreted after the fact.
