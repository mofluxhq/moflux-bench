import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { retainDiagnostics } from "./diagnostics-lib.mjs";
import { redactDiagnostic } from "../load/diagnostics-lib.mjs";
const directory = mkdtempSync(path.join(tmpdir(), "moflux-diagnostics-"));
try {
  const manifest = await retainDiagnostics({ directory, secrets: ["literal-secret"], collectors: {
    "logs.txt": async () => "grant expired; literal-secret; Bearer another-secret",
    "grants.json": async () => ({ grantId: "g1", tokenBudget: 262144, agentToken: "hidden" }),
    "failed.json": async () => { throw new Error("offline literal-secret"); },
  } });
  assert.deepEqual(manifest.entries.map((x) => x.status), ["saved", "saved", "failed"]);
  assert.equal(JSON.parse(readFileSync(path.join(directory, "manifest.json"))).entries.length, 3);
  const logs = readFileSync(path.join(directory, "logs.txt"), "utf8");
  assert.match(logs, /grant expired/);
  assert.ok(!logs.includes("literal-secret") && !logs.includes("another-secret"));
  const grants = JSON.parse(readFileSync(path.join(directory, "grants.json")));
  assert.equal(grants.tokenBudget, 262144);
  assert.equal(grants.agentToken, "[REDACTED]");
  assert.ok(!manifest.entries[2].error.includes("literal-secret"));
  assert.equal(redactDiagnostic("prefix: abcdef", ["abcdef"]), "prefix: [REDACTED]");
} finally { rmSync(directory, { recursive: true, force: true }); }
console.log("PASS diagnostics survive individual capture failures and redact credentials");
