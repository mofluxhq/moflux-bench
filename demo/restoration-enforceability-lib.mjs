/**
 * restoration-enforceability-lib.mjs — measuring what a restoration mechanism
 * actually guarantees, for Tyr 0.30.0 and Latchflo 0.15.0.
 *
 * The question
 * ------------
 * Every capacity control plane in this space says "protected floor". Almost
 * none of them say what happens at the moment the floor is demanded back while
 * a borrower is still holding it. There are only three honest answers:
 *
 *   objective     the borrower is asked to finish and the floor returns when
 *                 it does. A wall-clock SLO is a target, not a mechanism. This
 *                 is Latchflo's `lease_safe_handoff` for admission slots and
 *                 `non_preemptive` for upstream tokens.
 *
 *   unlent_floor  a slice of the floor was never lent, so it needs no
 *                 reclamation. Allocation-enforced and instant — and the price
 *                 is that the slice sat idle for the entire borrow window.
 *                 Latchflo 0.15.0.
 *
 *   enforced      the resource is taken back from the borrower mid-request.
 *                 Only Tyr's own admission slot can do this, via 0.30.0's
 *                 `deadline_abandonment`. The price is a shed request.
 *
 * One property of the enforced case is easy to misread and worth stating
 * plainly: the deadline is unconditional. It bounds how long a borrowed slot
 * may be held at all, not how long it may be held *after the owner asks for it
 * back*. A borrower running past the deadline is shed even when the pool is
 * idle and nobody wanted the capacity. What that buys is a bounded worst-case
 * wait for the floor owner; what it costs is every over-running borrower,
 * needed or not.
 *
 * Nothing in this stack can reclaim upstream tokens already in flight at the
 * provider. Tyr sends an abort signal and reports the result as `unverified`.
 * This module refuses to upgrade that word, and every summary it produces
 * carries the distinction explicitly rather than leaving it to prose.
 *
 * What this measures, and what it costs
 * -------------------------------------
 * An enforceability claim is only worth publishing next to its bill. For each
 * mechanism the summary pairs the benefit (how fast the protected floor came
 * back) with the cost (borrower requests shed, or borrowable capacity withheld
 * for the whole idle window). A mechanism that restores instantly by never
 * lending anything has not beaten lending; it has declined to lend.
 *
 * Every function here is pure so the arithmetic is testable against fixtures
 * without Docker or a licensed image.
 */

import { prometheusSamples } from "./admission-timing-lib.mjs";
import {
  latchfloUnlentFloorExpected,
  tyrBorrowedSlotDeadlinesExpected,
} from "./restoration-contract-lib.mjs";

export const ENFORCEABILITY_FRAMING =
  "Admission slots are Tyr-local and can be taken back from a borrower by an expiring deadline (enforced). " +
  "Upstream token capacity cannot be reclaimed once in flight at the provider: an unlent slice is withheld " +
  "before lending (allocation-enforced), and everything else is a wall-clock objective. " +
  "Tyr reports upstream cancellation as unverified and this benchmark never restates it as reclaimed capacity.";

function nonNegative(value) {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

/**
 * Collapses Tyr 0.30.0's per-pool `tyr.restoration` blocks into one record.
 *
 * `statsByPool` is `{ [poolName]: <pool /stats payload> }`, exactly as Tyr
 * returns it. A pool whose payload predates 0.30.0 has no `restoration` key;
 * that is a legitimate "not instrumented" answer on an older image and lost
 * instrumentation on a newer one, so the version gate decides which.
 */
export function summarizeTyrRestoration({ statsByPool = {}, tyrVersion } = {}) {
  const entries = Object.entries(statsByPool);
  const instrumented = entries.filter(
    ([, stats]) => stats?.tyr?.restoration !== undefined,
  );
  if (instrumented.length === 0) {
    if (tyrBorrowedSlotDeadlinesExpected(tyrVersion)) {
      throw new Error(
        `Tyr ${tyrVersion} claims borrowed-slot deadline support but no pool exposed tyr.restoration`,
      );
    }
    return Object.freeze({
      status: "not-instrumented",
      framing: ENFORCEABILITY_FRAMING,
      admissionSlots: null,
      upstreamCapacity: null,
      pools: [],
    });
  }

  const configuredDeadlinesMs = {};
  let released = 0;
  let releasedByDeadline = 0;
  let releasedByManual = 0;
  let cancellationRequested = 0;
  let activeAccountingHolds = 0;
  const pools = [];

  for (const [pool, stats] of instrumented) {
    const restoration = stats.tyr.restoration;
    const slots = restoration.admissionSlots ?? {};
    const upstream = restoration.upstreamCapacity ?? {};
    const byCause = slots.releasedByCause ?? {};
    const deadlines = slots.configuredDeadlinesMs ?? {};
    for (const [admissionClass, deadlineMs] of Object.entries(deadlines)) {
      const key = `${pool}/${admissionClass}`;
      configuredDeadlinesMs[key] = Number(deadlineMs);
    }
    released += nonNegative(slots.released);
    releasedByDeadline += nonNegative(byCause.deadline);
    releasedByManual += nonNegative(byCause.manual);
    cancellationRequested += nonNegative(upstream.cancellationRequested);
    activeAccountingHolds += nonNegative(upstream.activeAccountingHolds);
    pools.push({
      pool,
      admissionSlotReleaseMechanism: slots.releaseMechanism ?? null,
      admissionSlotEnforceability: slots.enforceability ?? null,
      upstreamReleaseMechanism: upstream.releaseMechanism ?? null,
      upstreamEnforceability: upstream.enforceability ?? null,
      configuredClasses: Object.keys(deadlines).sort(),
      released: nonNegative(slots.released),
      releasedByCause: {
        deadline: nonNegative(byCause.deadline),
        manual: nonNegative(byCause.manual),
      },
      cancellationRequested: nonNegative(upstream.cancellationRequested),
      activeAccountingHolds: nonNegative(upstream.activeAccountingHolds),
    });
  }

  // Tyr splits early slot returns by cause precisely so a lease configured too
  // tight is distinguishable from deliberate shedding. Collapsing them would
  // throw away the only signal that says which of the two happened.
  const accountedByCause = releasedByDeadline + releasedByManual;
  if (accountedByCause > released) {
    throw new Error(
      `Tyr restoration cause split (${accountedByCause}) exceeds total slot releases (${released})`,
    );
  }

  return Object.freeze({
    status: "measured",
    framing: ENFORCEABILITY_FRAMING,
    admissionSlots: Object.freeze({
      releaseMechanism: "deadline_abandonment",
      enforceability: "enforced",
      configuredDeadlinesMs: Object.freeze(configuredDeadlinesMs),
      released,
      releasedByCause: Object.freeze({
        deadline: releasedByDeadline,
        manual: releasedByManual,
        /** Releases Tyr counted but did not attribute to a cause. */
        unattributed: released - accountedByCause,
      }),
      /** A rising deadline share means the configured lease is too tight. */
      deadlineShare: released > 0 ? +(releasedByDeadline / released).toFixed(4) : null,
    }),
    upstreamCapacity: Object.freeze({
      releaseMechanism: "abort_signal",
      enforceability: "unverified",
      cancellationRequested,
      /**
       * Requests Tyr still counts against the token budget after the local
       * concurrency slot went back. This is the accounting cost of an
       * unverified cancellation and must not be read as leaked capacity.
       */
      activeAccountingHolds,
      reclamation: "unverified",
    }),
    pools: Object.freeze(pools.sort((a, b) => a.pool.localeCompare(b.pool))),
  });
}

/**
 * Reads Latchflo 0.15.0 per-resource evidence off `/v1/restoration-episodes`.
 *
 * 0.15.0 kept the flat `restorationSloMs` / `sloViolatedAt` fields for 0.14
 * readers and deprecated them. This deliberately reads only the per-resource
 * `resources` and `resourceSloViolatedAt` shapes: the flat fields cannot say
 * which resource missed its objective, which is the whole point of the release.
 */
export function summarizeLatchfloRestorationEpisodes({
  episodes = [],
  latchfloVersion,
} = {}) {
  const perResource = episodes.filter((episode) => episode?.resources !== undefined);
  if (perResource.length === 0) {
    if (episodes.length > 0 && latchfloUnlentFloorExpected(latchfloVersion)) {
      throw new Error(
        `Latchflo ${latchfloVersion} returned ${episodes.length} restoration episodes without per-resource evidence`,
      );
    }
    return Object.freeze({
      status: episodes.length === 0 ? "no-episodes" : "not-instrumented",
      episodes: 0,
      resources: null,
    });
  }

  const byResource = new Map();
  for (const episode of perResource) {
    const violations = episode.resourceSloViolatedAt ?? {};
    for (const resource of ["admissionSlots", "upstreamCapacity"]) {
      const evidence = episode.resources[resource];
      if (evidence === undefined) continue;
      const key = `${resource}/${evidence.releaseMechanism}`;
      const current = byResource.get(key) ?? {
        resource,
        releaseMechanism: evidence.releaseMechanism,
        enforceability: evidence.enforceability,
        sloMs: evidence.sloMs,
        episodes: 0,
        sloViolations: 0,
        targetTotal: 0,
        unlentTotal: 0,
        durationsMs: [],
      };
      if (current.enforceability !== evidence.enforceability) {
        throw new Error(
          `Latchflo reported ${key} as both ${current.enforceability} and ${evidence.enforceability}`,
        );
      }
      current.episodes += 1;
      if (violations[resource] !== undefined && violations[resource] !== null) {
        current.sloViolations += 1;
      }
      current.targetTotal += nonNegative(evidence.target);
      current.unlentTotal += nonNegative(evidence.unlent);
      const duration = Number(episode.durationMs);
      if (Number.isFinite(duration) && duration >= 0) current.durationsMs.push(duration);
      byResource.set(key, current);
    }
  }

  const resources = [...byResource.values()]
    .map((row) => Object.freeze({
      resource: row.resource,
      releaseMechanism: row.releaseMechanism,
      enforceability: row.enforceability,
      sloMs: row.sloMs,
      episodes: row.episodes,
      sloViolations: row.sloViolations,
      /** Tokens or slots the episode was restoring, summed across episodes. */
      targetTotal: row.targetTotal,
      /** Non-zero only where Latchflo withheld a slice from borrowing. */
      unlentTotal: row.unlentTotal,
      medianDurationMs: median(row.durationsMs),
      maxDurationMs: row.durationsMs.length > 0 ? Math.max(...row.durationsMs) : null,
    }))
    .sort((a, b) => `${a.resource}/${a.releaseMechanism}`.localeCompare(`${b.resource}/${b.releaseMechanism}`));

  return Object.freeze({
    status: "measured",
    episodes: perResource.length,
    resources: Object.freeze(resources),
  });
}

function median(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? +sorted[middle].toFixed(1)
    : +(((sorted[middle - 1] + sorted[middle]) / 2)).toFixed(1);
}

/**
 * Reads the allocation-enforced unlent floors straight off Latchflo's gauges.
 *
 * The configured policy says what was asked for; these gauges say what the
 * allocator is actually holding back. A benchmark that only echoes its own
 * configuration has not measured the control plane.
 */
export function summarizeUnlentFloorGauges({
  metricsTexts = [],
  latchfloVersion,
  pools = null,
} = {}) {
  // One Latchflo serves every pool in the deployment, so a single scrape
  // carries gauges for arms this one is being compared against. Attributing
  // another arm's withheld tokens to this one would manufacture an enforced
  // floor out of a neighbour's configuration, so a caller measuring one arm
  // must name its pools.
  const wanted = pools === null ? null : new Set(pools);
  const included = (pool) => wanted === null || wanted.has(pool);
  const classRows = [];
  const memberRows = [];
  for (const text of metricsTexts) {
    for (const row of prometheusSamples(text, "latchflo_admission_class_unlent_protected_in_flight_tokens")) {
      const pool = row.labels.pool ?? "unknown";
      if (!included(pool)) continue;
      classRows.push({
        pool,
        admissionClass: row.labels.admission_class ?? "unknown",
        unlentTokens: row.value,
      });
    }
    for (const row of prometheusSamples(text, "latchflo_capacity_group_member_unlent_token_budget")) {
      const pool = row.labels.pool ?? "unknown";
      if (!included(pool)) continue;
      memberRows.push({
        capacityGroup: row.labels.capacity_group ?? "unknown",
        pool,
        unlentTokens: row.value,
      });
    }
  }
  const observed = classRows.length + memberRows.length;
  if (observed === 0) {
    return Object.freeze({
      status: latchfloUnlentFloorExpected(latchfloVersion) ? "not-configured" : "not-instrumented",
      admissionClasses: Object.freeze([]),
      capacityGroupMembers: Object.freeze([]),
      totalUnlentTokens: 0,
    });
  }
  return Object.freeze({
    status: "measured",
    admissionClasses: Object.freeze(
      classRows.sort((a, b) => `${a.pool}/${a.admissionClass}`.localeCompare(`${b.pool}/${b.admissionClass}`)),
    ),
    capacityGroupMembers: Object.freeze(
      memberRows.sort((a, b) => `${a.capacityGroup}/${a.pool}`.localeCompare(`${b.capacityGroup}/${b.pool}`)),
    ),
    totalUnlentTokens: classRows.reduce((sum, row) => sum + row.unlentTokens, 0) +
      memberRows.reduce((sum, row) => sum + row.unlentTokens, 0),
  });
}

/**
 * The deadline mechanism's bill, taken from the load generator rather than
 * from Tyr.
 *
 * Tyr counts slots it released; the client counts requests it lost. Those are
 * the same event seen from the two sides that matter, and reporting only the
 * first would describe an enforced restoration as free.
 */
export function summarizeBorrowedDeadlineCost(summary) {
  const classes = summary?.classes ?? {};
  const perClass = Object.entries(classes).map(([workload, values]) => ({
    workload,
    abandoned: nonNegative(values?.borrowedDeadlineAbandoned),
    success: nonNegative(values?.success),
    logical: nonNegative(values?.logical),
  }));
  const abandoned = perClass.reduce((sum, row) => sum + row.abandoned, 0);
  const logical = perClass.reduce((sum, row) => sum + row.logical, 0);
  const snapshots = Object.values(classes).flatMap(
    (values) => values?.borrowedDeadlineSnapshots ?? [],
  );

  // Every 504 must agree with Tyr's own wire contract. A snapshot claiming a
  // reclaimed upstream request would be a strictly stronger statement than the
  // controller made, so refuse to summarize it.
  for (const snapshot of snapshots) {
    if (
      snapshot.upstreamReclamation !== null &&
      snapshot.upstreamReclamation !== undefined &&
      snapshot.upstreamReclamation !== "unverified"
    ) {
      throw new Error(
        `borrowed-deadline response claimed upstream reclamation "${snapshot.upstreamReclamation}"; only "unverified" is a supported claim`,
      );
    }
  }

  const deadlinesMs = [...new Set(
    snapshots.map((snapshot) => snapshot.deadlineMs).filter((value) => Number.isFinite(value)),
  )].sort((a, b) => a - b);

  // The two client-visible outcomes are not equally good and must not be
  // averaged. Tyr can only write its `504 borrowed_admission_deadline` while it
  // still owns the response; once a stream has started it destroys the
  // connection instead, so a streaming caller gets a truncated body with no
  // explanation at all. On this benchmark's canonical streaming workload the
  // second is the common case, and reporting only the total would describe the
  // mechanism as better-behaved than callers actually experience.
  const byOutcome = { gateway_timeout: 0, stream_destroyed: 0, unattributed: 0 };
  for (const snapshot of snapshots) {
    const outcome = snapshot.outcome ?? "unattributed";
    byOutcome[outcome] = (byOutcome[outcome] ?? 0) + 1;
  }

  return Object.freeze({
    abandoned,
    abandonedRate: logical > 0 ? +(abandoned / logical).toFixed(4) : null,
    perClass: Object.freeze(perClass.sort((a, b) => a.workload.localeCompare(b.workload))),
    byOutcome: Object.freeze(byOutcome),
    /** Share of shed requests that reached the caller with no error body. */
    silentTruncationRate:
      abandoned > 0 ? +(byOutcome.stream_destroyed / abandoned).toFixed(4) : null,
    observedDeadlinesMs: Object.freeze(deadlinesMs),
    /** Distinct admission classes that actually lost a borrowed slot. */
    admissionClasses: Object.freeze(
      [...new Set(snapshots.map((snapshot) => snapshot.admissionClass))].sort(),
    ),
    localSlotReleasedAlways: snapshots.every(
      (snapshot) => snapshot.localSlotReleased === true || snapshot.localSlotReleased === null,
    ),
    upstreamReclamation: "unverified",
  });
}

/**
 * The headline verdict: per resource, which mechanism was configured, what it
 * can honestly guarantee, whether the run actually exercised it, and the bill.
 *
 * `restorationClaim` is the configured contract (from the capacity group or the
 * admission-class policy). The observed evidence must not out-rank it: a run
 * configured for a wall-clock objective cannot report an enforced restoration
 * just because nothing happened to miss the SLO.
 */
export function restorationEnforceabilityVerdict({
  arm,
  restorationClaim,
  tyrRestoration,
  latchfloEpisodes,
  unlentGauges,
  deadlineCost,
}) {
  const configured = restorationClaim?.enforceability ?? {};
  const tyrEnforced =
    tyrRestoration?.status === "measured" &&
    Object.keys(tyrRestoration.admissionSlots.configuredDeadlinesMs).length > 0;

  // Admission slots: Latchflo always calls its own mechanism an objective.
  // Tyr's per-class deadline is separate local policy, and it is the only
  // thing that upgrades this resource to enforced.
  const admissionSlots = {
    configuredEnforceability: configured.admissionSlots ?? null,
    effectiveEnforceability: tyrEnforced ? "enforced" : (configured.admissionSlots ?? null),
    releaseMechanism: tyrEnforced ? "deadline_abandonment" : "lease_safe_handoff",
    observed: tyrEnforced
      ? nonNegative(tyrRestoration.admissionSlots.releasedByCause.deadline) > 0
      : sloObserved(latchfloEpisodes, "admissionSlots"),
    deadlinesReleased: tyrEnforced
      ? nonNegative(tyrRestoration.admissionSlots.releasedByCause.deadline)
      : 0,
    requestsShed: nonNegative(deadlineCost?.abandoned),
  };

  // An arm with no configured deadline cannot lose requests to one. If it did,
  // the load generator's summary and Tyr's configuration describe different
  // pools, and the comparison this arm exists to make is invalid.
  if (!tyrEnforced && admissionSlots.requestsShed > 0) {
    throw new Error(
      `arm ${arm ?? "(unnamed)"} shed ${admissionSlots.requestsShed} requests to a borrowed-slot ` +
        "deadline but no pool in its Tyr stats configures one; the summary and the stats disagree",
    );
  }

  // An arm configured for a wall-clock objective bought no withheld capacity,
  // whatever the scrape contains. Crediting it with a neighbouring arm's
  // unlent slice would report a benefit this configuration never paid for.
  const scrapedUnlentTokens = nonNegative(unlentGauges?.totalUnlentTokens);
  const unlentConfigured = configured.upstreamCapacity === "unlent_floor";
  if (!unlentConfigured && scrapedUnlentTokens > 0) {
    throw new Error(
      `arm ${arm ?? "(unnamed)"} is configured as ${configured.upstreamCapacity ?? "non-lending"} ` +
        `but was given ${scrapedUnlentTokens} unlent tokens; scope the gauges to this arm's pools`,
    );
  }
  const unlentTokens = unlentConfigured ? scrapedUnlentTokens : 0;
  const upstreamCapacity = {
    configuredEnforceability: configured.upstreamCapacity ?? null,
    /**
     * Taken from the contract, never from observation. Tyr's per-class
     * deadline is the one mechanism that legitimately upgrades a resource past
     * what Latchflo published, and it applies only to admission slots; there
     * is nothing in this stack that can make an upstream token contract
     * stronger at runtime than it was configured to be.
     */
    effectiveEnforceability: configured.upstreamCapacity ?? null,
    releaseMechanism: restorationClaim?.contract?.upstreamCapacity?.releaseMechanism ?? null,
    /** Allocation-enforced tokens: withheld from borrowing for the whole run. */
    unlentTokens,
    observed: unlentConfigured
      ? unlentTokens > 0
      : sloObserved(latchfloEpisodes, "upstreamCapacity"),
    /** Unchanged in every configuration this stack can produce. */
    reclamation: "not-claimed",
  };

  return Object.freeze({
    arm: arm ?? null,
    framing: ENFORCEABILITY_FRAMING,
    admissionSlots: Object.freeze(admissionSlots),
    upstreamCapacity: Object.freeze(upstreamCapacity),
    /**
     * What the run paid for whatever enforcement it got. An enforced slot is
     * bought with a shed request; an unlent token floor is bought with tokens
     * no borrower could use while the owner was idle.
     */
    cost: Object.freeze({
      requestsShed: nonNegative(deadlineCost?.abandoned),
      shedRate: deadlineCost?.abandonedRate ?? null,
      tokensWithheldFromBorrowing: unlentTokens,
      /**
       * Slots Tyr says it took back, minus requests the client says it lost.
       *
       * The two counts are the same event seen from opposite ends and should
       * roughly agree. A large positive gap means the client could not
       * attribute abandonments it actually suffered — they are sitting in some
       * other bucket, most likely `transportError`, and the mechanism looks
       * free when it is not. A measured run is what surfaced exactly this: an
       * earlier attribution rule left all 26 abandonments unattributed.
       *
       * Small non-zero gaps are expected. Tyr counts per replica across the
       * whole pool's lifetime while the client counts logical attempts in one
       * arm, so this is a discrepancy signal, not an equality assertion.
       */
      controllerReportedDeadlineReleases: admissionSlots.deadlinesReleased,
      clientAttributionGap:
        admissionSlots.deadlinesReleased - nonNegative(deadlineCost?.abandoned),
    }),
  });
}

function sloObserved(episodes, resource) {
  if (episodes?.status !== "measured") return false;
  return episodes.resources.some((row) => row.resource === resource && row.episodes > 0);
}

/**
 * Rolls the per-seed ladder up across a sweep.
 *
 * Counting seeds rather than averaging verdicts is deliberate. Enforceability
 * is categorical: an arm either withheld capacity or it did not, and a mean of
 * "enforced" and "objective" is not a thing. The only numbers averaged here
 * are the bills, which really are continuous.
 */
export function aggregateRestorationLadder(rows) {
  const seeds = rows.filter((row) => row?.restorationLadder !== undefined);
  if (seeds.length === 0) return null;
  const armKeys = [...new Set(seeds.flatMap((row) => Object.keys(row.restorationLadder)))].sort();
  const arms = {};
  for (const key of armKeys) {
    const entries = seeds
      .map((row) => row.restorationLadder[key])
      .filter((entry) => entry !== undefined);
    const verdicts = entries.map((entry) => entry.verdict);
    const enforceabilities = [...new Set(verdicts.map((v) => v.admissionSlots.effectiveEnforceability))];
    if (enforceabilities.length > 1) {
      throw new Error(
        `arm ${key} reported different admission-slot enforceability across seeds: ${enforceabilities.join(", ")}`,
      );
    }
    const shed = verdicts.map((v) => nonNegative(v.cost.requestsShed));
    const withheld = verdicts.map((v) => nonNegative(v.cost.tokensWithheldFromBorrowing));
    arms[key] = Object.freeze({
      seeds: entries.length,
      pool: entries[0]?.pool ?? null,
      admissionSlotEnforceability: enforceabilities[0] ?? null,
      upstreamEnforceability: verdicts[0]?.upstreamCapacity.effectiveEnforceability ?? null,
      seedsWithSlotDeadlineObserved: verdicts.filter((v) => v.admissionSlots.observed).length,
      seedsWithUnlentTokensObserved: verdicts.filter((v) => v.upstreamCapacity.observed).length,
      requestsShedTotal: shed.reduce((sum, value) => sum + value, 0),
      requestsShedMedian: median(shed),
      tokensWithheldFromBorrowing: withheld[0] ?? 0,
      silentTruncationRateMedian: median(
        entries
          .map((entry) => entry.deadlineCost?.silentTruncationRate)
          .filter((value) => Number.isFinite(value)),
      ),
      /** Never varies; restated per arm so a reader of one row cannot miss it. */
      upstreamReclamation: "not-claimed",
    });
  }
  return Object.freeze({ framing: ENFORCEABILITY_FRAMING, arms: Object.freeze(arms) });
}
