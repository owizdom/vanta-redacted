/**
 * Markets — fetched live from the runtime's `/api/markets/watched`
 * endpoint (via the Vercel rewrite). The runtime watches a curated
 * set of real Polymarket conditions and refreshes mids every 30-60s.
 *
 * The frontend used to ship a 12-market hardcoded fixture (some real,
 * some invented). That fixture is gone — `useRealMarkets()` is the
 * single source of truth, and the dropdown reflects whatever the
 * runtime is actually watching right now.
 *
 * Kingdom assignment is heuristic on the question text (politics →
 * gemini, sports → gpt, macro/crypto → opus). Under the hood there is
 * one shared pool and one shared TEE signer; the kingdom split is
 * narrative, not architectural.
 */

import { useEffect, useState } from "react";

import { fetchWatchedMarkets, type MarketWatched } from "./runtime";

export type DemoKingdom = "opus" | "gpt" | "gemini";

export interface DemoMarket {
  readonly conditionIdHex: string;
  readonly tokenId: string;
  readonly side: "YES" | "NO";
  readonly question: string;
  readonly shortName: string;
  readonly currentMid: number;
  readonly timeToResolutionSeconds: number;
  readonly kingdom: DemoKingdom;
  readonly polymarketUrl: string | null;
  readonly stale: boolean;
}

export function kingdomKeyForAgentId(agentId: number): DemoKingdom | null {
  if (agentId === 0) return "opus";
  if (agentId === 1) return "gpt";
  if (agentId === 2) return "gemini";
  return null;
}

function kingdomFromQuestion(q: string): DemoKingdom {
  const s = q.toLowerCase();
  if (/(world cup|fifa|championship|nba|nfl|f1\b|super bowl|premier league|la liga|euro)/.test(s)) {
    return "gpt";
  }
  if (/(election|nomination|senate|congress|president|primary|governor|impeach|cabinet)/.test(s)) {
    return "gemini";
  }
  return "opus";
}

function pickSide(m: MarketWatched): "YES" | "NO" {
  if (m.owner_side === "YES" || m.owner_side === "NO") return m.owner_side;
  const yesMid = m.mid.yes !== null ? parseFloat(m.mid.yes) : null;
  const noMid = m.mid.no !== null ? parseFloat(m.mid.no) : null;
  if (yesMid !== null && noMid !== null) return yesMid >= noMid ? "YES" : "NO";
  if (yesMid !== null) return "YES";
  if (noMid !== null) return "NO";
  return "YES";
}

function pickMid(m: MarketWatched, side: "YES" | "NO"): number {
  const raw = side === "YES" ? m.mid.yes : m.mid.no;
  if (raw !== null) {
    const n = parseFloat(raw);
    if (Number.isFinite(n)) return n;
  }
  const tok = m.tokens.find((t) => t.outcome.toUpperCase() === side);
  if (tok !== undefined) {
    const n = parseFloat(tok.price);
    if (Number.isFinite(n)) return n;
  }
  return 0.5;
}

function pickTokenId(m: MarketWatched, side: "YES" | "NO"): string {
  const tok = m.tokens.find((t) => t.outcome.toUpperCase() === side);
  return tok?.tokenId ?? m.tokens[0]?.tokenId ?? "";
}

function timeToResolutionSeconds(m: MarketWatched): number {
  const iso = m.end_date_iso;
  if (typeof iso === "string" && iso.length > 0) {
    const t = Date.parse(iso);
    if (Number.isFinite(t)) {
      const delta = Math.floor((t - Date.now()) / 1000);
      if (delta > 0) return delta;
    }
  }
  return 90 * 86_400;
}

export function mapWatchedToDemoMarket(m: MarketWatched): DemoMarket | null {
  const cidHex = m.conditionId;
  if (typeof cidHex !== "string" || cidHex.length === 0) return null;
  if (m.tokens.length === 0) return null;
  const side = pickSide(m);
  const tokenId = pickTokenId(m, side);
  if (tokenId.length === 0) return null;
  const question = m.question ?? m.short_name ?? "untitled market";
  const shortName = m.short_name ?? question.slice(0, 32);
  return {
    conditionIdHex: cidHex,
    tokenId,
    side,
    question,
    shortName,
    currentMid: pickMid(m, side),
    timeToResolutionSeconds: timeToResolutionSeconds(m),
    kingdom: kingdomFromQuestion(question),
    polymarketUrl: m.polymarket_url,
    stale: m.stale,
  };
}

export interface UseRealMarketsResult {
  readonly markets: readonly DemoMarket[];
  readonly loading: boolean;
  readonly error: string | null;
}

export function useRealMarkets(): UseRealMarketsResult {
  const [markets, setMarkets] = useState<readonly DemoMarket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = async (): Promise<void> => {
      try {
        const watched = await fetchWatchedMarkets();
        if (!live) return;
        const mapped: DemoMarket[] = [];
        for (const w of watched) {
          const dm = mapWatchedToDemoMarket(w);
          if (dm !== null && !w.closed) mapped.push(dm);
        }
        setMarkets(mapped);
        setError(null);
      } catch (e) {
        if (!live) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (live) setLoading(false);
      }
    };
    void load();
    const id = setInterval(() => void load(), 60_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);

  return { markets, loading, error };
}

/**
 * Filter the live market list to the agent's kingdom theme. Returns
 * the full list as a fallback if the kingdom theme has no matches —
 * ensures the borrow modal is never empty when real markets exist.
 */
export function marketsForAgentFromList(
  agentId: number,
  all: readonly DemoMarket[],
): readonly DemoMarket[] {
  const k = kingdomKeyForAgentId(agentId);
  if (k === null) return all;
  const themed = all.filter((m) => m.kingdom === k);
  return themed.length > 0 ? themed : all;
}
