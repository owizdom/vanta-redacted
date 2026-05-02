"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

type LoopName = "credit" | "model" | "operational" | "onboarding";

interface LoopState {
  readonly name: LoopName;
  readonly lastTickAgeSec: number | null;
  readonly status: "ok" | "warn" | "crit" | "idle";
}

interface AgentState {
  readonly online: boolean;
  readonly tdx: boolean;
  readonly pubKey: string | null;
  readonly imageHash: string | null;
  readonly genesisId: string | null;
  readonly kmsKind: string | null;
  readonly rebindAgeSec: number | null;
  readonly loops: ReadonlyArray<LoopState>;
  readonly lastDecisionLabel: string | null;
  readonly lastDecisionAgeSec: number | null;
}

const INITIAL: AgentState = {
  online: false,
  tdx: false,
  pubKey: null,
  imageHash: null,
  genesisId: null,
  kmsKind: null,
  rebindAgeSec: null,
  loops: [
    { name: "credit", lastTickAgeSec: null, status: "idle" },
    { name: "model", lastTickAgeSec: null, status: "idle" },
    { name: "operational", lastTickAgeSec: null, status: "idle" },
    { name: "onboarding", lastTickAgeSec: null, status: "idle" },
  ],
  lastDecisionLabel: null,
  lastDecisionAgeSec: null,
};

const LOOP_DESCRIPTIONS: Record<LoopName, string> = {
  credit: "per-loan health · 60s",
  model: "calibration drift · weekly",
  operational: "runway + anomalies · 1h",
  onboarding: "candidate scheduler · 6h",
};

export function AgentChip(): JSX.Element {
  const [s, setS] = useState<AgentState>(INITIAL);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let rebindAnchorMs: number | null = null;
    async function pull(): Promise<void> {
      try {
        const [aRes, eRes] = await Promise.all([
          fetch("/.well-known/attestation", { cache: "no-store" }),
          fetch("/api/runtime/events", { cache: "no-store" }),
        ]);
        const att = aRes.ok
          ? ((await aRes.json()) as {
              signing_pub_key?: string;
              enclave_identity_hash?: string;
              genesis_event_id?: string;
              kms_anchor?: { kind?: string };
            })
          : null;
        const events = eRes.ok
          ? ((await eRes.json()) as {
              events?: Array<{
                id: string;
                type: string;
                timestamp: number;
              }>;
            })
          : null;
        if (cancelled) return;

        if (att !== null && rebindAnchorMs === null) rebindAnchorMs = Date.now();

        const now = Math.floor(Date.now() / 1000);
        const ageOf = (t: string): number | null => {
          const last = (events?.events ?? []).filter((e) => e.type === t).at(-1);
          return last !== undefined ? Math.max(0, now - last.timestamp) : null;
        };

        const loops: LoopState[] = (
          [
            { name: "credit", t: "loop.credit_tick" },
            { name: "model", t: "loop.calibration_proposal" },
            { name: "operational", t: "op.treasury_alert" },
            { name: "onboarding", t: "loop.onboard_decision" },
          ] as const
        ).map(({ name, t }) => {
          const age = ageOf(t);
          return {
            name,
            lastTickAgeSec: age,
            status: age === null ? "idle" : "ok",
          };
        });

        const lastDecisionEv = (events?.events ?? [])
          .filter((e) =>
            ["loop.credit_tick", "loop.onboard_decision", "loop.calibration_proposal"].includes(
              e.type,
            ),
          )
          .at(-1);

        setS({
          online: att !== null,
          tdx: att?.kms_anchor?.kind === "kms-jwt",
          pubKey: att?.signing_pub_key ?? null,
          imageHash: att?.enclave_identity_hash ?? null,
          genesisId: att?.genesis_event_id ?? null,
          kmsKind: att?.kms_anchor?.kind ?? null,
          rebindAgeSec:
            rebindAnchorMs !== null
              ? Math.floor((Date.now() - rebindAnchorMs) / 1000)
              : null,
          loops,
          lastDecisionLabel:
            lastDecisionEv !== undefined
              ? `${lastDecisionEv.type} · ${lastDecisionEv.id.slice(0, 8)}…`
              : null,
          lastDecisionAgeSec:
            lastDecisionEv !== undefined
              ? Math.max(0, now - lastDecisionEv.timestamp)
              : null,
        });
      } catch {
        if (!cancelled) setS((p) => ({ ...p, online: false }));
      }
    }
    void pull();
    const t = setInterval(() => void pull(), 6000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    function onDoc(ev: MouseEvent): void {
      if (wrapRef.current !== null && !wrapRef.current.contains(ev.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(ev: KeyboardEvent): void {
      if (ev.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pubKeyShort =
    s.pubKey !== null && s.pubKey.length > 12
      ? `${s.pubKey.slice(0, 6)}…${s.pubKey.slice(-4)}`
      : null;
  const imageShort =
    s.imageHash !== null && s.imageHash.length > 12
      ? `${s.imageHash.slice(0, 8)}…${s.imageHash.slice(-4)}`
      : null;
  const genesisShort =
    s.genesisId !== null && s.genesisId.length > 12
      ? `${s.genesisId.slice(0, 8)}…${s.genesisId.slice(-4)}`
      : null;

  const dotColor = !s.online
    ? "bg-signal-red"
    : s.tdx
      ? "bg-signal-green"
      : "bg-signal-amber";

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Agent attestation status"
        className="inline-flex items-center gap-1.5 rounded-md border border-ink-800 bg-ink-900 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-chalk-400 transition hover:border-ink-600 hover:text-chalk-200"
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${dotColor} ${s.online ? "animate-pulse-dot" : ""}`}
        />
        <span className="text-chalk-200">{s.online ? (s.tdx ? "tdx" : "att") : "off"}</span>
        <span className="text-ink-600">·</span>
        <span>vanta</span>
        <svg
          viewBox="0 0 8 8"
          aria-hidden
          className={`h-2 w-2 transition ${open ? "rotate-180" : ""}`}
          fill="currentColor"
        >
          <path d="M4 5.5 1 2.5h6L4 5.5Z" />
        </svg>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Agent details"
          className="absolute right-0 top-[calc(100%+8px)] z-30 w-[360px] overflow-hidden rounded-xl border border-ink-800 bg-ink-950 shadow-[0_24px_64px_-32px_rgba(108,84,255,0.4),0_0_0_1px_rgba(108,84,255,0.08)]"
        >
          {/* Header */}
          <div className="flex items-start justify-between gap-3 border-b border-ink-800 bg-gradient-to-br from-ink-900 to-ink-950 px-4 py-3">
            <div className="flex items-center gap-2.5">
              <span className="relative inline-flex h-7 w-7 items-center justify-center rounded-full bg-violet-500 font-display text-sm font-semibold leading-none text-chalk-50">
                V
                <span
                  className={`absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full ring-2 ring-ink-950 ${dotColor} ${s.online ? "animate-pulse-dot" : ""}`}
                />
              </span>
              <div className="leading-tight">
                <p className="font-display text-sm font-medium tracking-tight">VANTA agent</p>
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-chalk-400">
                  {pubKeyShort ?? (s.online ? "deriving…" : "runtime offline")}
                </p>
              </div>
            </div>
            <Link
              href="/.well-known/attestation"
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[9px] uppercase tracking-[0.16em] transition ${
                s.tdx
                  ? "border-signal-green/40 bg-signal-green/5 text-signal-green hover:bg-signal-green/10"
                  : "border-ink-700 bg-ink-900 text-chalk-400 hover:border-ink-600"
              }`}
            >
              <EigenMark />
              eigencompute · tdx
            </Link>
          </div>

          {/* Loops */}
          <div className="px-4 py-3">
            <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-chalk-500">
              reasoning loops
            </p>
            <ul className="space-y-1.5">
              {s.loops.map((l) => (
                <li key={l.name} className="flex items-center gap-2">
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      l.status === "idle" ? "bg-chalk-600" : "bg-signal-green animate-pulse-dot"
                    }`}
                  />
                  <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-chalk-200">
                    {l.name}
                  </span>
                  <span className="font-mono text-[10px] text-chalk-500">
                    {LOOP_DESCRIPTIONS[l.name]}
                  </span>
                  <span className="ml-auto font-mono text-[11px] text-chalk-300">
                    {l.lastTickAgeSec === null ? "—" : fmtAge(l.lastTickAgeSec)}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* Last decision */}
          <div className="border-t border-ink-800 px-4 py-3">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-chalk-500">
              last decision
            </p>
            <p className="mt-1 truncate font-mono text-xs text-chalk-100">
              {s.lastDecisionLabel ?? "no decisions yet"}
            </p>
            {s.lastDecisionAgeSec !== null && (
              <p className="font-mono text-[11px] text-chalk-400">
                {fmtAge(s.lastDecisionAgeSec)} ago
              </p>
            )}
          </div>

          {/* Telemetry */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-ink-800 bg-ink-900/30 px-4 py-3 font-mono text-[10px] uppercase tracking-[0.14em]">
            <Tele k="image" v={imageShort ?? "—"} />
            <Tele k="genesis" v={genesisShort ?? "—"} />
            <Tele k="kms" v={s.kmsKind ?? "off"} />
            <Tele
              k="rebind"
              v={s.rebindAgeSec !== null ? `${fmtAge(s.rebindAgeSec)} ago` : "—"}
            />
          </div>

          {/* Actions */}
          <div className="flex items-center justify-between border-t border-ink-800 px-4 py-2.5">
            <Link
              href="/events"
              className="font-mono text-[10px] uppercase tracking-[0.16em] text-chalk-400 hover:text-chalk-100"
            >
              audit chain →
            </Link>
            <Link
              href="/.well-known/attestation"
              className="font-mono text-[10px] uppercase tracking-[0.16em] text-chalk-200 hover:text-chalk-50"
            >
              verify attestation →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function Tele({ k, v }: { readonly k: string; readonly v: string }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-chalk-500">{k}</span>
      <span className="truncate text-chalk-200">{v}</span>
    </div>
  );
}

function EigenMark(): JSX.Element {
  return (
    <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" fill="currentColor" aria-hidden>
      <path d="M6 0 0 3l6 3 6-3-6-3Z" />
      <path d="M0 9l6 3 6-3-6-3-6 3Z" opacity={0.55} />
    </svg>
  );
}

function fmtAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}
