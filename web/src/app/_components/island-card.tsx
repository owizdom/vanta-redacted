/**
 * Single agent tile on the marketplace grid.
 *
 * Pure presentational. The page composes a list of these from the
 * runtime's `/api/agents` + per-agent `/api/pool/:id/state`. Color
 * swatch is the agent's `color_hex` from the registry; AUM and PnL
 * pull from the pool reader; thesis is truncated to one line.
 */

import Link from "next/link";

import {
  formatSignedUsdc6,
  formatUsdc6,
  type V3AgentSummary,
  type V3PoolState,
} from "@/lib/runtime";

export interface IslandCardProps {
  readonly agent: V3AgentSummary;
  readonly pool: V3PoolState | null;
}

export function IslandCard({ agent, pool }: IslandCardProps): JSX.Element {
  const aum = pool ? formatUsdc6(pool.nav_usdc6) : "—";
  const cap = pool ? formatUsdc6(pool.max_aum_usdc6) : "—";
  const pnl = pool ? formatSignedUsdc6(pool.realised_pnl_usdc6) : "—";
  const pnlPositive = pool && !pool.realised_pnl_usdc6.startsWith("-") && pool.realised_pnl_usdc6 !== "0";
  const pnlNegative = pool && pool.realised_pnl_usdc6.startsWith("-");

  return (
    <Link
      href={`/agent/${String(agent.agent_id)}`}
      className="group relative flex flex-col gap-4 rounded-2xl border border-ink-800 bg-ink-900/60 p-6 transition hover:border-ink-700"
    >
      <div className="flex items-start gap-4">
        <div
          className="h-12 w-12 shrink-0 rounded-xl ring-1 ring-inset ring-ink-700"
          style={{ backgroundColor: agent.color_hex }}
          aria-hidden
        />
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="font-display text-xl font-semibold text-chalk-50">{agent.name}</span>
            {agent.paused ? (
              <span className="rounded-full bg-amber-900/60 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.2em] text-amber-200">
                paused
              </span>
            ) : null}
          </div>
          <p className="mt-1 line-clamp-2 text-sm text-chalk-300">{agent.thesis}</p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3 border-t border-ink-800 pt-4 text-sm">
        <Stat label="AUM" value={aum} sub={`/ ${cap} cap`} />
        <Stat
          label="Realised PnL"
          value={pnl}
          tone={pnlPositive ? "pos" : pnlNegative ? "neg" : "neutral"}
        />
        <Stat
          label="Share price"
          value={pool ? sharePriceToDecimal(pool.share_price_e18) : "—"}
          sub="USDC/share"
        />
      </div>

      <div className="flex items-center justify-between border-t border-ink-800 pt-4 text-xs">
        <span className="font-mono text-chalk-400">id #{String(agent.agent_id)}</span>
        <span className="font-mono text-chalk-500 group-hover:text-chalk-300">
          back this agent →
        </span>
      </div>
    </Link>
  );
}

interface StatProps {
  readonly label: string;
  readonly value: string;
  readonly sub?: string;
  readonly tone?: "pos" | "neg" | "neutral";
}

function Stat({ label, value, sub, tone }: StatProps): JSX.Element {
  const valueClass =
    tone === "pos"
      ? "text-emerald-300"
      : tone === "neg"
        ? "text-rose-300"
        : "text-chalk-100";
  return (
    <div>
      <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-chalk-500">
        {label}
      </div>
      <div className={`mt-1 font-display text-base ${valueClass}`}>{value}</div>
      {sub ? (
        <div className="mt-0.5 font-mono text-[10px] text-chalk-500">{sub}</div>
      ) : null}
    </div>
  );
}

function sharePriceToDecimal(e18Str: string): string {
  // e18 → up to 4-decimal display. 1e18 = 1.0000.
  const e18 = BigInt(e18Str);
  const whole = e18 / 1_000_000_000_000_000_000n;
  const frac = e18 % 1_000_000_000_000_000_000n;
  const fracStr = frac.toString().padStart(18, "0").slice(0, 4);
  return `${whole.toString()}.${fracStr}`;
}
