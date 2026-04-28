/**
 * Enclave identity hash construction.
 *
 * Binds the signing pubkey to the identity anchor so an external
 * verifier holding the identity anchor can check that the enclave
 * self-reported pubkey was part of the same commitment. Per R3 §3
 * (the one thing bobIsAlive got right):
 *
 *   enclaveIdentityHash = sha256( kmsAnchor || signingPubKey )
 *
 * where `kmsAnchor` is:
 *   - for kind=="kms-jwt": sha256(canonical(jwt, kmsPublicKeyPem, audience))
 *   - for kind=="eigencompute-instance": utf8(instanceId) (+ sha256(pem) if present)
 *
 * The signingPubKey is the raw 32-byte scalar (R2 §2), hex-decoded before
 * hashing so the hash is over bytes, not over a hex string.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { asSha256Hex } from "./types.js";
import type { IdentityAnchor, Sha256Hex, SigningPubKeyHex } from "./types.js";

function anchorBytes(anchor: IdentityAnchor): Buffer {
  if (anchor.kind === "kms-jwt") {
    // Canonicalize by hashing a stable tuple: jwt || "\n" || audience || "\n"
    // || sha256(kmsPublicKeyPem). The JWT itself is canonical (three
    // base64url segments separated by '.').
    const kmsPemHash = createHash("sha256").update(anchor.kmsPublicKeyPem, "utf8").digest();
    const tuple = Buffer.concat([
      Buffer.from(anchor.jwt, "utf8"),
      Buffer.from("\n", "utf8"),
      Buffer.from(anchor.audience, "utf8"),
      Buffer.from("\n", "utf8"),
      kmsPemHash,
    ]);
    return createHash("sha256").update(tuple).digest();
  }
  // kind === "eigencompute-instance"
  const pemPart =
    anchor.kmsPublicKeyPem === null
      ? Buffer.alloc(0)
      : createHash("sha256").update(anchor.kmsPublicKeyPem, "utf8").digest();
  const tuple = Buffer.concat([
    Buffer.from("eigencompute-instance:", "utf8"),
    Buffer.from(anchor.instanceId, "utf8"),
    Buffer.from("\n", "utf8"),
    pemPart,
  ]);
  return createHash("sha256").update(tuple).digest();
}

export function computeEnclaveIdentityHash(
  signingPubKey: SigningPubKeyHex,
  anchor: IdentityAnchor,
): Sha256Hex {
  const anchorDigest = anchorBytes(anchor);
  const pubkeyBytes = Buffer.from(signingPubKey, "hex");
  if (pubkeyBytes.length !== 32) {
    // SigningPubKeyHex is branded 64-char hex (types.ts), so this is
    // belt-and-suspenders. Fail closed rather than quietly hash 0 bytes.
    throw new Error("computeEnclaveIdentityHash: signingPubKey did not decode to 32 bytes");
  }
  const hash = createHash("sha256")
    .update(anchorDigest)
    .update(pubkeyBytes)
    .digest("hex");
  return asSha256Hex(hash);
}
