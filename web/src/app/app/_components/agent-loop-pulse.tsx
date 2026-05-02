"use client";

/**
 * Four-dot loop cadence strip. Each dot represents one of VANTA's
 * reasoning loops (paper §7); pulse opacity is tied to freshness so a
 * loop that just ticked glows briefly, and a long-cadence loop reads
 * as quietly alive instead of stuck.
 *
 * Used by `<AgentBand>` (permanent surface on /app) and by `<AgentChip>`
 * (top-nav popover). Keeping the layout primitive separate from the
 * data fetcher lets both surfaces stay visually consistent.
 */

import type { LoopFreshness } from "@/lib/runtime";

type LoopName = "credit" | "model" | "operational" | "onboarding";

const LABELS: Record<LoopName, string> = {
  credit: "credit",
  model: "model",
  operational: "operational",
  onboarding: "onboarding",
};

const CADENCE: Record<LoopName, string> = {
  credit: "60s",
  model: "wk",
  operational: "1h",
  onboarding: "6h",
};

function fmtAge(secs: number | null): string {
  if (secs === null) return "—";
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86_400)}d`;
}

function fmtEta(secs: number, intervalS: number): string {
  // For the credit loop (60s cadence) we surface a live countdown.
  // Other loops just show "wk" / "1h" / "6h" cadence labels — a
  // countdown feels misleading when the loop is hours away.
  if (intervalS <= 5 * 60) {
    return `next ${String(Math.max(0, secs))}s`;
  }
  return "—";
}

function dotTone(ageS: number | null, intervalS: number): {
  bg: string;
  ring: string;
} {
  if (ageS === null) return { bg: "bg-ink-700", ring: "ring-ink-700/40" };
  // Healthy if ageS < 1.5 × interval. Anything older has missed a tick.
  if (ageS <= intervalS * 1.5) return { bg: "bg-signal-green", ring: "ring-signal-green/40" };
  if (ageS <= intervalS * 4) return { bg: "bg-signal-amber", ring: "ring-signal-amber/40" };
  return { bg: "bg-signal-red", ring: "ring-signal-red/40" };
}

export function AgentLoopPulse({
  loops,
}: {
  readonly loops: Record<LoopName, LoopFreshness>;
}): JSX.Element {
  return (
    <ul className="flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-[11px]">
      {(Object.keys(LABELS) as LoopName[]).map((k) => {
        const f = loops[k];
        const tone = dotTone(f.age_s, f.interval_s);
        return (
          <li key={k} className="flex items-center gap-2">
            <span
              aria-hidden
              className={`relative grid h-2 w-2 place-items-center rounded-full ${tone.bg} ring-2 ${tone.ring}`}
            >
              <span
                className={`absolute inset-0 rounded-full ${tone.bg} animate-ping opacity-60`}
                style={{
                  animationDuration:
                    f.interval_s <= 90
                      ? "1.5s"
                      : f.interval_s <= 60 * 60
                        ? "3s"
                        : "5s",
                }}
              />
            </span>
            <span className="text-chalk-300">{LABELS[k]}</span>
            <span className="text-chalk-500">{CADENCE[k]}</span>
            <span className="text-chalk-400">·</span>
            <span className="text-chalk-200">{fmtAge(f.age_s)} ago</span>
            <span className="text-chalk-500 hidden sm:inline">{fmtEta(f.next_eta_s, f.interval_s)}</span>
          </li>
        );
      })}
    </ul>
  );
}
