/**
 * Package barrel for @vanta/pledge.
 *
 * Re-exports only the public orchestration surface. Internal helpers
 * (fallback-slot constant, eligibility-reason types, finality poll
 * defaults) stay module-private.
 */

// Errors
export { PledgeError } from "./errors.js";
export type { PledgeErrorCode } from "./errors.js";

// Public types
export type {
  BorrowerRegistry,
  BorrowerRegistryEntry,
  ClobResolutionSnapshot,
  PledgeEligibility,
  PledgeReceipt,
  PledgeRequest,
  SignedLoanPledgeEvent,
  SignedLoanPledgeRevokedEvent,
  TransferSingleLog,
} from "./types.js";

// Top-level orchestrator
export { pledge } from "./pledge.js";
export type { PledgeArgs, PledgeTeeEnvelope } from "./pledge.js";

// Watchdog
export { startPledgeWatchdog } from "./watchdog.js";
export type {
  PledgeWatchdogHandle,
  StartPledgeWatchdogArgs,
  TeeInnerEnvelope,
  WatchdogOutcome,
} from "./watchdog.js";

// Eligibility (public so higher-level runtime can call it independently
// to pre-flight a pledge without running the full pipeline)
export { checkEligibility } from "./eligibility.js";
export type { CheckEligibilityArgs, ReadQuestionFn } from "./eligibility.js";
