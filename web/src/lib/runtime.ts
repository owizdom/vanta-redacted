/**
 * Tiny client around the runtime's HTTP surface. All paths go through
 * the Next rewrite at /api/runtime/* → http://127.0.0.1:8787/api/*.
 *
 * Methods are read-only. The agent never changes state from the web —
 * mutation lives in the signed-event pipeline + on-chain contracts.
 */

export interface VantaEventSummary {
  readonly id: string;
  readonly type: string;
  readonly timestamp: number;
  readonly parent_ids: readonly string[];
  readonly body: Record<string, unknown>;
}

export interface MarketWatched {
  readonly conditionId: string;
  readonly question: string | null;
  readonly closed: boolean;
  readonly accepting_orders: boolean;
  readonly mid: { readonly yes: string | null; readonly no: string | null };
  readonly polymarket_url: string | null;
  readonly short_name: string | null;
  readonly stale: boolean;
  readonly fetched_at_unix_ms: number;
}

export interface TeeIdentity {
  readonly signingPubKey: string;
  readonly bootedAt: number;
  readonly origination?: { readonly address: string };
  readonly identityAnchor?: { readonly kind: string };
}

const ROOT = typeof window === "undefined" ? "http://127.0.0.1:8787/api" : "/api/runtime";

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`${ROOT}${path}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`${path} → ${String(r.status)}`);
  return (await r.json()) as T;
}

export async function fetchEvents(): Promise<readonly VantaEventSummary[]> {
  const r = await getJson<{ events?: VantaEventSummary[] }>("/events");
  return r.events ?? [];
}

export async function fetchWatchedMarkets(): Promise<readonly MarketWatched[]> {
  const r = await getJson<{ markets?: MarketWatched[] }>("/markets/watched");
  return r.markets ?? [];
}

export async function fetchTee(): Promise<TeeIdentity | null> {
  try {
    return await getJson<TeeIdentity>("/tee");
  } catch {
    return null;
  }
}

export async function fetchHealth(): Promise<{ ok: boolean }> {
  try {
    const r = await fetch(`${ROOT.replace(/\/api(\/runtime)?$/, "")}/healthz`, {
      cache: "no-store",
    });
    return { ok: r.ok };
  } catch {
    return { ok: false };
  }
}
