/**
 * Package barrel for @vanta/tee. Re-exports the public API surface
 * recorded in spec §1 and frozen at Week 1 close. Any symbol not
 * re-exported here MUST NOT be considered public.
 */

// Types
export type {
  AttestationJwt,
  EthAddressHex,
  HkdfInfo,
  HkdfPurpose,
  HkdfSalt,
  IdentityAnchor,
  Sha256Hex,
  SigningPubKeyHex,
  TeeState,
} from "./types.js";
export {
  asAttestationJwt,
  asSha256Hex,
  asSigningPubKeyHex,
  HKDF_INFO,
  HKDF_SALT,
} from "./types.js";

// Errors
export { TeeError } from "./errors.js";
export type { TeeErrorCode } from "./errors.js";

// Signer
export { generateSigningKeypair, sign, signingPubKey } from "./signer.js";

// HKDF
export { deriveKey } from "./kdf.js";

// Attestation
export {
  attestationForExternalVerify,
  fetchAttestation,
  getAttestation,
} from "./attest.js";
export type { AttestationBundle } from "./attest.js";

// Identity
export { computeEnclaveIdentityHash } from "./identity.js";

// Boot
export { initTEE } from "./init.js";

// Origination admin EOA (HKDF-derived)
export { deriveOriginationEOA, MNEMONIC_LENGTH } from "./origination-eoa.js";
