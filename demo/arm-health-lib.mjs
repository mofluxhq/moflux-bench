/**
 * arm-health-lib.mjs — did this arm measure anything at all?
 *
 * The gap this closes
 * -------------------
 * Every existing guard on an arm checks that the *right workload was offered*:
 * `assertValidRun` compares the trace hash and the logical request counts,
 * `assertNoControlSemantics` checks the baseline refused nothing. None of them
 * checks that the workload produced a *result*.
 *
 * An arm whose replicas were healthy but whose upstream was not the provider
 * simulator therefore passes every check while reporting:
 *
 *     success 0.0%  goodput 0.00 req/s  p50 0.00s  local rejects 0
 *     upstream 429 0  peak active ?/32  interactive retries 4.00x
 *
 * That is not a benchmark result. Zero successes with zero admission decisions
 * means nothing was measured: no policy refused the work and no provider served
 * it. Percentiles read 0.00s because there are no successful samples, and
 * retry amplification pins to `maxAttempts` because every attempt failed.
 * Aggregated across seeds it becomes a published median.
 *
 * What counts as a harness fault
 * ------------------------------
 * The load generator already separates outcomes it can attribute to a policy
 * from outcomes it cannot:
 *
 *   localReject     admission refused it (429 or queue-timeout 504) — a real result
 *   upstreamReject  the provider returned 429                    — a real result
 *   success         it completed                                 — a real result
 *   serverError     unattributed 5xx from the hop                 — nobody decided this
 *   transportError  connection failed or stream died             — nobody decided this
 *
 * The last two are harness faults. Across all 42 arm summaries committed under
 * `results/` — five seeds x four arms x two classes — both are zero on every
 * one. They are not a normal cost of running the benchmark under load, so a
 * material rate of them means the measurement apparatus is broken and the
 * numbers must not be reported.
 */

/**
 * A small tolerance, not zero.
 *
 * A single dropped stream at the end of a 45-second phase should not discard a
 * 26-minute sweep, and an occasional one is plausible under a full envelope
 * even though the committed evidence has never shown one. Anything above this
 * is systematic rather than incidental, and the raw counts are recorded either
 * way so a run that stays under the bar is still visible in the evidence.
 */
export const UNATTRIBUTED_FAILURE_TOLERANCE = 0.01;

const CLASSES = ["interactive", "batch"];

function classHealth(cls) {
  const attempts = Number(cls?.attempts ?? 0);
  const success = Number(cls?.success ?? 0);
  const localReject = Number(cls?.localReject ?? 0);
  const upstreamReject = Number(cls?.upstreamReject ?? 0);
  const serverError = Number(cls?.serverError ?? 0);
  const transportError = Number(cls?.transportError ?? 0);
  return {
    attempts,
    success,
    decided: localReject + upstreamReject,
    serverError,
    transportError,
    unattributed: serverError + transportError,
  };
}

/**
 * Outcome accounting for one arm, plus a verdict.
 *
 * Pure so the presenter's gate can be tested without Docker, a provider, or a
 * load generator — the failure it guards against is precisely the case where
 * none of those are working.
 */
export function armHealth(summary) {
  const perClass = Object.fromEntries(
    CLASSES.map((name) => [name, classHealth(summary?.classes?.[name])]),
  );
  const totals = Object.values(perClass).reduce(
    (sum, cls) => ({
      attempts: sum.attempts + cls.attempts,
      success: sum.success + cls.success,
      decided: sum.decided + cls.decided,
      serverError: sum.serverError + cls.serverError,
      transportError: sum.transportError + cls.transportError,
      unattributed: sum.unattributed + cls.unattributed,
    }),
    { attempts: 0, success: 0, decided: 0, serverError: 0, transportError: 0, unattributed: 0 },
  );
  const unattributedRate = totals.attempts > 0 ? totals.unattributed / totals.attempts : 0;

  let reason = null;
  if (totals.attempts === 0) {
    reason = "no request was attempted";
  } else if (totals.success === 0 && totals.decided === 0) {
    // The signature of a broken request path: nothing completed and no policy
    // refused anything, so every attempt died somewhere the benchmark does not
    // model.
    reason =
      `every one of the ${totals.attempts} attempts failed without a single admission decision ` +
      `(${totals.transportError} transport, ${totals.serverError} unattributed 5xx). ` +
      "Zero successes and zero rejects is not a policy outcome";
  } else if (unattributedRate > UNATTRIBUTED_FAILURE_TOLERANCE) {
    reason =
      `${totals.unattributed} of ${totals.attempts} attempts (${(unattributedRate * 100).toFixed(1)}%) ` +
      `failed with no attributable cause (${totals.transportError} transport, ${totals.serverError} unattributed 5xx); ` +
      `the tolerance is ${(UNATTRIBUTED_FAILURE_TOLERANCE * 100).toFixed(0)}%`;
  }

  return {
    ...totals,
    unattributedRate: +unattributedRate.toFixed(6),
    classes: perClass,
    ok: reason === null,
    reason,
  };
}

/**
 * Refuses an arm that measured nothing, naming the apparatus rather than the
 * policy — because when this fires the policy is not what failed.
 */
export function assertArmProducedWork(summary, label, { providerBaseUrl = null } = {}) {
  const health = armHealth(summary);
  if (health.ok) return health;
  const where = providerBaseUrl
    ? `Check that ${providerBaseUrl} is this run's provider simulator and not another ` +
      "process holding the port, and that no HTTP proxy is intercepting loopback."
    : "Check that the provider simulator and the four replicas are the processes this run started.";
  throw new Error(
    `${label} produced no usable measurement: ${health.reason}. ` +
      `This is a harness fault, not a result, so the arm is refused rather than reported. ${where}`,
  );
}
