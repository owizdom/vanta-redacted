/**
 * Autonomy envelope. Paper §3 Invariant 4, §6 safety floor.
 *
 * The envelope is what the contract enforces, not what the agent
 * promises. Changes require 7-day timelocked lender-quorum upgrade.
 */

export interface AutonomyEnvelope {
  /** Maximum new markets onboarded per 24h, regardless of gate-pass count. */
  readonly maxOnboardsPer24h: number;
  /** Probationary borrow capacity per new market for the first probationDays. */
  readonly probationCapInitialUsdc: bigint;
  /** Probation period in days; cap ramps to formula-derived after. */
  readonly probationDays: number;
  /** Fresh-attestation staleness bound for OnboardEvent acceptance. */
  readonly onboardEventMaxStaleSeconds: number;
  /** Heartbeat silence after which the contract enters Withdraw-Only mode (Inv-5). */
  readonly attestationLivenessSilenceDays: number;
}

export const ENVELOPE_V0: AutonomyEnvelope = Object.freeze({
  maxOnboardsPer24h: 3,
  probationCapInitialUsdc: 25_000n * 10n ** 6n,
  probationDays: 7,
  onboardEventMaxStaleSeconds: 5 * 60,
  attestationLivenessSilenceDays: 14,
});

/**
 * Loan-side invariants enforced by the contracts. Same source as the
 * envelope: 7-day timelocked governance to change.
 */
export interface LoanInvariants {
  /** Per-market LTV ceiling — never above this regardless of formula output. */
  readonly ltvCeilingBps: number;
  /** Liquidation threshold — at this LTV, liquidation auction triggers. */
  readonly liquidationThresholdBps: number;
  /** Linear LTV ramp window before resolution: 7 days from threshold to 0. */
  readonly earlyClosureRampDays: number;
  /** Auction spread floor above 30-min TWAP, in basis points. */
  readonly auctionSpreadFloorBps: number;
  /** Auction window duration in minutes. */
  readonly auctionWindowMinutes: number;
}

export const LOAN_INVARIANTS_V0: LoanInvariants = Object.freeze({
  ltvCeilingBps: 5_000, // 50%
  liquidationThresholdBps: 7_700, // 77%
  earlyClosureRampDays: 7,
  auctionSpreadFloorBps: 20,
  auctionWindowMinutes: 10,
});

/**
 * Per-market freeze parameters (§6 Fail-safes).
 */
export const PER_MARKET_FREEZE = Object.freeze({
  flagBondUsdc: 1_000n * 10n ** 6n,
  flagsRequiredFor24hFreeze: 3,
  flagWindowHours: 24,
  postMortemDays: 7,
});

/**
 * Global onboarding pause (§6 Fail-safes) — multisig-controlled.
 */
export const GLOBAL_PAUSE = Object.freeze({
  multisigThreshold: 4,
  multisigSeatCount: 7,
  pauseMaxDays: 7,
  calibrationTimelockDays: 7,
});
