# Admission-class fairness and lending benchmark

MoFlux Bench 0.31.0 retains the four-arm authenticated noisy-neighbor scenario
introduced in 0.16.0, including demand-aware protected-floor lending with the current Tyr
0.30.0 and Latchflo 0.15.0 runtime.

## The restoration-enforceability ladder (0.31.0)

`--restoration-ladder` (`npm run demo:restoration`) adds two arms on top of the
four below. They exist to answer a question the original four cannot: when the
protected floor is demanded back while a borrower still holds it, what actually
returns it?

| Pool | Latchflo `restoration` | Tyr policy | Enforceability |
|---|---|---|---|
| `sim-adaptive` | `lease_safe_handoff` + `non_preemptive` | none | both resources are wall-clock objectives |
| `sim-unlent` | `lease_safe_handoff` + `unlent_floor` | none | tokens: half the floor is allocation-enforced |
| `sim-deadline` | identical to `sim-unlent` | `borrowedAdmissionSlot`, 2,500 ms | slots: enforced by an expiring deadline |

The Latchflo contract for `sim-unlent` and `sim-deadline` is deliberately
identical. Tyr's deadline is local configuration that Latchflo never sends, so
holding the control-plane side constant is what isolates Tyr's mechanism from
Latchflo's. The numeric floors match `sim-adaptive` exactly for the same reason.

The unlent slice is exactly half of each protected token floor — 4,000 of
premium's 8,000 and 18,000 of noisy's 36,000. Half is chosen for
interpretability rather than performance: the allocation-enforced half and the
objective-only half are the same size, so a measured difference is attributable
to the mechanism and not to how much capacity each one happened to guard.

Three properties are reported explicitly because each is easy to overstate:

- **The deadline is unconditional.** A borrowed request is abandoned 2,500 ms
  after admission even when nothing is waiting for the floor. It bounds how long
  a borrowed slot may be held at all, not how long it may be held after the
  owner demands it back.
- **Every enforced restoration is reported with its bill** — requests shed, or
  tokens withheld from borrowing for the whole idle window.
- **No arm claims upstream token reclamation.** `unlent_floor` withholds a slice
  before lending; Tyr's abort signal is reported as `unverified`. Every verdict
  carries `upstreamReclamation: "not-claimed"`.

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

All four arms use the same 240-second steady lease. The adaptive arm no longer
uses a shortened benchmark-only TTL. A 1-second idle threshold still creates a
clear lending window, but restoration must now be demonstrated through the
acknowledged class handoff before the old lent lease expires.


After the workload window, the runner allows a bounded 15-second synchronization window for a committed class handoff to propagate to Tyr. It actively requests reconciliation and continues sampling Tyr grants until the nominal noisy floor is observed or the bound expires. Controller commit and data-plane application are therefore proven separately.

Each seed gets a fresh Latchflo/Tyr control-plane state. This prevents a
240-second restored grant from seed N from suppressing idle-floor lending in
seed N+1. Before the adaptive trace starts, the runner waits for direct
controller + Tyr evidence that the noisy protected floor is actually lent. A
seed therefore cannot satisfy the restoration proof unless lending was observed
first in that same fresh seed.

Latchflo may release the active protected floor only after every active Tyr
replica reports the class idle. The hard class ceilings remain unchanged. When
noisy demand returns, Latchflo stops new borrowing, stages the restored floor,
and uses Tyr 0.30.0's ordered class acknowledgement plus fresh occupancy
evidence to prove the shared authority has drained by attrition. Running
requests are never revoked; lease expiry remains the fallback if proof fails.

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
- Latchflo recorded the restoration `admission_class.handoff_prepared` event,
  every required drain grant received an `applied` acknowledgement, and the
  matching handoff committed before the latest source-grant lease expired.
- The same hard ceilings were still intact after restoration.

The runner samples both `GET /v1/admission-class-demand?pool=sim-adaptive` and
Tyr `/stats` during the adaptive arm. After the run it also collects bounded
Latchflo `/v1/events` and `/v1/grants` evidence to join the prepared class
handoff to its source lease expirations and commit time. This prevents either a
controller-only transition or a coincidental lease expiry from being mistaken
for accelerated restoration.

The gate intentionally does **not** require a particular success-rate, goodput,
TTFT, or restoration-latency improvement. Those are measured outcomes and can
vary with host performance. The benchmark is designed to answer whether
adaptive floors recover otherwise idle protected capacity without losing their
bounded restoration semantics; it does not assume in advance that every
performance metric improves.

## Floor semantics

Tyr 0.30.0 reports bounded per-class demand and ordered class occupancy evidence while enforcing the class limits in its
currently applied Latchflo grant. Latchflo 0.15.0 owns the lending and handoff decisions; these handoff semantics were introduced in earlier 0.12.x releases and are preserved here.

A configured protected floor is therefore the **nominal floor**. In the
adaptive arm the **active floor** may temporarily be lower while the class is
fully observed idle. The class hard ceiling does not change. A returning class
does not preempt running borrowers. Latchflo first removes new shared borrowing
authority, waits for Tyr acknowledgement plus fresh occupancy evidence, and can
then restore the nominal floor before the previous lease boundary. The old
lease remains the fallback safety boundary.

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
applied by Tyr. `summary.json` uses schema version 4 and records:

- median success and contended goodput for all four arms;
- TTFT and goodput ratios for static/adaptive comparisons;
- noisy completions and local rejections;
- upstream 429 totals;
- per-seed lending/restoration proof state, restoration latency, class-handoff
  drain acknowledgements, and lease time avoided;
- the exact fleet-wide class ceilings/floors and adaptive policy used by the
  run.
