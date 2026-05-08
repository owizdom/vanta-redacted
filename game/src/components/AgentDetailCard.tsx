import { useEffect, useMemo, useState } from "react";
import type { Address } from "viem";

import { AgentAvatar } from "./AgentAvatar";
import { AttestationBadge } from "./AttestationBadge";
import { BorrowerFlow } from "./BorrowerFlow";
import { DepositForm } from "./DepositForm";
import { kingdomForAgentId } from "../lib/kingdoms";
import {
  extractImageDigestFromJwt,
  fetchAgent,
  fetchPoolState,
  fetchTee,
  fetchWatchedMarkets,
  formatSignedUsdc6,
  formatUsdc6,
  shortHash,
  type MarketWatched,
  type TeeIdentity,
  type V3AgentRecord,
  type V3PoolState,
} from "../lib/runtime";
import type { ReasoningEvent } from "../lib/stream";

const EIGEN_APP_ID = "0x95F2AB29fAa9A4C834B06B0514428d63C6e0E80d";
const EIGEN_VERIFY_URL = `https://verify.eigencloud.xyz/app/${EIGEN_APP_ID}`;

interface Props {
  readonly agentId: number | null;
  readonly latestReasoning: readonly ReasoningEvent[];
  readonly onClose: () => void;
  readonly onBack: () => void;
}

/**
 * Slide-in agent detail card. Stage 1 is read-only (this slice).
 * Stage 2 (deposit form) lives in DepositForm.tsx and gets slotted
 * in by Slice 4.
 */
export function AgentDetailCard({ agentId, latestReasoning, onClose, onBack }: Props): JSX.Element | null {
  const [agent, setAgent] = useState<V3AgentRecord | null>(null);
  const [pool, setPool] = useState<V3PoolState | null>(null);
  const [markets, setMarkets] = useState<readonly MarketWatched[]>([]);
  const [tee, setTee] = useState<TeeIdentity | null>(null);
  const [loading, setLoading] = useState(false);
  const [borrowOpen, setBorrowOpen] = useState(false);

  const kingdom = agentId !== null ? kingdomForAgentId(agentId) : null;

  // Esc to close.
  useEffect(() => {
    if (agentId === null) return;
    const handle = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [agentId, onClose]);

  // Fetch on agent change.
  useEffect(() => {
    if (agentId === null) {
      setAgent(null);
      setPool(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    Promise.all([
      fetchAgent(agentId),
      fetchPoolState(agentId),
      fetchWatchedMarkets(),
      fetchTee(),
    ])
      .then(([a, p, m, t]) => {
        if (cancelled) return;
        setAgent(a);
        setPool(p);
        setMarkets(m.slice(0, 5));
        setTee(t);
      })
      .catch(() => {
        // runtime offline — keep nulls so the empty state renders
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  const latestForAgent = useMemo(() => {
    if (agentId === null) return null;
    for (let i = latestReasoning.length - 1; i >= 0; --i) {
      const ev = latestReasoning[i]!;
      if (
        ev.agentId === agentId &&
        (ev.type === "reasoning.trace" ||
          ev.type === "op.inference" ||
          ev.type === "council.synthesised" ||
          ev.type === "loan.origination")
      ) {
        return ev;
      }
    }
    return null;
  }, [latestReasoning, agentId]);

  if (agentId === null || !kingdom) return null;

  return (
    <div
      className="fixed inset-0 z-30"
      onClick={onBack}
      style={{
        background: "linear-gradient(90deg, rgba(11,11,14,0.45) 0%, rgba(11,11,14,0.7) 60%)",
      }}
    >
      <aside
        onClick={(e) => e.stopPropagation()}
        className="absolute right-0 top-0 bottom-0 flex w-full max-w-[460px] flex-col bg-ink-900 border-l border-ink-700 shadow-[-24px_0_48px_-12px_rgba(0,0,0,0.6)] animate-slideInRight"
      >
        {/* header */}
        <header
          className="relative flex items-center gap-4 border-b border-ink-700 p-5"
          style={{
            background: `linear-gradient(180deg, ${kingdom.color}22 0%, transparent 100%)`,
          }}
        >
          <AgentAvatar kingdom={kingdom} size={72} />
          <div className="flex-1 min-w-0">
            <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-chalk-500">
              agent #{String(kingdom.agentId)} · {kingdom.compassDirection}
            </div>
            <div className="font-display text-xl font-semibold text-chalk-50 truncate">
              {kingdom.displayName}
            </div>
            <div className="text-xs text-chalk-400 truncate">{kingdom.thesis}</div>
          </div>
          <button
            onClick={onClose}
            className="absolute right-4 top-4 rounded-[2px] border border-ink-700 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.22em] text-chalk-400 hover:text-chalk-100"
          >
            close [esc]
          </button>
        </header>

        {/* body */}
        <div className="flex-1 space-y-5 overflow-y-auto p-5 [scrollbar-width:thin]">
          {loading ? (
            <div className="text-center font-mono text-xs text-chalk-400">loading…</div>
          ) : null}

          {/* live stats */}
          <Section label="live stats">
            <div className="grid grid-cols-2 gap-3">
              <Stat label="TVL" value={pool ? formatUsdc6(pool.nav_usdc6) : "—"} />
              <Stat
                label="share price"
                value={pool ? formatSharePrice(pool.share_price_e18) : "—"}
              />
              <Stat
                label="interest accrued"
                value={pool ? formatSignedUsdc6(pool.realised_pnl_usdc6) : "—"}
                tone={pool && pool.realised_pnl_usdc6.startsWith("-") ? "down" : "up"}
              />
              <Stat
                label="loans outstanding"
                value={pool ? formatUsdc6(pool.open_notional_usdc6) : "—"}
              />
            </div>
          </Section>

          {/* markets watching — collateral markets the agent is willing to lend against */}
          <Section label="markets backed">
            {markets.length === 0 ? (
              <Empty text="no live markets attached yet" />
            ) : (
              <ul className="space-y-1.5">
                {markets.map((m) => (
                  <li
                    key={m.conditionId}
                    className="flex items-start justify-between gap-3 rounded-[2px] border border-ink-700 bg-ink-800/60 p-2 font-mono text-[11px]"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-chalk-200">
                        {m.short_name ?? m.question ?? m.conditionId.slice(0, 12)}
                      </div>
                      <div className="mt-0.5 flex gap-2 text-[10px] text-chalk-500">
                        <span>YES {priceCell(m.mid.yes)}</span>
                        <span>·</span>
                        <span>NO {priceCell(m.mid.no)}</span>
                        {m.stale ? <span className="text-signal-amber">stale</span> : null}
                      </div>
                    </div>
                    {m.polymarket_url ? (
                      <a
                        href={m.polymarket_url}
                        target="_blank"
                        rel="noreferrer"
                        className="shrink-0 text-[10px] uppercase tracking-[0.18em] text-chalk-400 hover:text-chalk-100"
                      >
                        ↗
                      </a>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {/* latest reasoning */}
          <Section label="latest reasoning">
            {latestForAgent ? (
              <article className="rounded-[2px] border border-ink-700 bg-ink-800/60 p-3">
                <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-[0.22em] text-chalk-500">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ backgroundColor: kingdom.color }}
                  />
                  reasoned · {latestForAgent.market ?? "—"}
                </div>
                <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-chalk-200">
                  {latestForAgent.detail}
                </pre>
                <div className="mt-2 flex items-center gap-2">
                  <AttestationBadge
                    eventId={latestForAgent.id}
                    attestationHash={latestForAgent.attestationHash}
                  />
                </div>
              </article>
            ) : (
              <Empty text="no reasoning entries yet — wait for the next tick" />
            )}
          </Section>

          {/* tee identity — real values from /api/tee, derived inside the
              EigenCompute enclave. Click any row to verify externally. */}
          <Section label="tee identity">
            <div className="space-y-2 rounded-[2px] border border-ink-700 bg-ink-800/60 p-3 font-mono text-[10px]">
              <Row
                k="eigen app"
                v={EIGEN_APP_ID}
                href={EIGEN_VERIFY_URL}
                truncate
              />
              <Row
                k="image digest"
                v={
                  tee?.identityAnchor?.jwt
                    ? extractImageDigestFromJwt(tee.identityAnchor.jwt) ?? "—"
                    : "—"
                }
                truncate
              />
              <Row
                k="enclave id"
                v={tee?.enclaveIdentityHash ?? "—"}
                truncate
              />
              <Row
                k="signing key"
                v={tee?.signingPubKey ?? "—"}
                truncate
              />
              <Row
                k="admin EOA"
                v={tee?.originationAddress ?? "—"}
                truncate
              />
              {tee?.identityAnchor?.audience ? (
                <Row k="audience" v={tee.identityAnchor.audience} />
              ) : null}
            </div>
          </Section>
        </div>

        {/* footer — deposit (LP) + borrow CTAs */}
        <footer className="border-t border-ink-700 bg-ink-900 p-4 space-y-3">
          {agent ? (
            <DepositForm
              kingdom={kingdom}
              poolAddress={agent.pool as Address}
            />
          ) : (
            <div className="rounded-[2px] border border-ink-700 bg-ink-800/60 p-4 font-mono text-[10px] uppercase tracking-[0.22em] text-chalk-500">
              loading pool address…
            </div>
          )}
          <button
            onClick={() => setBorrowOpen(true)}
            className="w-full rounded-[2px] border border-black/40 px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.22em] font-medium transition-transform duration-150 active:translate-y-[2px]"
            style={{
              background: "transparent",
              color: kingdom.color,
              border: `1px solid ${kingdom.color}55`,
            }}
          >
            ◆ borrow against your position
          </button>
        </footer>
      </aside>
      {/* Borrower flow modal — opens over the detail card. */}
      <BorrowerFlow
        kingdom={kingdom}
        open={borrowOpen}
        onClose={() => setBorrowOpen(false)}
      />
    </div>
  );
}

function formatSharePrice(e18Str: string): string {
  const raw = BigInt(e18Str);
  // 18 decimals → 4 decimal display
  const whole = Number(raw / 10n ** 14n) / 10_000;
  return whole.toFixed(4);
}

function priceCell(p: string | null): string {
  if (p === null) return "—";
  const n = Number(p);
  if (!Number.isFinite(n)) return p;
  return n.toFixed(2);
}

interface SectionProps {
  readonly label: string;
  readonly children: React.ReactNode;
}

function Section({ label, children }: SectionProps): JSX.Element {
  return (
    <section className="space-y-2">
      <h3 className="font-mono text-[10px] uppercase tracking-[0.22em] text-chalk-500">
        {label}
      </h3>
      {children}
    </section>
  );
}

interface StatProps {
  readonly label: string;
  readonly value: string;
  readonly tone?: "up" | "down" | "neutral";
}

function Stat({ label, value, tone = "neutral" }: StatProps): JSX.Element {
  const color =
    tone === "up" ? "text-signal-green" : tone === "down" ? "text-signal-red" : "text-chalk-100";
  return (
    <div className="rounded-[2px] border border-ink-700 bg-ink-800/60 p-2.5">
      <div className="font-mono text-[9px] uppercase tracking-[0.22em] text-chalk-500">
        {label}
      </div>
      <div className={`font-display text-base font-semibold ${color}`}>{value}</div>
    </div>
  );
}

interface RowProps {
  readonly k: string;
  readonly v: string;
  readonly href?: string;
  readonly truncate?: boolean;
}

function Row({ k, v, href, truncate }: RowProps): JSX.Element {
  const display =
    truncate && v.length > 24 ? shortHash(v.replace(/^0x/, ""), 10, 8) : v;
  const inner = (
    <span
      className={`text-chalk-300 ${href ? "hover:text-chalk-100" : ""}`}
      title={v}
    >
      {display}
      {href ? <span className="ml-1 text-chalk-500">↗</span> : null}
    </span>
  );
  return (
    <div className="flex items-baseline gap-3">
      <span className="w-24 shrink-0 text-[9px] uppercase tracking-[0.22em] text-chalk-500">
        {k}
      </span>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="truncate"
        >
          {inner}
        </a>
      ) : (
        <span className="truncate">{inner}</span>
      )}
    </div>
  );
}

function Empty({ text }: { readonly text: string }): JSX.Element {
  return (
    <div className="rounded-[2px] border border-dashed border-ink-700 p-3 font-mono text-[10px] text-chalk-500">
      {text}
    </div>
  );
}
