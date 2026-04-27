/**
 * Onboarding gate thresholds. Paper §6 Table 1 — all must pass for a
 * candidate market to be onboardable.
 *
 * These are HARD FLOORS. The agent's reasoning (paper §7) lives above
 * the floor; below the floor, the contract auto-rejects regardless of
 * what the agent proposed.
 */

export interface GateThresholds {
  /** Depth at 5% impact: minimum USDC notional needed to move best-bid by 5%. */
  readonly depth5pctMinUsdc: bigint;
  /** UMA disputes against this market's resolver in the trailing 30 days. */
  readonly disputes30dMax: number;
  /** Days since market creation. */
  readonly ageDaysMin: number;
  /** 7-day realized volatility of mid-price, in price units. */
  readonly vol7dMax: number;
  /** Resolution-criteria text-clarity score from the LLM judge (0-100). */
  readonly textScoreMin: number;
  /** Hamming distance between candidate text and nearest standard template. */
  readonly textTemplateHammingMax: number;
}

export const GATES_V0: GateThresholds = Object.freeze({
  depth5pctMinUsdc: 250_000n * 10n ** 6n, // $250k, USDC has 6 decimals
  disputes30dMax: 0,
  ageDaysMin: 14,
  vol7dMax: 0.35,
  textScoreMin: 70,
  textTemplateHammingMax: 32,
});

export type GateName =
  | "depth"
  | "disputes30d"
  | "age"
  | "vol7d"
  | "textScore"
  | "textTemplate"
  | "tagNovelty";

export const GATE_NAMES: readonly GateName[] = Object.freeze([
  "depth",
  "disputes30d",
  "age",
  "vol7d",
  "textScore",
  "textTemplate",
  "tagNovelty",
]);
