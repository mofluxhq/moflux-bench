import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function parseEnvFile(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function run(command, args, { cwd, inherit = false, allowFailure = false, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

export function assertDockerAvailable() {
  let result;
  try {
    result = run("docker", ["info"], { allowFailure: true });
  } catch (error) {
    throw new Error("Docker is required for this demo; the docker command is missing or unavailable.", { cause: error });
  }
  if (result.status !== 0) {
    throw new Error("Docker is required for this demo and the Docker daemon is not available.");
  }
}

function packageVersion(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).version;
  } catch {
    return undefined;
  }
}

export function discoverLocalSource({ root, envKey, repoName, version, sourceDir }) {
  const candidates = [];
  const configured = sourceDir ?? process.env[envKey];
  if (configured) candidates.push(path.isAbsolute(configured) ? configured : path.resolve(root, configured));
  candidates.push(path.resolve(root, "..", repoName));
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "Dockerfile")) && packageVersion(candidate) === version) return candidate;
  }
  return undefined;
}

export function ensureRuntimeImage({ root, image, envKey, repoName, version, label, sourceDir }) {
  if (!image) throw new Error(`${label} image is not configured`);
  if (run("docker", ["image", "inspect", image], { allowFailure: true }).status === 0) return;
  const source = discoverLocalSource({ root, envKey, repoName, version, sourceDir });
  if (!source) {
    throw new Error(
      `${label} image ${image} is unavailable. Build/pull it first, place ${repoName} ${version} beside moflux-bench, ` +
      `or set ${envKey} to that source directory.`,
    );
  }
  console.log(`Building ${label} ${version} from ${source}`);
  run("docker", ["build", "-t", image, source], { inherit: true });
  if (run("docker", ["image", "inspect", image], { allowFailure: true }).status !== 0) {
    throw new Error(`Docker build completed but ${image} is still unavailable`);
  }
}

export function composeCommand({ project, envFile, composeFile, args, cwd, env = process.env, inherit = false, allowFailure = false }) {
  return run(
    "docker",
    ["compose", "-p", project, "--env-file", envFile, "-f", composeFile, ...args],
    { cwd, env, inherit, allowFailure },
  );
}
