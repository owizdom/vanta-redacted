"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { MarketAvatar } from "./avatar";

interface MarketRow {
  readonly conditionId: string;
  readonly question: string;
  readonly leverage: string;
  readonly midCents: number;
  readonly volume24h: number;
  readonly tvl: number;
  readonly delta24h: number;
  readonly autoCloseLabel: string;
  readonly autoCloseTs: number;
}

const SAMPLE: readonly MarketRow[] = [
  {
    conditionId: "1d519b87999e3d4e90e1e8f57b5eee73a0ba488ff3fdb70867f294733aba84a9",
    question: "Will Andy Beshear win the 2028 Democratic nomination?",
    leverage: "50% LTV",
    midCents: 11,
    volume24h: 12_000,
    tvl: 34_000,
    delta24h: -4.0,
    autoCloseLabel: "Jan 6, 2029",
    autoCloseTs: Date.UTC(2029, 0, 6),
  },
  {
    conditionId: "cdb1f0400949238a63d3e88243d2ada08cd9c2a71985ced9f0cfd5e66354cf90",
    question: "Will the USA win the 2026 FIFA World Cup?",
    leverage: "50% LTV",
    midCents: 13,
    volume24h: 17_000,
    tvl: 36_000,
    delta24h: 1.2,
    autoCloseLabel: "Jul 19, 2026",
    autoCloseTs: Date.UTC(2026, 6, 19),
  },
  {
    conditionId: "4c325469d9b516ef4e6b8f73a81a12607dec075e3c2fd454f91765aaeafc4760",
    question: "Will Pete Buttigieg win the 2028 Democratic nomination?",
    leverage: "50% LTV",
    midCents: 15,
    volume24h: 21_000,
    tvl: 34_000,
    delta24h: -2.5,
    autoCloseLabel: "Jan 6, 2029",
    autoCloseTs: Date.UTC(2029, 0, 6),
  },
  {
    conditionId: "0c4cd2055d6ea89354ffddc55d6dbcef9355748112ea952fc925f3db6a5c457f",
    question: "Will Argentina win the 2026 FIFA World Cup?",
    leverage: "50% LTV",
    midCents: 22,
    volume24h: 8_000,
    tvl: 18_000,
    delta24h: 3.4,
    autoCloseLabel: "Jul 19, 2026",
    autoCloseTs: Date.UTC(2026, 6, 19),
  },
  {
    conditionId: "30d55d8124ee1e12dabe89201badc45669b81dff69e4ce44d961f32878ec178a",
    question: "Will Brazil win the 2026 FIFA World Cup?",
    leverage: "50% LTV",
    midCents: 27,
    volume24h: 11_000,
    tvl: 22_000,
    delta24h: -1.1,
    autoCloseLabel: "Jul 19, 2026",
    autoCloseTs: Date.UTC(2026, 6, 19),
  },
];

interface FilterCtx {
  readonly favs: ReadonlySet<string>;
  readonly watched: ReadonlySet<string>;
}

const TABS = [
  { key: "favorites", label: "Favorites", icon: "bookmark", filter: (m: MarketRow, ctx: FilterCtx) => ctx.favs.has(m.conditionId) },
  { key: "live", label: "Live", icon: null, filter: (m: MarketRow, ctx: FilterCtx) => ctx.watched.has(m.conditionId) },
  { key: "all", label: "All", icon: null, filter: (_m: MarketRow, _ctx: FilterCtx) => true },
  { key: "politics", label: "Politics", icon: null, filter: (m: MarketRow, _ctx: FilterCtx) => /nomination|election|president|senate|congress|democrat|republican/i.test(m.question) },
  { key: "sports", label: "Sports", icon: null, filter: (m: MarketRow, _ctx: FilterCtx) => /world cup|fifa|nba|nfl|mlb|champion|premier league|stanley cup|super bowl/i.test(m.question) },
  { key: "crypto", label: "Crypto", icon: null, filter: (m: MarketRow, _ctx: FilterCtx) => /bitcoin|btc|eth\b|ethereum|solana|sol\b|xrp|crypto|stablecoin|memecoin|altcoin/i.test(m.question) },
  { key: "macro", label: "Macro", icon: null, filter: (m: MarketRow, _ctx: FilterCtx) => /fed |rate|fomc|cpi|inflation|gdp|recession|tariff|interest rate/i.test(m.question) },
  { key: "tech", label: "Tech", icon: null, filter: (m: MarketRow, _ctx: FilterCtx) => /\bai\b|llm|openai|anthropic|gemini|nvidia|x\.com|tesla|spacex|apple|google/i.test(m.question) },
] as const;

type TabKey = (typeof TABS)[number]["key"];
type SortKey = "mid" | "volume" | "tvl" | "delta" | "autoClose";

interface AgentDecision {
  readonly cid: string;
  readonly haircut_bps: number;
  readonly ltv_max_bps: number;
  readonly decision: string;
  readonly reviewed_at_unix_ms: number;
}

interface RawMarket {
  conditionId: string;
  question: string | null;
  mid?: { yes: string | null; no: string | null };
  volume_24h_usd?: number | null;
  volume_usd?: number | null;
  liquidity_usd?: number | null;
  one_day_price_change?: number | null;
  end_date_iso?: string | null;
}

function rawToRow(m: RawMarket): MarketRow | null {
  if (m.question === null) return null;
  const midYes =
    m.mid?.yes !== null && m.mid?.yes !== undefined && m.mid.yes !== ""
      ? Number(m.mid.yes)
      : 0;
  // Polymarket reports oneDayPriceChange in dollars (e.g. 0.012).
  // Convert to a price-relative percentage so 1.2¢ change at 12¢ mid
  // shows as +10%.
  const dpct =
    m.one_day_price_change != null && midYes > 0
      ? (m.one_day_price_change / midYes) * 100
      : 0;
  const closeTs =
    m.end_date_iso != null && m.end_date_iso !== ""
      ? Date.parse(m.end_date_iso)
      : 0;
  return {
    conditionId: m.conditionId,
    question: m.question,
    leverage: "50% LTV",
    midCents: Math.round(midYes * 100),
    volume24h: m.volume_24h_usd ?? 0,
    tvl: m.liquidity_usd ?? 0,
    delta24h: dpct,
    autoCloseLabel:
      closeTs > 0
        ? new Date(closeTs).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          })
        : "—",
    autoCloseTs: closeTs,
  };
}

export function MarketsTable(): JSX.Element {
  const [tab, setTab] = useState<TabKey>("all");
  const [rows, setRows] = useState<readonly MarketRow[]>(SAMPLE);
  const [search, setSearch] = useState("");
  const [favs, setFavs] = useState<ReadonlySet<string>>(new Set());
  const [view, setView] = useState<"list" | "grid">("list");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "volume",
    dir: "desc",
  });
  const [watchedCids, setWatchedCids] = useState<ReadonlySet<string>>(new Set());
  const [agentDecisions, setAgentDecisions] = useState<
    ReadonlyMap<string, AgentDecision>
  >(new Map());

  // Single pull function: fetches the corpus (top-N from gamma via the
  // Next route handler), the agent's watched set, and the agent's
  // per-market decisions in parallel. Then merges:
  //   - corpus is the broad-discovery base; cids dedupe
  //   - watched entries win on dedupe (preserve any future watched-only
  //     decoration like short_name / owner_label)
  //   - agentDecisions is a separate map keyed by cid, looked up at
  //     render time so we don't refetch the merged list when a tick lands
  useEffect(() => {
    let cancelled = false;
    async function pull(): Promise<void> {
      try {
        const [corpusR, watchedR, stateR] = await Promise.all([
          fetch("/api/markets", { cache: "no-store" }),
          fetch("/api/runtime/markets/watched", { cache: "no-store" }),
          fetch("/api/runtime/state", { cache: "no-store" }),
        ]);

        const corpus = corpusR.ok
          ? ((await corpusR.json()) as { markets?: RawMarket[] }).markets ?? []
          : [];
        const watched = watchedR.ok
          ? ((await watchedR.json()) as { markets?: RawMarket[] }).markets ?? []
          : [];
        const state = stateR.ok
          ? ((await stateR.json()) as {
              market_decisions?: AgentDecision[];
            })
          : { market_decisions: [] };

        if (cancelled) return;

        // Merge: corpus first, then watched overrides by cid.
        const byCid = new Map<string, MarketRow>();
        for (const m of corpus) {
          const r = rawToRow(m);
          if (r !== null) byCid.set(r.conditionId, r);
        }
        for (const m of watched) {
          const r = rawToRow(m);
          if (r !== null) byCid.set(r.conditionId, r);
        }

        const merged = Array.from(byCid.values());
        if (merged.length > 0) setRows(merged);

        const wSet = new Set<string>();
        for (const m of watched) {
          if (m.question !== null) wSet.add(m.conditionId);
        }
        setWatchedCids(wSet);

        const aMap = new Map<string, AgentDecision>();
        for (const d of state.market_decisions ?? []) {
          aMap.set(d.cid, d);
        }
        setAgentDecisions(aMap);
      } catch {
        /* keep sample */
      }
    }
    void pull();
    const t = setInterval(() => void pull(), 8000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  function toggleFav(id: string): void {
    setFavs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const filtered = useMemo(() => {
    const tabDef = TABS.find((t) => t.key === tab) ?? TABS[2];
    const ctx: FilterCtx = { favs, watched: watchedCids };
    let out = rows.filter((r) => tabDef.filter(r, ctx));
    if (search.trim().length > 0) {
      const q = search.toLowerCase();
      out = out.filter((r) => r.question.toLowerCase().includes(q));
    }
    out = [...out].sort((a, b) => {
      const dir = sort.dir === "asc" ? 1 : -1;
      switch (sort.key) {
        case "mid":
          return (a.midCents - b.midCents) * dir;
        case "volume":
          return (a.volume24h - b.volume24h) * dir;
        case "tvl":
          return (a.tvl - b.tvl) * dir;
        case "delta":
          return (a.delta24h - b.delta24h) * dir;
        case "autoClose":
          return (a.autoCloseTs - b.autoCloseTs) * dir;
        default:
          return 0;
      }
    });
    return out;
  }, [rows, tab, search, sort, favs, watchedCids]);

  const liveCount = watchedCids.size;

  return (
    <section className="mt-12">
      {/* Header row: title + search */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
            All markets
          </h2>
          <p className="mt-1 text-sm text-chalk-400">
            Polymarket positions VANTA accepts as collateral · max LTV 50%
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 rounded-md border border-ink-800 bg-ink-900 px-3 py-1.5">
            <SearchIcon />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search markets"
              className="w-44 bg-transparent text-sm text-chalk-50 placeholder:text-chalk-400 focus:outline-none"
            />
          </div>
          <button
            type="button"
            className="grid h-9 w-9 place-items-center rounded-md border border-ink-800 bg-ink-900 text-chalk-400 hover:border-ink-700 hover:text-chalk-200"
            aria-label="Filter"
          >
            <FilterIcon />
          </button>
        </div>
      </div>

      {/* Tabs row + view toggle */}
      <div className="mt-4 flex items-center justify-between border-b border-ink-800">
        <div className="flex flex-wrap gap-1">
          {TABS.map((t) => {
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={`relative inline-flex items-center gap-1.5 px-3 py-2.5 text-sm transition ${
                  active ? "text-chalk-50" : "text-chalk-400 hover:text-chalk-200"
                }`}
              >
                {t.icon === "bookmark" && <BookmarkIcon filled={false} />}
                <span>{t.label}</span>
                {t.key === "live" && (
                  <span className="rounded bg-violet-500/20 px-1.5 py-0.5 font-mono text-[10px] font-medium text-violet-300">
                    {liveCount}
                  </span>
                )}
                {active && (
                  <span className="absolute bottom-[-1px] left-2 right-2 h-0.5 rounded-full bg-violet-500" />
                )}
              </button>
            );
          })}
        </div>
        <div className="flex shrink-0 gap-1 pb-1">
          <button
            type="button"
            aria-label="List view"
            onClick={() => setView("list")}
            className={`grid h-7 w-7 place-items-center rounded ${
              view === "list" ? "bg-ink-800 text-chalk-50" : "text-chalk-400 hover:text-chalk-200"
            }`}
          >
            <ListIcon />
          </button>
          <button
            type="button"
            aria-label="Grid view"
            onClick={() => setView("grid")}
            className={`grid h-7 w-7 place-items-center rounded ${
              view === "grid" ? "bg-ink-800 text-chalk-50" : "text-chalk-400 hover:text-chalk-200"
            }`}
          >
            <GridIcon />
          </button>
        </div>
      </div>

      {view === "list" ? (
        <ListView
          rows={filtered}
          favs={favs}
          onToggleFav={toggleFav}
          decisions={agentDecisions}
          sort={sort}
          onSort={(key) =>
            setSort((prev) =>
              prev.key === key
                ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
                : { key, dir: "desc" },
            )
          }
        />
      ) : (
        <GridView
          rows={filtered}
          favs={favs}
          onToggleFav={toggleFav}
          decisions={agentDecisions}
        />
      )}
    </section>
  );
}

// ---------- Views ---------------------------------------------------------

function ListView({
  rows,
  favs,
  onToggleFav,
  decisions,
  sort,
  onSort,
}: {
  readonly rows: readonly MarketRow[];
  readonly favs: ReadonlySet<string>;
  readonly onToggleFav: (id: string) => void;
  readonly decisions: ReadonlyMap<string, AgentDecision>;
  readonly sort: { key: SortKey; dir: "asc" | "desc" };
  readonly onSort: (k: SortKey) => void;
}): JSX.Element {
  const router = useRouter();
  return (
    <div className="overflow-x-auto rounded-b-2xl border-x border-b border-ink-800">
      <table className="w-full min-w-[920px] text-sm">
        <thead className="text-left">
          <tr className="border-b border-ink-800 bg-ink-900/40 text-[11px] uppercase tracking-[0.16em] text-chalk-400">
            <th className="w-10 px-3 py-3" />
            <th className="px-4 py-3 font-mono font-normal">Market</th>
            <th className="px-4 py-3 font-mono font-normal">
              <SortHeader label="Mid" k="mid" sort={sort} onSort={onSort} />
            </th>
            <th className="hidden px-4 py-3 font-mono font-normal lg:table-cell">
              <SortHeader label="Volume" k="volume" sort={sort} onSort={onSort} />
            </th>
            <th className="hidden px-4 py-3 font-mono font-normal lg:table-cell">
              <SortHeader label="TVL" k="tvl" sort={sort} onSort={onSort} />
            </th>
            <th className="hidden px-4 py-3 font-mono font-normal md:table-cell">
              <SortHeader label="24hr ch%" k="delta" sort={sort} onSort={onSort} />
            </th>
            <th className="hidden px-4 py-3 font-mono font-normal lg:table-cell">
              <SortHeader label="Resolves" k="autoClose" sort={sort} onSort={onSort} />
            </th>
            <th className="px-4 py-3 text-right font-mono font-normal">Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={8} className="px-5 py-12 text-center text-sm text-chalk-400">
                no markets match
              </td>
            </tr>
          )}
          {rows.map((m) => {
            const isUp = m.delta24h > 0;
            const isFav = favs.has(m.conditionId);
            const dec = decisions.get(m.conditionId);
            return (
              <tr
                key={m.conditionId}
                onClick={() => router.push(`/app/trade/${m.conditionId}`)}
                className="cursor-pointer border-b border-ink-800 last:border-b-0 hover:bg-ink-900/40"
              >
                <td className="w-10 px-3 py-4">
                  <button
                    type="button"
                    aria-label={isFav ? "Unfavorite" : "Favorite"}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleFav(m.conditionId);
                    }}
                    className={`grid h-7 w-7 place-items-center rounded transition ${
                      isFav ? "text-accent-lime" : "text-chalk-400 hover:text-chalk-200"
                    }`}
                  >
                    <BookmarkIcon filled={isFav} />
                  </button>
                </td>
                <td className="min-w-0 px-4 py-4">
                  <div className="flex items-center gap-3">
                    <MarketAvatar question={m.question} size={36} />
                    <div className="min-w-0">
                      <p className="truncate font-medium text-chalk-50">{m.question}</p>
                      <div className="mt-0.5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-chalk-400">
                        <span>
                          0x{m.conditionId.slice(0, 6)}…{m.conditionId.slice(-4)}
                        </span>
                        <AgentBadge decision={dec} />
                      </div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-4">
                  <div className="flex items-center gap-2">
                    <Sparkline up={isUp} />
                    <span className="font-display text-lg font-semibold">{m.midCents}¢</span>
                  </div>
                </td>
                <td className="hidden px-4 py-4 font-mono text-chalk-200 lg:table-cell">
                  ${formatK(m.volume24h)}
                </td>
                <td className="hidden px-4 py-4 font-mono text-chalk-200 lg:table-cell">
                  ${formatK(m.tvl)}
                </td>
                <td
                  className={`hidden px-4 py-4 font-mono md:table-cell ${
                    m.delta24h === 0
                      ? "text-chalk-400"
                      : isUp
                        ? "text-signal-green"
                        : "text-signal-red"
                  }`}
                >
                  {m.delta24h === 0
                    ? "—"
                    : `${isUp ? "+" : ""}${m.delta24h.toFixed(2)}%`}
                </td>
                <td className="hidden px-4 py-4 text-violet-300 underline-offset-2 hover:underline lg:table-cell">
                  {m.autoCloseLabel}
                </td>
                <td className="px-4 py-4">
                  <div className="flex justify-end gap-1.5">
                    <Link
                      href={`/app/trade/${m.conditionId}?side=YES`}
                      onClick={(e) => e.stopPropagation()}
                      className="rounded-md border border-ink-700 bg-ink-900 px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.16em] text-chalk-50 transition hover:border-violet-500 hover:text-violet-300"
                    >
                      YES
                    </Link>
                    <Link
                      href={`/app/trade/${m.conditionId}?side=NO`}
                      onClick={(e) => e.stopPropagation()}
                      className="rounded-md border border-ink-700 bg-ink-900 px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.16em] text-chalk-50 transition hover:border-violet-500 hover:text-violet-300"
                    >
                      NO
                    </Link>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function GridView({
  rows,
  favs,
  onToggleFav,
  decisions,
}: {
  readonly rows: readonly MarketRow[];
  readonly favs: ReadonlySet<string>;
  readonly onToggleFav: (id: string) => void;
  readonly decisions: ReadonlyMap<string, AgentDecision>;
}): JSX.Element {
  return (
    <div className="grid gap-4 pt-4 md:grid-cols-2 xl:grid-cols-3">
      {rows.map((m) => {
        const isUp = m.delta24h > 0;
        const isFav = favs.has(m.conditionId);
        const dec = decisions.get(m.conditionId);
        return (
          <Link
            key={m.conditionId}
            href={`/app/trade/${m.conditionId}`}
            className="block rounded-2xl border border-ink-800 bg-ink-900 p-4 transition hover:border-ink-700"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <MarketAvatar question={m.question} size={36} />
                <div className="min-w-0">
                  <p className="line-clamp-2 text-sm font-medium text-chalk-50">
                    {m.question}
                  </p>
                  <div className="mt-1.5">
                    <AgentBadge decision={dec} />
                  </div>
                </div>
              </div>
              <button
                type="button"
                aria-label={isFav ? "Unfavorite" : "Favorite"}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onToggleFav(m.conditionId);
                }}
                className={`shrink-0 ${
                  isFav ? "text-accent-lime" : "text-chalk-400 hover:text-chalk-200"
                }`}
              >
                <BookmarkIcon filled={isFav} />
              </button>
            </div>
            <div className="mt-4 flex items-end justify-between gap-3">
              <div>
                <p className="font-display text-2xl font-semibold">{m.midCents}¢</p>
                <p
                  className={`font-mono text-xs ${
                    m.delta24h === 0
                      ? "text-chalk-400"
                      : isUp
                        ? "text-signal-green"
                        : "text-signal-red"
                  }`}
                >
                  {m.delta24h === 0
                    ? "—"
                    : `${isUp ? "+" : ""}${m.delta24h.toFixed(2)}%`}
                </p>
              </div>
              <Sparkline up={isUp} />
            </div>
            <div className="mt-4 flex items-center gap-1.5">
              <span className="flex-1 rounded-md border border-ink-700 bg-ink-950 px-3 py-2 text-center font-mono text-[11px] uppercase tracking-[0.18em] text-chalk-50">
                Pledge YES
              </span>
              <span className="flex-1 rounded-md border border-ink-700 bg-ink-950 px-3 py-2 text-center font-mono text-[11px] uppercase tracking-[0.18em] text-chalk-50">
                NO
              </span>
            </div>
          </Link>
        );
      })}
    </div>
  );
}

// ---------- Helpers / icons ----------------------------------------------

function fmtAge(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

function AgentBadge({
  decision,
}: {
  readonly decision: AgentDecision | undefined;
}): JSX.Element {
  if (decision === undefined) {
    return (
      <span className="rounded border border-ink-700 px-1 py-px text-chalk-600">
        unreviewed
      </span>
    );
  }
  const ltvPct = (decision.ltv_max_bps / 100).toFixed(0);
  const reviewedAge = fmtAge(decision.reviewed_at_unix_ms);
  return (
    <span className="rounded border border-violet-500/40 bg-violet-500/10 px-1 py-px text-violet-300">
      VANTA · {ltvPct}% · {reviewedAge} ago
    </span>
  );
}

function formatK(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return n.toFixed(0);
}

function SortHeader({
  label,
  k,
  sort,
  onSort,
}: {
  readonly label: string;
  readonly k: SortKey;
  readonly sort: { key: SortKey; dir: "asc" | "desc" };
  readonly onSort: (k: SortKey) => void;
}): JSX.Element {
  const active = sort.key === k;
  return (
    <button
      type="button"
      onClick={() => onSort(k)}
      className={`inline-flex items-center gap-1 ${active ? "text-chalk-50" : "text-chalk-400 hover:text-chalk-200"}`}
    >
      {label}
      <svg viewBox="0 0 8 12" className="h-3 w-2" fill="currentColor" aria-hidden>
        <path
          d="M4 0L0 4h8L4 0Z"
          opacity={active && sort.dir === "asc" ? 1 : 0.35}
        />
        <path
          d="M4 12L0 8h8L4 12Z"
          opacity={active && sort.dir === "desc" ? 1 : 0.35}
        />
      </svg>
    </button>
  );
}

function Sparkline({ up }: { readonly up: boolean }): JSX.Element {
  const stroke = up ? "#43e08c" : "#ff5f6d";
  return (
    <svg
      aria-hidden
      viewBox="0 0 80 24"
      className="h-6 w-20 shrink-0"
      fill="none"
      stroke={stroke}
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline
        points={
          up
            ? "0,18 10,16 20,15 30,12 40,11 50,8 60,9 70,5 80,3"
            : "0,6 10,8 20,9 30,12 40,11 50,15 60,14 70,18 80,20"
        }
      />
    </svg>
  );
}

function BookmarkIcon({ filled }: { readonly filled: boolean }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.5}>
      <path d="M3.5 2.5h9v11.25l-4.5-3-4.5 3V2.5Z" />
    </svg>
  );
}

function SearchIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 text-chalk-400" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <circle cx={7} cy={7} r={4.5} />
      <path d="m10.5 10.5 3 3" strokeLinecap="round" />
    </svg>
  );
}

function FilterIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M2 4h12M4 8h8M6 12h4" strokeLinecap="round" />
    </svg>
  );
}

function ListIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor">
      <rect x={2} y={3} width={12} height={2} rx={0.5} />
      <rect x={2} y={7} width={12} height={2} rx={0.5} />
      <rect x={2} y={11} width={12} height={2} rx={0.5} />
    </svg>
  );
}

function GridIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor">
      <rect x={2} y={2} width={5} height={5} rx={0.5} />
      <rect x={9} y={2} width={5} height={5} rx={0.5} />
      <rect x={2} y={9} width={5} height={5} rx={0.5} />
      <rect x={9} y={9} width={5} height={5} rx={0.5} />
    </svg>
  );
}
