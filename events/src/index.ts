/**
 * Package barrel for @vanta/events. Re-exports the public API surface
 * recorded in spec §1 and frozen at Week 1 close (BM1 §7 rule 2). Any
 * symbol not re-exported here MUST NOT be considered public.
 */

// Branded primitives + base types
export type {
  AttestationJwt,
  CanonicalJsonBytes,
  EventType,
  Sha256Hex,
  SigningPubKeyHex,
  VantaEvent,
  VantaEventBase,
  VantaEventOfType,
} from "./types.js";
export { asSha256HexOrEmpty } from "./types.js";

// Body interfaces
export type {
  ConstitutionalGenesisBody,
  EthAddressHex,
  LoanLiquidationBody,
  LoanMarkBody,
  LoanMarkRevokedBody,
  LoanOriginationBody,
  LoanPledgeBody,
  LoanPledgeRevokedBody,
  LoanSettlementBody,
  LoopCalibrationProposalBody,
  LoopCreditTickBody,
  LoopOnboardDecisionBody,
  OpInferenceBody,
  OpMarkGapBody,
  OpMarkSparseBody,
  OpOperationalAnomalyBody,
  OpTreasuryAlertBody,
  ReasoningTraceBody,
  TeeAttestationBody,
  TreasuryInflowBody,
  TreasuryOutflowBody,
} from "./bodies.js";

// Schemas (exposed for differential testing and integration surfaces)
export {
  bodySchemas,
  envelopePermissiveSchema,
  envelopeStrictSchema,
  VantaEventSchema,
} from "./schemas.js";

// Canonicalization
export { assertCanonicalizable, canonicalJsonBytes } from "./canonical.js";

// Build
export { buildAndSign } from "./build.js";
export type { BuildArgs, SignFn } from "./build.js";

// Decode
export { decodeEvent } from "./decode.js";
export type { DecodeResult } from "./decode.js";

// Verify
export {
  decodeAndVerify,
  verifyEvent,
  verifyTransitiveGenesis,
} from "./verify.js";
export type {
  EventLog,
  GenesisReachabilityReport,
  VerifyResult,
} from "./verify.js";

// Errors
export { EventsError } from "./errors.js";
export type { EventsErrorCode } from "./errors.js";
