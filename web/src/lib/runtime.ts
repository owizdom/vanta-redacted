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

export interface LoopFreshness {
  readonly age_s: number | null;
  readonly next_eta_s: number;
  readonly interval_s: number;
}

export interface AgentPosition {
  readonly label: string;
  readonly loan_id: string;
  readonly condition_id: string;
  readonly principal_usdc: string;
  readonly haircut_bps: number;
  readonly maturity_ts_unix: number;
}

export interface AgentMarketDecision {
  readonly cid: string;
  readonly haircut_bps: number;
  readonly ltv_max_bps: number;
  readonly decision: string;
  readonly reviewed_at_unix_ms: number;
}

export interface AgentLastDecision {
  readonly id: string;
  readonly type: string;
  readonly age_s: number;
  readonly body: Record<string, unknown>;
}

export interface AgentState {
  readonly now_unix_ms: number;
  readonly watching_n: number;
  readonly probation_n: number;
  readonly positions: readonly AgentPosition[];
  readonly earned_today_usdc: string;
  readonly runway_days: number;
  readonly last_decision: AgentLastDecision | null;
  readonly loops: {
    readonly credit: LoopFreshness;
    readonly model: LoopFreshness;
    readonly operational: LoopFreshness;
    readonly onboarding: LoopFreshness;
  };
  readonly market_decisions: readonly AgentMarketDecision[];
}

export async function fetchAgentState(): Promise<AgentState | null> {
  try {
    return await getJson<AgentState>("/state");
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

// ---------------------- v3 multi-VANTA marketplace ----------------------

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

/** Format USDC wei (6 decimals) into a human display ($1.23k). */
export function formatUsdc6(rawStr: string): string {
  const raw = BigInt(rawStr);
  const whole = Number(raw / 1_000_000n);
  if (whole === 0 && raw === 0n) return "$0";
  if (whole >= 1_000_000) return `$${(whole / 1_000_000).toFixed(2)}M`;
  if (whole >= 10_000) return `$${(whole / 1000).toFixed(0)}k`;
  if (whole >= 1_000) return `$${(whole / 1000).toFixed(1)}k`;
  return `$${whole.toLocaleString("en-US")}`;
}

/** Format signed USDC wei (allows leading `-`). */
export function formatSignedUsdc6(rawStr: string): string {
  const negative = rawStr.startsWith("-");
  const formatted = formatUsdc6(negative ? rawStr.slice(1) : rawStr);
  return negative ? `-${formatted}` : formatted;
}
