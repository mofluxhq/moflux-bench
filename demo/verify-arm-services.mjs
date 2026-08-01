/**
 * verify-arm-services.mjs — every arm's infrastructure is actually started.
 *
 * The bug this exists to prevent, which shipped once: the Redis-coordinated
 * arm was added to the sweep, but `redis` was never added to the set of
 * Compose services the presenter brings up. Redis is defined in
 * demo/compose.yaml and was needed by the standalone research walkthrough, so
 * everything looked wired — but the paired presenter had never needed it, and
 * the arm failed at the first flush with "Redis was not reachable".
 *
 * It slipped through because every other verifier in this chain is a pure
 * function test: none of them start Docker, so none of them could notice a
 * missing service. This one closes that gap by checking the source statically,
 * which needs no daemon.
 *
 * Run: node demo/verify-arm-services.mjs
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const presentSource = readFileSync(path.join(ROOT, "demo", "present.mjs"), "utf8");

/**
 * The source with commented-out lines removed.
 *
 * Checks for a call site must run against live code. Testing the raw source
 * lets a disabled call keep passing: commenting out `await waitForRedis()`
 * leaves text that still matches a naive search, so the guard reports healthy
 * while the wait no longer happens.
 *
 * Only whole-line comments are stripped, so a `//` inside a string literal —
 * a URL, for instance — is left alone.
 */
const present = presentSource
  .split("\n")
  .filter((line) => {
    const trimmed = line.trim();
    return !(trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*"));
  })
  .join("\n");
const compose = readFileSync(path.join(ROOT, "demo", "compose.yaml"), "utf8");

const failures = [];
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`PASS  ${name}`);
  } else {
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
}

// Services the base Compose file defines, by top-level key.
const composeServices = new Set(
  [...compose.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((match) => match[1]),
);

// Guard the guard: if comment-stripping ever removes real code, every check
// below turns into a false pass.
check(
  "comment stripping leaves the executable source intact",
  present.includes("async function waitForRedis(") && present.length > presentSource.length * 0.5,
);

check(
  "the base Compose file defines redis",
  composeServices.has("redis"),
  [...composeServices].join(", "),
);

// Every arm in the registry that declares needsRedis.
const armsNeedingRedis = [...present.matchAll(/needsRedis:\s*true/g)].length;
check("at least one arm declares a Redis dependency", armsNeedingRedis > 0);

// The presenter must bring redis up, conditioned on an arm needing it.
check(
  "the presenter adds redis to the services it starts",
  /supportServices\.push\("redis"\)/.test(present),
);
check(
  "redis is started only when a selected arm needs it",
  /CONTROL_ARMS\.some\(\(spec\) => spec\.needsRedis\)[\s\S]{0,120}supportServices\.push\("redis"\)/.test(
    present,
  ),
);

// Starting a container is not the same as it being ready to serve.
check("the presenter waits for Redis readiness", /async function waitForRedis\(/.test(present));
check("readiness is proven with a command, not a socket connect", /command\("PING"\)/.test(present));
check(
  "readiness is awaited during startup, before any arm runs",
  /await waitForRedis\(\)/.test(present),
);

// Readiness failure and flush failure are different faults and must not share
// one message, or a genuine flush error reads as a missing container.
const readinessMessage = /never became ready for the coordinated arm/.test(present);
const flushMessage = /Could not clear Redis state before the coordinated arm/.test(present);
check("a missing Redis reports as a readiness failure", readinessMessage);
check("a failed flush reports as its own distinct fault", flushMessage);
check(
  "the readiness error names the command that diagnoses it",
  /docker compose -f demo\/compose\.yaml ps redis/.test(present),
);

// The flush must still happen: skipping it carries leases across seeds.
check(
  "the coordinated arm flushes state before running",
  /if \(needsRedis\) await flushRedis\(\)/.test(present),
);

// Arms that need nothing extra must not drag Redis up with them.
check(
  "the static cap declares no Redis dependency",
  /"static-cap":\s*\{[\s\S]*?needsRedis:\s*false/.test(present),
);

console.log();
if (failures.length > 0) {
  console.log(`${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("All checks passed.");
