/**
 * publish-evidence-lib.mjs — the only way generated output becomes reviewed
 * evidence.
 *
 * Split from the CLI so the retargeting and the refusal rules can be tested
 * without a filesystem full of real sweeps.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { isReviewedEvidence, repoRelative } from "./evidence-paths-lib.mjs";

/**
 * Rewrites the per-seed evidence pointers in a sweep summary from the run
 * directory that produced them to the reviewed directory they are moving to.
 *
 * Returns a new summary; the input is not mutated. Throws when a pointer does
 * not sit under `fromPrefix`, because a summary that half-points at a deleted
 * run directory is worse than a failed publish.
 */
export function retargetSummary(summary, fromPrefix, toPrefix) {
  const from = fromPrefix.endsWith("/") ? fromPrefix : `${fromPrefix}/`;
  const to = toPrefix.endsWith("/") ? toPrefix : `${toPrefix}/`;
  const retarget = (value, where) => {
    if (typeof value !== "string") return value;
    if (!value.startsWith(from)) {
      throw new Error(`${where} does not point into ${from}: ${value}`);
    }
    return `${to}${value.slice(from.length)}`;
  };

  const runs = (summary.runs ?? []).map((run, index) => {
    const arms = Object.fromEntries(
      Object.entries(run.arms ?? {}).map(([key, value]) => [
        key,
        retarget(value, `runs[${index}].arms.${key}`),
      ]),
    );
    const scenario = run.scenario
      ? {
          ...run.scenario,
          // Previously this pointed at a scratch file the sweep deleted on the
          // way out. The per-seed trace copy is the artifact that survives, so
          // point at that instead.
          ...(run.scenario.trace && arms.trace
            ? { trace: { ...run.scenario.trace, evidence: arms.trace } }
            : {}),
        }
      : run.scenario;
    return { ...run, scenario, arms };
  });

  return { ...summary, runs };
}

/** Files a run directory contributes as reviewed evidence.
 *
 * Keep the root summary separate because it is rewritten to
 * `results/<name>.json`. Everything else that forms reproducible evidence may
 * be nested (for example OpenAI sweep `seed-N/summary.json` plus the exact Tyr
 * YAML used for that seed), so walk recursively instead of assuming a flat
 * seed-sweep directory.
 */
export function evidenceFiles(runDir, relativeDir = "") {
  const directory = path.join(runDir, relativeDir);
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...evidenceFiles(runDir, relative));
      continue;
    }
    if (!entry.isFile()) continue;
    if (relativeDir === "" && entry.name === "summary.json") continue;
    if (!/\.(?:json|ya?ml)$/i.test(entry.name)) continue;
    files.push(relative);
  }
  return files.sort();
}

/**
 * Promotes one completed run to `results/<name>.json` + `results/<name>/`.
 *
 * Refuses when the target already exists unless `force` is set. That refusal is
 * the entire point: an accidental overwrite of cited evidence should cost a
 * deliberate flag, not happen as a side effect of running the demo.
 */
export function publishRun({ root, resultsRoot, runDir, name, force = false, now = new Date() }) {
  if (!name || /[^a-zA-Z0-9._-]/.test(name)) {
    throw new Error(`invalid evidence name ${JSON.stringify(name)}`);
  }
  const summaryFile = path.join(runDir, "summary.json");
  if (!existsSync(summaryFile)) {
    throw new Error(`no summary.json in ${repoRelative(runDir, root)}; is that a completed run?`);
  }

  const targetSummary = path.join(resultsRoot, `${name}.json`);
  const targetDir = path.join(resultsRoot, name);
  const targetSummaryRel = repoRelative(targetSummary, root);
  const targetDirRel = repoRelative(targetDir, root);

  // Publishing to a path that is not reviewed evidence is allowed but worth
  // saying out loud, because nothing will protect it afterwards.
  const reviewed = isReviewedEvidence(targetSummaryRel) || isReviewedEvidence(`${targetDirRel}/`);

  const existing = existsSync(targetSummary) || existsSync(targetDir);
  if (existing && !force) {
    throw new Error(
      `${targetSummaryRel} already exists.\n` +
        "Publishing would replace evidence that may already be cited elsewhere.\n" +
        "Check what would change first:\n" +
        `  git diff --stat -- ${targetSummaryRel} ${targetDirRel}\n` +
        "Then re-run with --force if replacing it is intended.",
    );
  }

  const files = evidenceFiles(runDir);
  const summary = JSON.parse(readFileSync(summaryFile, "utf8"));
  const retargeted = retargetSummary(
    summary,
    repoRelative(runDir, root),
    targetDirRel,
  );
  // Multi-seed sweep summaries may retain convenience pointers back to their
  // generated run directory. Once promoted, those pointers must name the
  // reviewed artifacts that will survive cleanup of `results/runs/`.
  if (retargeted.outputs && typeof retargeted.outputs === "object") {
    retargeted.outputs = {
      ...retargeted.outputs,
      ...(Object.hasOwn(retargeted.outputs, "summary") ? { summary: targetSummaryRel } : {}),
      ...(Object.hasOwn(retargeted.outputs, "seedRunsDirectory")
        ? { seedRunsDirectory: targetDirRel }
        : {}),
    };
  }
  retargeted.publishedAt = now.toISOString();
  retargeted.publishedFrom = repoRelative(runDir, root);

  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });
  for (const file of files) {
    const destination = path.join(targetDir, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.join(runDir, file), destination);
  }
  // No trailing newline: matches every summary already published, so a
  // republish shows only the changes that are real.
  writeFileSync(targetSummary, JSON.stringify(retargeted, null, 2));

  return {
    name,
    reviewed,
    replaced: existing,
    summary: targetSummaryRel,
    directory: targetDirRel,
    files: files.length,
    from: repoRelative(runDir, root),
  };
}
