# MoFlux Bench 0.31.0 verification

Verified 2026-09-03 with Node.js 24.18.0 and npm 12.0.1.

This release moves the licensed path to **Tyr 0.30.0** and **Latchflo 0.15.0**
and adds the restoration-enforceability ladder. Unusually for this project, the
new-capability claims below were checked against the licensed images themselves
rather than only against the harness, because the two mechanisms under test are
the kind that are easy to describe more strongly than they behave.

## Passed

- `npm run check`: syntax check passed for 93 JavaScript modules.
- `npm run verify`: all 44 component checks passed in the working tree,
  including the new `demo/verify-restoration-enforceability.mjs`.
- `npm run verify:publication`: publication hygiene passed for 226 files.
- `npm run sweep`: analytic simulator sweep passed with a worst observed
  deviation of 4.0% from the predicted curve.

## Checked against the licensed images

- `latchflo-control-plane:0.15.0` accepted all five tenant-fairness pool
  definitions, including the new `unlent` class policy carrying
  `globalUnlentProtectedInFlightTokens`, and both capacity-group forms
  (`non_preemptive` and `unlent_floor`).
- The same controller **rejected** the pre-0.14 shape this benchmark previously
  wrote, with `400 capacityGroup.demandPolicy.restoration is required when
  lending is enabled`. Every lending run and the tenant-fairness adaptive arm
  would have failed at bootstrap without the per-resource contract added here;
  this was a required migration, not a stylistic one.
- Latchflo exposed `latchflo_admission_class_unlent_protected_in_flight_tokens`
  and `latchflo_capacity_group_member_unlent_token_budget` with exactly the
  configured values, so the withheld slice is read from the allocator rather
  than echoed from the benchmark's own configuration.
- `tyr-admission-controller:0.30.0` loaded the updated six-pool class config and
  registered for all six pools.
- Driving a borrowed request past a 1,200 ms `borrowedAdmissionSlot` deadline
  produced the documented `504 borrowed_admission_deadline` with
  `localSlotReleased: true`, `upstreamCancellation: "requested"`, and
  `upstreamReclamation: "unverified"`, alongside `x-admission-slot-borrowed`,
  `x-admission-borrowed-tokens`, and `x-admission-slot-deadline-ms` headers.
  `/stats` reported `releasedByCause: { deadline: 2 }` and
  `tyr_pool_borrowed_admission_slot_deadlines_total` matched. The `/stats`
  fixture in the new verifier is that payload verbatim.
- The vendored dependency versions were read out of the published image:
  `async-bulkhead-llm` 3.17.0 and `async-bulkhead-ts` **1.0.1**. The previous
  metadata recorded 1.0.2, a version the licensed runtime never contained; it is
  corrected in this release.

## Measured, and deliberately not softened

- **The borrowed-slot deadline is unconditional.** A single borrowed request
  against an otherwise idle pool, with nothing waiting on the floor, was
  abandoned 1,200 ms after admission. The deadline bounds how long a borrowed
  slot may be held at all — not how long it may be held after the owner demands
  it back. A borrowed request completing in 300 ms under the same policy
  succeeded and was not counted. This is what makes the owner's worst-case wait
  enforceable, and it means every borrower that legitimately runs longer pays,
  needed or not.
- **Deadline abandonment has two client-visible shapes.** Tyr writes its clean
  504 only while it still owns the response; once a stream has begun it destroys
  the connection instead. Both were observed. On this benchmark's canonical
  streaming workload the caller therefore usually receives a truncated body with
  no error at all, so the load generator attributes a torn stream to the
  deadline only when the admitted response carried the deadline header *and*
  elapsed time reached it, and the summary reports `byOutcome` and
  `silentTruncationRate` rather than one total.
- **No configuration in this release claims upstream token reclamation.**
  `unlent_floor` withholds a slice before lending; Tyr's abort signal is
  reported by Tyr as `unverified`. Every verdict carries
  `upstreamReclamation: "not-claimed"`, and the analysis raises rather than
  summarizing a response claiming otherwise.

## The ladder, run end to end

`node demo/tenant-fairness.mjs --seeds=7 --duration-ms=15000 --restoration-ladder`
was executed against the licensed stack: four Tyr 0.30.0 replicas and one
Latchflo 0.15.0 controller, all six pools registered and granted.

- Latchflo held the configured contracts live: `sim-adaptive` on
  `non_preemptive` with no unlent slice, `sim-unlent` and `sim-deadline` on
  `unlent_floor` with 18,000 noisy / 4,000 premium tokens withheld, confirmed
  both through `/v1/pools` and through the allocator's own gauges.
- The ladder verdicts came out as designed: the unlent arm reported admission
  slots `objective` and tokens `unlent_floor` with 22,000 tokens withheld, and
  the deadline arm reported slots `enforced` on the same token contract, with
  every verdict carrying `upstreamReclamation: "not-claimed"`.

**That run also found a bug in this release's own instrumentation, which is the
reason for running it.** Tyr reported 26 borrowed slots released to the
deadline; the load generator attributed zero, leaving all 26 counted as
`transportError`. The deadline runs from admission, which the client cannot see
— it can only bracket it, since admission falls between the request being sent
and its response headers arriving. The first rule compared elapsed time against
response-headers-received alone, which is always shorter than the deadline
because upstream prefill happens first, so it could never match. The rule is now
the two-sided bracket, and `cost.clientAttributionGap` reports controller-side
releases minus client-side attributions so the same silence cannot return.

Re-running the same seed with the corrected rule closed the gap exactly:

| Arm | Controller releases | Client attributions | Gap | Client-visible shape |
|---|---|---|---|---|
| `sim-unlent` | 0 | 0 | 0 | — no deadline configured |
| `sim-deadline` | 26 | 26 | 0 | 26 `stream_destroyed`, 0 `gateway_timeout` |

The second row is the measured form of a caveat this release states in prose:
`silentTruncationRate` came out at **1.0**. On streaming traffic every single
abandonment reached the caller as a truncated body with no error at all, and
none as Tyr's explanatory `504`. Against the same trace the deadline arm
completed 40 of 89 premium requests where the otherwise-identical unlent arm
completed 58 — the shed requests are the price of the bounded restoration, and
they are not free.

## Not executed in this build environment

- The single-seed run above is a mechanism check, not a published result. No
  multi-seed `npm run demo:restoration` sweep was run, so this release ships the
  arms, the analysis, and end-to-end evidence that the mechanisms behave as
  described — not a measured claim about what they are worth on this workload.
- Paid live `npm run demo:openai*` provider runs were not executed; no OpenAI
  API key was supplied.
- `npm run verify:all` was executed against a clean checkout with these changes
  applied. In the working tree at the time of writing, `verify:publication`
  fails on an unrelated in-progress rename of `demo/openai/` to `demo/ollama/`
  whose three YAML files are deleted but not yet re-registered. That rename is
  not part of this release and was left untouched.

## A pre-existing flake, recorded rather than papered over

`demo/verify-presenter.mjs` is intermittently failing on this machine with
`replica <port> did not expose admission overhead sum/count metrics`, a scrape
of the baseline arm's own replica metrics after its load phase.

Run head-to-head in the same location, alternating six times each, this branch
passed 4/6 and an unmodified checkout of the previous release passed 3/6. It is
therefore not introduced here, and the presenter test never exercises a
lending path — every code path this release adds to `demo/present.mjs` is inside
an `OPT.lending` branch that the test does not enter — so the changes are not
reachable from the failure. It is recorded because a suite that passes on some
runs and not others should not be described simply as passing.

## Unchanged

- The committed `results/` corpus keeps its recorded Tyr 0.17.0 / Latchflo 0.5.1
  metadata. Runs on Tyr 0.30.0 / Latchflo 0.15.0 are a new evidence set rather
  than a relabelling of the old one.
- The default four-arm tenant-fairness comparison runs exactly the arms it
  always has; the ladder is additive and opt-in behind `--restoration-ladder`.

## OpenAI pricing basis

The bundled default model is `gpt-5.6-luna`. Pricing was reviewed on 2026-08-28 against OpenAI's model documentation at:

`https://developers.openai.com/api/docs/models/gpt-5.6-luna`

The reviewed rates are $0.20 per million input tokens and $1.20 per million output tokens. Both live harnesses require explicit input and output prices for any model not present in their reviewed pricing tables. The spend guards protect only the planned invocation; they do not know or enforce account-wide monthly spend.
