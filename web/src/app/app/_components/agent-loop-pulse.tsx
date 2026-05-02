"use client";

/**
 * Loop status pills — one per reasoning loop. A loop is "active" when
 * its last tick is within 1.5× its cadence; long-cadence loops (model,
 * onboarding) read as inactive between ticks, which is honest.
 *
 * Visual chrome matches the AgentBand card design: dark pill, bordered,
 * violet-400 dot when active, neutral gray when idle.
 */

import type { LoopFreshness } from "@/lib/runtime";

type LoopName = "credit" | "model" | "operational" | "onboarding";

const LABELS: Record<LoopName, string> = {
  credit: "Credit",
  model: "Model",
  operational: "Operational",
  onboarding: "Onboarding",
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

function isActive(f: LoopFreshness): boolean {
  return f.age_s !== null && f.age_s <= f.interval_s * 1.5;
}

function StatusPill({
  label,
  cadence,
  active,
  ageLabel,
  etaLabel,
}: {
  readonly label: string;
  readonly cadence: string;
  readonly active: boolean;
  readonly ageLabel: string;
  readonly etaLabel: string | null;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2 rounded-md border border-[#2c2c2e] bg-[#1c1c1e] px-3 py-1.5">
      <span className="relative flex h-1.5 w-1.5">
        {active && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-violet-400 opacity-40" />
        )}
        <span
          className={`relative inline-flex h-1.5 w-1.5 rounded-full ${
            active ? "bg-violet-400" : "bg-[#48484a]"
          }`}
        />
      </span>
      <span className="text-[11px] font-medium uppercase tracking-wide text-[#8e8e93]">
        {label}
      </span>
      <span className="text-[11px] font-semibold text-[#e5e5ea]">{cadence}</span>
      <span className="text-[#48484a]">·</span>
      <span className="font-mono text-[11px] text-[#8e8e93]">{ageLabel}</span>
      {etaLabel !== null && (
        <span className="hidden font-mono text-[11px] text-[#636366] sm:inline">{etaLabel}</span>
      )}
    </div>
  );
}

export function AgentLoopPulse({
  loops,
}: {
  readonly loops: Record<LoopName, LoopFreshness>;
}): JSX.Element {
  return (
    <div className="flex flex-wrap gap-2">
      {(Object.keys(LABELS) as LoopName[]).map((k) => {
        const f = loops[k];
        const active = isActive(f);
        const eta =
          f.interval_s <= 5 * 60
            ? `next ${String(Math.max(0, f.next_eta_s))}s`
            : null;
        return (
          <StatusPill
            key={k}
            label={LABELS[k]}
            cadence={CADENCE[k]}
            active={active}
            ageLabel={`${fmtAge(f.age_s)} ago`}
            etaLabel={eta}
          />
        );
      })}
    </div>
  );
}
