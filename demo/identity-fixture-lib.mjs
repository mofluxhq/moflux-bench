import { generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:https";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

export const IDENTITY_ISSUER = "https://moflux-bench.local/";
export const IDENTITY_AUDIENCE = "moflux-bench";
export const IDENTITY_PORT = 9010;
export const PREMIUM_TENANT = "tenant-premium";
export const NOISY_TENANT = "tenant-noisy";

function runOpenSsl(args, cwd) {
  const result = spawnSync("openssl", args, { cwd, encoding: "utf8" });
  if (result.error) {
    throw new Error(`openssl could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `openssl ${args.join(" ")} failed with exit code ${result.status}: ` +
        `${result.stderr || result.stdout || "<no output>"}`,
    );
  }
}

/**
 * Generate a one-run CA and a server certificate valid for Docker Desktop's
 * host gateway. Nothing private is checked in; demo/classes/runtime is ignored
 * and removed before every run.
 */
export function generateIdentityTls(runtimeDir) {
  rmSync(runtimeDir, { recursive: true, force: true });
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const config = path.join(runtimeDir, "server.cnf");
  writeFileSync(
    config,
    `[req]\n` +
      `distinguished_name=req_dn\n` +
      `prompt=no\n` +
      `req_extensions=req_ext\n` +
      `[req_dn]\n` +
      `CN=host.docker.internal\n` +
      `[req_ext]\n` +
      `subjectAltName=@alt_names\n` +
      `[alt_names]\n` +
      `DNS.1=host.docker.internal\n` +
      `DNS.2=localhost\n` +
      `IP.1=127.0.0.1\n`,
    { mode: 0o600 },
  );

  runOpenSsl(
    [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", "ca-key.pem", "-out", "ca.pem",
      "-days", "2", "-subj", "/CN=MoFlux Bench Ephemeral CA",
    ],
    runtimeDir,
  );
  runOpenSsl(
    [
      "req", "-new", "-newkey", "rsa:2048", "-nodes",
      "-keyout", "server-key.pem", "-out", "server.csr",
      "-config", "server.cnf",
    ],
    runtimeDir,
  );
  runOpenSsl(
    [
      "x509", "-req", "-in", "server.csr",
      "-CA", "ca.pem", "-CAkey", "ca-key.pem", "-CAcreateserial",
      "-out", "server.pem", "-days", "2", "-sha256",
      "-extensions", "req_ext", "-extfile", "server.cnf",
    ],
    runtimeDir,
  );

  for (const name of ["ca-key.pem", "server-key.pem"]) {
    try { chmodSync(path.join(runtimeDir, name), 0o600); } catch { /* best effort */ }
  }
  return Object.freeze({
    ca: path.join(runtimeDir, "ca.pem"),
    key: path.join(runtimeDir, "server-key.pem"),
    cert: path.join(runtimeDir, "server.pem"),
  });
}

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function issueJwt(privateKey, kid, claims, nowSeconds = Math.floor(Date.now() / 1000)) {
  const header = encodeJson({ alg: "RS256", typ: "JWT", kid });
  const payload = encodeJson({
    iss: IDENTITY_ISSUER,
    aud: IDENTITY_AUDIENCE,
    iat: nowSeconds - 5,
    exp: nowSeconds + 3600,
    ...claims,
  });
  const signingInput = `${header}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput), privateKey)
    .toString("base64url");
  return `${signingInput}.${signature}`;
}

/** Start the HTTPS JWKS endpoint and return bounded benchmark identities. */
export async function startIdentityFixture(runtimeDir, { port = IDENTITY_PORT } = {}) {
  const tls = generateIdentityTls(runtimeDir);
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "moflux-bench-identity";
  const jwk = {
    ...publicKey.export({ format: "jwk" }),
    kid,
    alg: "RS256",
    use: "sig",
  };
  const tokens = Object.freeze({
    premium: issueJwt(privateKey, kid, {
      sub: "premium-user",
      tenant_id: PREMIUM_TENANT,
      azp: "latency-sensitive-app",
      roles: ["tyr.invoke", "tier.premium"],
    }),
    noisy: issueJwt(privateKey, kid, {
      sub: "noisy-worker",
      tenant_id: NOISY_TENANT,
      azp: "batch-worker",
      roles: ["tyr.invoke"],
    }),
  });

  const server = createServer(
    { key: readFileSync(tls.key), cert: readFileSync(tls.cert) },
    (request, response) => {
      if (request.url === "/healthz") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"ok":true}');
        return;
      }
      if (request.url === "/jwks") {
        response.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "public, max-age=60",
        });
        response.end(JSON.stringify({ keys: [jwk] }));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"error":"not_found"}');
    },
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", resolve);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;

  return Object.freeze({
    port: actualPort,
    url: `https://127.0.0.1:${actualPort}`,
    jwks: Object.freeze({ keys: Object.freeze([Object.freeze(jwk)]) }),
    tokens,
    tls,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  });
}
