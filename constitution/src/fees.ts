/**
 * Fee schedule. Paper §13 Economics.
 *
 * Origination: 50 bps of principal, paid by borrower at origination.
 * Oracle: 25 bps of TVL annualized, paid by lenders.
 * Onboarding: $0 to borrower; cost internalized in the rate.
 *
 * Bond requirement: $1k to flag a market (refundable on upheld flag,
 * slashable on frivolous).
 */

export interface FeeSchedule {
  readonly originationFeeBps: number;
  readonly oracleFeeAnnualBps: number;
  readonly flagBondUsdc: bigint;
}

export const FEES_V0: FeeSchedule = Object.freeze({
  originationFeeBps: 50,
  oracleFeeAnnualBps: 25,
  flagBondUsdc: 1_000n * 10n ** 6n,
});
