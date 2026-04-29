/**
 * Time-weighted average price (TWAP) per Uniswap v3 OracleLibrary.consult
 * semantics (canonical-reference.md §4 "TWAP aggregation recipe").
 *
 * Semantics:
 *   Each trade's price holds from its timestamp until the next trade's
 *   timestamp (right-continuous step function). The window is
 *   [window.startUnix, window.endUnix]. The "bootstrap" price is the
 *   price right before the first trade in the window; it weights the
 *   interval [windowStart, firstTrade.timestamp]. The price of the last
 *   trade weights the interval [lastTrade.timestamp, min(nextHypothetical, windowEnd)].
 *
 *   denominator = total covered seconds in [windowStart, windowEnd]
 *     (excluding any time the last trade extends past windowEnd).
 *
 *   numerator = Σ (price * segment_duration_seconds)
 *
 *   twap = numerator / denominator
 *
 * Invalid-window triggers (I-MK-3):
 *   1. trades.length < 3 → `insufficient_trades`
 *   2. denominator < (windowEnd - windowStart) - COVERAGE_GAP_MAX_SECONDS
 *      → `coverage_gap`
 *   3. any single trade's segment duration > 50% of denominator
 *      → `single_trade_dominance`
 *
 * Deduplication is the caller's responsibility (they pre-dedupe by
 * `transactionHash`); documented in the public jsdoc on `computeTwap`.
 *
 * Precision: prices are bounded in [0, 1] with up to ~6 significant
 * digits in practice. Using JS `number` for the running sum incurs
 * ~2^-52 relative rounding across a 1800-second window, ~3.6e-13
 * absolute error for a unit-scale price. Acceptable for the downstream
 * 2% cross-check tolerance; the external test uses toBeCloseTo(..., 10).
 * We render the final TWAP to 10 decimal places.
 */

import {
  COVERAGE_GAP_MAX_SECONDS,
  MAX_SINGLE_TRADE_SHARE,
  MIN_TRADES_IN_WINDOW,
} from "./constants.js";
import type { Trade } from "./types.js";
import type { SparseReason } from "./errors.js";

export interface TwapWindow {
  readonly startUnix: number;
  readonly endUnix: number;
}

export interface TwapValid {
  readonly valid: true;
  readonly twap: string;
  readonly denominator: number;
}

export interface TwapInvalid {
  readonly valid: false;
  readonly reason: Exclude<SparseReason, "cross_check_disagreement">;
  readonly denominator: number;
  readonly trade_count: number;
}

export type TwapResult = TwapValid | TwapInvalid;

/**
 * `trades` MUST be pre-deduplicated by `transactionHash` and MUST have
 * timestamps in `[window.startUnix, window.endUnix]`. The implementation
 * will sort internally by timestamp, but will not filter out-of-window
 * rows — a caller's responsibility.
 */
export function computeTwap(
  tradesIn: readonly Trade[],
  window: TwapWindow,
  bootstrapPrice: string,
): TwapResult {
  if (window.endUnix <= window.startUnix) {
    throw new Error("computeTwap: window.endUnix must be > window.startUnix");
  }

  // Fast-fail branch: not enough trades. Denominator is still the full
  // window (used for proportional analysis later; not material here).
  if (tradesIn.length < MIN_TRADES_IN_WINDOW) {
    return {
      valid: false,
      reason: "insufficient_trades",
      denominator: 0,
      trade_count: tradesIn.length,
    };
  }

  const trades = [...tradesIn].sort((a, b) => a.timestamp - b.timestamp);

  // Build segments:
  //   - [window.startUnix, trades[0].timestamp] at bootstrap price
  //   - [trades[i].timestamp, trades[i+1].timestamp] at trades[i].price
  //   - [trades[last].timestamp, window.endUnix] at trades[last].price
  // A trade whose timestamp falls at window.startUnix replaces the
  // bootstrap segment (its duration collapses to zero).
  //
  // segment.duration is clamped to [0, windowLength]; negative
  // durations (out-of-window trade) contribute zero.

  const segments: { readonly price: number; readonly duration: number }[] = [];
  const pushSegment = (price: number, duration: number): void => {
    if (duration > 0) segments.push({ price, duration });
  };

  const bootstrap = toNumber(bootstrapPrice, "bootstrapPrice");

  const firstTs = clamp(trades[0]?.timestamp ?? window.startUnix, window);
  pushSegment(bootstrap, firstTs - window.startUnix);

  for (let i = 0; i < trades.length; i++) {
    const cur = trades[i];
    if (cur === undefined) continue;
    const curTs = clamp(cur.timestamp, window);
    const nextTs =
      i + 1 < trades.length
        ? clamp(trades[i + 1]?.timestamp ?? window.endUnix, window)
        : window.endUnix;
    const segDuration = nextTs - curTs;
    const price = toNumber(cur.price, `trades[${String(i)}].price`);
    pushSegment(price, segDuration);
  }

  let numerator = 0;
  let denominator = 0;
  let maxSegmentDuration = 0;
  for (const seg of segments) {
    numerator += seg.price * seg.duration;
    denominator += seg.duration;
    if (seg.duration > maxSegmentDuration) maxSegmentDuration = seg.duration;
  }

  const windowLength = window.endUnix - window.startUnix;

  // Coverage-gap (I-MK-3): aggregate covered time falls below
  // windowLength - COVERAGE_GAP_MAX_SECONDS. Reachable when trade
  // timestamps cluster out-of-window (clamped segments collapse).
  if (denominator < windowLength - COVERAGE_GAP_MAX_SECONDS) {
    return {
      valid: false,
      reason: "coverage_gap",
      denominator,
      trade_count: trades.length,
    };
  }

  if (denominator <= 0) {
    // Defensive: all segments collapsed to zero.
    return {
      valid: false,
      reason: "coverage_gap",
      denominator,
      trade_count: trades.length,
    };
  }

  // Single-trade dominance (I-MK-3): any one segment's duration
  // exceeds 50% of the covered denominator. Fires for the sparse case
  // where three trades cluster at the start and the tail segment
  // dominates the rest of the window.
  if (maxSegmentDuration > MAX_SINGLE_TRADE_SHARE * denominator) {
    return {
      valid: false,
      reason: "single_trade_dominance",
      denominator,
      trade_count: trades.length,
    };
  }

  const twap = numerator / denominator;
  return {
    valid: true,
    twap: renderTwap(twap),
    denominator,
  };
}

/**
 * Render the TWAP as a decimal string bounded in [0, 1] with up to 10
 * fractional digits. The events-schema `loanMarkBody.twap` regex is
 * `^0(\.[0-9]+)?$|^1(\.0+)?$`, so we normalize `1` without trailing
 * digits and strip trailing zeros on anything else. Clamp to [0, 1] on
 * floating-point drift; a price computed from bounded inputs can
 * round to 1.0000000000000002.
 */
function renderTwap(x: number): string {
  if (!Number.isFinite(x) || x < 0) {
    throw new Error(`renderTwap: non-finite or negative value ${String(x)}`);
  }
  const clamped = x > 1 ? 1 : x;
  if (clamped === 0) return "0";
  if (clamped === 1) return "1";
  // 10 fractional digits; strip trailing zeros; drop trailing `.`.
  let s = clamped.toFixed(10);
  s = s.replace(/0+$/, "");
  s = s.replace(/\.$/, "");
  return s;
}

function toNumber(s: string, field: string): number {
  // Already regex-validated upstream; re-check for safety.
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`twap: ${field} not a non-negative number: ${s}`);
  }
  return n;
}

function clamp(ts: number, w: TwapWindow): number {
  if (ts < w.startUnix) return w.startUnix;
  if (ts > w.endUnix) return w.endUnix;
  return ts;
}
