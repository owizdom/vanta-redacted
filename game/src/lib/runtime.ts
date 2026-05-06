/**
 * Runtime API client. All paths go through the vite proxy at
 *   /api/runtime/*  →  http://127.0.0.1:8787/api/*
 *
 * Keeping this framework-agnostic — same shape as /web/src/lib/runtime.ts
 * so we can reuse types and call sites between the two surfaces.
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

const ROOT = "/api/runtime";

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`${ROOT}${path}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`${path} → ${String(r.status)}`);
  return (await r.json()) as T;
}

export async function fetchEvents(): Promise<readonly VantaEventSummary[]> {
  const r = await getJson<{ events?: VantaEventSummary[] }>("/events");
  return r.events ?? [];
}

export async function fetchEvent(id: string): Promise<VantaEventSummary | null> {
  try {
    return await getJson<VantaEventSummary>(`/events/${encodeURIComponent(id)}`);
  } catch {
    return null;
  }
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

// ---------------------- v3 multi-VANTA ----------------------

export interface V3AgentSummary {
  readonly agent_id: number;
  readonly name: string;
  readonly thesis: string;
  readonly color_rgb: number;
  readonly color_hex: string;
  readonly pool: string;
  readonly position_book: string;
  readonly op_cap: string;
  readonly operator: string;
  readonly registered_at_unix: number;
  readonly paused: boolean;
}

export interface V3AgentRecord extends V3AgentSummary {
  readonly image_digest: string;
  readonly attestation_hash: string;
  readonly island_offset: { readonly x: number; readonly z: number };
}

export interface V3PoolState {
  readonly agent_id: number;
  readonly pool: string;
  readonly position_book: string;
  readonly nav_usdc6: string;
  readonly total_supply: string;
  readonly share_price_e18: string;
  readonly max_aum_usdc6: string;
  readonly free_usdc6: string;
  readonly open_notional_usdc6: string;
  readonly lifetime_cost_basis_usdc6: string;
  readonly lifetime_proceeds_usdc6: string;
  readonly realised_pnl_usdc6: string;
}

export async function fetchAgents(): Promise<readonly V3AgentSummary[]> {
  const r = await getJson<{ agents?: V3AgentSummary[] }>("/agents");
  return r.agents ?? [];
}

export async function fetchAgent(agentId: number): Promise<V3AgentRecord | null> {
  try {
    return await getJson<V3AgentRecord>(`/agents/${String(agentId)}`);
  } catch {
    return null;
  }
}

export async function fetchPoolState(agentId: number): Promise<V3PoolState | null> {
  try {
    return await getJson<V3PoolState>(`/pool/${String(agentId)}/state`);
  } catch {
    return null;
  }
}

/** Format USDC wei (6 decimals) → "$1.23k". */
export function formatUsdc6(rawStr: string): string {
  const raw = BigInt(rawStr);
  const whole = Number(raw / 1_000_000n);
  if (whole === 0 && raw === 0n) return "$0";
  if (whole >= 1_000_000) return `$${(whole / 1_000_000).toFixed(2)}M`;
  if (whole >= 10_000) return `$${(whole / 1000).toFixed(0)}k`;
  if (whole >= 1_000) return `$${(whole / 1000).toFixed(1)}k`;
  return `$${whole.toLocaleString("en-US")}`;
}

export function formatSignedUsdc6(rawStr: string): string {
  const negative = rawStr.startsWith("-");
  const formatted = formatUsdc6(negative ? rawStr.slice(1) : rawStr);
  return negative ? `-${formatted}` : formatted;
}

/** Truncate "0xabc...def" hashes for compact display. */
export function shortHash(h: string, head = 6, tail = 4): string {
  if (h.length <= head + tail + 2) return h;
  return `${h.slice(0, head)}…${h.slice(-tail)}`;
}

/** "5m ago", "2h ago" — for chat timestamps. */
export function relativeTime(unixMs: number): string {
  const diff = Date.now() - unixMs;
  if (diff < 1000) return "now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${String(s)}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${String(m)}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${String(h)}h ago`;
  return new Date(unixMs).toLocaleDateString();
}
