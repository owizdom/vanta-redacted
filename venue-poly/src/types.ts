/**
 * Branded types for @vanta/venue-poly.
 *
 * Mirrors the branding pattern in `@vanta/tee` (Sha256Hex,
 * EthAddressHex, SigningPubKeyHex): runtime strings/bigints tagged at
 * compile time so a raw `string` or `bigint` cannot flow into an API
 * that expects a validated encoding.
 */

import type { Sha256Hex } from "@vanta/tee";

/**
 * CTF position id. Runtime representation is `uint256` as `bigint`
 * (CTF is ERC-1155, ids are full 256-bit). Brand distinguishes it from
 * free `bigint`.
 */
export type PositionId = bigint & { readonly __brand: "ctf-position-id" };

/**
 * CTF condition id. Runtime representation is a 32-byte keccak digest,
 * hex-encoded (64 lowercase hex chars, no `0x` prefix) so it slots into
 * our `Sha256Hex` brand family.
 */
export type ConditionId = Sha256Hex & { readonly __brand: "ctf-condition-id" };

/**
 * UMA question id. 32 bytes, hex-encoded (64 lowercase hex chars) —
 * same physical encoding as `ConditionId` but semantically distinct
 * (oracle-side identifier, not CTF-side).
 */
export type QuestionId = Sha256Hex & { readonly __brand: "uma-question-id" };

// ------------------------------- Brand constructors -------------------------------

const HEX64 = /^[0-9a-f]{64}$/;

/** Stamp a `PositionId` brand on a bigint. */
export function asPositionId(n: bigint): PositionId {
  if (n < 0n) {
    throw new Error("asPositionId: position id must be non-negative");
  }
  if (n >= 1n << 256n) {
    throw new Error("asPositionId: position id must fit in uint256");
  }
  return n as PositionId;
}

/** Stamp a `ConditionId` brand on a 64-char lowercase hex string. */
export function asConditionId(s: string): ConditionId {
  if (!HEX64.test(s)) {
    throw new Error(
      "asConditionId: input must be 64-char lowercase hex (no 0x prefix)",
    );
  }
  return s as ConditionId;
}

/** Stamp a `QuestionId` brand on a 64-char lowercase hex string. */
export function asQuestionId(s: string): QuestionId {
  if (!HEX64.test(s)) {
    throw new Error(
      "asQuestionId: input must be 64-char lowercase hex (no 0x prefix)",
    );
  }
  return s as QuestionId;
}
