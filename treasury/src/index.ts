/**
 * Package barrel for @vanta/treasury.
 *
 * Re-exports the Week-1-close public surface per spec §1. Any symbol
 * not re-exported here is implementation-detail and MUST NOT be
 * considered public.
 *
 * Scope:
 *   - initTreasury + getTreasuryAddress + getTreasuryState (spec §1.1-1.3)
 *   - buildOutflowTx (spec §1.5, Week 1 pure planner)
 *   - Types: TreasuryState, ScheduleEntry, OutflowPlan, TreasuryInflowBody,
 *     InflowSource, InitTreasuryOpts, TreasuryError,
 *     TreasuryErrorCode (spec §1.6, §4)
 *   - Reconciler handle (spec §2 I-TR-3, §6.5)
 *
 * Everything not listed below is intentionally private. External review
 * will check that this barrel matches the spec's frozen public surface.
 */

// Errors
export { TreasuryError } from "./errors.js";
export type { TreasuryErrorCode } from "./errors.js";

// Init + accessors
export {
  initTreasury,
  getTreasuryAddress,
  getTreasuryState,
  getChainId,
  getUsdcContract,
} from "./init.js";

// Outflow planner
export { buildOutflowTx } from "./outflow.js";
export type {
  BuildOutflowDeps,
  ConstitutionalRefResolver,
  SchedulePeriodRemainder,
} from "./outflow.js";

// Invariant reconciler
export {
  reconcileOnce,
  startReconciler,
} from "./invariant.js";
export type {
  ReconcileResult,
  ReconcileOpts,
  ReconcileEmitFn,
  ReconcileSchedulerHandle,
} from "./invariant.js";

// Public types
export type {
  InitTreasuryOpts,
  InflowSource,
  OutflowPlan,
  SchedulePeriod,
  ScheduleEntry,
  TreasuryInflowBody,
  TreasuryState,
  UsdcAmountWei,
} from "./types.js";

// Frozen constants (publishable; used by wire formatters and tests)
export {
  CHAIN_ID,
  CHAIN_LABEL,
  CONFIRMATION_BLOCKS,
  USDC_BASE_SEPOLIA,
  USDC_DECIMALS,
} from "./constants.js";
export type {
  ChainId,
  ChainLabel,
  ConfirmationDepth,
} from "./constants.js";
