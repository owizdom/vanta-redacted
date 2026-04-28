/**
 * Public types for the @vanta/tee module.
 *
 * The signing private key is intentionally NOT exported and has no type
 * here. It lives as a `KeyObject` in module scope inside `signer.ts` and
 * is only reachable via `sign(preimage)`.
 *
 * Branded primitives (R2 §2, §8; spec §D3) are runtime strings tagged at
 * compile time so a raw `string` cannot flow into an API that expects a
 * validated encoding.
 */

/** Raw 32-byte Ed25519 public key as 64-char lowercase hex (R2 §2). */
export type SigningPubKeyHex = string & { readonly __brand: "ed25519-pubkey-hex" };

/** Attestation JWT minted by EigenCloud KMS (R1 §1). */
export type AttestationJwt = string & { readonly __brand: "attestation-jwt" };

/** Hex-encoded SHA-256 digest. 32 bytes = 64 lowercase hex chars. */
export type Sha256Hex = string & { readonly __brand: "sha256-hex" };

/** Ethereum-style 0x-prefixed hex address. 20 bytes = 42 chars including 0x. */
export type EthAddressHex = `0x${string}`;

/**
 * Identity anchor — how this enclave instance is externally identifiable.
 *
 * Discriminated union, not `{kind, value}` (R1 §6 critique). `kms-jwt` is
 * the canonical path through ecloud-sdk `AttestClient`. `eigencompute-instance`
 * is the last-resort anchor when attestation is unavailable; `degraded: true`
 * is mandatory on that variant and callers must never print "hardware-enforced"
 * when it fires (R3 §4).
 */
export type IdentityAnchor =
  | {
      readonly kind: "kms-jwt";
      readonly jwt: AttestationJwt;
      readonly kmsPublicKeyPem: string;
      readonly audience: string;
    }
  | {
      readonly kind: "eigencompute-instance";
      readonly instanceId: string;
      readonly kmsPublicKeyPem: string | null;
      readonly degraded: true;
    };

export interface TeeState {
  /** True if initTEE produced a usable signing key AND at least one identity anchor. */
  readonly active: boolean;
  /** Ed25519 public key, raw 32-byte hex. The agent's canonical identifier. */
  readonly signingPubKey: SigningPubKeyHex;
  /** Attestation JWT from `@layr-labs/ecloud-sdk` AttestClient, or null if unavailable. */
  readonly attestationJwt: AttestationJwt | null;
  /** Identity anchor. Null only if initTEE did not complete (unreachable via public API). */
  readonly identityAnchor: IdentityAnchor | null;
  /**
   * TDX quote is known-inactive on Confidential Space today. The literal
   * `null` is enforced by construction: no code path writes a non-null value
   * (spec §2 I "`tdxQuoteHash` always null"; R1 §2; R3 §4).
   */
  readonly tdxQuoteHash: Sha256Hex | null;
  /** SHA-256 of the canonical identity anchor material bound to signing pubkey. */
  readonly enclaveIdentityHash: Sha256Hex;
  /** Boot timestamp (ms since epoch). */
  readonly bootedAt: number;
}

/**
 * Frozen salt constants for each HKDF purpose. Distinct per purpose so
 * the HKDF-Extract stage produces a distinct PRK even if someone passed
 * the same info label (R2 §4).
 */
export const HKDF_SALT = Object.freeze({
  AGENT_TREASURY: "vanta-agent-treasury-v1",
  VAULT_OPERATOR: "vanta-vault-operator-v1",
  API_CREDENTIALS: "vanta-api-credentials-v1",
  /**
   * Origination EOA salt is the empty string, matching RFC 5869 §2.2 default
   * and the Foundry deploy script (`Common.s.sol::_hkdfSha256(seed,
   * bytes(""), bytes("vanta-origination-eoa"))`). Distinct salts are
   * unnecessary for purpose-binding here — the info label is itself
   * unique — and choosing a non-empty salt would silently fork the EOA
   * away from the on-chain admin set by the deploy script.
   */
  ORIGINATION_EOA: "",
} as const);

/**
 * Frozen info labels for each HKDF purpose. Distinct per purpose so the
 * HKDF-Expand stage binds the output to a single context (R2 §4; TLS 1.3
 * HKDF-Expand-Label pattern).
 */
export const HKDF_INFO = Object.freeze({
  AGENT_TREASURY: "vanta/agent-treasury/v1/ed25519-seed",
  VAULT_OPERATOR: "vanta/vault-operator/v1/ed25519-seed",
  API_CREDENTIALS: "vanta/api-credentials/v1/ed25519-seed",
  /**
   * Origination admin EOA — secp256k1 private key for the
   * Ownable2Step admin of LpVault/LoanBook. The label string is fixed at
   * `"vanta-origination-eoa"` to match the Foundry deploy script byte for
   * byte; do not rename without rotating the on-chain admin.
   */
  ORIGINATION_EOA: "vanta-origination-eoa",
} as const);

export type HkdfSalt = (typeof HKDF_SALT)[keyof typeof HKDF_SALT];
export type HkdfInfo = (typeof HKDF_INFO)[keyof typeof HKDF_INFO];

/**
 * Compile-time restriction: only these three exact (salt, info) pairs are
 * valid arguments to `deriveKey`. Pair mismatches fail at type-check
 * (spec §2 "HKDF distinct (salt, info)"; §D2).
 */
export type HkdfPurpose =
  | { readonly salt: typeof HKDF_SALT.AGENT_TREASURY; readonly info: typeof HKDF_INFO.AGENT_TREASURY }
  | { readonly salt: typeof HKDF_SALT.VAULT_OPERATOR; readonly info: typeof HKDF_INFO.VAULT_OPERATOR }
  | { readonly salt: typeof HKDF_SALT.API_CREDENTIALS; readonly info: typeof HKDF_INFO.API_CREDENTIALS }
  | { readonly salt: typeof HKDF_SALT.ORIGINATION_EOA; readonly info: typeof HKDF_INFO.ORIGINATION_EOA };

// ----- Brand constructors -----
// Exported so sibling files can stamp brands after validating the shape.
// Callers outside this package should treat these as implementation detail.

const HEX64 = /^[0-9a-f]{64}$/;

export function asSigningPubKeyHex(s: string): SigningPubKeyHex {
  if (!HEX64.test(s)) {
    throw new Error("asSigningPubKeyHex: input must be 64-char lowercase hex");
  }
  return s as SigningPubKeyHex;
}

export function asSha256Hex(s: string): Sha256Hex {
  if (!HEX64.test(s)) {
    throw new Error("asSha256Hex: input must be 64-char lowercase hex");
  }
  return s as Sha256Hex;
}

export function asAttestationJwt(s: string): AttestationJwt {
  // RFC 7519: JWT is three base64url segments joined by '.'.
  // We do not validate signature here — that is attest.ts's concern.
  const parts = s.split(".");
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
    throw new Error("asAttestationJwt: input must be a three-part compact JWT");
  }
  return s as AttestationJwt;
}
