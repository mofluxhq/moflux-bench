# Tenant-fairness benchmark

MoFlux Bench 0.14.0 adds a paired, authenticated noisy-neighbor scenario for
Tyr 0.21.0 and Latchflo 0.7.2.

## What it compares

Every seed creates one immutable two-workload trace and replays it through two
Tyr pools with the same physical fleet envelope:

| Arm | Pool | Policy |
|---|---|---|
| Pool-only | `sim-shared` | 32 concurrent requests and 64,000 in-flight tokens shared by both tenants |
| Admission classes | `sim-isolated` | The same physical envelope plus an 8-slot/16,000-token `premium` ceiling and a 24-slot/48,000-token `noisy` ceiling |

The premium workload is small and latency-sensitive. The noisy workload carries
large prompts and output reservations. Both are authenticated with short-lived
RS256 JWTs. Tyr maps `tenant-premium` to the fixed `premium` class and maps the
other identity to the fixed default `noisy` class.

This is not a provider RPM/TPM benchmark. It measures fairness over live
concurrency and in-flight token exposure inside one shared model pool.

## Run it

```bash
npm run demo:classes
```

That runs seeds 1–5 and requires the structural proof gate. For one diagnostic
seed without a hard gate:

```bash
npm run demo:classes:single
```

Preflight only:

```bash
npm run demo:classes:doctor
```

The licensed Tyr and Latchflo images are not redistributed here. The command can
use existing exact-version images, build matching sibling source repositories,
or pull configured registry images.

## Identity fixture

The command creates an ephemeral local certificate authority, HTTPS server
certificate, signing key, JWKS document, and two JWTs at runtime. Tyr trusts only
the generated CA through `NODE_EXTRA_CA_CERTS`. No private key or bearer token is
checked into the repository, and generated TLS files are removed after the run
unless `--keep-stack` is supplied for inspection.

Persisted result JSON records only whether identity tokens were provided. It
never records the tokens themselves or raw tenant IDs as metric labels.

## Proof gate

Each seed must show all of the following:

- The two arms replayed the same trace hash.
- Neither arm caused a provider 429.
- Tyr returned `x-admission-class: premium` for premium traffic.
- Tyr returned `x-admission-class: noisy` for noisy traffic.
- The noisy class reached a local admission ceiling.
- Premium work completed during the noisy workload's contention window.

The gate intentionally does not require a particular latency or success-rate
improvement. Those are measured outcomes and can vary with host performance.
The structural gate proves that the intended identity and class-control path was
actually exercised rather than inferring it from configuration alone.

## Output

Runs are written beneath:

```text
results/runs/tenant-fairness/<run-id>/
```

Each directory contains the immutable trace, both raw arm summaries, one
comparison per seed, and `summary.json` with median premium goodput, success
rate, TTFT ratio, noisy-class rejects, upstream 429 totals, and the exact
fleet-wide class grant totals observed from Tyr.
