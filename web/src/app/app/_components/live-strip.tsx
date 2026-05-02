"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { MarketAvatar } from "./avatar";
import { TreasuryCard } from "./treasury-card";

interface LiveItem {
  readonly conditionId: string;
  readonly question: string;
  readonly mid: string;
  readonly delta: string;
  readonly leverage: string;
}

const SAMPLE: readonly LiveItem[] = [
  {
    conditionId: "1d519b87999e3d4e90e1e8f57b5eee73a0ba488ff3fdb70867f294733aba84a9",
    question: "Will Andy Beshear win the 2028 Democratic nomination?",
    mid: "11¢",
    delta: "−4.00%",
    leverage: "50% LTV",
  },
  {
    conditionId: "cdb1f0400949238a63d3e88243d2ada08cd9c2a71985ced9f0cfd5e66354cf90",
    question: "Will the USA win the 2026 FIFA World Cup?",
    mid: "13¢",
    delta: "−2.90%",
    leverage: "50% LTV",
  },
  {
    conditionId: "4c325469d9b516ef4e6b8f73a81a12607dec075e3c2fd454f91765aaeafc4760",
    question: "Will Pete Buttigieg win the 2028 Democratic nomination?",
    mid: "15¢",
    delta: "+1.20%",
    leverage: "50% LTV",
  },
  {
    conditionId: "0c4cd2055d6ea89354ffddc55d6dbcef9355748112ea952fc925f3db6a5c457f",
    question: "Will Argentina win the 2026 FIFA World Cup?",
    mid: "22¢",
    delta: "+3.40%",
    leverage: "50% LTV",
  },
  {
    conditionId: "30d55d8124ee1e12dabe89201badc45669b81dff69e4ce44d961f32878ec178a",
    question: "Will Brazil win the 2026 FIFA World Cup?",
    mid: "27¢",
    delta: "−1.10%",
    leverage: "50% LTV",
  },
];

const PAGE_SIZE = 3;

export function LiveStrip(): JSX.Element {
  const [items, setItems] = useState<readonly LiveItem[]>(SAMPLE);
  const [page, setPage] = useState(0);

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
            mid?: { yes: string | null; no: string | null };
          }>;
        };
        if (cancelled) return;
        const live = (j.markets ?? [])
          .filter((m) => m.question !== null)
          .map((m) => ({
            conditionId: m.conditionId,
            question: m.question ?? "—",
            mid:
              m.mid?.yes && m.mid.yes !== ""
                ? `${(Number(m.mid.yes) * 100).toFixed(0)}¢`
                : "—",
            delta: "—",
            leverage: "50% LTV",
          }));
        if (live.length > 0) setItems(live);
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

  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const slice = items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <section className="grid gap-6 lg:grid-cols-[2fr_1fr]">
      <div>
        <div className="mb-3 flex items-center gap-2">
          <svg
            aria-hidden
            viewBox="0 0 16 8"
            className="h-3 w-4 text-signal-green"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <polyline points="0,5 3,5 5,1 8,7 11,3 13,5 16,5" />
          </svg>
          <span className="font-medium text-chalk-200">Live</span>
        </div>

        <div className="overflow-hidden rounded-2xl border border-ink-800 bg-ink-900">
          <ul>
            {slice.map((it) => {
              const isUp = it.delta.startsWith("+");
              return (
                <li key={it.conditionId} className="border-b border-ink-800 last:border-b-0">
                  <Link
                    href={`/app/trade/${it.conditionId}`}
                    className="flex items-center justify-between gap-4 px-4 py-3.5 transition hover:bg-ink-800/40"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <MarketAvatar question={it.question} size={32} />
                      <span className="truncate text-sm text-chalk-100">{it.question}</span>
                      <span className="hidden shrink-0 rounded-md border border-ink-700 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-chalk-400 sm:inline">
                        {it.leverage}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-baseline gap-3">
                      <span className="font-display text-lg font-semibold">{it.mid}</span>
                      <span
                        className={`font-mono text-xs ${
                          it.delta === "—"
                            ? "text-chalk-400"
                            : isUp
                              ? "text-signal-green"
                              : "text-signal-red"
                        }`}
                      >
                        {it.delta}
                      </span>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>

          {/* Pagination */}
          <div className="flex items-center gap-2 border-t border-ink-800 px-4 py-2 font-mono text-[11px] text-chalk-400">
            <span>
              {page + 1}/{totalPages}
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="grid h-6 w-6 place-items-center rounded-md border border-ink-700 hover:border-ink-600 disabled:opacity-40"
              aria-label="Previous"
            >
              ‹
            </button>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="grid h-6 w-6 place-items-center rounded-md border border-ink-700 hover:border-ink-600 disabled:opacity-40"
              aria-label="Next"
            >
              ›
            </button>
          </div>
        </div>
      </div>

      <TreasuryCard />
    </section>
  );
}
