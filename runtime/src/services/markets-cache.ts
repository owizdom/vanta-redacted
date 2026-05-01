/**
 * Markets cache — Polymarket metadata + live midpoints for the
 * markets vanta is watching (paper §7.4 surfaces).
 *
 * start() / stop() / snapshotAll() / snapshotOne(). Two cadences:
 *
 *   - Market metadata (`fetchMarket`): 60s poll. Question text + outcome
 *     tokens rarely change; one call per conditionId.
 *   - Midpoints (`fetchMidpoint`): 30s poll. Per-side mid for every
 *     watched token. Faster cadence so the rail looks alive.
 *
 * Both calls are read-only; failures mark the snapshot stale: true and
 * keep the previous value. Never throws — callers depend on getting
 * *some* snapshot, even an old one.
 */

import { fetchMarket, fetchMidpoint } from "@vanta/mark";
import type { Sha256Hex } from "@vanta/tee";

import {
  allWatchedConditionIds,
  watchedTokenSides,
  WATCHED_ONLY_MARKETS,
  WATCHED_MARKETS,
  type WatchedMarket,
} from "./watched-markets.js";

export interface MarketSnapshot {
  /** 64-hex no 0x. */
  readonly conditionId: Sha256Hex;
  readonly question: string | null;
  readonly closed: boolean;
  readonly acceptingOrders: boolean;
  readonly tokens: readonly { tokenId: string; outcome: string; price: string | null; winner: boolean }[];
  readonly mid: { yes: string | null; no: string | null };
  /** ms since epoch — 0 means never fetched. */
  readonly fetchedAt: number;
  readonly stale: boolean;
  readonly lastError: string | null;
  /** Slug → polymarket.com link (derived from watched-markets fixture). */
  readonly polymarketSlug: string | null;
  /** Stable label of the position holder if any; null for watched-only. */
  readonly ownerLabel: string | null;
}

export interface MarketsCache {
  start(): void;
  stop(): void;
  snapshotAll(): readonly MarketSnapshot[];
  snapshotOne(conditionIdHex: Sha256Hex): MarketSnapshot | null;
}

const METADATA_INTERVAL_MS = 60_000;
const MIDPOINT_INTERVAL_MS = 30_000;

const blankSnapshot = (cid: Sha256Hex, slug: string | null, owner: string | null): MarketSnapshot => ({
  conditionId: cid,
  question: null,
  closed: false,
  acceptingOrders: false,
  tokens: [],
  mid: { yes: null, no: null },
  fetchedAt: 0,
  stale: true,
  lastError: null,
  polymarketSlug: slug,
  ownerLabel: owner,
});

/** Static map of cid → {slug, ownerLabel} drawn from watched-markets. */
function buildContextMap(): Map<string, { slug: string | null; ownerLabel: string | null }> {
  const out = new Map<string, { slug: string | null; ownerLabel: string | null }>();
  for (const m of WATCHED_MARKETS) {
    out.set(m.conditionIdHex, { slug: m.polymarketSlug, ownerLabel: m.label });
  }
  for (const w of WATCHED_ONLY_MARKETS) {
    if (!out.has(w.conditionIdHex)) {
      out.set(w.conditionIdHex, { slug: w.polymarketSlug, ownerLabel: null });
    }
  }
  return out;
}

export function createMarketsCache(): MarketsCache {
  const watched = allWatchedConditionIds();
  const tokenSides = watchedTokenSides();
  const ctx = buildContextMap();

  // Start every market in a blank stale state so snapshotAll() returns
  // something sensible before the first fetch lands.
  const cache = new Map<Sha256Hex, MarketSnapshot>();
  for (const cid of watched) {
    const meta = ctx.get(cid) ?? { slug: null, ownerLabel: null };
    cache.set(cid, blankSnapshot(cid, meta.slug, meta.ownerLabel));
  }

  let metadataTimer: ReturnType<typeof setInterval> | null = null;
  let midpointTimer: ReturnType<typeof setInterval> | null = null;

  async function refreshMetadata(): Promise<void> {
    for (const cid of watched) {
      try {
        const result = await fetchMarket(cid);
        const prev = cache.get(cid) ?? blankSnapshot(cid, null, null);
        cache.set(cid, {
          ...prev,
          question: result.market.question,
          closed: result.market.closed,
          acceptingOrders: result.market.accepting_orders,
          tokens: result.market.tokens.map((t) => ({
            tokenId: t.token_id,
            outcome: t.outcome,
            price: t.price ?? null,
            winner: t.winner,
          })),
          fetchedAt: Date.now(),
          stale: false,
          lastError: null,
        });
      } catch (err) {
        const prev = cache.get(cid);
        if (prev !== undefined) {
          cache.set(cid, {
            ...prev,
            stale: true,
            lastError: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  async function refreshMidpoints(): Promise<void> {
    for (const ts of tokenSides) {
      try {
        const result = await fetchMidpoint(ts.tokenId);
        const prev = cache.get(ts.conditionIdHex);
        if (prev === undefined) continue;
        const nextMid = ts.side === "YES"
          ? { yes: result.mid, no: prev.mid.no }
          : { yes: prev.mid.yes, no: result.mid };
        cache.set(ts.conditionIdHex, {
          ...prev,
          mid: nextMid,
          fetchedAt: Date.now(),
          stale: false,
        });
      } catch {
        // Silent — metadata refresh sets stale on its own cadence.
      }
    }
  }

  return {
    snapshotAll: () => Array.from(cache.values()),
    snapshotOne: (cid: Sha256Hex) => cache.get(cid) ?? null,
    start: () => {
      if (metadataTimer !== null || midpointTimer !== null) return;
      // Kick off both immediately so the first paint isn't all blanks.
      void refreshMetadata();
      void refreshMidpoints();
      metadataTimer = setInterval(() => {
        void refreshMetadata();
      }, METADATA_INTERVAL_MS);
      midpointTimer = setInterval(() => {
        void refreshMidpoints();
      }, MIDPOINT_INTERVAL_MS);
      metadataTimer.unref?.();
      midpointTimer.unref?.();
    },
    stop: () => {
      if (metadataTimer !== null) { clearInterval(metadataTimer); metadataTimer = null; }
      if (midpointTimer !== null) { clearInterval(midpointTimer); midpointTimer = null; }
    },
  };
}

/** Helper used by routes/markets.ts to look up the snapshot for a watched market. */
export function snapshotForMarket(
  cache: MarketsCache,
  market: WatchedMarket,
): MarketSnapshot | null {
  return cache.snapshotOne(market.conditionIdHex);
}
