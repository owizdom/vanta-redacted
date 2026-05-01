/**
 * Markets routes — surface the Polymarket markets vanta is watching.
 *
 *   GET /api/markets/watched           → array of MarketSnapshot for all watched cids
 *   GET /api/markets/positions         → joined view of WatchedMarket fixture +
 *                                        cached market state for each held label
 *   GET /api/markets/positions/:label  → single label's full reveal (rail expanded card)
 *
 * Read-only. Data comes from the in-memory markets cache (refreshed every
 * 30–60s) plus the static watched-markets fixture.
 */

import type { FastifyInstance } from "fastify";

import {
  WATCHED_MARKETS,
  WATCHED_ONLY_MARKETS,
  polymarketUrl,
  type WatchedMarket,
} from "../../services/watched-markets.js";
import type { MarketsCache, MarketSnapshot } from "../../services/markets-cache.js";

export interface RegisterMarketsOpts {
  readonly marketsCache: MarketsCache;
}

export async function registerMarketsRoutes(
  app: FastifyInstance,
  opts: RegisterMarketsOpts,
): Promise<void> {
  app.get("/api/markets/watched", async () => {
    const snapshots = opts.marketsCache.snapshotAll();
    return { markets: snapshots.map(serializeMarket) };
  });

  app.get("/api/markets/positions", async () => {
    const positions = WATCHED_MARKETS.map((m) =>
      buildPositionView(m, opts.marketsCache.snapshotOne(m.conditionIdHex)),
    );
    return { positions };
  });

  app.get<{ Params: { label: string } }>("/api/markets/positions/:label", async (req, reply) => {
    const label = req.params.label;
    const market = WATCHED_MARKETS.find((m) => m.label === label);
    if (market === undefined) {
      reply.code(404);
      return { error: "label_not_found", label };
    }
    return buildPositionView(market, opts.marketsCache.snapshotOne(market.conditionIdHex));
  });

  app.log.info({
    msg: "markets routes registered",
    held: WATCHED_MARKETS.length,
    watchedOnly: WATCHED_ONLY_MARKETS.length,
  });
}

// -----------------------------------------------------------------------
// Serialization
// -----------------------------------------------------------------------

function serializeMarket(s: MarketSnapshot): Record<string, unknown> {
  let shortName: string | null = null;
  let ownerSide: "YES" | "NO" | null = null;
  for (const m of WATCHED_MARKETS) {
    if (m.conditionIdHex === s.conditionId) {
      shortName = m.shortName;
      ownerSide = m.side;
      break;
    }
  }
  if (shortName === null) {
    for (const w of WATCHED_ONLY_MARKETS) {
      if (w.conditionIdHex === s.conditionId) {
        shortName = w.shortName;
        break;
      }
    }
  }
  return {
    conditionId: s.conditionId,
    conditionIdWith0x: "0x" + s.conditionId,
    question: s.question,
    closed: s.closed,
    accepting_orders: s.acceptingOrders,
    tokens: s.tokens,
    mid: s.mid,
    fetched_at_unix_ms: s.fetchedAt,
    stale: s.stale,
    last_error: s.lastError,
    polymarket_url: s.polymarketSlug !== null ? polymarketUrl(s.polymarketSlug) : null,
    polymarket_slug: s.polymarketSlug,
    owner_label: s.ownerLabel,
    short_name: shortName,
    owner_side: ownerSide,
  };
}

function buildPositionView(
  market: WatchedMarket,
  snapshot: MarketSnapshot | null,
): Record<string, unknown> {
  const sideMid = snapshot
    ? (market.side === "YES" ? snapshot.mid.yes : snapshot.mid.no)
    : null;
  return {
    label: market.label,
    position: {
      conditionId: market.conditionId,
      conditionIdHex: market.conditionIdHex,
      tokenId: market.tokenId,
      side: market.side,
      sizeUsdc6: market.sizeUsdc6.toString(),
      sizeUsdcDisplay: formatUsdcDisplay(market.sizeUsdc6),
      polymarketSlug: market.polymarketSlug,
      shortName: market.shortName,
    },
    market: snapshot
      ? {
          question: snapshot.question,
          closed: snapshot.closed,
          accepting_orders: snapshot.acceptingOrders,
          stale: snapshot.stale,
          fetched_at_unix_ms: snapshot.fetchedAt,
        }
      : null,
    mid: sideMid,
    polymarketUrl: polymarketUrl(market.polymarketSlug),
  };
}

function formatUsdcDisplay(raw6: bigint): string {
  const whole = Number(raw6 / 1_000_000n);
  if (whole >= 10_000) return `$${(whole / 1000).toFixed(0)}k`;
  if (whole >= 1_000) return `$${(whole / 1000).toFixed(1)}k`;
  return `$${whole.toLocaleString("en-US")}`;
}
