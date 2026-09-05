import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:https";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

export const IDENTITY_ISSUER = "https://moflux-bench.local/";
export const IDENTITY_AUDIENCE = "moflux-bench";
export const IDENTITY_PORT = 9010;
export const PREMIUM_TENANT = "tenant-premium";
export const NOISY_TENANT = "tenant-noisy";

/**
 * Bearer lifetime, and how early a token is replaced.
 *
 * A fixture that mints once and hands the same string to every request for the
 * life of the process is fine for a two-minute demo and wrong for a sweep. The
 * five-seed local-contention run takes over an hour of wall clock, and 0.33.2
 * died in seed 5's MoFlux warm-up on `HTTP 401` for exactly that reason: the
 * token was minted before seed 1 and had been expired for four minutes by the
 * time seed 5 asked Tyr for admission. Nothing about the control plane was
 * wrong; the benchmark had simply outlived its own credential.
 *
 * The fix is to re-mint rather than to lengthen. A longer fixed lifetime only
 * moves the cliff to whichever sweep is longer than the new guess, and it would
 * hide the failure mode instead of removing it. `IDENTITY_REFRESH_SKEW_SECONDS`
 * is generous relative to the longest single measured run (105 s plus drain),
 * so a token handed to a child process is never close to expiry when that child
 * makes its last request.
 */
export const IDENTITY_TOKEN_TTL_SECONDS = 3_600;
export const IDENTITY_REFRESH_SKEW_SECONDS = 600;

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

/**
 * Monotonic counter behind the `jti` claim.
 *
 * `iat` and `exp` have second granularity, so two mints inside the same second
 * produce byte-identical tokens. That makes a forced refresh — the thing the
 * warm-up path does after an HTTP 401 — a no-op that hands the server back the
 * credential it just refused, and makes the fingerprints in a diagnostic unable
 * to distinguish the retry from the original attempt. A distinct `jti` per mint
 * (RFC 7519 §4.1.7) settles both.
 */
let mintSequence = 0;

function issueJwt(
  privateKey,
  kid,
  claims,
  nowSeconds = Math.floor(Date.now() / 1000),
  ttlSeconds = IDENTITY_TOKEN_TTL_SECONDS,
) {
  const header = encodeJson({ alg: "RS256", typ: "JWT", kid });
  const issuedAt = nowSeconds - 5;
  const expiresAt = nowSeconds + ttlSeconds;
  mintSequence += 1;
  const payload = encodeJson({
    iss: IDENTITY_ISSUER,
    aud: IDENTITY_AUDIENCE,
    iat: issuedAt,
    exp: expiresAt,
    jti: `moflux-bench-${mintSequence}`,
    ...claims,
  });
  const signingInput = `${header}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput), privateKey)
    .toString("base64url");
  return { token: `${signingInput}.${signature}`, issuedAt, expiresAt };
}

/**
 * A stable, non-reversible handle for one minted token.
 *
 * Diagnostics have to be able to say "the request that got 401 carried a
 * different credential than the one issued at t=0" without a benchmark log
 * becoming a place bearer tokens are published. Twelve hex characters of
 * SHA-256 identify a token across log lines and reveal nothing.
 */
export function tokenFingerprint(token) {
  if (typeof token !== "string" || token.length === 0) return null;
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

/** Start the HTTPS JWKS endpoint and return bounded benchmark identities. */
export async function startIdentityFixture(
  runtimeDir,
  {
    port = IDENTITY_PORT,
    tokenTtlSeconds = IDENTITY_TOKEN_TTL_SECONDS,
    refreshSkewSeconds = IDENTITY_REFRESH_SKEW_SECONDS,
  } = {},
) {
  if (!Number.isFinite(tokenTtlSeconds) || tokenTtlSeconds <= 0) {
    throw new Error("startIdentityFixture requires a positive tokenTtlSeconds");
  }
  if (!Number.isFinite(refreshSkewSeconds) || refreshSkewSeconds < 0) {
    throw new Error("startIdentityFixture requires a non-negative refreshSkewSeconds");
  }
  const tls = generateIdentityTls(runtimeDir);
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "moflux-bench-identity";
  const jwk = {
    ...publicKey.export({ format: "jwk" }),
    kid,
    alg: "RS256",
    use: "sig",
  };
  const CLAIMS = Object.freeze({
    premium: {
      sub: "premium-user",
      tenant_id: PREMIUM_TENANT,
      azp: "latency-sensitive-app",
      roles: ["tyr.invoke", "tier.premium"],
    },
    noisy: {
      sub: "noisy-worker",
      tenant_id: NOISY_TENANT,
      azp: "batch-worker",
      roles: ["tyr.invoke"],
    },
    operator: {
      sub: "moflux-bench-harness",
      azp: "moflux-bench",
      roles: ["tyr.operator"],
    },
  });

  /** Per-identity credential state, replaced in place as tokens are re-minted. */
  const issued = new Map();
  const mint = (name, reason) => {
    const claims = CLAIMS[name];
    if (claims === undefined) throw new Error(`unknown benchmark identity ${JSON.stringify(name)}`);
    const minted = issueJwt(privateKey, kid, claims, undefined, tokenTtlSeconds);
    const previous = issued.get(name);
    issued.set(name, {
      token: minted.token,
      issuedAtMs: minted.issuedAt * 1000,
      expiresAtMs: minted.expiresAt * 1000,
      fingerprint: tokenFingerprint(minted.token),
      mintCount: (previous?.mintCount ?? 0) + 1,
      lastMintReason: reason,
    });
    return issued.get(name);
  };

  /**
   * Returns a credential that will still be valid when the caller finishes
   * using it.
   *
   * Read on every access rather than once at start-up. A benchmark hands the
   * same identity to a warm-up request, a hundred-second child process, and a
   * `/stats` scrape an hour later, and only the accessor knows which of those
   * is about to cross an expiry.
   */
  const currentCredential = (name, { force = false } = {}) => {
    const state = issued.get(name);
    if (force) return mint(name, force === true ? "forced" : String(force));
    if (state === undefined) return mint(name, "initial");
    if (state.expiresAtMs - Date.now() <= refreshSkewSeconds * 1000) {
      return mint(name, "expiry-approaching");
    }
    return state;
  };

  // Enumerable accessors rather than a frozen record of strings: every existing
  // `identity.tokens.premium` call site keeps working and silently stops being
  // able to outlive its own credential.
  const tokens = Object.freeze(
    Object.defineProperties(
      {},
      Object.fromEntries(
        Object.keys(CLAIMS).map((name) => [
          name,
          { enumerable: true, get: () => currentCredential(name).token },
        ]),
      ),
    ),
  );
  for (const name of Object.keys(CLAIMS)) mint(name, "initial");

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
    tokenTtlSeconds,
    refreshSkewSeconds,
    /**
     * Everything a diagnostic may say about a credential, and nothing it may
     * not. The token itself is deliberately absent: a warm-up failure report
     * has to be publishable.
     */
    credentialState(name) {
      const state = currentCredential(name);
      const now = Date.now();
      return Object.freeze({
        identity: name,
        fingerprint: state.fingerprint,
        issuedAtMs: state.issuedAtMs,
        issuedAt: new Date(state.issuedAtMs).toISOString(),
        expiresAtMs: state.expiresAtMs,
        expiresAt: new Date(state.expiresAtMs).toISOString(),
        expiresInMs: state.expiresAtMs - now,
        expired: state.expiresAtMs <= now,
        mintCount: state.mintCount,
        lastMintReason: state.lastMintReason,
      });
    },
    /** Forces a re-mint, for a caller that has just been told its token is stale. */
    refresh(name, reason = "forced") {
      mint(name, reason);
      return this.credentialState(name);
    },
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  });
}
