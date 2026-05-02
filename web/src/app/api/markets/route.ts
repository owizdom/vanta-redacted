/**
 * GET /api/markets — top-N Polymarket markets by 24h volume.
 *
 * Public Polymarket gamma-api proxy used by the /app discovery table
 * to populate the All / Politics / Sports / Crypto / Macro / Tech tabs.
 * The runtime's watched set (what the agent actively monitors) stays
 * separate and small; this corpus is for user-facing browse.
 *
 * Response shape mirrors `/api/runtime/markets/watched` so the
 * markets-table merge step is a Map-keyed dedupe by conditionId
 * (watched entries win when both sources have the same cid).
 *
 * ISR-cached for 60s — gamma is rate-limited at the edge and even at
 * 1 visitor we'd burn calls if we hit it on every render.
 */

const GAMMA_URL =
  "https://gamma-api.polymarket.com/markets" +
  "?active=true&closed=false&limit=120&order=volume24hr&ascending=false";

interface GammaMarket {
  readonly conditionId?: string;
  readonly question?: string;
  readonly slug?: string;
  readonly endDate?: string;
  readonly endDateIso?: string;
  readonly active?: boolean;
  readonly closed?: boolean;
  readonly acceptingOrders?: boolean;
  readonly volumeNum?: number;
  readonly volume24hr?: number;
  readonly liquidityNum?: number;
  readonly oneDayPriceChange?: number;
  readonly outcomePrices?: string;
  readonly tags?: ReadonlyArray<{
    readonly slug?: string;
    readonly label?: string;
  }>;
}

interface MarketRowOut {
  readonly conditionId: string;
  readonly question: string;
  readonly closed: boolean;
  readonly accepting_orders: boolean;
  readonly mid: { readonly yes: string | null; readonly no: string | null };
  readonly polymarket_url: string | null;
  readonly polymarket_slug: string | null;
  readonly short_name: string | null;
  readonly owner_label: string | null;
  readonly owner_side: "YES" | "NO" | null;
  readonly volume_usd: number | null;
  readonly volume_24h_usd: number | null;
  readonly liquidity_usd: number | null;
  readonly one_day_price_change: number | null;
  readonly end_date_iso: string | null;
  readonly tags: readonly string[];
}

function parseOutcomePrices(s: string | undefined): {
  yes: string | null;
  no: string | null;
} {
  if (typeof s !== "string" || s.length === 0) return { yes: null, no: null };
  try {
    const arr = JSON.parse(s) as unknown;
    if (!Array.isArray(arr)) return { yes: null, no: null };
    const yes = typeof arr[0] === "string" ? arr[0] : null;
    const no = typeof arr[1] === "string" ? arr[1] : null;
    return { yes, no };
  } catch {
    return { yes: null, no: null };
  }
}

function toMarketRow(m: GammaMarket): MarketRowOut | null {
  if (typeof m.conditionId !== "string" || typeof m.question !== "string") {
    return null;
  }
  const cid = m.conditionId.replace(/^0x/, "").toLowerCase();
  if (cid.length !== 64) return null;

  const mid = parseOutcomePrices(m.outcomePrices);
  const slug = typeof m.slug === "string" ? m.slug : null;

  return {
    conditionId: cid,
    question: m.question,
    closed: m.closed === true,
    accepting_orders: m.acceptingOrders === true,
    mid,
    polymarket_url: slug !== null ? `https://polymarket.com/event/${slug}` : null,
    polymarket_slug: slug,
    short_name: null,
    owner_label: null,
    owner_side: null,
    volume_usd: typeof m.volumeNum === "number" ? m.volumeNum : null,
    volume_24h_usd: typeof m.volume24hr === "number" ? m.volume24hr : null,
    liquidity_usd: typeof m.liquidityNum === "number" ? m.liquidityNum : null,
    one_day_price_change:
      typeof m.oneDayPriceChange === "number" ? m.oneDayPriceChange : null,
    end_date_iso: m.endDateIso ?? m.endDate ?? null,
    tags: (m.tags ?? [])
      .map((t) => t.slug ?? t.label ?? "")
      .filter((s): s is string => s.length > 0),
  };
}

export async function GET(): Promise<Response> {
  try {
    const r = await fetch(GAMMA_URL, {
      next: { revalidate: 60 },
      // Gamma sometimes returns an HTML error page on 5xx; force JSON
      // by accepting only that.
      headers: { accept: "application/json" },
    });
    if (!r.ok) {
      return Response.json(
        { markets: [], fetched_at: Date.now(), error: `gamma_${String(r.status)}` },
        { status: 200 },
      );
    }
    const arr = (await r.json()) as ReadonlyArray<GammaMarket>;
    const markets: MarketRowOut[] = [];
    for (const m of arr) {
      const row = toMarketRow(m);
      if (row !== null) markets.push(row);
    }
    return Response.json({ markets, fetched_at: Date.now() });
  } catch (err) {
    return Response.json(
      {
        markets: [],
        fetched_at: Date.now(),
        error: err instanceof Error ? err.message : "fetch_failed",
      },
      { status: 200 },
    );
  }
}
