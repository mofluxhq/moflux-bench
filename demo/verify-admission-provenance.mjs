#!/usr/bin/env node
import {
  proveAdmissionUsesSuccessorGrant,
  summarizeAdmissionProvenance,
} from "./admission-provenance-lib.mjs";

const failures = [];
function check(label, condition) {
  if (condition) console.log(`✓ ${label}`);
  else {
    console.error(`✗ ${label}`);
    failures.push(label);
  }
}

function evidence({ nextSequence, dropped = 0, captureFailures = 0, events = [] }) {
  return {
    capacity: 512,
    retained: events.length,
    dropped,
    captureFailures,
    nextSequence,
    events,
  };
}

function batchEvent({ sequence, grantId, revision = 7, admittedAt = null }) {
  return {
    schema: "tyr.admission-provenance.v1",
    sequence,
    admittedAt: admittedAt ?? `2026-08-19T16:26:54.${String(400 + sequence).padStart(3, "0")}Z`,
    admissionId: `admission-${sequence}`,
    pool: "sim-batch",
    priority: "normal",
    limitRevision: revision,
    reservedTokens: 9942,
    limits: {
      revision,
      maxConcurrent: 4,
      maxQueue: 0,
      tokenBudget: { budget: 40000, highPriorityReserve: 0 },
    },
    grant: {
      source: "latchflo",
      grantId,
      controllerEpoch: 3,
      revision,
      expiresAt: "2026-08-19T16:28:00.000Z",
    },
  };
}

const samples = [
  {
    observedAt: "2026-08-19T16:26:53.900Z",
    replicas: [
      { port: 8101, batch: { admissionProvenance: null } },
      { port: 8104, batch: { admissionProvenance: evidence({ nextSequence: 5 }) } },
    ],
  },
  {
    observedAt: "2026-08-19T16:26:54.650Z",
    replicas: [
      { port: 8101, batch: { admissionProvenance: null } },
      {
        port: 8104,
        batch: {
          admissionProvenance: evidence({
            nextSequence: 6,
            events: [batchEvent({ sequence: 5, grantId: "batch-successor" })],
          }),
        },
      },
    ],
  },
  {
    observedAt: "2026-08-19T16:26:55.150Z",
    replicas: [
      {
        port: 8104,
        batch: {
          admissionProvenance: evidence({
            nextSequence: 7,
            events: [
              batchEvent({ sequence: 5, grantId: "batch-successor" }),
              batchEvent({ sequence: 6, grantId: "later-renewal", revision: 8 }),
            ],
          }),
        },
      },
    ],
  },
];

const summary = summarizeAdmissionProvenance(samples, { pool: "batch" });
check("establishes one batch provenance baseline", summary.replicas.length === 1);
check("does not treat baseline history as measured-run admission", summary.events.length === 2);
check("preserves the first newly admitted event by Tyr sequence", summary.firstEventsByReplica[0]?.sequence === 5);
check("preserves the exact successor grant", summary.firstEventsByReplica[0]?.grant?.grantId === "batch-successor");
check("provenance is complete when no events were dropped or capture failed", summary.complete === true);

const proof = proveAdmissionUsesSuccessorGrant({
  provenance: summary,
  successorGrantIds: ["batch-successor"],
  predecessorGrantIds: ["batch-predecessor"],
});
check("successor grant proves post-commit authority without clock ordering", proof.proven === true);
check("successor proof is explicitly grant-based", proof.status === "proven_after_commit_by_successor_grant");

const handoffScoped = proveAdmissionUsesSuccessorGrant({
  provenance: {
    ...summary,
    events: [
      batchEvent({
        sequence: 4,
        grantId: "batch-predecessor",
        admittedAt: "2026-08-19T16:26:53.500Z",
      }),
      batchEvent({
        sequence: 5,
        grantId: "unrelated-renewal",
        admittedAt: "2026-08-19T16:26:54.200Z",
      }),
      batchEvent({
        sequence: 6,
        grantId: "batch-successor",
        admittedAt: "2026-08-19T16:26:54.600Z",
      }),
    ],
  },
  successorGrantIds: ["batch-successor"],
  predecessorGrantIds: ["batch-predecessor"],
  notBeforeAt: "2026-08-19T16:26:54.000Z",
});
check("pre-handoff predecessor admissions do not retroactively violate a later handoff", handoffScoped.violated === false);
check("unrelated grants are ignored when proving one handoff lineage", handoffScoped.proven === true);
check("handoff-scoped proof identifies the successor admission", handoffScoped.firstEvents[0]?.grant?.grantId === "batch-successor");

const predecessorSamples = structuredClone(samples);
predecessorSamples[1].replicas[1].batch.admissionProvenance.events[0].grant.grantId = "batch-predecessor";
predecessorSamples[2].replicas[0].batch.admissionProvenance.events[0].grant.grantId = "batch-predecessor";
const predecessorSummary = summarizeAdmissionProvenance(predecessorSamples, { pool: "batch" });
const violation = proveAdmissionUsesSuccessorGrant({
  provenance: predecessorSummary,
  successorGrantIds: ["batch-successor"],
  predecessorGrantIds: ["batch-predecessor"],
});
check("predecessor-grant admission is a proved ordering violation", violation.violated === true);
check("predecessor violation has an explicit status", violation.status === "proven_before_commit_by_predecessor_grant");

const droppedSamples = structuredClone(samples);
droppedSamples[2].replicas[0].batch.admissionProvenance.dropped = 1;
const dropped = summarizeAdmissionProvenance(droppedSamples, { pool: "batch" });
check("retention loss makes exact admission evidence incomplete", dropped.complete === false && dropped.reason === "retention_loss");
const inconclusive = proveAdmissionUsesSuccessorGrant({
  provenance: dropped,
  successorGrantIds: ["batch-successor"],
  predecessorGrantIds: ["batch-predecessor"],
});
check("retention loss is inconclusive, never silently proven", inconclusive.status === "inconclusive_provenance_loss");

console.log();
if (failures.length) {
  console.error(`${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("All admission provenance checks passed.");
