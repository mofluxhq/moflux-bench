#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDemoEnv } from "./env-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = process.env.MOFLUX_BENCH_ENV_FILE
  ? path.resolve(process.env.MOFLUX_BENCH_ENV_FILE)
  : path.join(ROOT, "demo", "moflux", ".env");
ensureDemoEnv(file, { quiet: process.argv.includes("--quiet") });
