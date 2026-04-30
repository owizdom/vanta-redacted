/**
 * Package barrel for @vanta/origination.
 *
 * Re-exports only the public orchestration surface and the typed error
 * class. Internal helpers (broadcast poll defaults, validateRequest,
 * `LOAN_BOOK_ABI` shape) stay module-private.
 */

// Errors
export { OriginationError } from "./errors.js";
export type { OriginationErrorCode } from "./errors.js";

// Public types
export type {
  OriginationReceipt,
  OriginationRequest,
  OriginationTeeEnvelope,
  SignedLoanOriginationEvent,
} from "./types.js";

// Top-level orchestrator
export {
  originate,
  ORIGINATION_FINALITY_DEPTH,
} from "./orchestrate.js";
export type {
  AppendEventFn,
  LoadEventFn,
  OriginateArgs,
} from "./orchestrate.js";

// paramsHash — exposed because the verifier CLI (commit 7) needs it to
// independently recompute the on-chain stamp.
export { computeParamsHash } from "./paramsHash.js";

// Broadcast — exposed so callers can inject a custom polling strategy
// without re-implementing it (e.g. a watchtower process).
export { broadcastOriginate } from "./broadcast.js";
export type {
  BroadcastOriginateArgs,
  BroadcastOriginateResult,
} from "./broadcast.js";
