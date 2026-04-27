/**
 * `buildAndSign` — the sole event-construction path (spec §1.4, §5).
 *
 * Flow (spec §5):
 *   1. Build preimage envelope with `id===""` and `signature===""`,
 *      allocated via `Object.create(null)` (I-EV-9), NFC-normalized
 *      strings (I-EV-10), integer timestamp/epoch asserted.
 *   2. Permissive parse — shape check without requiring signed/id
 *      fields. Failure → `schema_invalid`.
 *   3. Canonicalize — bytes that the signature covers (I-EV-1).
 *   4. Sign via injected `SignFn`; must return 64 bytes.
 *   5. Set `signature = hex(sig)`. Re-canonicalize. sha256 → `id`.
 *   6. Strict final parse (discriminated union + refine) — asserts
 *      I-EV-4 and per-type body shape. Failure → `schema_invalid`.
 *   7. Round-trip sanity — re-derive preimage, verify signature.
 *      Guards against a broken `SignFn` (I-EV-6 defensive). Uses Node
 *      `crypto.verify` per spec §D6 (in-enclave verify only).
 *
 * `epoch` semantics: caller typically passes
 * `Math.floor(TeeState.bootedAt / 1000)` (spec §8).
 *
 * No direct `@vanta/tee/signer` import (spec §D1).
 */

import { createHash, createPublicKey, verify as nativeVerify } from "node:crypto";

import { canonicalJsonBytes } from "./canonical.js";
import { EventsError } from "./errors.js";
import {
  envelopePermissiveSchema,
  VantaEventSchema,
  enforceGenesisParentShape,
} from "./schemas.js";
import { brandStampEvent } from "./types.js";
import type {
  CanonicalJsonBytes,
  EventType,
  Sha256Hex,
  VantaEvent,
  VantaEventBase,
  VantaEventOfType,
} from "./types.js";

/**
 * Signature injection (spec §1.3, §D1). MUST return exactly 64 bytes
 * of Ed25519 signature. The events module NEVER imports `sign` from
 * `@vanta/tee` directly; callers wire this in at boot.
 */
export type SignFn = (preimage: Uint8Array) => Buffer;

export interface BuildArgs<T extends EventType> {
  readonly type: T;
  readonly parent_ids: readonly Sha256Hex[];
  readonly lineage: string;
  readonly timestamp: number;
  readonly epoch: number;
  readonly tee: VantaEventBase["tee"];
  readonly instance: string;
  readonly body: VantaEventOfType<T>["body"];
  readonly sign: SignFn;
}

const HEX64 = /^[0-9a-f]{64}$/;

function assertPubKeyHex(s: string): void {
  if (!HEX64.test(s)) {
    throw new EventsError(
      "signer_pubkey_malformed",
      "signingPubKey must be 64-char lowercase hex",
      { actualLen: String(s.length) },
    );
  }
}

function assertIntegerField(n: number, field: string): void {
  if (!Number.isInteger(n)) {
    throw new EventsError(
      "timestamp_not_integer",
      `${field} must be an integer`,
      { field },
    );
  }
}

/** Normalize string fields at the envelope boundary (I-EV-10). */
function nfc(s: string): string {
  return s.normalize("NFC");
}

/** Build the preimage object with id+sig zeroed (spec §5 Step 1). */
function buildPreimage<T extends EventType>(
  args: BuildArgs<T>,
): Record<string, unknown> {
  // Allocate via Object.create(null) to close proto-pollution paths (I-EV-9).
  const preimage = Object.create(null) as Record<string, unknown>;
  preimage["id"] = "";
  preimage["version"] = "v1";
  preimage["parent_ids"] = args.parent_ids.slice();
  preimage["type"] = args.type;
  preimage["lineage"] = nfc(args.lineage);
  preimage["timestamp"] = args.timestamp;
  preimage["epoch"] = args.epoch;
  preimage["tee"] = {
    signingPubKey: args.tee.signingPubKey,
    kmsKeyHash: args.tee.kmsKeyHash,
    tdxQuoteHash: null,
    attestationJwtHash: args.tee.attestationJwtHash,
  };
  preimage["instance"] = nfc(args.instance);
  preimage["body"] = args.body;
  preimage["signature"] = "";
  return preimage;
}

function sha256Hex(bytes: CanonicalJsonBytes): string {
  const h = createHash("sha256");
  h.update(bytes);
  return h.digest("hex");
}

function bufferToHex(buf: Buffer): string {
  return buf.toString("hex");
}

/**
 * Build, sign, finalize, and validate a VANTA event.
 *
 * Throws `EventsError` with one of:
 *   `schema_invalid` | `canonical_json_failed` |
 *   `signer_pubkey_malformed` | `genesis_missing_parent_shape` |
 *   `signature_invalid` | `timestamp_not_integer`.
 */
export function buildAndSign<T extends EventType>(
  args: BuildArgs<T>,
): VantaEventOfType<T> {
  // Shape sanity prior to schema parse — produces the precise error code
  // `signer_pubkey_malformed` that the discriminated-union parse would
  // flatten into `schema_invalid`.
  assertPubKeyHex(args.tee.signingPubKey);

  assertIntegerField(args.timestamp, "timestamp");
  assertIntegerField(args.epoch, "epoch");

  // I-EV-4 precheck so we can raise the precise code.
  if (!enforceGenesisParentShape(args.type, args.parent_ids.length)) {
    throw new EventsError(
      "genesis_missing_parent_shape",
      "parent_ids shape does not match event type",
      { type: args.type, parentIdsLen: String(args.parent_ids.length) },
    );
  }

  const preimage = buildPreimage(args);

  // Step 2 — permissive parse.
  const permissiveParse = envelopePermissiveSchema.safeParse(preimage);
  if (!permissiveParse.success) {
    throw new EventsError(
      "schema_invalid",
      "permissive envelope parse failed",
      {
        stage: "permissive",
        zodIssues: String(permissiveParse.error.issues.length),
      },
    );
  }

  // Step 3 — canonicalize preimage bytes.
  const preimageBytes = canonicalJsonBytes(preimage);

  // Step 4 — sign.
  const sigBuf = args.sign(preimageBytes);
  if (!Buffer.isBuffer(sigBuf) || sigBuf.length !== 64) {
    throw new EventsError(
      "signature_invalid",
      "SignFn did not return a 64-byte Buffer",
      {
        expectedLen: "64",
        actualLen: String(Buffer.isBuffer(sigBuf) ? sigBuf.length : -1),
      },
    );
  }
  const sigHex = bufferToHex(sigBuf);

  // Step 5 — compute id over the canonical preimage with BOTH `id` and
  // `signature` zeroed, per spec §7 test contract T6 and the verifier
  // byte-level contract §5. An external verifier zeroes id+sig to
  // recompute the id; the builder must agree. (Regression guard: an
  // earlier draft hashed with signature filled, which broke verifier
  // parity and made every signed event fail id_mismatch on re-verify.)
  const finalBytesForId = canonicalJsonBytes(preimage);
  const idHex = sha256Hex(finalBytesForId);
  preimage["signature"] = sigHex;
  preimage["id"] = idHex;

  // Step 6 — strict parse on finalized preimage.
  const strictParse = VantaEventSchema.safeParse(preimage);
  if (!strictParse.success) {
    throw new EventsError(
      "schema_invalid",
      "strict envelope parse failed after signing",
      {
        stage: "strict",
        zodIssues: String(strictParse.error.issues.length),
      },
    );
  }

  const finalEvent = brandStampEvent(strictParse.data);

  // Step 7 — round-trip sanity: re-derive preimage bytes, verify signature
  // via Node `crypto.verify` (spec §D6, in-enclave path). Guards against
  // a broken `SignFn` before the event leaves this function.
  const roundTrip = reDerivePreimage(finalEvent);
  const okVerify = verifySignatureInEnclave(
    sigBuf,
    roundTrip,
    args.tee.signingPubKey,
  );
  if (!okVerify) {
    throw new EventsError(
      "signature_invalid",
      "round-trip verify failed; SignFn produced an invalid signature",
    );
  }

  // `type` is pinned in `preimage` so the branded union narrows by construction.
  return finalEvent as VantaEventOfType<T>;
}

/**
 * Re-derive the preimage bytes from a signed event: zero `id` and
 * `signature`, re-canonicalize. Shared with `verify.ts`.
 */
export function reDerivePreimage(event: VantaEvent): CanonicalJsonBytes {
  const copy = Object.create(null) as Record<string, unknown>;
  copy["id"] = "";
  copy["version"] = event.version;
  copy["parent_ids"] = event.parent_ids.slice();
  copy["type"] = event.type;
  copy["lineage"] = event.lineage.normalize("NFC");
  copy["timestamp"] = event.timestamp;
  copy["epoch"] = event.epoch;
  copy["tee"] = {
    signingPubKey: event.tee.signingPubKey,
    kmsKeyHash: event.tee.kmsKeyHash,
    tdxQuoteHash: null,
    attestationJwtHash: event.tee.attestationJwtHash,
  };
  copy["instance"] = event.instance.normalize("NFC");
  copy["body"] = event.body;
  copy["signature"] = "";
  return canonicalJsonBytes(copy);
}

/**
 * In-enclave sync Ed25519 verify via Node `crypto.verify` (spec §D6).
 * Wraps a raw 32-byte pubkey in SPKI so Node can consume it: prefix
 * the 12-byte Ed25519 SPKI ASN.1 header to the raw key bytes.
 */
function verifySignatureInEnclave(
  sig: Buffer,
  preimage: CanonicalJsonBytes,
  pubKeyHex: string,
): boolean {
  try {
    const rawKey = Buffer.from(pubKeyHex, "hex");
    if (rawKey.length !== 32) {
      return false;
    }
    // Ed25519 SubjectPublicKeyInfo ASN.1 prefix (RFC 8410).
    const SPKI_PREFIX = Buffer.from([
      0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ]);
    const spki = Buffer.concat([SPKI_PREFIX, rawKey]);
    const keyObj = createPublicKey({
      key: spki,
      format: "der",
      type: "spki",
    });
    return nativeVerify(null, Buffer.from(preimage), keyObj, sig);
  } catch {
    return false;
  }
}
