/**
 * evidence-paths-lib.mjs — where generated output may go, and where it may not.
 *
 * The problem this exists to prevent
 * ---------------------------------
 * Every sweep used to write its summary to `results/<sweep-name>.json` and its
 * per-seed files to `results/<sweep-name>/`. Those are also the paths that hold
 * reviewed, committed, published evidence. Running the demo therefore silently
 * replaced evidence that had already been cited elsewhere, under a different
 * runtime, with no record that it had happened — the JSON still validated, the
 * publication check still passed, and only the recorded `runtime.tyr.version`
 * inside the per-seed files revealed the swap.
 *
 * The rule now
 * ------------
 * A run writes only into `results/runs/<sweep-name>/<run-id>/`, which is
 * ignored by git. Reviewed evidence changes only through an explicit
 * `demo/publish-evidence.mjs` promotion, which refuses to overwrite without
 * `--force`. Both the sweep and the presenter assert their output directory is
 * not reviewed evidence before writing a byte, so a stray
 * `MOFLUX_BENCH_RESULTS_DIR` cannot reintroduce the problem.
 */

import path from "node:path";

/**
 * Repo-relative paths whose contents are reviewed evidence: committed,
 * potentially already cited, and never written by a run.
 *
 * A trailing slash marks a directory; everything under it is protected.
 *
 * Deliberately NOT listed: `results/lending.json`. It is generated output like
 * any other and now lands in a run directory, so nothing has to pretend it is
 * historical. Promote it with publish-evidence.mjs if it should be citable.
 */
export const REVIEWED_EVIDENCE = Object.freeze([
  "results/curated/",
  "results/tenant-fairness.json",
  "results/tenant-fairness/",
  "results/video-seed-sweep.json",
  "results/video-seed-sweep/",
  "results/video-seed-sweep-fault.json",
  "results/video-seed-sweep-fault/",
  "results/baseline-seed-sweep.json",
  "results/baseline-seed-sweep/",
  "results/moflux-seed-sweep.json",
  "results/moflux-seed-sweep/",
  "results/moflux-fault-seed-sweep.json",
  "results/moflux-fault-seed-sweep/",
  "results/openai-live-compatibility.json",
  "results/openai-live-compatibility/",
  "results/openai-live-overload-8-seed.json",
  "results/openai-live-overload-8-seed/",
  "results/local-inference-compatibility.json",
  "results/local-inference-compatibility/",
  // Deliberately a separate corpus from local-inference-compatibility above.
  // The 0.32.0 result is a compatibility measurement on an unsaturated server;
  // this one is a workload-isolation measurement under contention. Publishing
  // the second over the first would replace evidence for one claim with
  // evidence for a different one under a name that still says the old thing.
  "results/local-inference-contention.json",
  "results/local-inference-contention/",
  // 0.35.0 follow-up: same traces and floors, with one concurrency slot that
  // batch can never occupy. Kept separate so the negative baseline remains
  // immutable and citable.
  "results/local-inference-contention-unlent-concurrency.json",
  "results/local-inference-contention-unlent-concurrency/",
  "results/local-inference-contention-unlent-concurrency-v0.36.0.json",
  "results/local-inference-contention-unlent-concurrency-v0.36.0/",
  // GPU-backed four-arm vLLM experiment. Runs remain under results/runs until
  // explicitly reviewed and promoted; this target is protected in advance so
  // no future runner can overwrite a cited vLLM corpus.
  "results/vllm-contention.json",
  "results/vllm-contention/",
  // Apple-Silicon companion corpus. Kept distinct from CUDA because Metal,
  // unified memory, and host-process telemetry are not interchangeable with
  // NVIDIA device telemetry.
  "results/vllm-metal-contention.json",
  "results/vllm-metal-contention/",
  // Metal with a pinned KV pool. Protected in advance and kept separate from
  // the unpinned corpus above, which never pressured KV.
  "results/vllm-metal-long-context.json",
  "results/vllm-metal-long-context/",
  // The same long-context workload with a two-slot unlent interactive reserve.
  // A different policy, so a separate corpus, protected in advance.
  "results/vllm-metal-long-context-unlent-concurrency-2.json",
  "results/vllm-metal-long-context-unlent-concurrency-2/",
]);

/** Directory under the results root that holds generated runs. */
export const RUNS_DIRNAME = "runs";

/** Repo-relative POSIX form of an absolute path. */
export function repoRelative(target, root) {
  return path.relative(root, target).split(path.sep).join("/");
}

function normalize(entry) {
  return entry.endsWith("/") ? entry.slice(0, -1) : entry;
}

function isDirectoryEntry(entry) {
  return entry.endsWith("/");
}

/** True when `rel` is a reviewed artifact or sits inside a reviewed directory. */
export function isReviewedEvidence(rel) {
  const candidate = normalize(rel);
  return REVIEWED_EVIDENCE.some((entry) => {
    const base = normalize(entry);
    if (candidate === base) return true;
    return isDirectoryEntry(entry) && candidate.startsWith(`${base}/`);
  });
}

/** Reviewed entries that live inside `rel`, i.e. what a recursive delete would take. */
export function reviewedEvidenceInside(rel) {
  const candidate = normalize(rel);
  if (candidate === "" || candidate === ".") return [...REVIEWED_EVIDENCE];
  return REVIEWED_EVIDENCE.filter((entry) =>
    normalize(entry).startsWith(`${candidate}/`),
  );
}

/**
 * Guard for a directory a run will write individual files into.
 *
 * One-directional: the directory itself must not be reviewed evidence. The
 * results root legitimately *contains* reviewed evidence, so containment is
 * allowed here.
 */
export function assertSafeResultsDir(dir, root, label = "results directory") {
  const rel = repoRelative(dir, root);
  if (isReviewedEvidence(rel)) {
    throw new Error(
      `refusing to use reviewed evidence as a ${label}: ${rel}\n` +
        "Reviewed evidence is only changed by demo/publish-evidence.mjs. " +
        "Point MOFLUX_BENCH_RESULTS_DIR somewhere else.",
    );
  }
  return dir;
}

/**
 * Guard for a directory a run creates, deletes and recreates wholesale.
 *
 * Bi-directional: the directory must be neither reviewed evidence nor a parent
 * of any, because the run clears it recursively before it starts.
 */
export function assertSafeRunDir(dir, root, label = "run directory") {
  assertSafeResultsDir(dir, root, label);
  const rel = repoRelative(dir, root);
  const contained = reviewedEvidenceInside(rel);
  if (contained.length > 0) {
    throw new Error(
      `refusing to clear a ${label} that contains reviewed evidence: ${rel}\n` +
        `would destroy: ${contained.join(", ")}`,
    );
  }
  return dir;
}

/** Guard for a single file a run writes. */
export function assertSafeOutputFile(file, root, label = "output file") {
  const rel = repoRelative(file, root);
  if (isReviewedEvidence(rel)) {
    throw new Error(
      `refusing to write reviewed evidence as a ${label}: ${rel}\n` +
        "Use demo/publish-evidence.mjs to promote a completed run instead.",
    );
  }
  return file;
}

/**
 * Sortable, filesystem-safe UTC run identifier: `20260801T223625Z`.
 *
 * Second resolution is enough because a sweep takes minutes; `suffix`
 * disambiguates the pathological case of two runs starting in the same second.
 */
export function runId(now = new Date(), suffix = "") {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return suffix ? `${stamp}-${suffix}` : stamp;
}

/** `<results>/runs/<sweepName>` — the parent of every run of one sweep. */
export function sweepRunsDir(resultsRoot, sweepName) {
  return path.join(resultsRoot, RUNS_DIRNAME, sweepName);
}

/** `<results>/runs/<sweepName>/<runId>` — one run's private output directory. */
export function runDir(resultsRoot, sweepName, id) {
  return path.join(sweepRunsDir(resultsRoot, sweepName), id);
}

/** Stable pointer file naming the most recent run of a sweep. */
export function latestPointerFile(resultsRoot, sweepName) {
  return path.join(sweepRunsDir(resultsRoot, sweepName), "latest.json");
}
