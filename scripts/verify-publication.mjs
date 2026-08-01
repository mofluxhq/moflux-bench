#!/usr/bin/env node
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  ".gitignore",
  ".github/workflows/ci.yml",
  "demo/moflux/.env.example",
];
const ignoredDirectories = new Set([".git", "node_modules", "coverage", ".tmp", "tmp"]);
const forbiddenNames = new Set([".DS_Store", "Thumbs.db"]);
const forbiddenExtensions = new Set([".pem", ".p12", ".pfx", ".jks", ".keystore"]);
const findings = [];

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(ROOT, full).split(path.sep).join("/");
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) findings.push(`${rel}: symbolic links are not allowed in a release`);
    if (entry.isDirectory()) {
      if (entry.name === "__MACOSX") findings.push(`${rel}: macOS archive metadata is not allowed`);
      files.push(...walk(full));
    } else if (entry.isFile()) {
      files.push({ full, rel });
    }
  }
  return files;
}

for (const rel of required) {
  try {
    if (!lstatSync(path.join(ROOT, rel)).isFile()) findings.push(`${rel}: required file is missing`);
  } catch {
    findings.push(`${rel}: required file is missing`);
  }
}

const files = walk(ROOT);
const privateKeyMarker = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
const contentPatterns = [
  [/(?:^|["'\s])\/(?:Users|home)\/[A-Za-z0-9._-]+\//m, "absolute user-home path"],
  [/[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\/i, "absolute Windows user-home path"],
  [/AKIA[0-9A-Z]{16}/, "AWS access key"],
  [/AIza[0-9A-Za-z_-]{35}/, "Google API key"],
  [/gh[pousr]_[A-Za-z0-9_]{20,}/, "GitHub token"],
  [/sk-[A-Za-z0-9_-]{20,}/, "API secret key"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [new RegExp(privateKeyMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "private key"],
];

for (const { full, rel } of files) {
  const base = path.basename(rel);
  if (forbiddenNames.has(base)) findings.push(`${rel}: forbidden generated file`);
  if (base === ".env" || (base.startsWith(".env.") && base !== ".env.example")) {
    findings.push(`${rel}: local environment file must not be published`);
  }
  if (forbiddenExtensions.has(path.extname(base).toLowerCase())) {
    findings.push(`${rel}: credential-container extension is not allowed`);
  }
  if (rel.startsWith("results/") && rel.endsWith(".json") && !rel.startsWith("results/curated/")) {
    findings.push(`${rel}: generated JSON must not be committed outside results/curated/`);
  }
  if (rel === "scripts/verify-publication.mjs") continue;
  const buffer = readFileSync(full);
  if (buffer.includes(0)) continue;
  const text = buffer.toString("utf8");
  for (const [pattern, label] of contentPatterns) {
    if (pattern.test(text)) findings.push(`${rel}: contains ${label}`);
  }
  if (rel.startsWith("results/curated/") && rel.endsWith(".json")) {
    try { JSON.parse(text); } catch (error) {
      findings.push(`${rel}: invalid JSON (${error.message})`);
    }
  }
}

const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
if (pkg.private !== true) findings.push("package.json: benchmark package must remain private to prevent accidental npm publication");
if (pkg.license !== "Apache-2.0") findings.push("package.json: license must be Apache-2.0");
if (lock.packages?.[""]?.version !== pkg.version || lock.version !== pkg.version) {
  findings.push("package-lock.json: version does not match package.json");
}
const example = readFileSync(path.join(ROOT, "demo/moflux/.env.example"), "utf8");
for (const expected of [
  "MOFLUX_TYR_IMAGE=tyr-admission-controller:0.16.0",
  "MOFLUX_LATCHFLO_IMAGE=latchflo-control-plane:0.5.0",
]) {
  if (!example.includes(expected)) {
    findings.push(`demo/moflux/.env.example: missing pinned runtime ${expected}`);
  }
}
for (const name of ["LATCHFLO_ADMIN_TOKEN", "LATCHFLO_AGENT_BOOTSTRAP_TOKEN"]) {
  const match = new RegExp(`^${name}=(.*)$`, "m").exec(example);
  if (!match || !match[1].startsWith("replace-with-")) {
    findings.push(`demo/moflux/.env.example: ${name} must remain an explicit placeholder`);
  }
}

for (let replica = 1; replica <= 4; replica += 1) {
  const rel = `demo/moflux/tyr-r${replica}.yaml`;
  const yaml = readFileSync(path.join(ROOT, rel), "utf8");
  if (!/^    version: 0\.16\.0$/m.test(yaml)) {
    findings.push(`${rel}: control-plane metadata must identify Tyr 0.16.0`);
  }
}
if (pkg.scripts?.demo !== "node demo/seed-sweep.mjs --seeds=1-5 --pause-ms=0" ||
    pkg.scripts?.predemo !== "npm run demo:prepare" ||
    pkg.scripts?.["demo:record"] !== "node demo/seed-sweep.mjs --seeds=1-5 --step") {
  findings.push("package.json: npm run demo must remain automatic and demo:record must retain the step-through path");
}
if (!pkg.scripts?.verify?.includes("scripts/verify.mjs")) {
  findings.push("package.json: verify must use the bounded verification runner");
}

if (findings.length > 0) {
  console.error("Publication verification failed:\n");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}
console.log(`PASS  publication hygiene (${files.length} files scanned)`);
