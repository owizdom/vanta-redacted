/**
 * In-enclave Ed25519 signer.
 *
 * The private key is an opaque Node `KeyObject` (R2 §1, §6). It lives
 * only in module scope, is never exported, never serialized, never logged.
 * `crypto.sign(null, data, privateKey)` is the canonical EdDSA idiom
 * (R2 §1) — `algorithm = null` is required for Ed25519.
 *
 * Identity-once-at-genesis (V7 I1, BM1 §3.1): second call to
 * `generateSigningKeypair` throws `signing_already_initialized`. No
 * idempotent-return. Tests cycle state via `__resetForTesting`.
 */

import { generateKeyPairSync, sign as nativeSign } from "node:crypto";
import type { KeyObject } from "node:crypto";

import { TeeError } from "./errors.js";
import { asSigningPubKeyHex } from "./types.js";
import type { SigningPubKeyHex } from "./types.js";

let privateKey: KeyObject | null = null;
let publicKeyHex: SigningPubKeyHex | null = null;

/**
 * Generate a fresh Ed25519 keypair in enclave RAM. Fails closed on
 * re-call (spec §1.3; R1 §6; R3 §6). Never logs, never exposes the
 * KeyObject.
 */
export function generateSigningKeypair(): { signingPubKey: SigningPubKeyHex } {
  if (privateKey !== null || publicKeyHex !== null) {
    throw new TeeError(
      "signing_already_initialized",
      "Ed25519 signing keypair has already been generated this process",
    );
  }
  const pair = generateKeyPairSync("ed25519");
  privateKey = pair.privateKey;
  publicKeyHex = extractRawPubKeyHex(pair.publicKey);
  return { signingPubKey: publicKeyHex };
}

/**
 * Sign a preimage with the in-enclave Ed25519 private key.
 *
 * Returns a 64-byte Ed25519 signature as `Buffer` (spec §D1; R2 §8). The
 * buffer is zeroable by the caller if they wish. The hex round-trip is
 * deliberately not performed here.
 *
 * Throws `signing_not_initialized` if the keypair has not been generated.
 * Asserts the KeyObject is still an Ed25519 private key on every call
 * (R3 §6 gap).
 */
export function sign(preimage: Uint8Array): Buffer {
  if (privateKey === null) {
    throw new TeeError("signing_not_initialized", "signing keypair has not been generated");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    // Defensive: someone mutated the KeyObject. Fail closed.
    throw new TeeError(
      "signing_not_initialized",
      "in-memory private key is not an Ed25519 KeyObject",
      { asymmetricKeyType: String(privateKey.asymmetricKeyType ?? "undefined") },
    );
  }
  // `algorithm = null` is the documented EdDSA idiom (R2 §1).
  const sig = nativeSign(null, Buffer.from(preimage), privateKey);
  return Buffer.from(sig);
}

/**
 * Return the raw 32-byte Ed25519 public key as 64-char lowercase hex
 * (R2 §2). Not SPKI DER — the SPKI round-trip in the draft was theater
 * (R1 §6 critique). External verifiers expect the raw form.
 */
export function signingPubKey(): SigningPubKeyHex {
  if (publicKeyHex === null) {
    throw new TeeError("signing_not_initialized", "signing keypair has not been generated");
  }
  return publicKeyHex;
}

/**
 * Test-only: drop the in-memory keypair so generateSigningKeypair can be
 * called again in the next test case. Refuses to run outside Vitest /
 * `NODE_ENV=test`. Not re-exported from the package barrel; tests
 * import via relative path.
 */
export function __resetForTesting(): void {
  if (process.env["NODE_ENV"] !== "test" && process.env["VITEST"] === undefined) {
    throw new TeeError(
      "signing_not_initialized",
      "__resetForTesting is disabled outside tests",
    );
  }
  privateKey = null;
  publicKeyHex = null;
}

/**
 * Extract raw 32-byte Ed25519 pubkey from a KeyObject and hex-encode it.
 *
 * Path: JWK export → base64url-decode `.x` → hex. JWK `.x` is defined as
 * the raw Ed25519 public scalar (RFC 8037). Avoids the 12-byte SPKI
 * prefix (R2 §2).
 */
function extractRawPubKeyHex(publicKey: KeyObject): SigningPubKeyHex {
  const jwk = publicKey.export({ format: "jwk" });
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    throw new TeeError(
      "signing_not_initialized",
      "generated key did not export as Ed25519 OKP JWK",
      { kty: String(jwk.kty ?? ""), crv: String(jwk.crv ?? "") },
    );
  }
  const raw = Buffer.from(jwk.x, "base64url");
  if (raw.length !== 32) {
    throw new TeeError(
      "signing_not_initialized",
      "Ed25519 JWK.x did not decode to 32 bytes",
      { length: String(raw.length) },
    );
  }
  return asSigningPubKeyHex(raw.toString("hex"));
}
