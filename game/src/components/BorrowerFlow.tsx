import { useEffect, useMemo, useState } from "react";
import { useAccount, useReadContracts } from "wagmi";

import type { Kingdom } from "../lib/kingdoms";
import {
  ERC1155_BALANCE_OF_ABI,
  POLYMARKET_CTF_ADDRESS,
  POLYMARKET_CTF_CHAIN_ID,
} from "../lib/contracts";
import {
  marketsForAgentFromList,
  useRealMarkets,
  type DemoMarket,
} from "../lib/markets";
import { sseStream, type ReasoningEvent } from "../lib/stream";

interface Props {
  readonly kingdom: Kingdom;
  readonly open: boolean;
  readonly onClose: () => void;
}

type FormStage =
  | { kind: "input" }
  | { kind: "submitting" }
  | { kind: "submitted"; loanId: string; principalUsdc6: string; haircutBps: number }
  | { kind: "denied"; reason: string }
  | { kind: "error"; message: string };

interface PortfolioPosition {
  readonly market: DemoMarket;
  /** CTF shares actually held in the user's wallet (or synthetic). */
  readonly shares: number;
  /** Per-share entry price they paid (usually mid +/- a tiny premium). */
  readonly entryPrice: number;
  /** True when read from Polymarket CTF on Polygon; false for demo fallback. */
  readonly real: boolean;
}

/**
 * VANTA's pitch in one sentence: you own a Polymarket bet, you don't
 * want to sell it, but you want cash now — VANTA lends you USDC
 * against it. The agents read the market, deliberate with their
 * underwriting council, decide whether to lend and at what rate, and
 * run the loan from start to finish.
 *
 * This modal is the user-facing surface for that pitch.
 *
 * Flow:
 *   1. User connects a wallet (uses the demo account for the demo).
 *   2. We render their Polymarket positions filtered to the agent's
 *      kingdom thesis. (Real wallets would fetch from Polymarket's
 *      API; the demo synthesizes a plausible portfolio so the user
 *      can pick one to borrow against.)
 *   3. User picks a position + USDC amount. We compute max-loan
 *      from the position's current value × (1 − haircut_bps).
 *   4. "Submit to council" hits `/admin/demo/borrow` on the runtime.
 *      The runtime emits a fresh signed origination chain — pledge →
 *      2× NPC thoughts → council synthesis → reasoning trace →
 *      loan.origination. Each event lands in the chat panel via SSE.
 *
 * Why no on-chain `LoanBook.originate`: that requires actual CTF
 * tokens escrowed in `VantaVault` on Polygon Amoy, which the demo
 * wallet doesn't have. The signed audit chain is the same shape —
 * the only thing missing is a Base Sepolia tx hash, and the demo
 * substitutes a synthetic one for narrative completeness.
 */
export function BorrowerFlow({ kingdom, open, onClose }: Props): JSX.Element | null {
  const { address, isConnected } = useAccount();
  const [stage, setStage] = useState<FormStage>({ kind: "input" });

  // Live markets the runtime is actually watching right now.
  const { markets: liveMarkets, loading: marketsLoading, error: marketsError } =
    useRealMarkets();

  const themedMarkets = useMemo(
    () => marketsForAgentFromList(kingdom.agentId, liveMarkets).slice(0, 4),
    [kingdom.agentId, liveMarkets],
  );

  // Real Polymarket CTF balance reads on Polygon mainnet. We multicall
  // `balanceOf(user, tokenId)` for each themed market's tokenId so the
  // borrow modal surfaces the wallet's ACTUAL CTF holdings instead of
  // fabricated share counts.
  const balanceContracts = useMemo(
    () =>
      address !== undefined
        ? themedMarkets.map((m) => ({
            address: POLYMARKET_CTF_ADDRESS,
            abi: ERC1155_BALANCE_OF_ABI,
            functionName: "balanceOf" as const,
            args: [address, BigInt(m.tokenId)] as const,
            chainId: POLYMARKET_CTF_CHAIN_ID,
          }))
        : [],
    [address, themedMarkets],
  );

  const balancesQuery = useReadContracts({
    contracts: balanceContracts,
    query: { enabled: balanceContracts.length > 0 },
  });

  const realBalances = useMemo<readonly bigint[]>(() => {
    if (!balancesQuery.data) return [];
    return balancesQuery.data.map((r) =>
      r.status === "success" && typeof r.result === "bigint" ? r.result : 0n,
    );
  }, [balancesQuery.data]);

  // Build the portfolio: prefer real on-chain balances; fall back to
  // a synthetic sample only when the wallet holds no CTF positions in
  // the watched set. The synthetic fallback is clearly labeled "demo"
  // so users always know which path they're on.
  const portfolio = useMemo<readonly PortfolioPosition[]>(() => {
    const real: PortfolioPosition[] = [];
    themedMarkets.forEach((m, i) => {
      const raw = realBalances[i] ?? 0n;
      // CTF tokens are 6-decimal (USDC-equivalent shares).
      const shares = Number(raw / 1_000_000n);
      if (shares > 0) {
        real.push({
          market: m,
          shares,
          entryPrice: m.currentMid,
          real: true,
        });
      }
    });
    if (real.length > 0) return real;

    // Demo fallback so the modal stays interactive when the connected
    // wallet has no Polymarket positions in the watched set.
    return themedMarkets.map((m, i) => {
      const sharesByIdx = [2400, 1500, 950, 3200];
      const shares = sharesByIdx[i] ?? 1000;
      const entryPrice = Math.max(0.02, m.currentMid - 0.02 + i * 0.005);
      return { market: m, shares, entryPrice, real: false };
    });
  }, [themedMarkets, realBalances]);

  const hasRealPositions = portfolio.some((p) => p.real);

  const [selectedIdx, setSelectedIdx] = useState<number>(0);
  const [principalUsdc, setPrincipalUsdc] = useState("500");
  const [maturityDays, setMaturityDays] = useState("30");
  const [feed, setFeed] = useState<readonly ReasoningEvent[]>([]);
  const [requestSeq, setRequestSeq] = useState(0);
  const [submitTime, setSubmitTime] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    const handle = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [open, onClose]);

  // Reset form when the modal opens fresh.
  useEffect(() => {
    if (!open) {
      setStage({ kind: "input" });
      setFeed([]);
      setSelectedIdx(0);
      setPrincipalUsdc("500");
      setMaturityDays("30");
      setSubmitTime(null);
      return;
    }
  }, [open]);

  // Subscribe to SSE while the modal is open. Filter to the council
  // narrative for THIS submission only — events that arrive after
  // the user clicked submit, scoped to the chosen agent.
  useEffect(() => {
    if (!open) return;
    const stream = sseStream();
    const off = stream.subscribe((e) => {
      setFeed((prev) => {
        const next = [...prev, e];
        if (next.length > 200) next.splice(0, next.length - 200);
        return next;
      });
    });
    return off;
  }, [open]);

  const filteredFeed = useMemo(() => {
    if (submitTime === null) return [];
    return feed.filter(
      (e) =>
        e.timestamp * 1000 >= submitTime - 1000 &&
        e.agentId === kingdom.agentId &&
        (e.type === "npc.thought" ||
          e.type === "council.synthesised" ||
          e.type === "loan.origination" ||
          e.type === "reasoning.trace"),
    );
  }, [feed, submitTime, kingdom.agentId]);

  if (!open) return null;

  const selected = portfolio[selectedIdx] ?? portfolio[0];
  const positionValueUsdc = selected ? selected.shares * selected.market.currentMid : 0;
  const HAIRCUT_BPS = 6_500;
  const maxLoanUsdc = (positionValueUsdc * HAIRCUT_BPS) / 10_000;
  const apr = 4.7;
  const principalNum = Number.parseFloat(principalUsdc) || 0;
  const principalOk = principalNum > 0 && principalNum <= maxLoanUsdc;

  const onSubmit = async (): Promise<void> => {
    if (!isConnected || !address) {
      setStage({ kind: "error", message: "connect a wallet first" });
      return;
    }
    if (!selected) {
      setStage({ kind: "error", message: "pick a position to borrow against" });
      return;
    }
    if (!principalOk) {
      setStage({
        kind: "error",
        message: `principal must be between $0 and $${maxLoanUsdc.toFixed(2)}`,
      });
      return;
    }
    const principalUsdc6 = BigInt(Math.round(principalNum * 1_000_000));
    const maturityTsUnix =
      Math.floor(Date.now() / 1000) +
      Math.max(1, Number(maturityDays || "30")) * 86_400;

    setStage({ kind: "submitting" });
    setSubmitTime(Date.now());
    setRequestSeq((s) => s + 1);
    setFeed([]);

    try {
      const r = await fetch("/admin/demo/borrow", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: kingdom.agentId,
          principalUsdc6: principalUsdc6.toString(),
          maturityTsUnix,
          borrower: address,
          market: {
            conditionIdHex: selected.market.conditionIdHex,
            tokenId: selected.market.tokenId,
            question: selected.market.question,
            shortName: selected.market.shortName,
            currentMid: selected.market.currentMid,
            timeToResolutionSeconds: selected.market.timeToResolutionSeconds,
          },
        }),
      });
      const data = (await r.json()) as
        | { ok: true; loanId: string; principalUsdc6: string; haircutBps: number }
        | { error: string; message?: string };
      if (!r.ok || !("ok" in data && data.ok)) {
        const reason =
          "error" in data && typeof data.error === "string"
            ? `${data.error}${"message" in data && typeof data.message === "string" ? `: ${data.message}` : ""}`
            : `submission failed (${String(r.status)})`;
        setStage({ kind: "denied", reason });
        return;
      }
      setStage({
        kind: "submitted",
        loanId: data.loanId,
        principalUsdc6: data.principalUsdc6,
        haircutBps: data.haircutBps,
      });
    } catch (err) {
      setStage({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <div
      // Backdrop click closes the modal. Children stop propagation so
      // clicks inside the form don't bubble up to either this backdrop
      // or the AgentDetailCard's outer overlay (which would otherwise
      // navigate the user back to the world view).
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        className="grid w-full max-w-4xl grid-cols-2 gap-4 max-h-[88vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* form */}
        <div
          className="overflow-y-auto rounded-[2px] border border-ink-700 bg-ink-900 p-5"
          style={{ borderColor: `${kingdom.color}55` }}
        >
          <header className="mb-4 flex items-center justify-between">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-chalk-500">
                borrow against your position
              </div>
              <div
                className="mt-1 font-display text-2xl font-bold"
                style={{ color: kingdom.color }}
              >
                {kingdom.displayName} · loan request
              </div>
            </div>
            <button
              onClick={onClose}
              className="font-mono text-xs uppercase tracking-[0.22em] text-chalk-400 hover:text-chalk-100"
            >
              close [esc]
            </button>
          </header>

          <Step n={1} title="connect wallet" done={isConnected}>
            {isConnected ? (
              <div className="font-mono text-[10px] text-chalk-400">
                connected as <span className="text-chalk-200">{address}</span>
              </div>
            ) : (
              <div className="font-mono text-[10px] text-chalk-500">
                use the connect-wallet button on the world view to import
                your Polymarket portfolio.
              </div>
            )}
          </Step>

          <Step n={2} title="pick a position to borrow against">
            <p className="mb-3 text-[10px] leading-relaxed text-chalk-400">
              These are the {kingdom.displayName} positions in your Polymarket portfolio.
              You keep the upside; <span className="text-chalk-200">{kingdom.displayName}</span> lends
              you USDC against the current value (haircut {(HAIRCUT_BPS / 100).toFixed(0)}%).
            </p>
            {address !== undefined ? (
              hasRealPositions ? (
                <div className="mb-3 rounded-[2px] border border-signal-green/40 bg-signal-green/5 p-2 font-mono text-[10px] uppercase tracking-[0.18em] text-signal-green">
                  ● live positions read from polymarket on polygon
                </div>
              ) : (
                <div className="mb-3 rounded-[2px] border border-ink-700 bg-ink-900/85 p-2 font-mono text-[10px] text-chalk-400">
                  no polymarket positions found on{" "}
                  <span className="text-chalk-200">{address.slice(0, 6)}…{address.slice(-4)}</span>{" "}
                  for these markets — showing a demo portfolio so you can see
                  the council flow.{" "}
                  <a
                    href="https://polymarket.com/"
                    target="_blank"
                    rel="noreferrer"
                    className="text-chalk-200 underline"
                  >
                    buy yes/no shares ↗
                  </a>
                </div>
              )
            ) : null}
            {marketsLoading && portfolio.length === 0 ? (
              <div className="rounded-[2px] border border-ink-700 bg-ink-900/85 p-3 font-mono text-[10px] text-chalk-500">
                loading live markets from runtime…
              </div>
            ) : null}
            {!marketsLoading && portfolio.length === 0 ? (
              <div className="rounded-[2px] border border-ink-700 bg-ink-900/85 p-3 font-mono text-[10px] text-chalk-500">
                {marketsError !== null
                  ? `runtime markets unreachable: ${marketsError}`
                  : "no live markets available right now."}
              </div>
            ) : null}
            <div className="space-y-2">
              {portfolio.map((p, i) => {
                const value = p.shares * p.market.currentMid;
                const isSelected = i === selectedIdx;
                return (
                  <button
                    key={p.market.conditionIdHex}
                    type="button"
                    onClick={() => setSelectedIdx(i)}
                    className={[
                      "w-full rounded-[2px] border p-3 text-left transition-colors",
                      isSelected
                        ? "border-chalk-200 bg-ink-800"
                        : "border-ink-700 bg-ink-900/85 hover:border-ink-500",
                    ].join(" ")}
                    style={
                      isSelected
                        ? { borderColor: kingdom.color, boxShadow: `0 0 18px -8px ${kingdom.color}` }
                        : undefined
                    }
                  >
                    <div className="font-mono text-[11px] text-chalk-100 leading-snug">
                      {p.market.question}
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 font-mono text-[10px] text-chalk-400">
                      <span style={{ color: kingdom.color }}>
                        {p.market.side} @ {p.market.currentMid.toFixed(2)}
                      </span>
                      <span>·</span>
                      <span>{p.shares.toLocaleString()} shares</span>
                      <span>·</span>
                      <span className="text-chalk-200">
                        ${value.toLocaleString(undefined, { maximumFractionDigits: 0 })} value
                      </span>
                      {p.real ? (
                        <span className="rounded-[2px] border border-signal-green/40 px-1.5 py-px text-[8px] uppercase tracking-[0.2em] text-signal-green">
                          live
                        </span>
                      ) : (
                        <span className="rounded-[2px] border border-ink-600 px-1.5 py-px text-[8px] uppercase tracking-[0.2em] text-chalk-500">
                          demo
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </Step>

          <Step n={3} title="loan amount">
            <div className="mb-2 flex items-baseline justify-between font-mono text-[10px]">
              <span className="text-chalk-400">max loan</span>
              <span className="text-chalk-200">
                ${maxLoanUsdc.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                <span className="ml-1 text-chalk-500">
                  ({(HAIRCUT_BPS / 100).toFixed(0)}% of position value)
                </span>
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <NumberInput
                label="usdc requested"
                value={principalUsdc}
                onChange={setPrincipalUsdc}
                prefix="$"
              />
              <NumberInput
                label="maturity (days)"
                value={maturityDays}
                onChange={setMaturityDays}
              />
            </div>
            <div className="mt-2 flex items-baseline justify-between font-mono text-[10px]">
              <span className="text-chalk-400">rate</span>
              <span className="text-chalk-200">≈ {apr.toFixed(1)}% APR</span>
            </div>
            <div className="flex items-baseline justify-between font-mono text-[10px]">
              <span className="text-chalk-400">interest at maturity</span>
              <span className="text-chalk-200">
                ${((principalNum * apr) / 100 * (Number(maturityDays) / 365)).toFixed(2)}
              </span>
            </div>
          </Step>

          <button
            disabled={!isConnected || !selected || !principalOk || stage.kind === "submitting"}
            onClick={() => void onSubmit()}
            className={[
              "mt-4 w-full rounded-[2px] border border-black/40 px-4 py-2.5 font-mono text-xs uppercase tracking-[0.22em] font-medium",
              "transition-transform duration-150 active:translate-y-[2px] disabled:cursor-not-allowed disabled:opacity-40",
              "shadow-[inset_0_-3px_0_0_rgba(0,0,0,0.45),inset_0_2px_0_0_rgba(255,255,255,0.18)]",
            ].join(" ")}
            style={{ background: kingdom.color, color: "#0b0b0e", boxShadow: `0 0 24px -6px ${kingdom.color}` }}
          >
            {stage.kind === "submitting"
              ? "council deliberating…"
              : `submit to ${kingdom.displayName} council`}
          </button>

          {stage.kind === "submitted" ? (
            <div className="mt-3 rounded-[2px] border border-signal-green/60 bg-signal-green/10 p-3 font-mono text-[10px]">
              <div className="text-signal-green">
                approved · loan {stage.loanId.slice(0, 12)}…
              </div>
              <div className="mt-1 text-chalk-300">
                ${(Number(stage.principalUsdc6) / 1_000_000).toLocaleString()} USDC sent to your wallet
                <span className="ml-2 text-chalk-500">
                  · haircut {(stage.haircutBps / 100).toFixed(0)}%
                </span>
              </div>
            </div>
          ) : null}
          {stage.kind === "denied" ? (
            <div className="mt-3 rounded-[2px] border border-signal-red/50 bg-signal-red/10 p-3 font-mono text-[10px] text-signal-red">
              denied: {stage.reason}
            </div>
          ) : null}
          {stage.kind === "error" ? (
            <div className="mt-3 rounded-[2px] border border-signal-amber/50 bg-signal-amber/10 p-3 font-mono text-[10px] text-signal-amber">
              {stage.message}
            </div>
          ) : null}
        </div>

        {/* live council feed */}
        <div
          className="overflow-y-auto rounded-[2px] border border-ink-700 bg-ink-900 p-4"
          style={{ borderColor: `${kingdom.color}33` }}
        >
          <div className="mb-3 font-mono text-[10px] uppercase tracking-[0.22em] text-chalk-500">
            council · live feed
          </div>
          {filteredFeed.length === 0 ? (
            <div className="flex h-full items-center justify-center font-mono text-[10px] text-chalk-600">
              {stage.kind === "submitting"
                ? "•••\nwaiting for council activity…"
                : stage.kind === "input"
                  ? "submit a loan to start the council deliberation"
                  : "•••"}
            </div>
          ) : (
            <ul className="space-y-2">
              {filteredFeed.map((e) => (
                <li
                  key={e.id}
                  className="rounded-[2px] border border-ink-700 bg-ink-900/85 p-2.5"
                >
                  <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-chalk-500">
                    {labelForFeed(e.type)}
                  </div>
                  <div className="mt-1 font-mono text-[11px] text-chalk-200 leading-relaxed">
                    {e.summary}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function labelForFeed(t: ReasoningEvent["type"]): string {
  switch (t) {
    case "npc.thought":
      return "townsperson";
    case "council.synthesised":
      return "council synthesised";
    case "reasoning.trace":
      return "reasoning trace";
    case "loan.origination":
      return "loan originated";
    default:
      return t;
  }
}

interface StepProps {
  readonly n: number;
  readonly title: string;
  readonly done?: boolean;
  readonly children: React.ReactNode;
}

function Step({ n, title, done = false, children }: StepProps): JSX.Element {
  return (
    <section className="mb-4">
      <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.22em] text-chalk-300">
        {done ? "✓" : `${String(n)}.`} {title}
      </div>
      {children}
    </section>
  );
}

interface NumberInputProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (v: string) => void;
  readonly prefix?: string;
}

function NumberInput({ label, value, onChange, prefix }: NumberInputProps): JSX.Element {
  return (
    <label className="block">
      <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.18em] text-chalk-500">
        {label}
      </div>
      <div className="flex items-center rounded-[2px] border border-ink-700 bg-ink-900 focus-within:border-chalk-500">
        {prefix ? (
          <span className="pl-2 font-mono text-[11px] text-chalk-400">{prefix}</span>
        ) : null}
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-transparent px-2 py-1.5 font-mono text-[11px] text-chalk-200 outline-none"
        />
      </div>
    </label>
  );
}
