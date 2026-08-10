# Wiring the Tyr and Latchflo arms (licensed only)

Tyr and Latchflo are proprietary and are not redistributed here. Licensed
users can run the integrated video path with `npm run demo`; the command creates
its ignored local environment file automatically. The public arms remain
independently reproducible.


## Presenter command

The integrated arm requires Tyr 0.24.0 and Latchflo 0.10.0 licensed images.
Tyr contains async-bulkhead-llm 3.15.1 and async-bulkhead-ts 1.0.1. Once the
images are tagged locally or accessible through the configured registry, run:

```bash
npm run demo
```

The command creates the ignored local env file and random credentials on first
use. The presenter creates or updates `sim-interactive` and `sim-batch` with a
short
enrollment lease before Tyr starts. It sends Latchflo 0.10.0's minimum viable
grant settings for each request class, so an allocator split below one slot or
below one request's token reservation fails explicitly. Tyr 0.24.0 also polls
private capacity snapshots from the other three replicas and can forward a
request once to the peer with the best request-specific headroom. The shared
routing secret is generated in the ignored local `.env`; Latchflo does not
distribute topology or secrets. Tyr 0.24.0 also reports per-pool in-flight work,
recent admissions and rejections, and token headroom on its authenticated
Latchflo heartbeat. `npm run demo:lending` uses those reports to drive a
Latchflo 0.10.0 demand-aware capacity group with a fully funded 28/4 protected
split; normal runs retain the static 31/1 policy. All four replicas register for interactive traffic, while replica 4
also registers for batch. Once all registrations are
visible, the presenter promotes both pools to the steady-state TTL and waits
until every endpoint is simultaneously ready with a live local grant that can
admit one request and has enough remaining TTL for a stable start. Demand-aware
runs install the capacity group with lending disabled during enrollment; after
the measured trace starts and a fresh interactive demand heartbeat arrives, the
presenter enables the configured lending policy. This prevents pre-run idle
heartbeats from turning slow enrollment into zero-capacity grants while keeping
the workload trace unchanged. It then reports per-run token-accounting deltas.
The default Anthropic-shaped stream
reports input usage at start and cumulative output usage while active, allowing
Tyr to reconcile progressively with the benchmark's pinned 256-token update
step and 256-token future-output safety margin. Use `npm run demo:openai` only
for protocol compatibility; its usage arrives at completion and therefore does
not exercise early release. The full sequence is documented in
`demo/VIDEO-DEMO.md`.

## Position in the harness

Tyr replaces `arms/replica.mjs` — it occupies the same place in the request
path, so latency and goodput remain comparable to arms 1-4:

    loadgen -> Tyr (:8101..:810N) -> provider-sim (:9000)
                 ^
                 Latchflo issues expiring capacity grants, off the request path

Point Tyr's upstream at the simulator rather than a real provider. Tyr forwards
the caller's provider credential verbatim, and the simulator ignores it.

## Two arms, not one

- **Arm 5, observe mode.** Runs the real estimator and admission logic without
  capacity-related rejection. This is the arm that produces the estimator-quality
  dataset, and it is the one worth running first: it yields the headline evidence
  without enforcing anything.
- **Arm 6, enforce mode with Latchflo.** Adds fleet coordination via versioned,
  expiring grants.

## Metrics to scrape

Tyr already exposes what the harness needs; no instrumentation change is
required. Add its port to `demo/prometheus/prometheus.yml` and collect:

    tyr_pool_tokens_reserved_total      reservation at admission
    tyr_pool_tokens_consumed_total      actual usage after reconciliation
    tyr_pool_tokens_refunded_total      returned by reconciliation
    tyr_pool_tokens_overrun_total       consumption beyond the reservation
    tyr_pool_progressive_reconciliation_enabled
    tyr_pool_progressive_usage_reports_total
    tyr_pool_progressive_updates_total
    tyr_pool_progressive_coalesced_total
    tyr_pool_progressive_tokens_released_total  returned before stream completion
    tyr_pool_advisory_would_reject_total  prospective rejects in observe mode
    tyr_pool_observe_bypassed_total
    tyr_request_duration_seconds        }  the difference is Tyr's own
    tyr_upstream_duration_seconds       }  added latency
    tyr_pool_in_flight / _tokens_in_flight / _limit_revision
    tyr_pool_grant_managed / _grant_expires_at_seconds / _controller_epoch

Enable `auditEnabled` for per-request signed estimator error: the
`tyr.admission-audit.v2` event pairs `reservedTokens` with `usage`.

## The metrics to lead with

`totalRefunded / totalReserved` and
`progressiveEarlyReleasedTokens / totalRefunded`.

Reservation is `estimated_input + max_tokens`, and `max_tokens` is a cap rather
than a prediction, so over-reservation is structural and large — with a median
output near 220 tokens against a 4096 cap, most of the output reservation is
phantom. The interesting claim is therefore not "we predict tokens accurately."
It is: **here is exactly what capacity safety costs, how much reconciliation
gives back, and how much becomes reusable before the call ends.** Arms 2 and 4
cannot progressively resize a live request's token hold; they retain their
admission-time reservation for the life of the call. Keep final refunds and
early releases separate so a completion-only protocol is not presented as
progressive behavior.

Report over-reservation waste as a first-class number, including where it makes
MoFlux look expensive.

## Fleet convergence

Latchflo defers rebalancing while any lease is still active, so convergence
after a replica joins or dies is bounded below by the lease TTL. Chart it — "a
replica dies at 3am, how long until its capacity is usable again?" is a question
every buyer asks, and arms 2 and 4 answer it badly in different ways (stranded
forever vs stranded until TTL).

## Comparison hygiene

Same simulator settings, same immutable trace hash, and the same class-specific
replica routing as the no-control arm. If Tyr runs against different parameters
or request counts, the presenter rejects the comparison.
