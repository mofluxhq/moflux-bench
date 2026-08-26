#!/usr/bin/env node
/**
 * verify-arm-health.mjs — the gate that refuses an arm which measured nothing.
 *
 * The regression this locks down was a real published-evidence hazard: an arm
 * whose replicas were healthy but whose upstream was not the provider simulator
 * completed, passed every existing assertion, and reported 0.0% success with
 * zero rejects into a five-seed median. The fixture below is the exact shape
 * that produced it.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  UNATTRIBUTED_FAILURE_TOLERANCE,
  armHealth,
  assertArmProducedWork,
} from "./arm-health-lib.mjs";
import { DEFAULT_CONTROL_ARM_NAMES, resolveControlArmNames } from "./control-arm-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const cls = (over = {}) => ({
  attempts: 400,
  success: 200,
  localReject: 200,
  upstreamReject: 0,
  serverError: 0,
  transportError: 0,
  ...over,
});
const summary = (interactive, batch = cls()) => ({ classes: { interactive, batch } });

// ── the reported failure ─────────────────────────────────────────────
// Every attempt failed against a non-provider upstream: no successes, no
// admission decision, retries pinned at maxAttempts.
const brokenUpstream = summary(
  cls({ attempts: 616, success: 0, localReject: 0, upstreamReject: 0, serverError: 616 }),
  cls({ attempts: 152, success: 0, localReject: 0, upstreamReject: 0, serverError: 152 }),
);
check("an arm with no successes and no admission decisions is unhealthy", !armHealth(brokenUpstream).ok);
check(
  "and is refused rather than reported",
  (() => {
    try {
      assertArmProducedWork(brokenUpstream, "Static cap");
      return false;
    } catch (error) {
      return /Static cap/.test(error.message) && /harness fault/.test(error.message);
    }
  })(),
);
check(
  "the refusal names the missing provider, not the admission policy",
  (() => {
    try {
      assertArmProducedWork(brokenUpstream, "Static cap", { providerBaseUrl: "http://127.0.0.1:9000" });
      return false;
    } catch (error) {
      return error.message.includes("http://127.0.0.1:9000") && /proxy/.test(error.message);
    }
  })(),
);

// A connection that never opens looks different in the counters and must fail
// the same way.
const deadUpstream = summary(
  cls({ attempts: 616, success: 0, localReject: 0, upstreamReject: 0, transportError: 616 }),
  cls({ attempts: 152, success: 0, localReject: 0, upstreamReject: 0, transportError: 152 }),
);
check("transport failures fail the same gate as unattributed 5xx failures", !armHealth(deadUpstream).ok);

// ── outcomes that are real results ───────────────────────────────────
check("a healthy mixed arm passes", armHealth(summary(cls())).ok);
check(
  "an arm that rejected everything locally is a result, not a fault",
  armHealth(summary(cls({ success: 0, localReject: 400 }))).ok,
  "a saturated policy legitimately refuses every request",
);
check(
  "an arm that was 429'd by the provider throughout is a result",
  armHealth(summary(cls({ success: 0, localReject: 0, upstreamReject: 400 }))).ok,
);
check(
  "one stray dropped stream does not discard a sweep",
  armHealth(summary(cls({ attempts: 400, success: 199, transportError: 1 }))).ok,
  `tolerance is ${UNATTRIBUTED_FAILURE_TOLERANCE}`,
);
check(
  "a systematic rate of unattributable failures does",
  !armHealth(summary(cls({ attempts: 400, success: 180, localReject: 180, transportError: 40 }))).ok,
);
const empty = cls({ attempts: 0, success: 0, localReject: 0 });
check("an arm that attempted nothing is unhealthy", !armHealth(summary(empty, empty)).ok);

// ── the tolerance is calibrated against committed evidence ───────────
const evidenceDir = path.join(ROOT, "results", "video-seed-sweep");
if (existsSync(evidenceDir)) {
  const armFiles = readdirSync(evidenceDir).filter((f) => f.endsWith(".json"));
  const scanned = [];
  for (const file of armFiles) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path.join(evidenceDir, file), "utf8"));
    } catch {
      continue;
    }
    if (parsed?.classes?.interactive) scanned.push([file, armHealth(parsed)]);
  }
  check(
    "every committed arm summary passes the gate",
    scanned.length > 0 && scanned.every(([, health]) => health.ok),
    scanned.filter(([, h]) => !h.ok).map(([f]) => f).join(", "),
  );
  check(
    "and none of them carries an unattributable failure at all",
    scanned.every(([, health]) => health.unattributed === 0),
    "the tolerance is headroom, not an allowance the published runs use",
  );
}

// ── "all" means the same thing to both callers ───────────────────────
const presenterArms = ["static-cap", "static-partition", "redis"];
const wrapperArms = ["static-cap", "static-partition", "redis"];
check(
  "the presenter and the sweep wrapper expand --control-arms=all identically",
  JSON.stringify(resolveControlArmNames("all", presenterArms)) ===
    JSON.stringify(resolveControlArmNames("all", wrapperArms)),
);
check(
  "and all means the two buy-vs-build arms, not every registered spec",
  JSON.stringify([...DEFAULT_CONTROL_ARM_NAMES]) === JSON.stringify(["static-cap", "redis"]),
  "static-partition is the lending control, selected explicitly by demo:lending",
);
check("the partition arm is still selectable by name", JSON.stringify(resolveControlArmNames("static-partition", presenterArms)) === JSON.stringify(["static-partition"]));
check("an empty value selects no control arms", resolveControlArmNames("", presenterArms).length === 0);
check(
  "an unknown arm is rejected",
  (() => {
    try {
      resolveControlArmNames("static-capp", presenterArms);
      return false;
    } catch (error) {
      return /unsupported/.test(error.message);
    }
  })(),
);

// ── the presenter actually calls the gate ────────────────────────────
const present = readFileSync(path.join(ROOT, "demo/present.mjs"), "utf8");
check("assertValidRun runs the health gate", /assertArmProducedWork\(summary, label/.test(present));
check("every arm's provider identity is proven before load", (present.match(/assertProviderIdentity\(/g) ?? []).length >= 3);
check(
  "provider occupancy is no longer allowed to be silently unknown",
  !/return \(await response\.json\(\)\)\?\.counters \?\? null;/.test(present),
);
check(
  "only an arm on the admission path records coordinator latency",
  /consultsCoordinator \? OPT\.coordinatorLatencyMs : 0/.test(present),
);
check(
  "the redis arm is the one that records it",
  /attachScenario\(summary, \{ consultsCoordinator: Boolean\(needsRedis\) \}\)/.test(present),
);

// ── the ladder reads back the rung it ran ────────────────────────────
const ladder = readFileSync(path.join(ROOT, "demo/coordinator-ladder.mjs"), "utf8");
check("each rung writes a named run directory", /--run-id=\$\{rungRunId\(latencyMs\)\}/.test(ladder));
check("and the rung is read back from that directory", /runDirFor\(RESULTS, SWEEP_NAME, rungRunId\(latencyMs\)\)/.test(ladder));
check("a rung that disagrees with its own evidence fails", /records rung \$\{recorded\}ms/.test(ladder));
check("the ladder no longer passes a flag nothing reads", !/--keep-stack/.test(ladder));

assert.equal(typeof armHealth(summary(cls())).unattributedRate, "number");

console.log();
if (failures > 0) {
  console.log(`${failures} check(s) failed.`);
  process.exit(1);
}
console.log("All checks passed.");
