"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { fmtUsdc, useWallet } from "@/lib/wallet";

import { MarketAvatar } from "../avatar";

interface MarketOutcome {
  readonly tokenId: string;
  readonly outcome: string;
  readonly priceCents: number | null;
}

interface MarketDoc {
  readonly conditionId: string;
  readonly question: string;
  readonly midYesCents: number | null;
  readonly midNoCents: number | null;
  readonly tokens: readonly MarketOutcome[];
  readonly polymarketUrl: string | null;
  readonly stale: boolean;
  readonly fetchedAt: number;
}

const STAT_GAP = "min-w-[88px]";

export function TradeView({ marketParam }: { readonly marketParam: string }): JSX.Element {
  const sp = useSearchParams();
  const initialSide = sp.get("side") === "NO" ? "NO" : "YES";
  const [doc, setDoc] = useState<MarketDoc | null>(null);
  const [side, setSide] = useState<"YES" | "NO">(initialSide as "YES" | "NO");
  const [tradeMode, setTradeMode] = useState<"market" | "limit" | "pro">("market");
  const [margin, setMargin] = useState<string>("0.00");
  const [leverage, setLeverage] = useState<number>(2);

  useEffect(() => {
    let cancelled = false;
    // Two-source resolve: agent's watched set first (has token IDs +
    // agent overlay), then the broad /api/markets corpus for any market
    // outside the watched 7. Without the fallback, clicking a market
    // from Politics/Sports/Crypto/Macro/Tech leaves doc=null and pledge
    // silently bails on its `doc === null` guard.
    async function pull(): Promise<void> {
      try {
        const rw = await fetch("/api/runtime/markets/watched", { cache: "no-store" });
        if (rw.ok) {
          const j = (await rw.json()) as {
            markets?: Array<{
              conditionId: string;
              question: string | null;
              mid: { yes: string | null; no: string | null };
              tokens: Array<{ tokenId: string; outcome: string; price: string | null }>;
              polymarket_url?: string | null;
              stale?: boolean;
              fetched_at_unix_ms?: number;
            }>;
          };
          if (cancelled) return;
          const target = (j.markets ?? []).find(
            (m) => m.conditionId === marketParam || `0x${m.conditionId}` === marketParam,
          );
          if (target !== undefined) {
            setDoc({
              conditionId: target.conditionId,
              question: target.question ?? "—",
              midYesCents: parseCents(target.mid.yes),
              midNoCents: parseCents(target.mid.no),
              tokens: target.tokens.map((t) => ({
                tokenId: t.tokenId,
                outcome: t.outcome,
                priceCents: parseCents(t.price),
              })),
              polymarketUrl: target.polymarket_url ?? null,
              stale: target.stale ?? false,
              fetchedAt: target.fetched_at_unix_ms ?? Date.now(),
            });
            return;
          }
        }
        const rb = await fetch("/api/markets", { cache: "no-store" });
        if (!rb.ok) return;
        const j = (await rb.json()) as {
          markets?: Array<{
            conditionId: string;
            question: string;
            mid: { yes: string | null; no: string | null };
            polymarket_url: string | null;
          }>;
          fetched_at?: number;
        };
        if (cancelled) return;
        const norm = marketParam.toLowerCase().replace(/^0x/, "");
        const target = (j.markets ?? []).find((m) => m.conditionId === norm);
        if (target === undefined) return;
        setDoc({
          conditionId: target.conditionId,
          question: target.question,
          midYesCents: parseCents(target.mid.yes),
          midNoCents: parseCents(target.mid.no),
          tokens: [],
          polymarketUrl: target.polymarket_url,
          stale: false,
          fetchedAt: j.fetched_at ?? Date.now(),
        });
      } catch {
        /* keep null */
      }
    }
    void pull();
    const t = setInterval(() => void pull(), 6000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [marketParam]);

  const midCents = doc !== null ? (side === "YES" ? doc.midYesCents : doc.midNoCents) : null;

  return (
    <>
      <NoticeBanner />
      <div className="-mx-6 -my-8 grid grid-cols-1 gap-3 px-3 py-3 lg:grid-cols-[minmax(0,1fr)_320px_300px]">
        <div className="space-y-3">
          <MarketHeader doc={doc} marketParam={marketParam} />
          <ChartCard doc={doc} side={side} />
          <BottomTabs />
        </div>
        <OrderBookCard side={side} doc={doc} />
        <TradePanel
          doc={doc}
          side={side}
          setSide={setSide}
          tradeMode={tradeMode}
          setTradeMode={setTradeMode}
          margin={margin}
          setMargin={setMargin}
          leverage={leverage}
          setLeverage={setLeverage}
          midCents={midCents}
        />
      </div>
      <LiveMarquee currentCid={marketParam} />
    </>
  );
}

// ---------------------------------------------------------------- Notice banner

function NoticeBanner(): JSX.Element {
  return (
    <div className="-mx-6 mb-3 border-y border-violet-500/20 bg-violet-500/5">
      <div className="mx-auto flex max-w-[1600px] items-center gap-2 px-6 py-2.5 text-xs text-chalk-200">
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 text-violet-400" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <path d="M8 1 1 14h14L8 1Z" />
          <path d="M8 6v4M8 12v.01" strokeLinecap="round" />
        </svg>
        <span>
          VANTA is in private preview. Pledging is gated to whitelisted lenders;{" "}
          <Link href="/paper" className="text-violet-300 underline-offset-2 hover:underline">
            read the paper
          </Link>{" "}
          for the full rollout schedule.
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Market header

function MarketHeader({
  doc,
  marketParam,
}: {
  readonly doc: MarketDoc | null;
  readonly marketParam: string;
}): JSX.Element {
  const question = doc?.question ?? "Loading market…";
  const midYesCents = doc?.midYesCents ?? null;
  const midNoCents = doc?.midNoCents ?? null;
  const lastTraded = midYesCents !== null ? `${midYesCents}¢` : "—";

  return (
    <div className="rounded-2xl border border-ink-800 bg-ink-900/60 p-4">
      <div className="flex items-start gap-3">
        <MarketAvatar question={question} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <h1 className="font-display text-lg font-semibold leading-tight text-chalk-50">
              {question}
            </h1>
            <div className="flex shrink-0 items-center gap-1 text-chalk-400">
              {doc?.polymarketUrl !== null && doc?.polymarketUrl !== undefined && (
                <Link
                  href={doc.polymarketUrl}
                  target="_blank"
                  rel="noopener"
                  aria-label="Polymarket source"
                  className="grid h-7 w-7 place-items-center rounded hover:bg-ink-800 hover:text-chalk-200"
                >
                  <ExternalIcon />
                </Link>
              )}
              <button
                type="button"
                aria-label="Copy link"
                className="grid h-7 w-7 place-items-center rounded hover:bg-ink-800 hover:text-chalk-200"
              >
                <LinkIcon />
              </button>
              <button
                type="button"
                aria-label="Bookmark"
                className="grid h-7 w-7 place-items-center rounded hover:bg-ink-800 hover:text-chalk-200"
              >
                <BookmarkIcon />
              </button>
            </div>
          </div>

          {/* Stat row */}
          <div className="mt-3 flex flex-wrap gap-x-8 gap-y-3 text-xs">
            <Stat label="Price" value={lastTraded} valueClass="text-chalk-50 font-display text-base font-semibold" />
            <Stat label="24h ch" value="—" />
            <Stat label="Open Interest" value="$0" />
            <Stat label="Capacity left" value="$19.9K" />
            <Stat label="Volume" value="$13.5K" />
            <Stat label="Liquidity" value="$34.2K" />
            <Stat label="Auto-close" value="May 8, 1pm" valueClass="text-chalk-50 font-mono text-xs" />
          </div>

          <div className="mt-3 flex items-center justify-between text-xs">
            <div className="flex items-center gap-6">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-chalk-400">
                  ◉ Tweet count
                </p>
                <p className="font-mono text-chalk-100">0</p>
              </div>
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-chalk-400 underline-offset-2">
                  Early Auto-close
                </p>
                <p className="text-chalk-100">Normal</p>
              </div>
            </div>
            <Link
              href="/paper"
              className="inline-flex items-center gap-1 rounded-full border border-violet-500/40 bg-violet-500/10 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-violet-300 hover:border-violet-500"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-violet-500" />
              Read auto-close rule
            </Link>
          </div>
        </div>
      </div>

      {/* Outcome chips */}
      <div className="mt-4 flex flex-wrap gap-2">
        <OutcomeChip
          question={question}
          label="240-259 tweets"
          priceCents={midYesCents ?? 11}
          active
        />
        <OutcomeChip question={question} label="220-239 tweets" priceCents={(midNoCents ?? 16) - 1} />
        <OutcomeChip question={question} label="200-219 tweets" priceCents={(midNoCents ?? 16) - 1} />
        <OutcomeChip question={question} label="180-199 tweets" priceCents={(midNoCents ?? 13)} />
        <OutcomeChip question={question} label="160-179 tweets" priceCents={(midNoCents ?? 12) - 1} />
      </div>

      <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.18em] text-chalk-400">
        cid · 0x{marketParam.slice(0, 8)}…{marketParam.slice(-4)}
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  valueClass,
}: {
  readonly label: string;
  readonly value: string;
  readonly valueClass?: string;
}): JSX.Element {
  return (
    <div className={STAT_GAP}>
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-chalk-400">{label}</p>
      <p className={`mt-1 ${valueClass ?? "text-chalk-100 font-mono text-sm"}`}>{value}</p>
    </div>
  );
}

function OutcomeChip({
  question,
  label,
  priceCents,
  active,
}: {
  readonly question: string;
  readonly label: string;
  readonly priceCents: number;
  readonly active?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs transition ${
        active
          ? "border-violet-500/50 bg-violet-500/10 text-chalk-50"
          : "border-ink-800 bg-ink-900 text-chalk-200 hover:border-ink-700"
      }`}
    >
      <MarketAvatar question={`${question} ${label}`} size={20} />
      <span>{label}</span>
      <span className="font-mono text-chalk-50">{priceCents}¢</span>
    </button>
  );
}

// ---------------------------------------------------------------- Chart

function ChartCard({
  doc,
  side,
}: {
  readonly doc: MarketDoc | null;
  readonly side: "YES" | "NO";
}): JSX.Element {
  const midCents = doc !== null ? (side === "YES" ? doc.midYesCents : doc.midNoCents) : null;
  const lastPrice = midCents ?? 11;
  const [clock, setClock] = useState<string>("");
  useEffect(() => {
    setClock(nowHHMM());
    const t = setInterval(() => setClock(nowHHMM()), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="overflow-hidden rounded-2xl border border-ink-800 bg-ink-900/60">
      <div className="flex items-center justify-between border-b border-ink-800 px-3 py-2 text-chalk-400">
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="rounded px-2 py-1 font-mono text-xs text-chalk-200 hover:bg-ink-800"
          >
            15m
          </button>
          <button type="button" className="grid h-7 w-7 place-items-center hover:text-chalk-200" aria-label="Adjust">
            <SliderIcon />
          </button>
          <button type="button" className="inline-flex items-center gap-1 px-2 py-1 hover:text-chalk-200">
            <FxIcon />
            <span className="text-xs">Indicators</span>
          </button>
          <button type="button" className="grid h-7 w-7 place-items-center opacity-40">
            <UndoIcon />
          </button>
          <button type="button" className="grid h-7 w-7 place-items-center opacity-40">
            <RedoIcon />
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className="grid h-7 w-7 place-items-center hover:text-chalk-200" aria-label="Settings">
            <SettingsIcon />
          </button>
          <button type="button" className="grid h-7 w-7 place-items-center hover:text-chalk-200" aria-label="Fullscreen">
            <ExpandIcon />
          </button>
          <button type="button" className="grid h-7 w-7 place-items-center hover:text-chalk-200" aria-label="Screenshot">
            <CameraIcon />
          </button>
        </div>
      </div>

      <div className="px-3 pb-3 pt-2">
        <div className="flex items-center gap-2 text-xs text-chalk-400">
          <MarketAvatar question={doc?.question ?? "loading"} size={16} />
          <span className="text-chalk-200">{shortLabel(doc?.question)}</span>
          <span className="text-chalk-500">·</span>
          <span>15</span>
          <span className="text-chalk-500">·</span>
          <span>VANTA</span>
          <span className="ml-2 text-chalk-500">O</span>
          <span className="text-chalk-200">{(lastPrice + 1).toFixed(1)}</span>
          <span className="text-chalk-500">H</span>
          <span className="text-chalk-200">{(lastPrice + 1).toFixed(1)}</span>
          <span className="text-chalk-500">L</span>
          <span className="text-chalk-200">{lastPrice.toFixed(1)}</span>
          <span className="text-chalk-500">C</span>
          <span className="text-chalk-200">{lastPrice.toFixed(1)}</span>
          <span className="text-signal-red">−1.0 (−8.70%)</span>
        </div>

        <CandleChart lastPrice={lastPrice} />

        <div className="mt-2 flex items-center justify-between text-xs text-chalk-400">
          <div className="flex items-center gap-1">
            <button type="button" className="rounded px-1.5 py-0.5 hover:bg-ink-800 text-chalk-200">3m</button>
            <button type="button" className="rounded px-1.5 py-0.5 hover:bg-ink-800">5d</button>
            <button type="button" className="rounded px-1.5 py-0.5 hover:bg-ink-800">1d</button>
            <span className="ml-1 grid h-5 w-5 place-items-center rounded hover:bg-ink-800">
              <CalendarIcon />
            </span>
          </div>
          <div className="font-mono" suppressHydrationWarning>
            <span>{clock}</span>
            <span className="ml-1 text-chalk-500">UTC</span>
            <span className="ml-3">%</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function CandleChart({ lastPrice }: { readonly lastPrice: number }): JSX.Element {
  // Synthesize a tasteful 25-bar candle series anchored at the live mid.
  const candles = useMemo(() => synthesizeCandles(lastPrice), [lastPrice]);
  const W = 720;
  const H = 220;
  const PAD_LEFT = 12;
  const PAD_RIGHT = 56;
  const PAD_TOP = 12;
  const PAD_BOT = 18;

  const minP = Math.min(...candles.flatMap((c) => [c.l, c.h]));
  const maxP = Math.max(...candles.flatMap((c) => [c.l, c.h]));
  const range = Math.max(0.5, maxP - minP);

  const innerW = W - PAD_LEFT - PAD_RIGHT;
  const innerH = H - PAD_TOP - PAD_BOT;
  const stepX = innerW / candles.length;
  const yOf = (p: number): number => PAD_TOP + ((maxP - p) / range) * innerH;

  // Y axis ticks
  const ticks: number[] = [];
  for (let t = Math.ceil(minP); t <= Math.floor(maxP); t++) {
    if ((t * 2) % 1 === 0) ticks.push(t);
  }

  return (
    <div className="mt-3 overflow-hidden rounded-md border border-ink-800 bg-ink-950">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-[220px] w-full" preserveAspectRatio="none">
        {/* horizontal gridlines */}
        {ticks.map((t) => (
          <line
            key={`g${t}`}
            x1={PAD_LEFT}
            x2={W - PAD_RIGHT}
            y1={yOf(t)}
            y2={yOf(t)}
            stroke="#2a2a2a"
            strokeDasharray="2 4"
          />
        ))}
        {candles.map((c, i) => {
          const x = PAD_LEFT + i * stepX + stepX * 0.15;
          const w = stepX * 0.7;
          const isUp = c.c >= c.o;
          const fill = isUp ? "#3aa776" : "#cf6c5a";
          const yTop = yOf(Math.max(c.o, c.c));
          const yBot = yOf(Math.min(c.o, c.c));
          return (
            <g key={i}>
              <line
                x1={x + w / 2}
                x2={x + w / 2}
                y1={yOf(c.h)}
                y2={yOf(c.l)}
                stroke={fill}
                strokeWidth={1}
              />
              <rect
                x={x}
                y={yTop}
                width={w}
                height={Math.max(2, yBot - yTop)}
                fill={fill}
                opacity={0.85}
              />
            </g>
          );
        })}
        {/* last-price line + label */}
        <line
          x1={PAD_LEFT}
          x2={W - PAD_RIGHT}
          y1={yOf(lastPrice)}
          y2={yOf(lastPrice)}
          stroke="#cf6c5a"
          strokeDasharray="3 3"
          strokeWidth={1}
        />
        <rect
          x={W - PAD_RIGHT + 2}
          y={yOf(lastPrice) - 9}
          width={PAD_RIGHT - 6}
          height={18}
          rx={3}
          fill="#cf6c5a"
        />
        <text
          x={W - PAD_RIGHT / 2 - 1}
          y={yOf(lastPrice) + 4}
          textAnchor="middle"
          fontFamily="JetBrains Mono, monospace"
          fontSize={11}
          fill="#fff"
        >
          {lastPrice.toFixed(1)}
        </text>

        {/* y-axis ticks (right side) */}
        {ticks.map((t) => (
          <text
            key={`tk${t}`}
            x={W - PAD_RIGHT + 8}
            y={yOf(t) + 4}
            fontSize={10}
            fontFamily="JetBrains Mono, monospace"
            fill="#7e8694"
          >
            {t.toFixed(1)}
          </text>
        ))}

        {/* x-axis time hint */}
        <text
          x={W - PAD_RIGHT - 6}
          y={H - 4}
          fontSize={9}
          fontFamily="JetBrains Mono, monospace"
          fill="#4a5160"
          textAnchor="end"
        >
          15m
        </text>
      </svg>
    </div>
  );
}

interface Candle {
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
}

function synthesizeCandles(last: number): readonly Candle[] {
  // 25 bars of band-limited pseudo-random walk anchored at `last`.
  // Closes track within ±band of `last` so the right-axis label aligns
  // without producing an outlier final candle.
  const N = 25;
  const band = Math.max(0.6, Math.min(2.5, last * 0.15));
  const out: Candle[] = [];
  let cur = last + band * 0.6; // start a little above so the trend has room
  for (let i = 0; i < N; i++) {
    const drift = (Math.sin(i * 0.55) + Math.cos(i * 0.31)) * 0.18 * band;
    const noise = ((Math.sin(i * 3.1 + 1.7) + 1) / 2) * 0.35 * band;
    const target = last + Math.sin((i / N) * Math.PI) * band * 0.6;
    // Pull cur toward target a little each step.
    cur = cur + (target - cur) * 0.35 + drift;
    const o = cur;
    const c = Math.max(0.3, Math.min(99, o + (noise - 0.2 * band) * 0.6));
    const h = Math.max(o, c) + noise * 0.5;
    const l = Math.min(o, c) - noise * 0.5;
    out.push({ o: r(o), h: r(h), l: r(l), c: r(c) });
    cur = c;
  }
  // Last candle's close lands exactly on `last`; cap its height/low so it
  // doesn't visually diverge from the surrounding bars.
  const tail = out[N - 1];
  const o = tail.o;
  const c = last;
  out[N - 1] = {
    o: r(o),
    c: r(c),
    h: r(Math.max(o, c) + band * 0.15),
    l: r(Math.min(o, c) - band * 0.15),
  };
  return out;
}

function r(n: number): number {
  return Math.round(n * 10) / 10;
}

// ---------------------------------------------------------------- Order book

function OrderBookCard({
  side,
  doc,
}: {
  readonly side: "YES" | "NO";
  readonly doc: MarketDoc | null;
}): JSX.Element {
  const [view, setView] = useState<"long" | "short">(side === "YES" ? "long" : "short");
  const midCents = doc !== null ? (side === "YES" ? doc.midYesCents : doc.midNoCents) : null;
  const last = midCents ?? 11;
  const ladder = useMemo(() => buildLadder(last), [last]);
  const bidTotal = ladder.bids.reduce((a, b) => a + b.shares, 0);
  const askTotal = ladder.asks.reduce((a, b) => a + b.shares, 0);
  const askPct = Math.round((askTotal / Math.max(1, askTotal + bidTotal)) * 100);

  return (
    <aside className="flex h-full flex-col rounded-2xl border border-ink-800 bg-ink-900/60">
      <div className="flex items-center justify-between border-b border-ink-800 px-3 py-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-chalk-400">
          Order book
        </span>
        <div className="inline-flex items-center rounded border border-ink-800 bg-ink-900 p-0.5 text-[11px]">
          <button
            type="button"
            onClick={() => setView("long")}
            className={`rounded px-2 py-0.5 ${view === "long" ? "bg-ink-700 text-chalk-50" : "text-chalk-400"}`}
          >
            Long
          </button>
          <button
            type="button"
            onClick={() => setView("short")}
            className={`rounded px-2 py-0.5 ${view === "short" ? "bg-ink-700 text-chalk-50" : "text-chalk-400"}`}
          >
            Short
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between px-3 py-2 text-xs">
        <span className="text-chalk-400">Last Traded</span>
        <span className="text-[#cf6c5a]">▼ {last}¢</span>
      </div>
      <div className="flex items-center justify-between px-3 pb-2 text-xs">
        <span className="text-chalk-400">Spread</span>
        <span className="text-chalk-200">0.9¢</span>
      </div>

      <div className="grid grid-cols-3 border-y border-ink-800 px-3 py-1.5 text-[10px] uppercase tracking-[0.16em] text-chalk-400">
        <span>Price</span>
        <span className="text-right">Shares</span>
        <span className="text-right">USD</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        <ul className="divide-y divide-ink-800/60 text-xs">
          {[...ladder.asks].reverse().map((row) => (
            <LadderRow key={`ask${row.priceCents}`} row={row} kind="ask" />
          ))}
        </ul>
        <div className="border-y border-ink-800 bg-ink-950/40 px-3 py-1.5 text-center font-mono text-[11px]">
          <span className="text-[#cf6c5a]">▼ {last}¢</span>
          <span className="ml-2 text-chalk-500">last</span>
        </div>
        <ul className="divide-y divide-ink-800/60 text-xs">
          {ladder.bids.map((row) => (
            <LadderRow key={`bid${row.priceCents}`} row={row} kind="bid" />
          ))}
        </ul>
      </div>

      <div className="border-t border-ink-800 px-3 py-2">
        <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.16em]">
          <span className="text-[#cf6c5a]">Ask {askPct}%</span>
          <span className="text-[#3aa776]">{100 - askPct}% Bid</span>
        </div>
        <div className="mt-1 flex h-1 overflow-hidden rounded bg-ink-800">
          <span className="bg-[#cf6c5a]" style={{ width: `${askPct}%` }} />
          <span className="bg-[#3aa776]" style={{ width: `${100 - askPct}%` }} />
        </div>
        <div className="mt-2 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.18em] text-chalk-400">
          <span className="text-chalk-200">Open</span>
          <span className="rounded bg-ink-800 px-2 py-0.5 text-chalk-300">Closed</span>
        </div>
      </div>
    </aside>
  );
}

interface LadderEntry {
  readonly priceCents: number;
  readonly shares: number;
}

function buildLadder(midCents: number): {
  readonly bids: readonly LadderEntry[];
  readonly asks: readonly LadderEntry[];
} {
  const bids: LadderEntry[] = [];
  const asks: LadderEntry[] = [];
  for (let i = 0; i < 6; i++) {
    const bidPx = Math.max(0.1, midCents - 1 - i);
    const askPx = midCents + 1 + i;
    bids.push({ priceCents: bidPx, shares: pseudoSize(bidPx, i) });
    asks.push({ priceCents: askPx, shares: pseudoSize(askPx, i + 0.5) });
  }
  return { bids, asks };
}

function pseudoSize(price: number, salt: number): number {
  const base = 100 + Math.abs(Math.sin(price * 1.3 + salt) * 2700);
  return Math.round(base);
}

function LadderRow({
  row,
  kind,
}: {
  readonly row: LadderEntry;
  readonly kind: "ask" | "bid";
}): JSX.Element {
  const fillColor =
    kind === "ask" ? "rgba(207,108,90,0.22)" : "rgba(58,167,118,0.22)";
  const textColor = kind === "ask" ? "text-[#cf6c5a]" : "text-[#3aa776]";
  const px = `${row.priceCents}¢`;
  const usd = `$${(row.shares * (row.priceCents / 100)).toFixed(2)}`;
  return (
    <li className="relative grid grid-cols-3 px-3 py-1 hover:bg-ink-800/60">
      <span
        aria-hidden
        className="absolute inset-y-0 right-0"
        style={{
          width: `${Math.min(95, row.shares / 60)}%`,
          background: fillColor,
        }}
      />
      <span className={`relative font-mono text-xs ${textColor}`}>{px}</span>
      <span className="relative text-right font-mono text-chalk-200">
        {row.shares >= 1000 ? `${(row.shares / 1000).toFixed(1)}K` : row.shares}
      </span>
      <span className="relative text-right font-mono text-chalk-200">{usd}</span>
    </li>
  );
}

// ---------------------------------------------------------------- Trade panel

function TradePanel({
  doc,
  side,
  setSide,
  tradeMode,
  setTradeMode,
  margin,
  setMargin,
  leverage,
  setLeverage,
  midCents,
}: {
  readonly doc: MarketDoc | null;
  readonly side: "YES" | "NO";
  readonly setSide: (s: "YES" | "NO") => void;
  readonly tradeMode: "market" | "limit" | "pro";
  readonly setTradeMode: (m: "market" | "limit" | "pro") => void;
  readonly margin: string;
  readonly setMargin: (m: string) => void;
  readonly leverage: number;
  readonly setLeverage: (l: number) => void;
  readonly midCents: number | null;
}): JSX.Element {
  const ltvPct = Math.min(50, leverage * 5);

  return (
    <aside className="flex h-full flex-col rounded-2xl border border-ink-800 bg-ink-900/60">

      <div className="grid grid-cols-2 gap-1.5 border-b border-ink-800 p-2">
        <button
          type="button"
          onClick={() => setSide("YES")}
          className={`rounded-md py-2.5 text-sm font-medium tracking-[0.04em] transition ${
            side === "YES"
              ? "bg-ink-800 text-chalk-50 ring-1 ring-inset ring-violet-500/40"
              : "bg-transparent text-chalk-400 hover:text-chalk-200"
          }`}
        >
          PLEDGE YES
        </button>
        <button
          type="button"
          onClick={() => setSide("NO")}
          className={`rounded-md py-2.5 text-sm font-medium tracking-[0.04em] transition ${
            side === "NO"
              ? "bg-ink-800 text-chalk-50 ring-1 ring-inset ring-violet-500/40"
              : "bg-transparent text-chalk-400 hover:text-chalk-200"
          }`}
        >
          PLEDGE NO
        </button>
      </div>

      <div className="flex items-center gap-3 border-b border-ink-800 px-3 py-2 text-sm">
        <button
          type="button"
          onClick={() => setTradeMode("market")}
          className={`relative pb-1 ${tradeMode === "market" ? "text-chalk-50" : "text-chalk-400"}`}
        >
          Market
          {tradeMode === "market" && (
            <span className="absolute -bottom-px left-0 right-0 h-0.5 rounded-full bg-violet-500" />
          )}
        </button>
        <button
          type="button"
          onClick={() => setTradeMode("limit")}
          className={`flex items-center gap-1 ${tradeMode === "limit" ? "text-chalk-50" : "text-chalk-400"}`}
        >
          Limit
          <span className="rounded bg-accent-orange/20 px-1 font-mono text-[9px] uppercase text-accent-orange">
            new
          </span>
        </button>
        <button
          type="button"
          onClick={() => setTradeMode("pro")}
          className={`${tradeMode === "pro" ? "text-chalk-50" : "text-chalk-400"}`}
        >
          Pro
        </button>
      </div>

      <BalRow />


      <div className="px-3 pt-2">
        <div className="flex items-baseline gap-2 rounded-md border border-ink-800 bg-ink-950 px-3 py-3">
          <span className="font-display text-2xl text-chalk-400">$</span>
          <input
            type="text"
            inputMode="decimal"
            value={margin}
            onChange={(e) => {
              const v = e.target.value.replace(/[^0-9.]/g, "");
              setMargin(v);
            }}
            className="flex-1 bg-transparent font-display text-3xl font-medium text-chalk-50 outline-none placeholder:text-chalk-500"
            placeholder="0.00"
          />
          <span className="rounded-md border border-violet-500/40 bg-violet-500/10 px-2 py-0.5 font-mono text-[11px] text-violet-300">
            {leverage}X
          </span>
        </div>

        <div className="mt-2 grid grid-cols-5 gap-1">
          {(["10%", "25%", "50%", "75%", "MAX"] as const).map((p) => (
            <button
              key={p}
              type="button"
              className="rounded-md border border-ink-800 bg-ink-900 py-1 font-mono text-[11px] text-chalk-200 hover:border-violet-500"
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      <div className="px-3 pt-4">
        <div className="flex items-baseline justify-between text-xs">
          <span className="text-chalk-400">Leverage</span>
          <span className="font-display text-2xl font-semibold">
            {leverage}
            <span className="ml-0.5 text-base text-chalk-400">x</span>
          </span>
        </div>
        <LeverageBars value={leverage} onChange={setLeverage} />
        <div className="mt-1 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.16em] text-chalk-400">
          <span className={leverage <= 2 ? "text-violet-300" : ""}>2x</span>
          <span>3x</span>
          <span>4x</span>
          <span>5x</span>
          <span>6x</span>
          <span>7x</span>
          <span>8x</span>
          <span>9x</span>
          <span>10x</span>
        </div>
        <p className="mt-2 text-[10px] text-chalk-500">≈ {ltvPct}% LTV cap · 50% max</p>
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-ink-800 px-3 py-2 text-xs text-chalk-400">
        <span className="inline-flex items-center gap-1">
          <ToggleDot />
          Take profit / Stop loss
        </span>
      </div>

      <PledgeCta doc={doc} side={side} marginUsdc={Number(margin) || 0} leverage={leverage} midCents={midCents} />
    </aside>
  );
}

function BalRow(): JSX.Element {
  const { connected, balanceUsdc } = useWallet();
  return (
    <div className="flex items-center justify-between px-3 pt-3 text-xs">
      <span className="text-chalk-400 underline-offset-2">Margin</span>
      <span className="text-chalk-400">
        Bal.{" "}
        <span className={connected ? "text-chalk-100" : "text-chalk-500"}>
          {fmtUsdc(balanceUsdc)}
        </span>
      </span>
    </div>
  );
}

function PledgeCta({
  doc,
  side,
  marginUsdc,
  leverage,
  midCents,
}: {
  readonly doc: MarketDoc | null;
  readonly side: "YES" | "NO";
  readonly marginUsdc: number;
  readonly leverage: number;
  readonly midCents: number | null;
}): JSX.Element {
  const { connected, mode, openConnect, addDemoPledge, balanceUsdc } = useWallet();
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  async function pledge(): Promise<void> {
    if (doc === null || midCents === null) return;
    if (mode !== "demo") return;
    setSubmitting(true);
    // Tiny perceptible delay so the button has motion.
    await new Promise((r) => setTimeout(r, 450));
    const notional = Math.max(1, marginUsdc * leverage);
    const principal = Math.round(notional * 0.5 * 100) / 100; // 50% LTV
    const haircutBps = 625;
    addDemoPledge({
      conditionId: doc.conditionId,
      question: doc.question,
      side,
      entryCents: midCents,
      notionalUsdc: notional,
      principalUsdc: principal,
      haircutBps,
    });
    setSubmitting(false);
    setDone(`+${fmtUsdc(principal)} borrowed against ${fmtUsdc(notional)} ${side}`);
    setTimeout(() => setDone(null), 4500);
  }

  const insufficient = connected && marginUsdc > balanceUsdc;
  const tooSmall = connected && marginUsdc <= 0;
  const label = !connected
    ? "Sign in"
    : insufficient
      ? "Insufficient balance"
      : tooSmall
        ? `Enter margin to pledge ${side}`
        : submitting
          ? "Pledging…"
          : `Pledge ${side}`;

  const disabled = connected && (insufficient || tooSmall || submitting);
  const onClick = connected ? () => void pledge() : openConnect;

  return (
    <div className="mt-auto p-3">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={`w-full rounded-md py-3 text-sm font-medium text-chalk-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] transition disabled:opacity-50 ${
          connected ? "bg-violet-500 hover:bg-violet" : "bg-[#2f9c66] hover:bg-[#3aa776]"
        }`}
      >
        {label}
      </button>
      {done !== null && (
        <p className="mt-2 text-center font-mono text-[10px] uppercase tracking-[0.16em] text-signal-green">
          {done}
        </p>
      )}
      {midCents !== null && done === null && (
        <p className="mt-2 text-center font-mono text-[10px] uppercase tracking-[0.16em] text-chalk-500">
          mark {midCents}¢ · {side} · {mode === "demo" ? "demo" : "agent-vetted"}
        </p>
      )}
      {doc?.stale === true && (
        <p className="mt-1 text-center font-mono text-[10px] text-signal-amber">
          stale snapshot — runtime offline
        </p>
      )}
    </div>
  );
}

function LeverageBars({
  value,
  onChange,
}: {
  readonly value: number;
  readonly onChange: (n: number) => void;
}): JSX.Element {
  const N = 36;
  const heights = useMemo(() => Array.from({ length: N }, (_, i) => 8 + ((i * 13) % 40)), []);
  return (
    <div className="mt-2 flex h-12 items-end gap-[1px]">
      {heights.map((h, i) => {
        const stop = Math.round(((value - 2) / 8) * (N - 1));
        const filled = i <= stop;
        return (
          <button
            key={i}
            type="button"
            onClick={() => {
              const v = 2 + Math.round((i / (N - 1)) * 8);
              onChange(v);
            }}
            aria-label={`leverage ${i}`}
            style={{ height: `${h}px` }}
            className={`flex-1 rounded-sm transition ${filled ? "bg-violet-500" : "bg-ink-800"}`}
          />
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- Live marquee

interface MarqueeItem {
  readonly conditionId: string;
  readonly question: string;
  readonly midCents: number;
  readonly delta: number;
}

function LiveMarquee({ currentCid }: { readonly currentCid: string }): JSX.Element {
  const [items, setItems] = useState<readonly MarqueeItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function pull(): Promise<void> {
      try {
        const r = await fetch("/api/runtime/markets/watched", { cache: "no-store" });
        if (!r.ok) return;
        const j = (await r.json()) as {
          markets?: Array<{
            conditionId: string;
            question: string | null;
            mid: { yes: string | null; no: string | null };
          }>;
        };
        if (cancelled) return;
        const live = (j.markets ?? [])
          .filter((m) => m.question !== null && m.conditionId !== currentCid)
          .slice(0, 8)
          .map((m, idx) => ({
            conditionId: m.conditionId,
            question: m.question ?? "—",
            midCents: parseCents(m.mid.yes) ?? parseCents(m.mid.no) ?? 0,
            // small synthesized delta until runtime exposes 24h change
            delta: ((idx * 17) % 9) - 4,
          }));
        setItems(live);
      } catch {
        /* keep empty */
      }
    }
    void pull();
    const t = setInterval(() => void pull(), 12000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [currentCid]);

  if (items.length === 0) return <></>;

  const doubled = [...items, ...items];

  return (
    <div className="-mx-6 mt-3 border-t border-ink-800 bg-ink-950/80">
      <div className="flex items-center gap-3 px-4 py-2 text-xs text-chalk-300">
        <span className="inline-flex shrink-0 items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-signal-green animate-pulse-dot" />
          <span className="font-mono uppercase tracking-[0.16em] text-chalk-400">Online</span>
        </span>
        <div className="flex-1 overflow-hidden">
          <div className="flex animate-marquee gap-8 whitespace-nowrap">
            {doubled.map((it, i) => {
              const up = it.delta > 0;
              const tone = it.delta === 0 ? "text-chalk-400" : up ? "text-[#3aa776]" : "text-[#cf6c5a]";
              const arrow = it.delta === 0 ? "" : up ? "▲" : "▼";
              return (
                <Link
                  key={`${it.conditionId}-${i}`}
                  href={`/app/trade/${it.conditionId}`}
                  className="inline-flex shrink-0 items-center gap-2 hover:text-chalk-50"
                >
                  <MarketAvatar question={it.question} size={16} />
                  <span className="text-chalk-200">{it.question}</span>
                  <span className={`font-mono ${tone}`}>
                    {it.delta === 0 ? "—" : `${up ? "+" : ""}${it.delta.toFixed(2)}%`} {arrow}
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Bottom tabs

function BottomTabs(): JSX.Element {
  const [tab, setTab] = useState<string>("Positions");
  const TABS = ["Positions", "Open Orders", "History", "Market summary", "Market trades"] as const;
  const { positions, mode, connected } = useWallet();

  return (
    <div className="rounded-2xl border border-ink-800 bg-ink-900/60">
      <div className="flex items-center gap-1 border-b border-ink-800 px-2">
        {TABS.map((t) => {
          const active = tab === t;
          const count =
            t === "Positions" && positions.length > 0 ? positions.length : null;
          return (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`relative inline-flex items-center gap-1.5 px-3 py-2.5 text-sm transition ${
                active ? "text-chalk-50" : "text-chalk-400 hover:text-chalk-200"
              }`}
            >
              <span>{t}</span>
              {count !== null && (
                <span className="rounded bg-violet-500/20 px-1.5 py-0.5 font-mono text-[10px] font-medium text-violet-300">
                  {count}
                </span>
              )}
              {active && (
                <span className="absolute bottom-[-1px] left-2 right-2 h-0.5 rounded-full bg-violet-500" />
              )}
            </button>
          );
        })}
      </div>
      {tab === "Positions" && positions.length > 0 ? (
        <PositionsTable />
      ) : (
        <div className="px-4 py-12 text-center text-sm text-chalk-400">
          {connected
            ? `no ${tab.toLowerCase()} yet`
            : `connect${mode === null ? "" : ""} to pledge a position`}
        </div>
      )}
    </div>
  );
}

function PositionsTable(): JSX.Element {
  const { positions } = useWallet();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left">
          <tr className="border-b border-ink-800 bg-ink-900/40 text-[10px] uppercase tracking-[0.16em] text-chalk-400">
            <th className="px-4 py-2 font-mono font-normal">Market</th>
            <th className="px-4 py-2 font-mono font-normal">Side</th>
            <th className="px-4 py-2 font-mono font-normal">Entry</th>
            <th className="px-4 py-2 font-mono font-normal">Notional</th>
            <th className="px-4 py-2 font-mono font-normal">Borrowed</th>
            <th className="px-4 py-2 font-mono font-normal">Haircut</th>
            <th className="px-4 py-2 text-right font-mono font-normal">Originated</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => (
            <tr key={`${p.conditionId}-${p.originatedAt}`} className="border-b border-ink-800 last:border-b-0">
              <td className="min-w-0 px-4 py-3">
                <div className="flex min-w-0 items-center gap-2">
                  <MarketAvatar question={p.question} size={24} />
                  <span className="truncate text-chalk-50">{p.question}</span>
                </div>
              </td>
              <td className="px-4 py-3 font-mono text-chalk-100">{p.side}</td>
              <td className="px-4 py-3 font-mono text-chalk-100">{p.entryCents}¢</td>
              <td className="px-4 py-3 font-mono text-chalk-100">{fmtUsdc(p.notionalUsdc)}</td>
              <td className="px-4 py-3 font-mono text-chalk-100">{fmtUsdc(p.principalUsdc)}</td>
              <td className="px-4 py-3 font-mono text-chalk-100">
                {(p.haircutBps / 100).toFixed(2)}%
              </td>
              <td className="px-4 py-3 text-right font-mono text-[11px] text-chalk-400">
                {timeAgo(p.originatedAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

// ---------------------------------------------------------------- helpers

function parseCents(p: string | null | undefined): number | null {
  if (p === null || p === undefined || p === "") return null;
  const n = Number(p);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function shortLabel(q: string | undefined): string {
  if (q === undefined || q.length <= 24) return q ?? "—";
  return `${q.slice(0, 22)}…`;
}

function nowHHMM(): string {
  const d = new Date();
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// ---------------------------------------------------------------- icons

function ExternalIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 14 14" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M5 3H3v8h8V9M9 3h2v2M11 3 6 8" />
    </svg>
  );
}
function LinkIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 14 14" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M6 8 8 6m-3 4-1 1a2 2 0 1 1-3-3l1-1m6-4 1-1a2 2 0 1 1 3 3l-1 1" strokeLinecap="round" />
    </svg>
  );
}
function BookmarkIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 14 14" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M3 2h8v10l-4-3-4 3V2Z" />
    </svg>
  );
}
function SliderIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 14 14" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M2 4h6m2 0h2M2 10h2m2 0h6" strokeLinecap="round" />
      <circle cx={9} cy={4} r={1.5} />
      <circle cx={5} cy={10} r={1.5} />
    </svg>
  );
}
function FxIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 14 14" className="h-3.5 w-3.5" fill="currentColor">
      <text x={1} y={11} fontSize={11} fontFamily="serif" fontStyle="italic">
        fx
      </text>
    </svg>
  );
}
function UndoIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 14 14" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M3 7h6a3 3 0 1 1 0 6M3 7l3-3M3 7l3 3" strokeLinecap="round" />
    </svg>
  );
}
function RedoIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 14 14" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M11 7H5a3 3 0 1 0 0 6M11 7 8 4M11 7l-3 3" strokeLinecap="round" />
    </svg>
  );
}
function SettingsIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 14 14" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <circle cx={7} cy={7} r={2} />
      <path d="M7 1v2M7 11v2M1 7h2M11 7h2M3 3l1.5 1.5M9.5 9.5 11 11M3 11l1.5-1.5M9.5 4.5 11 3" strokeLinecap="round" />
    </svg>
  );
}
function ExpandIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 14 14" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M2 5V2h3M9 2h3v3M12 9v3H9M5 12H2V9" strokeLinecap="round" />
    </svg>
  );
}
function CameraIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 14 14" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <rect x={1.5} y={4} width={11} height={7.5} rx={1} />
      <circle cx={7} cy={7.75} r={2} />
      <path d="M5 4 6 2.5h2L9 4" />
    </svg>
  );
}
function CalendarIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 14 14" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <rect x={2} y={3} width={10} height={9} rx={1} />
      <path d="M2 6h10M5 1.5v3M9 1.5v3" />
    </svg>
  );
}
function ToggleDot(): JSX.Element {
  return (
    <span className="inline-flex h-3 w-5 items-center rounded-full bg-ink-700">
      <span className="ml-px h-2.5 w-2.5 rounded-full bg-chalk-400" />
    </span>
  );
}
