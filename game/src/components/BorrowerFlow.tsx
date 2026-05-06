import { useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";

import type { Kingdom } from "../lib/kingdoms";
import { sseStream, type ReasoningEvent } from "../lib/stream";

interface Props {
  readonly kingdom: Kingdom;
  readonly open: boolean;
  readonly onClose: () => void;
}

type FormStage =
  | { kind: "input" }
  | { kind: "submitting" }
  | { kind: "submitted"; loanId: string; txHash: string }
  | { kind: "denied"; reason: string }
  | { kind: "error"; message: string };

interface OriginationRequest {
  readonly positionId: string;
  readonly requestedPrincipalCapUsdc6: string;
  readonly maturityTs: number;
  readonly pledgeEventId: string;
}

interface OriginationResponse {
  readonly loanId: string;
  readonly txHash: string;
  readonly blockNumber: number;
  readonly eventId: string;
  readonly haircutBps: number;
  readonly principalUsdc6: string;
  readonly paramsHash: string;
}

/**
 * Borrower flow modal. The user connects a wallet, supplies the
 * Polymarket position they want to borrow against, and submits a
 * loan request to the runtime. The runtime's origination route runs
 * the council pass, computes haircut + principal, calls
 * `LoanBook.originate(...)` on Base Sepolia, and replies with the
 * resulting `loanId` + `txHash`.
 *
 * Live SSE feed below the form filters events by the supplied
 * `pledgeEventId` so the user sees Brother Tomás and Helga
 * deliberate in real time, then the synthesis, then the origination.
 *
 * Pledge step: the v2 origination contract requires a signed
 * `loan.pledge` event already on the chain (the borrower's CTF
 * tokens escrowed in `VantaVault`). This UI honestly surfaces the
 * dependency. Production users do the pledge step via a separate
 * Polygon Amoy transaction; for runtime demos there's an operator
 * helper that pre-seeds a pledge event log entry.
 */
export function BorrowerFlow({ kingdom, open, onClose }: Props): JSX.Element | null {
  const { address, isConnected } = useAccount();
  const [stage, setStage] = useState<FormStage>({ kind: "input" });

  // Form fields
  const [conditionId, setConditionId] = useState("");
  const [tokenId, setTokenId] = useState("");
  const [pledgeEventId, setPledgeEventId] = useState("");
  const [principalUsdc, setPrincipalUsdc] = useState("");
  const [maturityDays, setMaturityDays] = useState("30");

  // Live SSE feed scoped to this submission
  const [feed, setFeed] = useState<readonly ReasoningEvent[]>([]);

  // Esc to close.
  useEffect(() => {
    if (!open) return;
    const handle = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [open, onClose]);

  // Subscribe to the runtime SSE while the modal is open. We hold all
  // events client-side and filter by the pledgeEventId / loanId once
  // we have one — that gives the live "council deliberating" feel.
  useEffect(() => {
    if (!open) {
      setFeed([]);
      return;
    }
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
    return feed.filter(
      (e) =>
        e.type === "npc.thought" ||
        e.type === "council.synthesised" ||
        e.type === "loan.origination" ||
        e.type === "reasoning.trace",
    );
  }, [feed]);

  if (!open) return null;

  const onSubmit = async (): Promise<void> => {
    if (!isConnected || !address) {
      setStage({ kind: "error", message: "connect a wallet first" });
      return;
    }
    const principalRaw = (() => {
      const trimmed = principalUsdc.trim();
      if (!/^\d+(\.\d{0,6})?$/.test(trimmed)) return null;
      const [whole = "0", frac = ""] = trimmed.split(".");
      const padded = (frac + "000000").slice(0, 6);
      try {
        return BigInt(whole) * 1_000_000n + BigInt(padded);
      } catch {
        return null;
      }
    })();
    if (principalRaw === null || principalRaw <= 0n) {
      setStage({ kind: "error", message: "principal must be a positive USDC amount" });
      return;
    }
    const maturityTs =
      Math.floor(Date.now() / 1000) +
      Math.max(1, Number(maturityDays || "30")) * 86_400;

    const body: OriginationRequest = {
      positionId: tokenId.trim(),
      requestedPrincipalCapUsdc6: principalRaw.toString(),
      maturityTs,
      pledgeEventId: pledgeEventId.trim(),
    };

    setStage({ kind: "submitting" });
    try {
      const r = await fetch("/api/runtime/origination", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await r.json()) as
        | OriginationResponse
        | { error: string; reason?: string };
      if (!r.ok) {
        const err = data as { error: string; reason?: string };
        setStage({
          kind: "denied",
          reason: err.reason ?? err.error ?? "origination_rejected",
        });
        return;
      }
      const ok = data as OriginationResponse;
      setStage({
        kind: "submitted",
        loanId: ok.loanId,
        txHash: ok.txHash,
      });
    } catch (e: unknown) {
      setStage({
        kind: "error",
        message: e instanceof Error ? e.message : "fetch_failed",
      });
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/85 backdrop-blur-sm animate-fadeIn"
      onClick={onClose}
    >
      <div
        className="relative grid w-full max-w-3xl grid-cols-[1fr_360px] gap-0 overflow-hidden rounded-[2px] border border-ink-700 bg-ink-900 shadow-[0_24px_48px_-12px_rgba(0,0,0,0.8)]"
        style={{ maxHeight: "85vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* left — form */}
        <div className="flex flex-col overflow-y-auto p-6 [scrollbar-width:thin]">
          <header
            className="mb-4 flex items-baseline justify-between border-b pb-3"
            style={{ borderColor: `${kingdom.color}66` }}
          >
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-chalk-500">
                borrow against your position
              </div>
              <h2
                className="font-display text-xl font-semibold"
                style={{ color: kingdom.color }}
              >
                {kingdom.displayName} · loan request
              </h2>
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
                use the connect-wallet button on the world view, then return here.
              </div>
            )}
          </Step>

          <Step n={2} title="pledge your CTF position">
            <p className="mb-2 text-[10px] leading-relaxed text-chalk-400">
              The v2 origination contract requires your Polymarket CTF
              tokens to be escrowed in <code className="text-chalk-200">VantaVault</code> first
              and a signed <code className="text-chalk-200">loan.pledge</code> event
              recorded on the runtime's chain. Paste the resulting
              event id below.
            </p>
            <Input
              label="pledge_event_id (64-char hex)"
              value={pledgeEventId}
              onChange={setPledgeEventId}
              placeholder="0x…"
            />
          </Step>

          <Step n={3} title="loan terms">
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="condition_id"
                value={conditionId}
                onChange={setConditionId}
                placeholder="0x…"
              />
              <Input
                label="position / token_id"
                value={tokenId}
                onChange={setTokenId}
                placeholder="123…"
              />
              <Input
                label="principal (USDC)"
                value={principalUsdc}
                onChange={setPrincipalUsdc}
                placeholder="500.00"
              />
              <Input
                label="maturity (days)"
                value={maturityDays}
                onChange={setMaturityDays}
                placeholder="30"
              />
            </div>
          </Step>

          <button
            disabled={!isConnected || stage.kind === "submitting"}
            onClick={() => void onSubmit()}
            className={[
              "mt-3 rounded-[2px] border border-black/40 px-4 py-2.5 font-mono text-xs uppercase tracking-[0.22em] font-medium",
              "transition-transform duration-150 active:translate-y-[2px] disabled:cursor-not-allowed disabled:opacity-40",
              "shadow-[inset_0_-3px_0_0_rgba(0,0,0,0.45),inset_0_2px_0_0_rgba(255,255,255,0.18)]",
            ].join(" ")}
            style={{ background: kingdom.color, color: "#0b0b0e", boxShadow: `0 0 24px -6px ${kingdom.color}` }}
          >
            {stage.kind === "submitting" ? "council deliberating…" : "submit to council"}
          </button>

          {stage.kind === "submitted" ? (
            <div className="mt-3 rounded-[2px] border border-signal-green/60 bg-signal-green/10 p-3 font-mono text-[10px]">
              <div className="text-signal-green">approved · loan {stage.loanId.slice(0, 12)}…</div>
              <a
                href={`https://sepolia.basescan.org/tx/${stage.txHash}`}
                target="_blank"
                rel="noreferrer"
                className="mt-1 block text-chalk-300 hover:text-chalk-100"
              >
                view on basescan ↗
              </a>
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

        {/* right — live council feed */}
        <aside
          className="flex flex-col border-l border-ink-700 bg-ink-950"
          style={{ maxHeight: "85vh" }}
        >
          <header
            className="border-b border-ink-700 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.22em] text-chalk-500"
            style={{ background: `${kingdom.color}11` }}
          >
            council · live feed
          </header>
          <div className="flex-1 space-y-2 overflow-y-auto p-3 [scrollbar-width:thin]">
            {filteredFeed.length === 0 ? (
              <div className="grid h-full place-items-center text-center font-mono text-[10px] uppercase tracking-[0.18em] text-chalk-500">
                <div>
                  <span className="block mb-2 animate-pulseDot">•••</span>
                  waiting for council activity…
                </div>
              </div>
            ) : (
              filteredFeed.map((e) => (
                <div
                  key={e.id}
                  className="rounded-[2px] border border-ink-700 bg-ink-900/60 p-2 font-mono text-[10px]"
                >
                  <div className="mb-1 flex items-center gap-2 text-chalk-500">
                    <span
                      className="inline-block h-1.5 w-1.5 rounded-full"
                      style={{ backgroundColor: kingdom.color }}
                    />
                    <span>{labelForType(e.type)}</span>
                  </div>
                  <div className="text-chalk-200 leading-relaxed">{e.summary}</div>
                </div>
              ))
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function Step({
  n,
  title,
  done,
  children,
}: {
  readonly n: number;
  readonly title: string;
  readonly done?: boolean;
  readonly children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="mb-4">
      <header className="mb-1.5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em]">
        <span className={done ? "text-signal-green" : "text-chalk-400"}>
          {done ? "✓" : `${String(n)}.`}
        </span>
        <span className="text-chalk-300">{title}</span>
      </header>
      {children}
    </section>
  );
}

function Input({
  label,
  value,
  onChange,
  placeholder,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (v: string) => void;
  readonly placeholder?: string;
}): JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 block font-mono text-[9px] uppercase tracking-[0.22em] text-chalk-500">
        {label}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-[2px] border border-ink-700 bg-ink-950 px-2 py-1.5 font-mono text-[11px] text-chalk-100 focus:border-opus focus:outline-none"
      />
    </label>
  );
}

function labelForType(t: ReasoningEvent["type"]): string {
  switch (t) {
    case "npc.thought":
      return "townsperson";
    case "council.synthesised":
      return "council weighed";
    case "loan.origination":
      return "loan originated";
    case "reasoning.trace":
      return "reasoning";
    default:
      return t;
  }
}
