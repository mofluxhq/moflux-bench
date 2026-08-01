/**
 * verify-loadgen-args.mjs — every trace-shaping option reaches the generator.
 *
 * The bug this exists to prevent, which shipped once: `--size-distribution`
 * was added to the presenter and to the load generator, and the presenter
 * built a version-2 trace with it — but never forwarded the flag. The
 * generator therefore parsed its own config as `uniform`, rebuilt the expected
 * workload from that, and rejected the very trace the presenter had just
 * handed it:
 *
 *     Error: trace is version 2 but this configuration expects version 1
 *
 * The failure is not subtle once it happens, but nothing caught it before the
 * run: both files were individually correct and only their handshake was
 * broken.
 *
 * The check derives its expectations from `traceWorkload()` rather than from a
 * hand-written list, so a key added to the trace in future is covered without
 * anyone remembering to update this file. That is the whole point — a list
 * maintained by hand would have the same gap as the code it checks.
 *
 * Run: node demo/verify-loadgen-args.mjs
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { traceWorkload } from "../load/trace-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const present = readFileSync(path.join(ROOT, "demo", "present.mjs"), "utf8");
const loadgen = readFileSync(path.join(ROOT, "load", "loadgen.mjs"), "utf8");

const failures = [];
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`PASS  ${name}`);
  } else {
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
}

const kebab = (key) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/**
 * A configuration exercising every branch of traceWorkload(), so optional keys
 * that only appear in heterogeneous mode are included in the expectation.
 */
const FULL_CONFIG = {
  durationMs: 45000, seed: 3, interactiveRps: 6, interactiveInputChars: 1200,
  interactiveMaxTokens: 400, batchStartMs: 27000, batchDurationMs: 15750, batchRps: 3,
  batchInputChars: 24000, batchMaxTokens: 3000, maxAttempts: 4, backoffBaseMs: 250,
  sizeDistribution: "lognormal", interactiveSizeSigma: 0.75, batchSizeSigma: 0,
};

const traceKeys = Object.keys(traceWorkload(FULL_CONFIG));
check("traceWorkload exposes the heterogeneous keys", traceKeys.includes("sizeDistribution"));

// The presenter's argument list, isolated so a flag mentioned in a comment
// elsewhere in the file cannot satisfy the check.
const argsBlock = /function loadgenArgs\([\s\S]*?\n\}/.exec(present);
check("the presenter's loadgenArgs block is readable", Boolean(argsBlock));
const args = argsBlock ? argsBlock[0] : "";

for (const key of traceKeys) {
  const flag = `--${kebab(key)}=`;
  check(
    `loadgenArgs forwards ${flag}`,
    args.includes(flag),
    `${key} affects the trace hash but is not passed to the generator`,
  );
}

// The generator must actually accept each flag, or forwarding it is a no-op
// and the two sides disagree again — silently this time, because an unknown
// argument is ignored rather than rejected.
for (const key of traceKeys) {
  const flag = kebab(key);
  check(
    `the generator parses --${flag}`,
    new RegExp(`"${flag}"`).test(loadgen),
    `present.mjs sends --${flag} but loadgen.mjs never reads it`,
  );
}

// Both sides must agree on the default, or an unset flag means one thing to
// the presenter and another to the generator.
const presentDefault = /sizeDistribution: str\("size-distribution", "([^"]+)"\)/.exec(present);
const loadgenDefault = /sizeDistribution: str\("size-distribution", "([^"]+)"\)/.exec(loadgen);
check("both sides declare a size-distribution default", Boolean(presentDefault && loadgenDefault));
check(
  "the defaults agree",
  presentDefault && loadgenDefault && presentDefault[1] === loadgenDefault[1],
  presentDefault && loadgenDefault ? `${presentDefault[1]} vs ${loadgenDefault[1]}` : "",
);
check(
  "the default preserves version-1 behaviour",
  presentDefault && presentDefault[1] === "uniform",
  "a heterogeneous default would silently invalidate every recorded v1 result",
);

// The Redis arm is the only one that consults a coordinator on the admission
// path, so it is the only one that may receive this flag. Sending it to the
// others would make them look sensitive to a coordinator they never call.
const redisSpec = /redis: \{[\s\S]*?replicaFlags:[\s\S]*?\],/.exec(present);
check("the redis arm receives the coordinator latency", 
  Boolean(redisSpec) && redisSpec[0].includes("--coordinator-latency-ms="));
const staticSpec = /"static-cap":\s*\{[\s\S]*?replicaFlags:[\s\S]*?\],/.exec(present);
check("the static cap does not", 
  Boolean(staticSpec) && !staticSpec[0].includes("--coordinator-latency-ms="));
check("the generator is not sent a coordinator flag it cannot use",
  !args.includes("--coordinator-latency-ms="));

console.log();
if (failures.length > 0) {
  console.log(`${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("All checks passed.");
