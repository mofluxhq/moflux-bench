# Tenant-fairness benchmark

MoFlux Bench 0.15.0 adds a three-arm, authenticated noisy-neighbor scenario for
Tyr 0.22.0 and Latchflo 0.8.0.

## What it compares

Every seed creates one immutable two-workload trace and replays it through three
Tyr pools with the same 32-request / 64,000-token physical fleet envelope:

| Arm | Pool | Class policy |
|---|---|---|
| Pool-only | `sim-shared` | No admission classes |
| Class ceilings | `sim-ceilings` | Premium max 8 concurrent; noisy max 24 concurrent; each class may use up to the full 64,000-token physical ceiling |
| Protected floors | `sim-protected` | The same hard ceilings plus premium floors of 4 concurrent / 8,000 tokens and noisy floors of 4 concurrent / 36,000 tokens |

The premium workload is small and latency-sensitive. The noisy workload uses a
15,000-character prompt and a 4,000-token output reservation. That shape is
large enough for two noisy requests to consume nearly all of one replica's
16,000-token physical grant when no floor is reserved, while one request still
fits inside the protected noisy floor.

Before traffic starts, the runner reads every Tyr replica's applied class
limits. It verifies the exact fleet-wide ceilings and floors and rejects the
run unless every class-aware replica can fund one noisy request. This prevents a
fragmented class budget from producing the misleading result "all noisy work
was rejected, therefore fairness passed."

This is not a provider RPM/TPM benchmark. It measures fairness over live
concurrency and in-flight token exposure inside one shared model pool.

## Run it

```bash
npm run demo:classes
```

That runs seeds 1–5 and requires the proof gate. For one diagnostic seed without
a hard gate:

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
certificate, signing key, JWKS document, and three JWTs at runtime: premium,
noisy, and operator. Tyr trusts only the generated CA through
`NODE_EXTRA_CA_CERTS`. No private key or bearer token is checked into the
repository, and generated TLS files are removed after the run unless
`--keep-stack` is supplied for inspection.

Persisted result JSON records only whether identity tokens were provided. It
never records the tokens themselves or raw tenant IDs as metric labels.

## Proof gate

Each seed must show all of the following:

- All three arms replayed the same trace hash.
- No arm caused a provider 429.
- Both class-aware arms returned `x-admission-class: premium` for premium traffic.
- Both class-aware arms returned `x-admission-class: noisy` for noisy traffic.
- The protected noisy policy rejected at least one excess admission, proving the
  configured bound was exercised.
- Premium work completed during the protected arm's contention window.
- Noisy work completed during the protected arm's contention window.
- The protected noisy class completed at least four requests in the contention
  window as a conservative anti-starvation threshold. Exact four-slot floor
  delivery is verified separately from the applied Tyr grants; the completion
  count alone is not a concurrency measurement.

The last two checks are deliberate. MoFlux Bench 0.14.0 could pass while the
noisy class completed zero requests because it required only classification and
rejection. Version 0.15.0 treats complete starvation as a failed fairness proof.

The gate does not require a particular latency or success-rate improvement.
Those are measured outcomes and can vary with host performance. Per-seed
observations separately report whether protected premium TTFT improved over the
pool-only and ceiling-only arms.

## Floor semantics

Tyr 0.22.0 enforces protected capacity locally and never revokes running work.
Latchflo 0.8.0 partitions the fleet-wide floor across the four replicas and
updates it atomically with the surrounding pool grant.

An idle class floor is not automatically lent to another admission class in
this release. Tyr reports pool-level demand to Latchflo, not per-class demand.
The benchmark therefore proves strict floor enforcement and restoration-safe
policy delivery, not class-level work-conserving lending.

## Output

Runs are written beneath:

```text
results/runs/tenant-fairness/<run-id>/
```

Each directory contains the immutable trace, three raw arm summaries, one
comparison per seed, and a schema-version-2 `summary.json`. The summary records
median success, contended goodput, protected-to-control TTFT ratios, noisy
completions and rejections, upstream 429 totals, proof checks and observations,
and the exact fleet-wide class floors and ceilings observed from Tyr.
