/**
 * SDK AttestClient wrapper.
 *
 * Source of truth (R1 §1): `@layr-labs/ecloud-sdk` master, attest-client.
 * Constructor: `new AttestClient({kmsServerURL, kmsPublicKey, audience})`.
 * `attest()` takes no arguments on master and returns a plain JWT string.
 *
 * Retry policy (spec §6): transient codes retry 3 times at 500 ms / 1.5 s
 * / 3 s. Terminal codes (signature_mismatch, decrypt_failed) no retry.
 *
 * Classification is done by string-matching on the plain `Error` messages
 * the SDK throws (R1 §3 — no structured error codes upstream). Any change
 * in upstream wording breaks classification; the fallback is
 * `attestation_unavailable` (transient-retryable), never silent success.
 */

import { Buffer } from "node:buffer";
import { setTimeout as sleep } from "node:timers/promises";

import { AttestClient, JwtProvider } from "@layr-labs/ecloud-sdk/attest";

import { TeeError } from "./errors.js";
import { asAttestationJwt } from "./types.js";
import type { AttestationJwt, SigningPubKeyHex } from "./types.js";
import { signingPubKey } from "./signer.js";

export interface AttestationBundle {
  readonly jwt: AttestationJwt;
  readonly kmsPublicKeyPem: string;
  readonly audience: string;
  readonly fetchedAt: number;
}

const DEFAULT_AUDIENCE = "vanta.app";
const RETRY_DELAYS_MS = [500, 1500, 3000] as const;

let cachedBundle: AttestationBundle | null = null;
let cachedProvider: JwtProvider | null = null;
let observedAlgLogged = false;
let degradedPemRecord: string | null = null;

function readEnvOrThrow(name: string): string {
  const v = process.env[name];
  if (typeof v !== "string" || v.length === 0) {
    throw new TeeError(
      "env_not_configured",
      `required env var ${name} is missing`,
      { envVar: name },
    );
  }
  return v;
}

// Widened terminal-match regexes. The goal is that a signature-verify or
// decrypt failure is NEVER downgraded to a retryable
// `attestation_unavailable` even if the upstream SDK rewords its Error
// messages. Pinned current-wording checks kept as exact-substring alongside
// the regex to catch both familiar and future variants.
const TERMINAL_SIG_MISMATCH_PATTERNS: readonly RegExp[] = [
  /signature\s+verification\s+failed/i,
  /signature\s+(?:mismatch|invalid|bad|failed)/i,
  /signature\s+did\s+not\s+verify/i,
  /invalid\s+signature/i,
];

const TERMINAL_DECRYPT_FAIL_PATTERNS: readonly RegExp[] = [
  /jwedecryptionfailed/i,
  /decryption\s+operation\s+failed/i,
  /jwe\s+decryption\s+failed/i,
  /decrypt(?:ion)?\s+(?:failed|error)/i,
  /failed\s+to\s+decrypt/i,
];

function matchesAny(msg: string, patterns: readonly RegExp[]): boolean {
  for (const p of patterns) {
    if (p.test(msg)) return true;
  }
  return false;
}

function classify(err: unknown): TeeError {
  const msg = err instanceof Error ? err.message : String(err);

  // Terminal — sig mismatch from KMS envelope verify (R1 §3).
  if (matchesAny(msg, TERMINAL_SIG_MISMATCH_PATTERNS)) {
    return new TeeError("attestation_signature_mismatch", msg);
  }
  // Terminal — JWE RSA-OAEP decrypt failure from `jose` (R1 §3).
  if (matchesAny(msg, TERMINAL_DECRYPT_FAIL_PATTERNS)) {
    return new TeeError("attestation_decrypt_failed", msg);
  }
  // Transient — socket unreachable.
  if (
    msg.includes("ENOENT") ||
    msg.includes("ECONNREFUSED") ||
    msg.toLowerCase().includes("tee attestation request failed")
  ) {
    return new TeeError("socket_unavailable", msg);
  }
  // Transient — KMS unreachable or 5xx.
  if (
    msg.toLowerCase().includes("kms attest failed") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("EAI_AGAIN")
  ) {
    return new TeeError("kms_server_unreachable", msg);
  }
  // Unknown → retryable generic.
  return new TeeError("attestation_unavailable", msg);
}

function isTerminal(code: TeeError["code"]): boolean {
  return (
    code === "attestation_signature_mismatch" ||
    code === "attestation_decrypt_failed" ||
    code === "env_not_configured"
  );
}

/**
 * Permitted JWT alg values. Spec §8 names RS256 and ES256. Operators can
 * widen via `VANTA_ATTEST_ALLOWED_ALGS` (comma-separated, case-insensitive)
 * if the KMS empirically signs with a different alg in production.
 */
const DEFAULT_ALLOWED_ALGS: readonly string[] = ["RS256", "ES256"] as const;

function allowedAlgs(): readonly string[] {
  const override = process.env["VANTA_ATTEST_ALLOWED_ALGS"];
  if (typeof override !== "string" || override.length === 0) {
    return DEFAULT_ALLOWED_ALGS;
  }
  return override
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
}

/**
 * Enforce JWT alg (spec §8). Decodes the JWT header and THROWS
 * `attestation_unavailable` if `alg` is outside the allow-list. Called
 * once per boot.
 *
 * Never logs the payload, never logs the signature.
 */
function enforceJwtAlgOnce(jwt: string): void {
  // Validation always runs; the telemetry flag is set ONLY after a clean
  // pass, so retry attempts do not inherit the flag from a prior bad-alg
  // JWT.
  const parts = jwt.split(".");
  if (parts.length !== 3) {
    throw new TeeError(
      "attestation_unavailable",
      "attestation JWT does not have three compact segments",
    );
  }
  const headerPart = parts[0];
  if (typeof headerPart !== "string" || headerPart.length === 0) {
    throw new TeeError(
      "attestation_unavailable",
      "attestation JWT has empty header segment",
    );
  }
  let alg: string;
  try {
    const headerJson = Buffer.from(headerPart, "base64url").toString("utf8");
    const header = JSON.parse(headerJson) as { alg?: unknown };
    alg = typeof header.alg === "string" ? header.alg : "";
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new TeeError(
      "attestation_unavailable",
      `attestation JWT header is not valid base64url-JSON: ${msg}`,
    );
  }

  const permitted = allowedAlgs();
  if (!permitted.map((s) => s.toUpperCase()).includes(alg.toUpperCase())) {
    throw new TeeError(
      "attestation_unavailable",
      "attestation JWT uses an unexpected alg",
      { alg, allowed: permitted.join(",") },
    );
  }

  // Validation passed: mark telemetry observed (idempotent for the
  // lifetime of the boot). Already-logged guard prevents repeat warnings
  // in the refresh path.
  if (!observedAlgLogged) {
    observedAlgLogged = true;
  }
}

/**
 * Fetch one attestation JWT. 3-retry backoff 500 ms / 1.5 s / 3 s on
 * transient codes; terminal codes no retry (spec §1.5, §6).
 *
 * Blocks synchronously as part of boot (spec §D4).
 */
export async function fetchAttestation(): Promise<AttestationBundle> {
  const kmsServerURL = readEnvOrThrow("KMS_SERVER_URL");
  const kmsPublicKey = readEnvOrThrow("KMS_PUBLIC_KEY");
  const audience = process.env["VANTA_ATTEST_AUDIENCE"] ?? DEFAULT_AUDIENCE;

  const client = new AttestClient({ kmsServerURL, kmsPublicKey, audience });

  let lastError: TeeError | null = null;
  const maxAttempts = 1 + RETRY_DELAYS_MS.length;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS_MS[attempt - 1] ?? 3000;
      await sleep(delay);
    }
    try {
      const jwt = await client.attest();
      if (typeof jwt !== "string" || jwt.length === 0) {
        throw new Error("AttestClient.attest returned non-string token");
      }
      enforceJwtAlgOnce(jwt);
      const bundle: AttestationBundle = {
        jwt: asAttestationJwt(jwt),
        kmsPublicKeyPem: kmsPublicKey,
        audience,
        fetchedAt: Date.now(),
      };
      cachedBundle = bundle;
      cachedProvider = new JwtProvider(client, 30);
      return bundle;
    } catch (err: unknown) {
      // Preserve our own typed errors (context, code) verbatim. Only
      // classify unknown upstream throws via string-matching.
      const te = err instanceof TeeError ? err : classify(err);
      lastError = te;
      if (isTerminal(te.code)) {
        throw te;
      }
      // else: fall through to next attempt.
    }
  }
  // All retries exhausted on transient errors.
  throw (
    lastError ??
    new TeeError(
      "attestation_unavailable",
      "AttestClient.attest exhausted retries without a specific error",
    )
  );
}

/**
 * Return the cached bundle. If `initTEE` ran in degraded mode, returns
 * null. Uses the internal JwtProvider to refresh with
 * `bufferSeconds = 30` (R1 §1).
 */
export async function getAttestation(): Promise<AttestationBundle | null> {
  if (cachedBundle === null || cachedProvider === null) return null;
  const now = Date.now();
  try {
    const jwt = await cachedProvider.getToken();
    if (typeof jwt !== "string" || jwt.length === 0) return cachedBundle;
    if (jwt === cachedBundle.jwt) return cachedBundle;
    cachedBundle = {
      jwt: asAttestationJwt(jwt),
      kmsPublicKeyPem: cachedBundle.kmsPublicKeyPem,
      audience: cachedBundle.audience,
      fetchedAt: now,
    };
    return cachedBundle;
  } catch (err: unknown) {
    // Refresh failure does not invalidate the existing bundle — serve
    // the stale one rather than fabricate a null result.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`vanta/tee: JwtProvider refresh failed: ${msg}`);
    return cachedBundle;
  }
}

/**
 * Non-throwing public view for `/api/tee` and `/.well-known/attestation`.
 * Callable only after the signer has been initialized.
 */
export function attestationForExternalVerify(): {
  readonly signingPubKey: SigningPubKeyHex;
  readonly jwt: AttestationJwt | null;
  readonly kmsPublicKeyPem: string | null;
  readonly audience: string | null;
} {
  const pk = signingPubKey(); // throws if signer not initialized — propagate
  const pem = cachedBundle?.kmsPublicKeyPem ?? degradedPemRecord;
  return {
    signingPubKey: pk,
    jwt: cachedBundle?.jwt ?? null,
    kmsPublicKeyPem: pem,
    audience: cachedBundle?.audience ?? null,
  };
}

/**
 * Record a degraded-mode KMS PEM so `attestationForExternalVerify` can
 * surface it when the canonical bundle is absent. Internal; only used by
 * `init.ts` when it falls back to `EIGENCOMPUTE_INSTANCE_ID`.
 */
export function __recordDegradedKmsPem(pem: string | null): void {
  if (cachedBundle !== null) return;
  if (pem === null) return;
  degradedPemRecord = pem;
}

/**
 * Test-only state reset. Gated on NODE_ENV/VITEST. Not re-exported from
 * the package barrel.
 */
export function __resetForTesting(): void {
  if (process.env["NODE_ENV"] !== "test" && process.env["VITEST"] === undefined) {
    throw new TeeError("attestation_unavailable", "__resetForTesting is disabled outside tests");
  }
  cachedBundle = null;
  cachedProvider = null;
  observedAlgLogged = false;
  degradedPemRecord = null;
}
