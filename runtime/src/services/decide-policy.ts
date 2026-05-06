/**
 * Decide-policy — pure function shared by the trading loop and the
 * `/api/agent/decide` route.
 *
 * Inputs: a market snapshot (mid + book depth at 5%), the agent's
 * belief + confidence for that market, the existing portfolio state
 * (open positions, free USDC, AUM cap), and the agent's risk
 * parameters. Output: a single `Decision` — enter / hold / exit.
 *
 * The function is deliberately mechanical: all LLM reasoning lives
 * upstream in the belief engine. Decide-policy is the rulebook that
 * turns a belief into a sized action while respecting:
 *
 *   1. Edge gate: |belief - mid| ≥ thresholdBps (otherwise HOLD)
 *   2. Confidence gate: confidence ≥ minConfidenceBps (else HOLD)
 *   3. Depth gate: book depth at 5% ≥ size × depthBufferRatio (so the
 *      entry doesn't move mid by more than 5%)
 *   4. AUM cap: open notional + size ≤ maxAumUsdc6 (Phase A contract
 *      cap is $10k — paper-trading mode respects the same cap so the
 *      simulation matches what a live deploy would do)
 *   5. Per-market cap: each market gets at most one open position;
 *      the agent re-marks rather than averaging in
 *   6. Exit policy: open position → if gap collapses below
 *      exitGapBps, return EXIT
 *
 * Sizing: when entering, the agent puts `kellyFractionBps` of free
 * USDC on the trade, capped at `maxPositionUsdc6`. v3.0 keeps this
 * simple — Kelly fraction is a single immutable parameter, not a
 * function of confidence. v3.1 will scale by confidence.
 */

import type { Sha256Hex } from "@vanta/tee";

export type DecisionAction = "enter" | "hold" | "exit";
export type Side = "yes" | "no";

/**
 * Snapshot of one prediction-market state at a single instant. The
 * trading loop pulls this from `@vanta/mark.fetchMidpoint` +
 * `fetchBook` per tick.
 */
export interface MarketSnapshot {
  readonly market_id: Sha256Hex;
  /** Mid price ∈ [0, 1] as a JS number. The schema-side wire form is
   *  `mid_centibps` (0..1_000_000). */
  readonly mid: number;
  /** USDC notional needed to move mid by 5%. Wei (6 decimals). */
  readonly depth_5pct_usdc6: bigint;
}

/**
 * Agent's belief about a market. Produced by the belief engine.
 * `belief` is the structured-output probability of YES resolving;
 * `confidence` is the engine's self-estimated certainty.
 */
export interface Belief {
  readonly market_id: Sha256Hex;
  readonly belief: number; // ∈ [0, 1]
  readonly confidence: number; // ∈ [0, 1]
  /** event id of the `op.inference` that produced the belief. */
  readonly inference_event_id: Sha256Hex;
}

/**
 * Open position view from PositionBook. The decide-policy needs only
 * the cost-basis + side + market_id to decide on exit; full struct
 * lives in the contract.
 */
export interface OpenPosition {
  readonly position_id: Sha256Hex;
  readonly market_id: Sha256Hex;
  readonly side: Side;
  readonly size_usdc6: bigint;
  readonly entry_price_bps: number; // 0..10000
}

export interface Portfolio {
  readonly free_usdc6: bigint;
  readonly open_notional_usdc6: bigint;
  readonly max_aum_usdc6: bigint;
  readonly positions: readonly OpenPosition[];
}

/** All thresholds carried as bps (basis points) so the math is integer. */
export interface DecidePolicyParams {
  /** Minimum |belief − mid| in bps to consider entering. */
  readonly entry_gap_threshold_bps: number;
  /** Below this gap, an open position auto-exits. */
  readonly exit_gap_threshold_bps: number;
  /** Minimum confidence in bps. Below this we hold. */
  readonly min_confidence_bps: number;
  /** Book depth must be ≥ size × this/10_000. */
  readonly depth_buffer_ratio_bps: number;
  /** Kelly fraction of free USDC per entry (bps). */
  readonly kelly_fraction_bps: number;
  /** Hard ceiling per single position (USDC wei). */
  readonly max_position_usdc6: bigint;
}

/** Sensible defaults for paper-trading mode. */
export const DEFAULT_DECIDE_POLICY: DecidePolicyParams = {
  entry_gap_threshold_bps: 500, // 5pp edge required
  exit_gap_threshold_bps: 100, // close when within 1pp of mid
  min_confidence_bps: 6000, // 60% confidence required
  depth_buffer_ratio_bps: 12_000, // 1.2× headroom
  kelly_fraction_bps: 200, // 2% of free USDC per entry
  max_position_usdc6: 500_000_000n, // $500 ceiling
};

export interface Decision {
  readonly action: DecisionAction;
  readonly market_id: Sha256Hex;
  readonly side: Side;
  readonly size_usdc6: bigint;
  readonly mid_centibps: number;
  readonly belief_centibps: number;
  readonly confidence_bps: number;
  readonly gap_bps: number;
  /** When EXIT, the existing position id; otherwise the all-zero hex. */
  readonly position_id: Sha256Hex;
  readonly reason: string;
}

const ZERO_HEX: Sha256Hex =
  "0000000000000000000000000000000000000000000000000000000000000000" as Sha256Hex;

/** Probability ∈ [0, 1] → centibps (0..1_000_000). */
function probToCentibps(p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1_000_000;
  return Math.round(p * 1_000_000);
}

/** Probability ∈ [0, 1] → bps (0..10_000). */
function probToBps(p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 10_000;
  return Math.round(p * 10_000);
}

/**
 * Return the open position on `market_id` if any. The vault has at
 * most one open position per market (rule 5).
 */
function findOpenOnMarket(
  portfolio: Portfolio,
  marketId: Sha256Hex,
): OpenPosition | undefined {
  return portfolio.positions.find((p) => p.market_id === marketId);
}

function holdDecision(args: {
  readonly snapshot: MarketSnapshot;
  readonly belief: Belief;
  readonly gapBps: number;
  readonly reason: string;
}): Decision {
  return {
    action: "hold",
    market_id: args.snapshot.market_id,
    side: "yes",
    size_usdc6: 0n,
    mid_centibps: probToCentibps(args.snapshot.mid),
    belief_centibps: probToCentibps(args.belief.belief),
    confidence_bps: probToBps(args.belief.confidence),
    gap_bps: args.gapBps,
    position_id: ZERO_HEX,
    reason: args.reason,
  };
}

/**
 * Pure decide function. The trading loop calls this once per (market,
 * agent) per tick.
 */
export function decide(args: {
  readonly snapshot: MarketSnapshot;
  readonly belief: Belief;
  readonly portfolio: Portfolio;
  readonly params: DecidePolicyParams;
}): Decision {
  const { snapshot, belief, portfolio, params } = args;
  const beliefBps = probToBps(belief.belief);
  const midBps = probToBps(snapshot.mid);
  const gapBpsSigned = beliefBps - midBps;
  const gapMagnitude = Math.abs(gapBpsSigned);

  const open = findOpenOnMarket(portfolio, snapshot.market_id);

  // -------- exit branch (open position on this market) --------
  if (open !== undefined) {
    if (gapMagnitude < params.exit_gap_threshold_bps) {
      return {
        action: "exit",
        market_id: snapshot.market_id,
        side: open.side,
        size_usdc6: open.size_usdc6,
        mid_centibps: probToCentibps(snapshot.mid),
        belief_centibps: probToCentibps(belief.belief),
        confidence_bps: probToBps(belief.confidence),
        gap_bps: gapBpsSigned,
        position_id: open.position_id,
        reason: `gap ${String(gapMagnitude)}bps below exit threshold ${String(params.exit_gap_threshold_bps)}bps`,
      };
    }
    return holdDecision({
      snapshot,
      belief,
      gapBps: gapBpsSigned,
      reason: `holding open position; gap ${String(gapMagnitude)}bps still > exit threshold`,
    });
  }

  // -------- entry branch (no open position on this market) --------
  if (gapMagnitude < params.entry_gap_threshold_bps) {
    return holdDecision({
      snapshot,
      belief,
      gapBps: gapBpsSigned,
      reason: `gap ${String(gapMagnitude)}bps below entry threshold ${String(params.entry_gap_threshold_bps)}bps`,
    });
  }

  const confidenceBps = probToBps(belief.confidence);
  if (confidenceBps < params.min_confidence_bps) {
    return holdDecision({
      snapshot,
      belief,
      gapBps: gapBpsSigned,
      reason: `confidence ${String(confidenceBps)}bps below min ${String(params.min_confidence_bps)}bps`,
    });
  }

  // Sizing.
  const kellyTarget =
    (portfolio.free_usdc6 * BigInt(params.kelly_fraction_bps)) / 10_000n;
  const sizeCapped =
    kellyTarget > params.max_position_usdc6
      ? params.max_position_usdc6
      : kellyTarget;

  // AUM headroom.
  const aumHeadroom =
    portfolio.max_aum_usdc6 > portfolio.open_notional_usdc6
      ? portfolio.max_aum_usdc6 - portfolio.open_notional_usdc6
      : 0n;
  const sizeAfterAum = sizeCapped > aumHeadroom ? aumHeadroom : sizeCapped;

  if (sizeAfterAum === 0n) {
    return holdDecision({
      snapshot,
      belief,
      gapBps: gapBpsSigned,
      reason: "AUM cap reached or kelly fraction zero",
    });
  }

  // Depth gate — book at 5% must cover size × buffer.
  const requiredDepth =
    (sizeAfterAum * BigInt(params.depth_buffer_ratio_bps)) / 10_000n;
  if (snapshot.depth_5pct_usdc6 < requiredDepth) {
    return holdDecision({
      snapshot,
      belief,
      gapBps: gapBpsSigned,
      reason: `book depth ${snapshot.depth_5pct_usdc6.toString()} < required ${requiredDepth.toString()}`,
    });
  }

  // Side: if belief > mid, we want YES (mispriced low); else NO.
  const side: Side = gapBpsSigned > 0 ? "yes" : "no";

  return {
    action: "enter",
    market_id: snapshot.market_id,
    side,
    size_usdc6: sizeAfterAum,
    mid_centibps: probToCentibps(snapshot.mid),
    belief_centibps: probToCentibps(belief.belief),
    confidence_bps: confidenceBps,
    gap_bps: gapBpsSigned,
    position_id: ZERO_HEX,
    reason: `enter ${side} size=${sizeAfterAum.toString()} on gap ${String(gapMagnitude)}bps`,
  };
}
