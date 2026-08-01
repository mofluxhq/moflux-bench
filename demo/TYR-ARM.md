# Wiring the Tyr and Latchflo arms (licensed only)

Tyr and Latchflo are proprietary and are not redistributed here. Licensed
users can run the integrated video path with `npm run demo`; the command creates
its ignored local environment file automatically. The public arms remain
independently reproducible.


## Presenter command

The integrated arm requires Tyr 0.17.0 and Latchflo 0.5.1 licensed images. Once
they are tagged locally or accessible through the configured registry, run:

```bash
npm run demo
```

The command creates the ignored local env file and random credentials on first
use. The presenter creates or updates `sim-interactive` and `sim-batch` with a
short
enrollment lease before Tyr starts. It sends Latchflo 0.5.1's minimum viable
grant settings for each request class, so an allocator split below one slot or
below one request's token reservation fails explicitly. Tyr 0.17.0 also polls
private capacity snapshots from the other three replicas and can forward a
request once to the peer with the best request-specific headroom. The shared
routing secret is generated in the ignored local `.env`; Latchflo does not
distribute topology or secrets. All four replicas register for interactive
traffic, while replica 4 also registers for batch. Once all registrations are
visible, the presenter promotes both pools to the steady-state TTL and waits
until every endpoint is simultaneously ready with a live local grant that can
admit one request and has enough remaining TTL for the benchmark phase. It then
replays the same immutable trace as the baseline and
reports per-run token-accounting deltas. The full sequence is documented in
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
    tyr_pool_advisory_would_reject_total  prospective rejects in observe mode
    tyr_pool_observe_bypassed_total
    tyr_request_duration_seconds        }  the difference is Tyr's own
    tyr_upstream_duration_seconds       }  added latency
    tyr_pool_in_flight / _tokens_in_flight / _limit_revision
    tyr_pool_grant_managed / _grant_expires_at_seconds / _controller_epoch

Enable `auditEnabled` for per-request signed estimator error: the
`tyr.admission-audit.v2` event pairs `reservedTokens` with `usage`.

## The metric to lead with

`totalRefunded / totalReserved`.

Reservation is `estimated_input + max_tokens`, and `max_tokens` is a cap rather
than a prediction, so over-reservation is structural and large — with a median
output near 220 tokens against a 4096 cap, most of the output reservation is
phantom. The interesting claim is therefore not "we predict tokens accurately."
It is: **here is exactly what capacity safety costs, and here is how much of it
reconciliation gives back.** Arms 2 and 4 cannot give any of it back; they hold
the full reservation for the life of the call.

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
