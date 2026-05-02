"use client";

/**
 * `<AgentBand>` — full-width hero band shown above the markets table.
 *
 * Replaces the old `<LiveStrip>` with a surface that broadcasts what
 * VANTA *is doing right now*: posture line + 4 reasoning loops + last
 * signed decision + ambient identity strip.
 *
 * Polls /api/runtime/state every 6s. Falls back to a neutral skeleton
 * when the runtime is offline so the page never reads as broken.
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

function fmtRunway(days: number): string {
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
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
  const watchBand = positions.length;
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

  const genesisDate = att.genesis_ts_unix_ms !== null
    ? new Date(att.genesis_ts_unix_ms).toISOString().slice(5, 10)
    : "—";

  return (
    <section
      aria-label="VANTA — agent posture"
      className="overflow-hidden rounded-2xl border border-ink-800 bg-ink-900/60"
    >
      {/* ─── Posture line ─────────────────────────────────────── */}
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2 border-b border-ink-800 px-5 py-4">
        <div className="flex items-center gap-2">
          <span aria-hidden className="grid h-1.5 w-1.5 place-items-center">
            <span className="h-1.5 w-1.5 rounded-full bg-violet-500 animate-pulse" />
          </span>
          <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-chalk-400">
            VANTA · right now
          </span>
        </div>

        <p className="text-base text-chalk-100 sm:text-lg">
          <span className="text-chalk-50">Watching </span>
          <span className="font-display font-semibold text-chalk-50">{watching}</span>
          <span className="text-chalk-50"> markets</span>
          {probation > 0 && (
            <>
              <span className="text-chalk-400"> · </span>
              <span className="font-display font-semibold text-chalk-50">{probation}</span>
              <span className="text-chalk-200"> in onboarding probation</span>
            </>
          )}
          {watchBand > 0 && (
            <>
              <span className="text-chalk-400"> · </span>
              <span className="font-display font-semibold text-chalk-50">{watchBand}</span>
              <span className="text-chalk-200"> position{watchBand === 1 ? "" : "s"} on the books</span>
            </>
          )}
          <span className="text-chalk-400"> · </span>
          <span className="text-chalk-200">runway </span>
          <span className="font-display font-semibold text-chalk-50">{fmtRunway(runway)}</span>
          <span className="text-chalk-400"> · </span>
          <span className="text-chalk-200">earned today </span>
          <span className="font-display font-semibold text-signal-green">${earned}</span>
        </p>
      </div>

      {/* ─── Loop pulse strip ─────────────────────────────────── */}
      <div className="border-b border-ink-800 px-5 py-3">
        <AgentLoopPulse loops={loops} />
      </div>

      {/* ─── Last signed decision ─────────────────────────────── */}
      <div className="flex flex-col gap-1.5 border-b border-ink-800 px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="flex flex-wrap items-baseline gap-2 min-w-0">
          <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-chalk-400">
            last decision
          </span>
          {lastDecision !== null && (
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-violet-300">
              {decisionTypeLabel(lastDecision.type)}
            </span>
          )}
          <span className="text-sm text-chalk-100 truncate">
            {decisionSummary(lastDecision)}
          </span>
          <span className="font-mono text-[11px] text-chalk-400">
            {lastDecision === null ? "" : `${fmtAge(lastDecision.age_s)} ago`}
          </span>
        </div>
        {lastDecision !== null ? (
          <Link
            href={`/events?id=${lastDecision.id}`}
            className="self-start whitespace-nowrap rounded-md border border-ink-700 bg-ink-900 px-2.5 py-1 font-mono text-[11px] text-chalk-200 transition hover:border-violet-500/60 hover:text-chalk-50 sm:self-auto"
          >
            view chain →
          </Link>
        ) : null}
      </div>

      {/* ─── Identity micro-strip ─────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-chalk-400">
        <span>image <span className="text-chalk-200 normal-case tracking-normal">{shortHex(att.enclave_identity_hash)}</span></span>
        <span aria-hidden>·</span>
        <span>genesis <span className="text-chalk-200 normal-case tracking-normal">{genesisDate}</span></span>
        <span aria-hidden>·</span>
        <span>kms <span className="text-chalk-200 normal-case tracking-normal">{att.kms_kind ?? "—"}</span></span>
        <span aria-hidden>·</span>
        <span>signed <span className="text-chalk-200 normal-case tracking-normal">{shortHex(att.signing_pub_key)}</span></span>
        <span aria-hidden>·</span>
        <span>attestation <span className="text-signal-green normal-case tracking-normal">{fmtAge(attestAgeS)}</span> ago</span>
      </div>
    </section>
  );
}
