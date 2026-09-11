#!/usr/bin/env node
/**
 * 0.36.0 native-unlent follow-up to the published local-contention baseline.
 *
 * The wrapper selects the profile before local-contention-lib.mjs is imported,
 * so every policy helper, proof and summary sees one immutable experiment
 * definition. All CLI arguments are consumed by local-contention.mjs unchanged.
 */
process.env.MOFLUX_LOCAL_CONTENTION_PROFILE = "unlent-concurrency-1";
await import("./local-contention.mjs");
