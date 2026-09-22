import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { redactDiagnostic } from "../load/diagnostics-lib.mjs";

/** Best-effort collection: one failed source must not discard the others. */
export async function retainDiagnostics({ directory, collectors, secrets = [] }) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const entries = await Promise.all(Object.entries(collectors).map(async ([name, collect]) => {
    try {
      const value = await collect();
      writeFileSync(path.join(directory, name), redactDiagnostic(value, secrets) + "\n", { mode: 0o600 });
      return { file: name, status: "saved" };
    } catch (error) {
      return { file: name, status: "failed", error: redactDiagnostic(String(error), secrets) };
    }
  }));
  const manifest = { capturedAt: new Date().toISOString(), entries };
  writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  return manifest;
}
