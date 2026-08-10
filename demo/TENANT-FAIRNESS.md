# Admission-class fairness and lending benchmark

MoFlux Bench 0.17.0 retains the four-arm authenticated noisy-neighbor scenario
introduced in 0.16.0, including demand-aware protected-floor lending with Tyr
0.24.0 and Latchflo 0.10.0.

## What it compares

Every seed creates one immutable two-workload trace and replays it through four
Tyr pools with the same 32-request / 64,000-token physical fleet envelope:

| Arm | Pool | Class policy |
|---|---|---|
| Pool-only | `sim-shared` | No admission classes |
| Class ceilings | `sim-ceilings` | Premium max 8 concurrent; noisy max 24 concurrent; each class may use up to the full 64,000-token physical ceiling |
| Static protected floors | `sim-protected` | The same hard ceilings plus premium floors of 4 concurrent / 8,000 tokens and noisy floors of 4 concurrent / 36,000 tokens |
| Adaptive protected floors | `sim-adaptive` | The same nominal floors and hard ceilings, with Latchflo class-demand lending enabled |

The premium workload is small and latency-sensitive. The noisy workload uses a
15,000-character prompt and a 4,000-token output reservation. Noisy traffic
starts five seconds after premium traffic. That initial quiet window gives the
adaptive arm an explicit opportunity to lend the idle noisy floor before noisy
demand appears.

This is not a provider RPM/TPM benchmark. It measures fairness and work
conservation over live concurrency and in-flight token exposure inside one
shared model pool.

## Adaptive policy

Only `sim-adaptive` enables:

```json
{
  "admissionClassDemandPolicy": {
    "enabled": true,
    "reportStaleAfterMs": 5000,
    "idleAfterMs": 1000
  }
}
```

The three control arms keep 120-second steady leases. The adaptive arm uses a
3-second grant TTL so a safe floor restoration can occur within a 30-second
benchmark seed. This is deliberate benchmark instrumentation, not a general
production TTL recommendation.

Latchflo may release the active protected floor only after every active Tyr
replica reports the class idle. The hard class ceilings remain unchanged. When
noisy demand returns, Latchflo stops treating the floor as lendable and restores
the nominal floor through its lease-safe handoff; Tyr never revokes running
requests.

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

- All four arms replayed the same trace hash.
- No arm caused a provider 429.
- Every class-aware arm attributed premium and noisy responses to the expected
  admission class.
- Both static and adaptive protected policies shed at least one excess noisy
  admission, proving the configured bounds were exercised.
- Premium and noisy work both completed during contention in the adaptive arm.
- The adaptive noisy class completed at least four requests in the contention
  window as a conservative anti-starvation threshold.
- Before noisy demand, Latchflo reported the noisy floor released and Tyr's
  applied grant set showed the noisy protected concurrency/token floor at zero.
- While that floor was lent, Tyr's fleet-wide noisy hard ceilings remained
  exactly 24 concurrent / 64,000 in-flight tokens.
- After noisy demand appeared, the runner observed the nominal noisy floor
  restored in Tyr: 4 protected concurrent / 36,000 protected tokens.
- The same hard ceilings were still intact after restoration.

The runner samples both `GET /v1/admission-class-demand?pool=sim-adaptive` and
Tyr `/stats` during the adaptive arm. This prevents a controller-only state
transition from being mistaken for a data-plane-applied grant.

The gate intentionally does **not** require a particular success-rate, goodput,
TTFT, or restoration-latency improvement. Those are measured outcomes and can
vary with host performance. The benchmark is designed to answer whether
adaptive floors recover otherwise idle protected capacity without losing their
bounded restoration semantics; it does not assume in advance that every
performance metric improves.

## Floor semantics

Tyr 0.24.0 reports bounded per-class demand and enforces the class limits in its
currently applied Latchflo grant. Latchflo 0.10.0 owns the lending decision.

A configured protected floor is therefore the **nominal floor**. In the
adaptive arm the **active floor** may temporarily be lower while the class is
fully observed idle. The class hard ceiling does not change. A returning class
does not preempt running borrowers; restoration is bounded by the outstanding
lease that represents the lent allocation plus normal reconcile/poll delay.

Missing, stale, or incomplete class telemetry fails protected: Latchflo keeps or
restores the nominal floor rather than lending on uncertain demand state.

## Output

Runs are written beneath:

```text
results/runs/tenant-fairness/<run-id>/
```

Each directory contains the immutable trace, four raw arm summaries, one
comparison per seed, and an `adaptive-lending-seed-<n>.json` observation stream
containing bounded controller state plus the aggregate class limits actually
applied by Tyr. `summary.json` uses schema version 3 and records:

- median success and contended goodput for all four arms;
- TTFT and goodput ratios for static/adaptive comparisons;
- noisy completions and local rejections;
- upstream 429 totals;
- per-seed lending/restoration proof state and restoration latency;
- the exact fleet-wide class ceilings/floors and adaptive policy used by the
  run.
