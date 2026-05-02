"use client";

/**
 * `<AgentBand>` — VANTA's "right now" status card.
 *
 * Shipped above the markets table on /app. Polls /api/runtime/state +
 * /.well-known/attestation every 6s and renders:
 *   - header (live dot + wordmark)
 *   - hero metric (earned today, with markets/runway/probation/positions
 *     stacked on the right)
 *   - 4 loop pills (credit/model/operational/onboarding)
 *   - last signed decision pill, with a "view chain →" link
 *   - identity meta strip (image hash, genesis, KMS, signing key, attestation age)
 *
 * Color palette pinned inline (matches the card design reference); doesn't
 * depend on the global ink/chalk tokens so the card reads correctly on
 * any background and visual drift between the design and runtime UI is
 * impossible.
 */

import Link from "next/link";
import { useEffect, useState } from "react";

import {
  fetchAgentState,
  type AgentState,
} from "@/lib/runtime";

import { AgentLoopPulse } from "./agent-loop-pulse";

interface Attestation {
  signing_pub_key: string | null;
  enclave_identity_hash: string | null;
  genesis_event_id: string | null;
  genesis_ts_unix_ms: number | null;
  kms_kind: string | null;
  fetched_at_ms: number;
}

const ATTEST_FALLBACK: Attestation = {
  signing_pub_key: null,
  enclave_identity_hash: null,
  genesis_event_id: null,
  genesis_ts_unix_ms: null,
  kms_kind: null,
  fetched_at_ms: 0,
};

function shortHex(h: string | null, n = 4): string {
  if (h === null || h.length === 0) return "—";
  const trimmed = h.replace(/^0x/, "");
  return `${trimmed.slice(0, n)}…${trimmed.slice(-n)}`;
}

function fmtAge(secs: number | null): string {
  if (secs === null) return "—";
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86_400)}d`;
}

function fmtRunwayDays(days: number): { value: string; suffix: string } {
  if (days <= 0) return { value: "0", suffix: "d" };
  if (days < 60) return { value: String(days), suffix: "d" };
  if (days < 365) return { value: String(Math.floor(days / 30)), suffix: "mo" };
  return { value: String((days / 365).toFixed(1)), suffix: "y" };
}

function decisionSummary(d: AgentState["last_decision"]): string {
  if (d === null) return "no signed decision yet";
  const body = d.body;
  if (d.type === "loop.onboard_decision") {
    const decision = (body["decision"] as string | undefined) ?? "decided";
    const cap = body["cap_initial_usdc"] as string | undefined;
    const ltv = body["ltv_max_bps"] as number | undefined;
    const gates = body["gate_results"] as
      | ReadonlyArray<{ pass: boolean }>
      | undefined;
    const passed = gates?.filter((g) => g.pass).length ?? 0;
    const total = gates?.length ?? 0;
    const capUsd = cap !== undefined
      ? `$${(Number(cap) / 1_000_000).toFixed(0)}`
      : "—";
    const ltvPct = ltv !== undefined ? `${(ltv / 100).toFixed(0)}%` : "—";
    return `${decision} · cap ${capUsd} · LTV ${ltvPct} · ${passed}/${total} gates ✓`;
  }
  if (d.type === "loop.credit_tick") {
    const flag = (body["flag"] as string | undefined) ?? "ok";
    const ltv = body["ltv_current_bps"] as number | undefined;
    const ltvPct = ltv !== undefined ? `${(ltv / 100).toFixed(1)}%` : "—";
    return `credit ${flag} · LTV ${ltvPct}`;
  }
  if (d.type === "op.treasury_alert") {
    const sev = (body["severity"] as string | undefined) ?? "warning";
    const days = body["runway_days"] as number | undefined;
    return `treasury ${sev} · runway ${days ?? "—"}d`;
  }
  if (d.type === "op.operational_anomaly") {
    const kind = (body["kind"] as string | undefined) ?? "anomaly";
    return `anomaly · ${kind}`;
  }
  if (d.type === "loop.calibration_proposal") {
    const err = body["error_bps"] as number | undefined;
    return `calibration · error ${err ?? "—"}bps`;
  }
  return d.type;
}

function decisionTypeLabel(t: string): string {
  return t.replace(/^loop\.|^op\./, "").replace(/_/g, " ");
}

function DecisionIcon({ hasDecision }: { readonly hasDecision: boolean }): JSX.Element {
  if (!hasDecision) {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#7e8694" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8a78ff" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function HeroStat({
  label,
  value,
  suffix,
}: {
  readonly label: string;
  readonly value: string;
  readonly suffix?: string;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-[0.15em] text-chalk-400">
        {label}
      </span>
      <span className="text-lg font-semibold text-chalk-50">
        {value}
        {suffix !== undefined && (
          <span className="font-normal text-chalk-400">{suffix}</span>
        )}
      </span>
    </div>
  );
}

function MetaItem({
  label,
  value,
  separator = false,
  valueClass = "text-chalk-200",
}: {
  readonly label: string;
  readonly value: string | null;
  readonly separator?: boolean;
  readonly valueClass?: string;
}): JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      {separator && <span aria-hidden className="mr-1 text-chalk-600">·</span>}
      <span className="text-[10px] font-medium uppercase tracking-widest text-chalk-400">{label}</span>
      <span className={`text-[10px] font-semibold ${valueClass}`}>{value ?? "—"}</span>
    </div>
  );
}

export function AgentBand(): JSX.Element {
  const [state, setState] = useState<AgentState | null>(null);
  const [att, setAtt] = useState<Attestation>(ATTEST_FALLBACK);

  useEffect(() => {
    let cancelled = false;
    async function tick(): Promise<void> {
      const [s, aRes] = await Promise.all([
        fetchAgentState(),
        fetch("/.well-known/attestation", { cache: "no-store" }).catch(
          () => null,
        ),
      ]);
      if (cancelled) return;
      if (s !== null) setState(s);
      if (aRes !== null && aRes.ok) {
        try {
          const j = (await aRes.json()) as {
            signing_pub_key?: string;
            enclave_identity_hash?: string;
            genesis_event_id?: string;
            genesis_ts_unix_ms?: number;
            kms_anchor?: { kind?: string };
          };
          setAtt({
            signing_pub_key: j.signing_pub_key ?? null,
            enclave_identity_hash: j.enclave_identity_hash ?? null,
            genesis_event_id: j.genesis_event_id ?? null,
            genesis_ts_unix_ms: j.genesis_ts_unix_ms ?? null,
            kms_kind: j.kms_anchor?.kind ?? null,
            fetched_at_ms: Date.now(),
          });
        } catch { /* keep prior */ }
      }
    }
    void tick();
    const t = setInterval(() => void tick(), 6000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  const watching = state?.watching_n ?? 0;
  const positions = state?.positions ?? [];
  const probation = state?.probation_n ?? 0;
  const earned = state?.earned_today_usdc ?? "0.00";
  const runway = state?.runway_days ?? 0;
  const lastDecision = state?.last_decision ?? null;

  const loops = state?.loops ?? {
    credit:      { age_s: null, next_eta_s: 60,             interval_s: 60 },
    model:       { age_s: null, next_eta_s: 7 * 24 * 3600,  interval_s: 7 * 24 * 3600 },
    operational: { age_s: null, next_eta_s: 3600,           interval_s: 3600 },
    onboarding:  { age_s: null, next_eta_s: 6 * 3600,       interval_s: 6 * 3600 },
  };

  const attestAgeS = att.fetched_at_ms === 0
    ? null
    : Math.floor((Date.now() - att.fetched_at_ms) / 1000);
  const genesisShort = att.genesis_ts_unix_ms !== null
    ? new Date(att.genesis_ts_unix_ms).toISOString().slice(5, 10)
    : null;

  const runwayParts = fmtRunwayDays(runway);

  return (
    <section
      aria-label="VANTA — agent posture"
      className="relative overflow-hidden rounded-2xl border border-ink-800 bg-ink-900 shadow-2xl shadow-black/50"
    >
      {/* Top hairline gradient */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-ink-700 to-transparent"
      />

      <div className="p-6 sm:p-8">
        {/* ─── Header ───────────────────────────────────────── */}
        <div className="mb-7 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="relative inline-flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-violet-500 opacity-40" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-violet-500" />
            </span>
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-bold uppercase tracking-[0.15em] text-chalk-50">
                Vanta
              </span>
              <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-chalk-400">
                Right now
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-chalk-600">
            <span className="relative inline-flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-violet-400 opacity-30" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-violet-500" />
            </span>
            <span className="font-medium uppercase tracking-wide">Live</span>
          </div>
        </div>

        {/* ─── Hero metrics ────────────────────────────────── */}
        <div className="mb-7 flex flex-col justify-between gap-6 sm:flex-row sm:items-end">
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-medium uppercase tracking-[0.15em] text-chalk-400">
              Earned today
            </span>
            <span className="font-display text-4xl font-light tracking-tight text-chalk-50 sm:text-5xl">
              <span className="font-normal text-violet-400">$</span>
              {earned}
            </span>
          </div>
          <div className="flex items-end gap-6 sm:gap-8">
            <HeroStat label="Markets" value={String(watching)} />
            {probation > 0 && <HeroStat label="Probation" value={String(probation)} />}
            {positions.length > 0 && (
              <HeroStat label="Positions" value={String(positions.length)} />
            )}
            <HeroStat label="Runway" value={runwayParts.value} suffix={runwayParts.suffix} />
          </div>
        </div>

        {/* ─── Loop pills ──────────────────────────────────── */}
        <div className="mb-7">
          <AgentLoopPulse loops={loops} />
        </div>

        {/* Divider */}
        <div className="mb-6 h-px bg-ink-800" />

        {/* ─── Last decision ────────────────────────────────── */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-chalk-600">
              Last decision
            </span>
            <span className="text-[10px] text-chalk-400">
              {lastDecision === null ? "—" : `${fmtAge(lastDecision.age_s)} ago`}
            </span>
          </div>
          <div
            className={`flex items-center gap-3 rounded-lg border px-4 py-3.5 ${
              lastDecision === null
                ? "border-dashed border-ink-800 bg-ink-950"
                : "border-ink-800 bg-ink-950"
            }`}
          >
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink-800">
              <DecisionIcon hasDecision={lastDecision !== null} />
            </div>
            <div className="flex min-w-0 flex-1 items-baseline gap-2">
              {lastDecision !== null && (
                <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.18em] text-violet-400">
                  {decisionTypeLabel(lastDecision.type)}
                </span>
              )}
              <span
                className={`truncate text-sm font-medium ${
                  lastDecision === null ? "text-chalk-400" : "text-chalk-50"
                }`}
              >
                {decisionSummary(lastDecision)}
              </span>
            </div>
            {lastDecision !== null && (
              <Link
                href={`/events?id=${lastDecision.id}`}
                className="shrink-0 whitespace-nowrap rounded-md border border-ink-700 bg-ink-800 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide text-chalk-200 transition hover:border-violet-500/40 hover:text-chalk-50"
              >
                view chain →
              </Link>
            )}
          </div>
        </div>
      </div>

      {/* ─── Bottom meta bar ─────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-ink-800 bg-ink-950 px-6 py-4 sm:px-8">
        <MetaItem label="Image" value={shortHex(att.enclave_identity_hash)} />
        <MetaItem label="Genesis" value={genesisShort ?? "—"} separator />
        <MetaItem label="KMS" value={att.kms_kind ?? "—"} separator />
        <MetaItem label="Signed" value={shortHex(att.signing_pub_key)} separator />
        <MetaItem
          label="Attestation"
          value={`${fmtAge(attestAgeS)}`}
          separator
          valueClass="text-violet-400"
        />
        <span className="text-[10px] font-medium uppercase tracking-widest text-chalk-600">
          ago
        </span>
      </div>
    </section>
  );
}
