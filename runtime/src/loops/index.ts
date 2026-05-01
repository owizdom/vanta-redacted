/**
 * @vanta/runtime/loops — three continuous reasoning loops (paper §7).
 *
 * Public surface:
 *   - createCreditLoop      — per-loan health monitor
 *   - createModelLoop       — calibration drift detector
 *   - createOperationalLoop — treasury runway + cost anomalies
 *
 * Each returns a `ReasoningLoop` with start/stop/runTick. The runtime
 * wires up shared dependencies (chain clients, EventSink, clock) and
 * fans them out across the three loops at boot.
 *
 * None of the loops can move funds, change formula parameters in
 * production, or onboard markets outside the §6 envelope. The loops
 * reason; the contract gates and the lender multisig act.
 */

export { createCreditLoop } from "./credit.js";
export type {
  ActiveLoanView,
  CreditLoopArgs,
  CreditObservation,
  FetchObservationFn,
} from "./credit.js";

export { createModelLoop } from "./model.js";
export type {
  ModelLoopArgs,
  ReplayRow,
  FetchReplayDatasetFn,
} from "./model.js";

export { createOperationalLoop } from "./operational.js";
export type {
  OperationalLoopArgs,
  OperationalSnapshot,
  FetchOperationalSnapshotFn,
} from "./operational.js";

export type {
  CalibrationProposalBody,
  CreditFlag,
  CreditTickBody,
  EventSink,
  LoopClock,
  LoopContext,
  OperationalAnomalyBody,
  ReasoningLoop,
  ReasoningTraceBody,
  TreasuryAlertBody,
} from "./types.js";
