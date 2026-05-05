/**
 * Real CreditObservation builder — wires the credit loop to live
 * Polymarket data.
 *
 * Replaces the stub at main.ts that returned `{best_bid: 0.5, twap: 0.5,
 * depth: 300_000_000_000, ...}` for every loan on every tick. With this
 * module the per-loan tick reads three things from the Polymarket CLOB:
 *
 *   1. fetchMidpoint(token_id)           → best_bid (mid as proxy)
 *   2. fetchPricesHistory(token_id, …)   → twap_30min (time-weighted)
 *   3. fetchBook(token_id)               → depth_5pct_usdc (orderbook walk)
 *
 * `dispute_30d_count` is hardcoded to 0 with a Phase-6 TODO — UMA dispute
 * lookup needs `@vanta/venue-poly` integration. Zero is the safe default;
 * it doesn't trigger any gate. `time_to_resolution_seconds` is computed
 * directly from the loan's maturity timestamp.
 *
 * Caching: `marketsCache` already polls midpoints every 30s for watched
 * markets — we reuse those when available. Book + history are NOT in the
 * cache today, so we add a short-TTL (15s) per-token in-memory cache here
 * to avoid hammering Polymarket on every credit tick when several loans
 * share a market.
 *
 * Failure mode: any clob call throws → return a degraded-but-safe
 * observation that triggers the `freeze_request` path on every loan
 * (LTV → 9999). The agent fails closed when it can't see the market —
 * safer than reading stale stubs.
 */

import {
  fetchBook,
  fetchMidpoint,
  fetchPricesHistory,
} from "@vanta/mark";
import { asSha256Hex } from "@vanta/tee";

import type { ActiveLoanView, CreditObservation } from "../loops/credit.js";

import type { MarketsCache } from "./markets-cache.js";

const TTL_MS = 15_000;
const TWAP_WINDOW_SECONDS = 30 * 60; // 30 minutes
const DEPTH_IMPACT_FRACTION = 0.05; // 5% mid-impact threshold

interface CachedFetch<T> {
  readonly fetchedAt: number;
  readonly value: T;
}

interface BookSnapshot {
  readonly bestBid: number; // decimal in [0, 1]
  readonly depth5pctUsdc: bigint; // USDC wei (6 decimals)
}

interface HistorySnapshot {
  readonly twap: number; // decimal in [0, 1]
}

/**
 * Walk the bid side of the orderbook from the best bid downward, summing
 * notional (price × size) until the cumulative move from best_bid would
 * exceed `DEPTH_IMPACT_FRACTION` of the best_bid. The cumulative USDC
 * notional at that point is the 5% depth.
 *
 * Polymarket's `/book` returns `bids` already sorted from best (highest
 * price) to worst — we walk in that order.
 *
 * USDC has 6 decimals, so we multiply notional by 1e6 to land in wei.
 * Inputs are decimal strings; we parse via `Number()` to keep math
 * floating-point. The 5% threshold doesn't need wei-precision.
 */
function compute5pctDepth(
  bids: ReadonlyArray<{ readonly price: string; readonly size: string }>,
): { bestBid: number; depthUsdc6: bigint } {
  if (bids.length === 0) return { bestBid: 0, depthUsdc6: 0n };
  const bestBidStr = bids[0]?.price ?? "0";
  const bestBid = Number(bestBidStr);
  if (!(bestBid > 0)) return { bestBid: 0, depthUsdc6: 0n };

  const stopPrice = bestBid * (1 - DEPTH_IMPACT_FRACTION);
  let cumulativeUsdc = 0;
  for (const lvl of bids) {
    const lvlPrice = Number(lvl.price);
    const lvlSize = Number(lvl.size);
    if (!(lvlPrice > 0) || !(lvlSize > 0)) continue;
    if (lvlPrice < stopPrice) break;
    cumulativeUsdc += lvlPrice * lvlSize;
  }
  // Convert to USDC wei (6 decimals). Math.floor to keep it inside bigint.
  const depthUsdc6 = BigInt(Math.floor(cumulativeUsdc * 1_000_000));
  return { bestBid, depthUsdc6 };
}

/**
 * Time-weighted average price across a `prices-history` series. Each
 * point `(t, p)` carries weight `t_{i+1} - t_i` (the duration that price
 * persisted). The last point carries weight `now - t_last`.
 *
 * Falls back to a simple mean when only one point is returned.
 */
function computeTwapFromHistory(
  history: ReadonlyArray<{ readonly t: number; readonly p: string }>,
  endTs: number,
): number {
  if (history.length === 0) return 0;
  if (history.length === 1) {
    const only = history[0];
    return only === undefined ? 0 : Number(only.p);
  }

  let weightedSum = 0;
  let totalWeight = 0;
  for (let i = 0; i < history.length; i++) {
    const cur = history[i];
    if (cur === undefined) continue;
    const next = history[i + 1];
    const nextTs = next === undefined ? endTs : next.t;
    const weight = Math.max(0, nextTs - cur.t);
    if (weight === 0) continue;
    const price = Number(cur.p);
    if (!(price >= 0)) continue;
    weightedSum += price * weight;
    totalWeight += weight;
  }
  if (totalWeight === 0) {
    // All points collapsed onto the same instant — fall back to the most
    // recent price.
    const last = history[history.length - 1];
    return last === undefined ? 0 : Number(last.p);
  }
  return weightedSum / totalWeight;
}

export interface CreditObserverArgs {
  readonly marketsCache: MarketsCache;
  /** Override clock; tests inject a fake. */
  readonly nowMs?: () => number;
}

const DEGRADED_OBSERVATION: CreditObservation = {
  best_bid: "0",
  twap_30min: "0",
  depth_5pct_usdc: "0",
  dispute_30d_count: 0,
  time_to_resolution_seconds: 0,
};

export function createCreditObserver(
  args: CreditObserverArgs,
): (loan: ActiveLoanView) => Promise<CreditObservation> {
  const now = args.nowMs ?? ((): number => Date.now());
  const bookCache = new Map<string, CachedFetch<BookSnapshot>>();
  const historyCache = new Map<string, CachedFetch<HistorySnapshot>>();

  const readBook = async (tokenId: string): Promise<BookSnapshot> => {
    const cached = bookCache.get(tokenId);
    const t = now();
    if (cached !== undefined && t - cached.fetchedAt < TTL_MS) {
      return cached.value;
    }
    const { book } = await fetchBook(tokenId);
    const { bestBid, depthUsdc6 } = compute5pctDepth(book.bids);
    const snap: BookSnapshot = { bestBid, depth5pctUsdc: depthUsdc6 };
    bookCache.set(tokenId, { fetchedAt: t, value: snap });
    return snap;
  };

  const readHistory = async (tokenId: string): Promise<HistorySnapshot> => {
    const cached = historyCache.get(tokenId);
    const t = now();
    if (cached !== undefined && t - cached.fetchedAt < TTL_MS) {
      return cached.value;
    }
    const endTs = Math.floor(t / 1000);
    const startTs = endTs - TWAP_WINDOW_SECONDS;
    const { history } = await fetchPricesHistory(tokenId, startTs, endTs);
    const snap: HistorySnapshot = { twap: computeTwapFromHistory(history, endTs) };
    historyCache.set(tokenId, { fetchedAt: t, value: snap });
    return snap;
  };

  return async (loan: ActiveLoanView): Promise<CreditObservation> => {
    try {
      // Try cached midpoint first — the marketsCache already polls these
      // every 30s for watched markets. If unavailable we fetch directly.
      let bestBidStr: string | null = null;
      const cidHex = asSha256Hex(loan.condition_id.replace(/^0x/, ""));
      const cached = args.marketsCache.snapshotOne(cidHex);
      if (cached !== null && !cached.stale) {
        // Pick the side matching the loan's token. The cache stores YES/NO
        // mids keyed by side, but the loan only carries token_id — so
        // match against the cache's tokens list.
        for (const tok of cached.tokens) {
          if (tok.tokenId === loan.token_id) {
            bestBidStr =
              tok.outcome.toUpperCase() === "YES"
                ? cached.mid.yes
                : cached.mid.no;
            break;
          }
        }
      }

      const [book, history] = await Promise.all([
        readBook(loan.token_id),
        readHistory(loan.token_id),
      ]);

      // Prefer the orderbook best-bid (live, walked from raw L2). Fall
      // back to cached midpoint if the book came back empty.
      const bestBid =
        book.bestBid > 0
          ? book.bestBid
          : bestBidStr !== null
            ? Number(bestBidStr)
            : 0;

      // TWAP fallback: if history was empty, degrade to best_bid so the
      // dual-source min(best, twap) check in computeLtvBps still produces
      // a sensible LTV.
      const twap = history.twap > 0 ? history.twap : bestBid;

      const ttrSeconds = Math.max(
        0,
        Math.floor((loan.maturity_ts_ms - now()) / 1000),
      );

      return {
        best_bid: bestBid.toFixed(6),
        twap_30min: twap.toFixed(6),
        depth_5pct_usdc: book.depth5pctUsdc.toString(),
        // TODO(phase-6): wire UMA dispute count via @vanta/venue-poly.
        dispute_30d_count: 0,
        time_to_resolution_seconds: ttrSeconds,
      };
    } catch (err) {
      // Fail closed. The credit loop's computeLtvBps will see a zero
      // collateral value and stamp LTV=9999 → flag=freeze_request. The
      // operational loop's oracle_read_failure anomaly fires if this
      // becomes a pattern.
      // eslint-disable-next-line no-console
      console.warn(
        `vanta/credit-observer: degraded observation for loan ${loan.loan_id} (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
      const ttrSeconds = Math.max(
        0,
        Math.floor((loan.maturity_ts_ms - now()) / 1000),
      );
      return {
        ...DEGRADED_OBSERVATION,
        time_to_resolution_seconds: ttrSeconds,
      };
    }
  };
}
