"use client";

import { useEffect, useState } from "react";

interface LoopRow {
  readonly name: string;
  readonly cadence: string;
  readonly description: string;
  readonly tickRate: string;
  readonly emits: readonly string[];
}

const LOOPS: readonly LoopRow[] = [
  {
    name: "credit",
    cadence: "60s",
    description:
      "Per-loan health monitor. Reads best-bid + 30-min TWAP, dispute history, depth, time-to-resolution. Flags watch at 60% LTV, freeze at 70%, contract liquidates at 77%.",
    tickRate: "every loan, every 60s",
    emits: ["loop.credit_tick", "reasoning.trace"],
  },
  {
    name: "model",
    cadence: "weekly",
    description:
      "Calibration drift detector. Replays the formula against a public resolved-markets dataset; emits a proposal to the 4-of-7 lender multisig (7-day timelock) when realized error breaches 200 bps.",
    tickRate: "1× / week",
    emits: ["loop.calibration_proposal", "reasoning.trace"],
  },
  {
    name: "operational",
    cadence: "1h",
    description:
      "Runway + cost monitor. Flags treasury alerts under 60 days runway, gas spikes above the trailing-30d 95th percentile, inference-cost step changes, oracle-read failures.",
    tickRate: "1× / hour",
    emits: ["op.treasury_alert", "op.operational_anomaly", "reasoning.trace"],
  },
  {
    name: "onboarding",
    cadence: "6h",
    description:
      "Candidate-market scheduler. Runs the 7-gate floor; for passing candidates the agent reasons about resolution-text clarity, depth-shape, cluster correlation. Caps at 3 onboards / 24h.",
    tickRate: "1× / 6h",
    emits: ["loop.onboard_decision", "reasoning.trace"],
  },
];

export function LoopStatus(): JSX.Element {
  const [activeIdx, setActiveIdx] = useState(0);
  const [counts, setCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    let cancelled = false;
    async function pull(): Promise<void> {
      try {
        const r = await fetch("/api/runtime/events", { cache: "no-store" });
        if (!r.ok) return;
        const j = (await r.json()) as {
          events?: Array<{ type: string }>;
        };
        if (cancelled) return;
        const next: Record<string, number> = {};
        for (const e of j.events ?? []) {
          if (e.type === "loop.credit_tick") next.credit = (next.credit ?? 0) + 1;
          else if (e.type === "loop.calibration_proposal")
            next.model = (next.model ?? 0) + 1;
          else if (e.type === "loop.onboard_decision")
            next.onboarding = (next.onboarding ?? 0) + 1;
          else if (e.type.startsWith("op.")) next.operational = (next.operational ?? 0) + 1;
        }
        setCounts(next);
      } catch {
        /* runtime not running */
      }
    }
    void pull();
    const t = setInterval(() => void pull(), 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const active = LOOPS[activeIdx]!;

  return (
    <section className="border-t border-ink-800/60">
      <div className="mx-auto max-w-6xl px-6 py-24">
        <div className="flex items-end justify-between gap-6">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-chalk-400">
              continuous reasoning loops
            </p>
            <h2 className="mt-4 font-display text-3xl font-semibold tracking-tight sm:text-5xl">
              Four loops, always on.
            </h2>
          </div>
          <p className="hidden max-w-md text-chalk-200 sm:block">
            None of them can move funds. They reason; the contract gates and
            the lender quorum act. Every tick signs a trace.
          </p>
        </div>

        <div className="mt-12 grid gap-px overflow-hidden rounded-xl border border-ink-700 bg-ink-700 lg:grid-cols-[1fr_2fr]">
          <ul className="bg-ink-900">
            {LOOPS.map((l, i) => {
              const isActive = i === activeIdx;
              return (
                <li key={l.name}>
                  <button
                    type="button"
                    onClick={() => setActiveIdx(i)}
                    className={`flex w-full items-center justify-between border-b border-ink-700 px-6 py-5 text-left transition last:border-b-0 ${
                      isActive ? "bg-ink-800" : "hover:bg-ink-800/50"
                    }`}
                  >
                    <div>
                      <span className="font-display text-lg font-semibold capitalize">
                        {l.name}
                      </span>
                      <p className="mt-1 font-mono text-xs uppercase tracking-[0.16em] text-chalk-400">
                        {l.cadence}
                      </p>
                    </div>
                    <span className="font-mono text-sm text-signal-green">
                      {counts[l.name] ?? 0}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="bg-ink-900 p-8">
            <span className="font-mono text-xs uppercase tracking-[0.18em] text-signal-green">
              {active.name}
            </span>
            <h3 className="mt-3 font-display text-3xl font-semibold tracking-tight">
              {active.tickRate}
            </h3>
            <p className="mt-4 max-w-prose text-chalk-200">{active.description}</p>
            <p className="mt-6 font-mono text-xs uppercase tracking-[0.16em] text-chalk-400">
              emits
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {active.emits.map((e) => (
                <code
                  key={e}
                  className="rounded border border-ink-700 bg-ink-800 px-2 py-1 font-mono text-xs text-chalk-200"
                >
                  {e}
                </code>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
