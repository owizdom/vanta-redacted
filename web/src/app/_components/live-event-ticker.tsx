"use client";

import { useEffect, useState } from "react";

interface TickerItem {
  readonly id: string;
  readonly type: string;
  readonly age: string;
}

const SAMPLE: readonly TickerItem[] = [
  { id: "loop.credit_tick", type: "credit", age: "ok · ltv 47%" },
  { id: "reasoning.trace", type: "trace", age: "depth-shape healthy" },
  { id: "loop.onboard_decision", type: "onboard", age: "fomc-2026 · cap $25k" },
  { id: "op.treasury_alert", type: "ops", age: "runway 92d" },
  { id: "loan.origination", type: "credit", age: "0xa6004c · 124,500 USDC" },
  { id: "reasoning.trace", type: "trace", age: "cluster-saturated tag" },
  { id: "loop.calibration_proposal", type: "model", age: "α/β/γ within band" },
  { id: "loop.credit_tick", type: "credit", age: "ok · ltv 31%" },
];

const COLOR: Record<string, string> = {
  credit: "text-signal-green",
  trace: "text-chalk-400",
  onboard: "text-signal-amber",
  ops: "text-chalk-200",
  model: "text-signal-amber",
};

export function LiveEventTicker(): JSX.Element {
  const [items, setItems] = useState<readonly TickerItem[]>(SAMPLE);

  useEffect(() => {
    let cancelled = false;
    async function pull(): Promise<void> {
      try {
        const r = await fetch("/api/runtime/events", { cache: "no-store" });
        if (!r.ok) return;
        const j = (await r.json()) as {
          events?: Array<{ id: string; type: string; body?: Record<string, unknown> }>;
        };
        if (cancelled) return;
        const tail = (j.events ?? []).slice(-12).reverse();
        if (tail.length === 0) return;
        setItems(
          tail.map((e) => ({
            id: e.id.slice(0, 8),
            type:
              e.type.startsWith("loop.")
                ? e.type.includes("credit")
                  ? "credit"
                  : e.type.includes("calibration")
                    ? "model"
                    : "onboard"
                : e.type.startsWith("op.")
                  ? "ops"
                  : "trace",
            age: e.type,
          })),
        );
      } catch {
        /* runtime not running — keep sample */
      }
    }
    void pull();
    const t = setInterval(() => void pull(), 4000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  // Duplicate the list so the marquee loop is seamless.
  const doubled = [...items, ...items];

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 border-t border-ink-800 bg-ink-950/90 backdrop-blur">
      <div className="flex items-center gap-3 border-b border-ink-800/60 bg-ink-900 px-4 py-1.5 text-[10px] uppercase tracking-[0.22em] text-chalk-400">
        <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-signal-green" />
        signed event log · live
      </div>
      <div className="overflow-hidden">
        <div className="flex animate-marquee gap-10 whitespace-nowrap px-6 py-3 font-mono text-xs text-chalk-200">
          {doubled.map((it, i) => (
            <span key={`${it.id}-${String(i)}`} className="flex items-center gap-3">
              <span className={`uppercase tracking-[0.16em] ${COLOR[it.type] ?? "text-chalk-200"}`}>
                {it.type}
              </span>
              <span className="text-chalk-400">{it.id}</span>
              <span>{it.age}</span>
              <span className="text-ink-600">·</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
