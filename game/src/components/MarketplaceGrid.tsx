import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { AgentAvatar } from "./AgentAvatar";
import { kingdomForAgentId } from "../lib/kingdoms";
import {
  fetchAgents,
  fetchPoolState,
  formatSignedUsdc6,
  formatUsdc6,
  type V3AgentSummary,
  type V3PoolState,
} from "../lib/runtime";

type SortKey = "tvl" | "pnl" | "name" | "registered";
type SortDir = "asc" | "desc";

interface Row {
  readonly summary: V3AgentSummary;
  readonly pool: V3PoolState | null;
}

/**
 * Marketplace comparison grid. Each row is one VANTA: avatar +
 * kingdom + thesis + live stats + "Back" CTA pointing at
 * /world?agent=N (which auto-opens that agent's detail card).
 *
 * Sortable by TVL / PnL / name / age. Win-rate and depositor count
 * aren't in the runtime API yet — those columns show "—" until
 * Slice 6 adds aggregation.
 */
export function MarketplaceGrid(): JSX.Element {
  const [rows, setRows] = useState<readonly Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("tvl");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchAgents()
      .then(async (agents) => {
        const states = await Promise.all(
          agents.map((a) => fetchPoolState(a.agent_id)),
        );
        if (cancelled) return;
        setRows(agents.map((summary, i) => ({ summary, pool: states[i] ?? null })));
      })
      .catch((e: unknown) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : "fetch_failed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sorted = useMemo(() => {
    const arr = [...rows];
    arr.sort((a, b) => {
      let av: number | string = 0;
      let bv: number | string = 0;
      switch (sortKey) {
        case "tvl":
          av = Number(a.pool ? BigInt(a.pool.nav_usdc6) : 0n);
          bv = Number(b.pool ? BigInt(b.pool.nav_usdc6) : 0n);
          break;
        case "pnl":
          av = a.pool ? Number(BigInt(a.pool.realised_pnl_usdc6)) : 0;
          bv = b.pool ? Number(BigInt(b.pool.realised_pnl_usdc6)) : 0;
          break;
        case "name":
          av = a.summary.name;
          bv = b.summary.name;
          break;
        case "registered":
          av = a.summary.registered_at_unix;
          bv = b.summary.registered_at_unix;
          break;
      }
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return arr;
  }, [rows, sortKey, sortDir]);

  const onSort = (key: SortKey): void => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "name" ? "asc" : "desc");
    }
  };

  if (loading) {
    return (
      <div className="grid place-items-center py-24 font-mono text-xs uppercase tracking-[0.22em] text-chalk-500">
        loading agents…
      </div>
    );
  }

  if (err) {
    return (
      <div className="rounded-[2px] border border-signal-red/60 bg-signal-red/10 p-6 font-mono text-sm text-signal-red">
        runtime offline: {err}
      </div>
    );
  }

  if (sorted.length === 0) {
    return (
      <div className="rounded-[2px] border border-dashed border-ink-700 p-12 text-center font-mono text-sm text-chalk-500">
        no VANTAs registered yet
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em] text-chalk-500">
        <span className="mr-2">sort:</span>
        <SortChip label="tvl" active={sortKey === "tvl"} dir={sortDir} onClick={() => onSort("tvl")} />
        <SortChip label="pnl" active={sortKey === "pnl"} dir={sortDir} onClick={() => onSort("pnl")} />
        <SortChip label="name" active={sortKey === "name"} dir={sortDir} onClick={() => onSort("name")} />
        <SortChip
          label="age"
          active={sortKey === "registered"}
          dir={sortDir}
          onClick={() => onSort("registered")}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {sorted.map((row) => (
          <AgentCard key={row.summary.agent_id} row={row} />
        ))}
      </div>
    </div>
  );
}

interface AgentCardProps {
  readonly row: Row;
}

function AgentCard({ row }: AgentCardProps): JSX.Element {
  const kingdom = kingdomForAgentId(row.summary.agent_id);
  const color = kingdom?.color ?? row.summary.color_hex ?? "#9b6bff";
  const pnlPositive = row.pool && !row.pool.realised_pnl_usdc6.startsWith("-");

  return (
    <article
      className="group flex flex-col gap-4 rounded-[2px] border border-ink-700 bg-ink-900/85 p-5 transition-colors hover:border-ink-600"
      style={{
        boxShadow: `0 0 32px -16px ${color}66`,
      }}
    >
      <header className="flex items-start gap-3">
        {kingdom ? (
          <AgentAvatar kingdom={kingdom} size={56} />
        ) : (
          <div
            className="grid h-14 w-14 place-items-center rounded-full font-mono text-lg text-ink-950"
            style={{ background: color }}
          >
            #{row.summary.agent_id}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-chalk-500">
            agent #{String(row.summary.agent_id)}
            {kingdom ? ` · ${kingdom.compassDirection}` : ""}
          </div>
          <h3 className="font-display text-lg font-semibold text-chalk-50 truncate">
            {row.summary.name}
          </h3>
          <div className="text-xs text-chalk-400 truncate">
            {row.summary.thesis || kingdom?.thesis || "—"}
          </div>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-2 font-mono text-[11px]">
        <Stat
          label="TVL"
          value={row.pool ? formatUsdc6(row.pool.nav_usdc6) : "—"}
        />
        <Stat
          label="interest YTD"
          value={row.pool ? formatSignedUsdc6(row.pool.realised_pnl_usdc6) : "—"}
          tone={row.pool ? (pnlPositive ? "up" : "down") : "neutral"}
        />
        <Stat label="liquidation rate" value="—" tone="neutral" />
        <Stat label="avg loan size" value="—" tone="neutral" />
      </div>

      <Link
        to={`/world?agent=${String(row.summary.agent_id)}`}
        className="rounded-[2px] border border-black/40 px-4 py-2.5 text-center font-mono text-xs uppercase tracking-[0.22em] font-medium text-ink-950 transition-transform duration-150 active:translate-y-[2px]"
        style={{
          background: color,
          boxShadow: `0 0 24px -6px ${color}, inset 0 -3px 0 0 rgba(0,0,0,0.4), inset 0 2px 0 0 rgba(255,255,255,0.2)`,
        }}
      >
        ▶ back this VANTA
      </Link>
    </article>
  );
}

function Stat({
  label,
  value,
  tone = "neutral",
}: {
  readonly label: string;
  readonly value: string;
  readonly tone?: "up" | "down" | "neutral";
}): JSX.Element {
  const color =
    tone === "up" ? "text-signal-green" : tone === "down" ? "text-signal-red" : "text-chalk-100";
  return (
    <div className="rounded-[2px] border border-ink-700 bg-ink-800/60 p-2">
      <div className="text-[9px] uppercase tracking-[0.22em] text-chalk-500">{label}</div>
      <div className={`text-sm font-semibold ${color}`}>{value}</div>
    </div>
  );
}

function SortChip({
  label,
  active,
  dir,
  onClick,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly dir: SortDir;
  readonly onClick: () => void;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={[
        "rounded-[2px] border px-2 py-1 text-[10px] uppercase tracking-[0.22em] transition-colors",
        active
          ? "border-opus bg-opus/10 text-opus"
          : "border-ink-700 bg-ink-800 text-chalk-400 hover:text-chalk-100",
      ].join(" ")}
    >
      {label}
      {active ? <span className="ml-1">{dir === "asc" ? "↑" : "↓"}</span> : null}
    </button>
  );
}
