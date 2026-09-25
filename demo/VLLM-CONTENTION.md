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
`gpu-memory-utilization`, and disabled prefix caching stay fixed. Only the
declared scheduler and admission path change. The memory setting defaults to
0.85 on NVIDIA and 0.4 on Metal. `--gpu-memory-utilization` overrides it for
the whole run, and every arm's observed value must equal the declared one. A symbolic Hugging Face revision
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
NVIDIA container runtime, OpenSSL, Node.js 22+, the Tyr 0.33.0 image and the
licensed Latchflo 0.19.0 image, and network access for the first model download. vLLM's
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

### Long-context KV pressure on Apple Silicon

`metal-balanced-v1` never pressures the KV cache: its requests are tiny, and the
Sept 23 run peaked at 3.11% KV usage. `metal-long-context-v1` asks the question
that run could not. When protected demand returns and Tyr restores the
interactive grant, are borrowed batch requests still holding KV, so that
returning interactive work waits inside the engine rather than at admission?

```bash
npm run demo:vllm:metal:long-context:dry-run
npm run demo:vllm:metal:long-context:single  # seed 3
npm run demo:vllm:metal:long-context
```

The profile keeps every interactive setting of `metal-balanced-v1` and changes
three things:

- **Batch requests are long:** 7,100 characters, which Qwen2.5-1.5B's chat
  template turns into 1,607 prompt tokens, decoding exactly 64 tokens. Batch
  arrives at 0.15 req/s.
- **The scheduler's KV pool is pinned** with `--num-gpu-blocks-override=320`
  and `--block-size=16`: 5,120 tokens, which still holds one 4,096-token
  request. Three batch requests take 315 blocks, and a fourth does not fit.
  The memory setting stays at 0.4, so the host does not swap. vLLM Metal still
  allocates its physical cache from that setting (1,933 blocks on a 16 GB
  M1); the override caps what the scheduler may use, which is where
  requests wait and are preempted.
- **Results go to their own corpus,** `results/runs/vllm-metal-long-context/`,
  never pooled with the unpinned Metal runs.

A probe on an M1 with 16 GB set these sizes. With three batch requests
resident, KV reached 100%, the engine queued two requests and preempted one,
and priority-scheduled interactive TTFT rose from 0.35s alone to 1.2–3.3s
while staying inside the 5s SLO. Each batch request took about 20s at
three-way concurrency. Arrivals are random per seed. Seeds 1–5 each place
3–6 batch arrivals in the 20s before demand returns. These offer an opportunity
for overlap; rejection and completion mean arrivals alone cannot establish residency. Seed 7 places none, so the single-seed script
uses seed 3.

Two validity gates apply only to this profile. `kvPoolPinned` reads
`vllm:cache_config_info` from every arm and requires 320 blocks of 16 tokens,
so an engine that ignored the override fails the seed. `kvPressureExercised`
requires peak KV usage of at least 0.9 in a direct arm; a run that never
filled the pool did not test the question and is inconclusive. The five
hypotheses and their thresholds are unchanged from `metal-balanced-v1`.

Each arm records `vllm.scheduledReturn`: an engine-wide snapshot after the
scheduled return boundary and `firstObservedEmptyQueueDelayMs`, the delay to
its first sampled empty queue. This includes sampling delay, may precede actual
interactive arrival or restoration, and does not imply sustained clearance.
A queue may form after that first zero. Missing waiting metrics remain unknown.

For managed arms, `evidence.*.engineCorrelation` places engine and admission
snapshots beside the observed demand mark and grant-floor restoration, retaining
sample offsets and lag. Batch borrowed occupancy is admission-side evidence;
aggregate KV and queue gauges cannot attribute residency or waiting to a class.
These observations cannot establish an additional backend-release delay after
admission occupancy settles. Request-level engine timing would be needed.

`batchBorrowAccounting.arrivalCohort` counts eventual successful completions of
requests arriving during the borrow phase. `completionWindow` instead counts
successful batch completions timestamped within that phase, regardless of arrival.
Both divide by the borrow-phase duration. The historical comparison fields
`batchBorrowGoodputRps` and `mofluxBatchBorrowDeltaVsStaticRps`, and hypothesis H3,
retain arrival-cohort semantics and their original thresholds. They do not claim
within-window throughput. Read successful-request TTFT alongside rejection counts
and SLO goodput. Five-seed median gates are descriptive, not statistical confidence
bounds for non-inferiority.

To regenerate reporting from a saved run without modifying its raw evidence:

```bash
node demo/reanalyze-vllm-reporting.mjs /absolute/path/to/run/summary.json /absolute/path/to/new-summary.json
```

The output must be a new file outside reviewed evidence paths. Original runtime
and generation timestamps are retained; reanalysis adds its own timestamp and
source SHA-256 hashes. No inference runs and no hypothesis thresholds change.

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
makes any such refusal invalidate the seed. Latchflo 0.16.0 produced one at
every lease boundary, because it reissued a grant only after expiry. Latchflo
0.17.0 renews a live lease before it expires. In 0.17.0, lending an idle class's
floor still waited for the old lease to expire; Latchflo 0.17.1 commits it
immediately. Such a window can be shorter than the one-second managed sampler
interval, so the refusal record and the retained Latchflo events are the
authoritative evidence. This experiment therefore requires Latchflo 0.17.1 or
later and pins `latchflo-control-plane:0.19.0`, the same release as the other
experiments. If the image is missing, the runner builds it from a
`latchflo-control-plane` 0.19.0 checkout beside `moflux-bench` or from `MOFLUX_LATCHFLO_SOURCE_DIR`. To use a
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

The experiment pins Tyr 0.33.0. Since Tyr 0.31.0, when Tyr's own call to vLLM fails, its
`502 upstream_error` names the transport cause, for example
`cause.code: "ECONNRESET"` or `"UND_ERR_SOCKET"`. Tyr also writes a
`tyr.diagnostic.v1` line with the detail to its log, which the Compose logs
above retain. Class summaries count these as `serverErrorCauses`, and the
`noEngineOrTransportErrors` gate reports them per arm. Under Tyr 0.30.0 a 502
carried only `fetch failed`, and nothing recorded why, so a failure that never
reached vLLM could not be attributed.

On Metal, the runner also samples host memory pressure on each five-second
platform tick, because process CPU/RSS cannot show unified-memory contention:
- `kern.memorystatus_vm_pressure_level` and `vm.swapusage`;
- `vm_stat` swap, page and compressor counters;
- `pmset -g therm` thermal and performance warnings.

vLLM, Docker's VM, Tyr and Latchflo all share that memory. Each arm reports
`hostPressure` and prints a one-line host summary. The `hostMemoryHeadroom`
gate makes a Metal seed inconclusive if, in any arm:
- pressure samples are missing or failed;
- any sample reached `critical` memory pressure;
- more than 256 MiB was swapped out.

A swapping host degrades Docker networking, control-plane requests and engine
latency together, and later arms degrade more. That is host contention, not an
arm effect. `warn` pressure is reported but does not fail the gate on its own;
swap-outs are the objective measure.

Two settings keep a 16 GB Apple-Silicon Mac inside that budget:
- **vLLM's KV reservation.** vLLM Metal budgets KV cache as a fraction of the
  unified-memory Metal working-set limit. At 0.85 that reservation is several
  gigabytes, while this workload can hold at most 4 × 4,096 = 16,384 KV tokens,
  about 450 MiB for Qwen2.5-1.5B. The Metal default of 0.4 still leaves about
  three times that capacity after the model weights.
- **Docker Desktop's VM memory.** Tyr and Latchflo need little memory. Set the
  VM to about 2–4 GB in Docker Desktop's resource settings. The runner prints
  the VM's memory at startup and records it as `runtime.dockerVmMemoryBytes`.

The top-level result has three states:

- `inconclusive`: a validity gate failed, including missing or unpopulated
  request metrics, missing token evidence, missing NVIDIA GPU or Metal process
  samples, no observed queue, zero SLO goodput in both direct arms, trace
  mismatch, generator saturation, runtime identity drift, a managed-arm refusal
  with no live grant, a Metal host that swapped or hit critical memory pressure
  during an arm, or an engine/request/transport error.
- `fail`: the run was valid but at least one preregistered performance or
  restoration hypothesis failed.
- `pass`: the run was valid and every preregistered hypothesis passed.

The hypotheses are median native-priority SLO goodput no worse than FCFS;
MoFlux no more than 0.04 req/s below native priority; MoFlux batch borrow-arrival cohort
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
