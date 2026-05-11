import { useEffect, useMemo, useState } from "react";
import {
  useAccount,
  useReadContracts,
  useSignTypedData,
} from "wagmi";
import { type Address } from "viem";

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
import {
  deriveUserWallet,
  pollRelayerTx,
  submitWalletCtfTransfer,
  type RelayerAuth,
} from "../lib/polymarket-relayer";
import { deriveApiKey, type ApiCreds } from "../lib/polymarket-auth";
import { sseStream, type ReasoningEvent } from "../lib/stream";
import { DEMO_ADDRESS } from "../lib/wallets/demo-wallet";

const PM_PROXY_KEY = "vanta:polymarket:proxy";
const PM_API_KEY = "vanta:polymarket:apiKey";
const PM_CREDS_KEY = "vanta:polymarket:creds";

// VantaVault address — same on Polygon as LpVault on Base for the V0
// deploy (same TEE-derived deployer + same nonce). Hardcoded for the
// frontend to skip a runtime round-trip.
const VANTA_VAULT_ADDRESS = "0xe2f93c448d9fc51155e2e06479b3b1e86f8ae45b" as const;

interface Props {
  readonly kingdom: Kingdom;
  readonly open: boolean;
  readonly onClose: () => void;
}

type FormStage =
  | { kind: "input" }
  | { kind: "submitting"; step?: string }
  | {
      kind: "submitted";
      loanId: string;
      principalUsdc6: string;
      haircutBps: number;
      real?: boolean;
      txHash?: string;
      /** loan.origination event id — the audit-chain root for this loan. */
      originationId?: string;
      /** TEE-derived EOA that signed the origination event + (real path) the chain tx. */
      teeAddress?: string;
      /** Borrower wallet — echoed back from the runtime so the receipt
       *  card can show "loan to ..." without re-reading wagmi state. */
      borrower?: string;
    }
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
 * tokens escrowed in `VantaVault` on Polygon mainnet, which the demo
 * wallet doesn't have. The signed audit chain is the same shape —
 * the only thing missing is a Base mainnet tx hash, and the demo
 * substitutes a synthetic one for narrative completeness.
 */
export function BorrowerFlow({ kingdom, open, onClose }: Props): JSX.Element | null {
  const { address, isConnected } = useAccount();
  const [stage, setStage] = useState<FormStage>({ kind: "input" });

  // Demo wallet detection — synthetic address has no signer; the
  // real-borrow path would prompt for a sig the wallet can't produce,
  // so demo always falls through to /admin/demo/borrow. Computed
  // early because the portfolio builder depends on it.
  const isDemoWallet =
    address !== undefined &&
    address.toLowerCase() === DEMO_ADDRESS.toLowerCase();

  // Polymarket relayer settings — the user's CTF tokens live in a
  // Safe-style proxy controlled by Polymarket's relayer (not the
  // user's EOA), so a real borrow needs (a) the proxy address that
  // actually holds the CTF and (b) a Polymarket Relayer API key the
  // user can paste from their Polymarket developer settings. Auto-
  // derived from the EOA via Polymarket's PolyProxyFactory CREATE2
  // pattern; user can override if their proxy was deployed by an
  // older factory or via email-auth.
  const [pmProxy, setPmProxy] = useState<string>(() => {
    try {
      return window.localStorage.getItem(PM_PROXY_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [pmApiKey, setPmApiKey] = useState<string>(() => {
    try {
      return window.localStorage.getItem(PM_API_KEY) ?? "";
    } catch {
      return "";
    }
  });
  useEffect(() => {
    if (address === undefined || isDemoWallet) return;
    if (pmProxy.length > 0) return;
    try {
      const derived = deriveUserWallet(address);
      setPmProxy(derived);
      window.localStorage.setItem(PM_PROXY_KEY, derived);
    } catch {
      /* derivation should never fail on a 20-byte addr; ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, isDemoWallet]);
  const persistProxy = (v: string): void => {
    setPmProxy(v);
    try {
      window.localStorage.setItem(PM_PROXY_KEY, v);
    } catch {
      /* private mode — keep in-memory only */
    }
  };
  const persistApiKey = (v: string): void => {
    setPmApiKey(v);
    try {
      window.localStorage.setItem(PM_API_KEY, v);
    } catch {
      /* private mode — keep in-memory only */
    }
  };
  const [pmCreds, setPmCreds] = useState<ApiCreds | null>(() => {
    try {
      const raw = window.localStorage.getItem(PM_CREDS_KEY);
      if (raw === null) return null;
      const parsed = JSON.parse(raw) as Partial<ApiCreds>;
      if (
        typeof parsed.key === "string" &&
        typeof parsed.secret === "string" &&
        typeof parsed.passphrase === "string"
      ) {
        return { key: parsed.key, secret: parsed.secret, passphrase: parsed.passphrase };
      }
      return null;
    } catch {
      return null;
    }
  });
  const [credsBusy, setCredsBusy] = useState(false);
  const [credsErr, setCredsErr] = useState<string | null>(null);

  const proxyValid = /^0x[0-9a-fA-F]{40}$/.test(pmProxy);
  const apiKeyValid = pmApiKey.trim().length > 0;
  const credsValid =
    pmCreds !== null &&
    pmCreds.key.length > 0 &&
    pmCreds.secret.length > 0 &&
    pmCreds.passphrase.length > 0;
  const authReady = credsValid || apiKeyValid;
  const proxyAddr = (proxyValid ? pmProxy : null) as Address | null;
  const { signTypedDataAsync } = useSignTypedData();

  const persistCreds = (c: ApiCreds | null): void => {
    setPmCreds(c);
    try {
      if (c === null) window.localStorage.removeItem(PM_CREDS_KEY);
      else window.localStorage.setItem(PM_CREDS_KEY, JSON.stringify(c));
    } catch {
      /* ignore */
    }
  };

  const connectPolymarket = async (): Promise<void> => {
    if (address === undefined) {
      setCredsErr("connect wallet first");
      return;
    }
    setCredsBusy(true);
    setCredsErr(null);
    try {
      const creds = await deriveApiKey({
        eoa: address,
        chainId: POLYMARKET_CTF_CHAIN_ID,
        signTypedData: (typedArgs) =>
          signTypedDataAsync({
            domain: typedArgs.domain,
            types: typedArgs.types,
            primaryType: typedArgs.primaryType,
            message: typedArgs.message,
          }),
      });
      persistCreds(creds);
    } catch (e) {
      setCredsErr(e instanceof Error ? e.message : String(e));
    } finally {
      setCredsBusy(false);
    }
  };

  // Live markets the runtime is actually watching right now.
  const { markets: liveMarkets, loading: marketsLoading, error: marketsError } =
    useRealMarkets();

  const themedMarkets = useMemo(
    () => marketsForAgentFromList(kingdom.agentId, liveMarkets).slice(0, 4),
    [kingdom.agentId, liveMarkets],
  );

  // Real Polymarket CTF balance reads on Polygon mainnet. We multicall
  // `balanceOf(holder, tokenId)` for each themed market's tokenId so
  // the borrow modal surfaces the wallet's ACTUAL CTF holdings.
  //
  // Holder = the Polymarket proxy that actually owns the CTF tokens
  // (NOT the user's connected EOA), since Polymarket routes all
  // trades through a Safe-style proxy. Falls back to the EOA when no
  // proxy is configured so users with raw CTF in their wallet (rare,
  // e.g. CLOB API users) still see balances.
  const holderForBalance = proxyAddr ?? address;
  const balanceContracts = useMemo(
    () =>
      holderForBalance !== undefined && holderForBalance !== null
        ? themedMarkets.map((m) => ({
            address: POLYMARKET_CTF_ADDRESS,
            abi: ERC1155_BALANCE_OF_ABI,
            functionName: "balanceOf" as const,
            args: [holderForBalance, BigInt(m.tokenId)] as const,
            chainId: POLYMARKET_CTF_CHAIN_ID,
          }))
        : [],
    [holderForBalance, themedMarkets],
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

  // Build the portfolio:
  //   - Demo wallet (or no wallet) → synthetic sample portfolio so
  //     visitors can preview the council flow without holding any
  //     positions. Submits via /admin/demo/borrow.
  //   - Real wallet → ONLY real CTF holdings on Polygon. If the
  //     wallet holds nothing in the watched set, the modal renders
  //     an empty state pushing the user to polymarket.com — never
  //     fabricated positions.
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
    if (!isDemoWallet && isConnected) return [];

    return themedMarkets.map((m, i) => {
      const sharesByIdx = [2400, 1500, 950, 3200];
      const shares = sharesByIdx[i] ?? 1000;
      const entryPrice = Math.max(0.02, m.currentMid - 0.02 + i * 0.005);
      return { market: m, shares, entryPrice, real: false };
    });
  }, [themedMarkets, realBalances, isDemoWallet, isConnected]);

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

    // ----- REAL flow: connected wallet (non-demo) holds CTF for the
    //       selected market. We register them on VantaVault if needed,
    //       have them pledge the CTF on Polygon, wait for the runtime's
    //       signed loan.pledge event, and call /api/origination with
    //       the pledgeEventId to land a real LoanBook entry on Base.
    if (!isDemoWallet && selected.real) {
      if (!proxyValid || proxyAddr === null) {
        setStage({
          kind: "error",
          message:
            "polymarket deposit wallet address required (auto-derived from your eoa; paste your funder address from polymarket.com if it differs)",
        });
        return;
      }
      if (!authReady) {
        setStage({
          kind: "error",
          message:
            "polymarket auth required — click 'connect polymarket' (1 signature) or paste a relayer api key",
        });
        return;
      }
      const auth: RelayerAuth = credsValid && pmCreds !== null
        ? { mode: "builder", creds: pmCreds, eoa: address }
        : { mode: "relayer-key", apiKey: pmApiKey.trim(), eoa: address };
      try {
        await runRealBorrow({
          borrower: proxyAddr,
          eoa: address,
          auth,
          signTypedDataAsync,
          tokenId: selected.market.tokenId,
          conditionIdHex: selected.market.conditionIdHex,
          principalUsdc6,
          maturityTsUnix,
          shares: selected.shares,
          setStage,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setStage({ kind: "error", message: `real borrow failed: ${msg}` });
      }
      return;
    }

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
        | {
            ok: true;
            loanId: string;
            principalUsdc6: string;
            haircutBps: number;
            originationId?: string;
            txHash?: string;
            teeAddress?: string;
            borrower?: string;
          }
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
        ...(data.originationId !== undefined ? { originationId: data.originationId } : {}),
        ...(data.txHash !== undefined ? { txHash: data.txHash } : {}),
        ...(data.teeAddress !== undefined ? { teeAddress: data.teeAddress } : {}),
        ...(data.borrower !== undefined ? { borrower: data.borrower } : {}),
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
        className="grid w-full max-w-3xl grid-cols-1 md:grid-cols-2 gap-3 max-h-[88vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* form */}
        <div
          className="overflow-y-auto rounded-[2px] border border-ink-700 bg-ink-900 p-4"
          style={{ borderColor: `${kingdom.color}55` }}
        >
          <header className="mb-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="font-mono text-[9px] uppercase tracking-[0.22em] text-chalk-500">
                loan request
              </div>
              <div
                className="font-display text-xl font-semibold leading-tight"
                style={{ color: kingdom.color }}
              >
                {kingdom.displayName}
              </div>
            </div>
            <button
              onClick={onClose}
              className="shrink-0 rounded-[2px] border border-ink-700 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.22em] text-chalk-400 hover:text-chalk-100"
            >
              close
            </button>
          </header>

          {!isConnected ? (
            <div className="mb-3 rounded-[2px] border border-signal-amber/40 bg-signal-amber/5 p-2 font-mono text-[10px] text-signal-amber">
              connect a wallet from the world view to continue.
            </div>
          ) : (
            <div className="mb-3 flex items-center gap-2 rounded-[2px] border border-ink-700 bg-ink-800/40 px-2 py-1 font-mono text-[10px] text-chalk-400">
              <span className="text-signal-green">●</span>
              <span className="truncate text-chalk-200">
                {address?.slice(0, 6)}…{address?.slice(-4)}
              </span>
              <span className="ml-auto text-chalk-500">connected</span>
            </div>
          )}

          {isConnected && !isDemoWallet ? (
            <div className="mb-3 rounded-[2px] border border-ink-700 bg-ink-800/40 p-2">
              <div className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.18em] text-chalk-500">
                polymarket account
              </div>
              <label className="block">
                <div className="mb-0.5 font-mono text-[9px] uppercase tracking-[0.18em] text-chalk-500">
                  deposit wallet (funder)
                </div>
                <input
                  type="text"
                  value={pmProxy}
                  onChange={(e) => persistProxy(e.target.value.trim())}
                  spellCheck={false}
                  placeholder="0x… (auto-derived from your eoa)"
                  className="w-full rounded-[2px] border border-ink-700 bg-ink-900 px-1.5 py-1 font-mono text-[10px] text-chalk-200 outline-none focus:border-chalk-500"
                />
              </label>
              <div className="mt-2">
                {credsValid ? (
                  <div className="flex items-center justify-between gap-2 rounded-[2px] border border-signal-green/40 bg-signal-green/5 px-2 py-1 font-mono text-[10px] text-signal-green">
                    <span>● polymarket connected (key {pmCreds?.key.slice(0, 8)}…)</span>
                    <button
                      type="button"
                      onClick={() => persistCreds(null)}
                      className="text-[9px] uppercase tracking-[0.18em] text-chalk-500 hover:text-chalk-200"
                    >
                      disconnect
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => void connectPolymarket()}
                    disabled={credsBusy || !isConnected}
                    className="w-full rounded-[2px] border border-chalk-500 bg-ink-900 px-2 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-chalk-200 hover:bg-ink-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {credsBusy ? "signing…" : "connect polymarket (1 sig)"}
                  </button>
                )}
                {credsErr !== null ? (
                  <div className="mt-1 font-mono text-[9px] text-signal-red">
                    {credsErr}
                  </div>
                ) : null}
              </div>
              <details className="mt-2 font-mono text-[9px] text-chalk-500">
                <summary className="cursor-pointer hover:text-chalk-300">
                  or paste relayer api key manually
                </summary>
                <label className="mt-1 block">
                  <input
                    type="password"
                    value={pmApiKey}
                    onChange={(e) => persistApiKey(e.target.value.trim())}
                    spellCheck={false}
                    placeholder="paste from polymarket.com developer settings"
                    className="w-full rounded-[2px] border border-ink-700 bg-ink-900 px-1.5 py-1 font-mono text-[10px] text-chalk-200 outline-none focus:border-chalk-500"
                  />
                </label>
              </details>
              <div className="mt-1 font-mono text-[9px] text-chalk-500">
                credentials stored locally; never sent to vanta backend.
              </div>
            </div>
          ) : null}

          <Step title="pick a position">
            <p className="mb-2 text-[10px] leading-relaxed text-chalk-400">
              borrow USDC against a polymarket bet — keep the upside, get cash now (haircut {(HAIRCUT_BPS / 100).toFixed(0)}%).
            </p>
            {hasRealPositions ? (
              <div className="mb-2 rounded-[2px] border border-signal-green/40 bg-signal-green/5 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.18em] text-signal-green">
                ● live polygon · pledge → real loanbook
              </div>
            ) : isDemoWallet ? (
              <div className="mb-2 rounded-[2px] border border-ink-700 bg-ink-800/40 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.18em] text-chalk-500">
                demo wallet · synthesised council flow
              </div>
            ) : isConnected ? (
              <div className="mb-2 rounded-[2px] border border-signal-amber/40 bg-signal-amber/5 px-2 py-1 font-mono text-[10px] text-signal-amber">
                no polymarket positions on{" "}
                <span className="text-chalk-100">
                  {(holderForBalance ?? "").slice(0, 6)}…{(holderForBalance ?? "").slice(-4)}
                </span>{" "}
                — to use the real flow, buy YES/NO shares on{" "}
                <a
                  href="https://polymarket.com/"
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:text-chalk-100"
                >
                  polymarket ↗
                </a>{" "}
                in one of these markets, then come back.
              </div>
            ) : null}
            {marketsLoading && portfolio.length === 0 ? (
              <div className="rounded-[2px] border border-ink-700 bg-ink-800/40 px-2 py-1.5 font-mono text-[10px] text-chalk-500">
                loading…
              </div>
            ) : null}
            {!marketsLoading && portfolio.length === 0 ? (
              marketsError !== null ? (
                <div className="rounded-[2px] border border-ink-700 bg-ink-800/40 px-2 py-1.5 font-mono text-[10px] text-chalk-500">
                  runtime unreachable: {marketsError}
                </div>
              ) : isConnected && !isDemoWallet && themedMarkets.length > 0 ? (
                <div className="space-y-1">
                  <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-chalk-500">
                    eligible markets
                  </div>
                  {themedMarkets.map((m) => (
                    <a
                      key={m.conditionIdHex}
                      href={m.polymarketUrl ?? "https://polymarket.com/"}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center justify-between gap-2 rounded-[2px] border border-ink-700 bg-ink-800/40 px-2.5 py-1.5 font-mono text-[10px] text-chalk-300 hover:border-ink-500 hover:text-chalk-100"
                    >
                      <span className="truncate">{m.shortName}</span>
                      <span className="shrink-0 text-chalk-500">
                        {m.side}@{m.currentMid.toFixed(2)} ↗
                      </span>
                    </a>
                  ))}
                </div>
              ) : (
                <div className="rounded-[2px] border border-ink-700 bg-ink-800/40 px-2 py-1.5 font-mono text-[10px] text-chalk-500">
                  no live markets right now.
                </div>
              )
            ) : null}
            <div className="space-y-1.5">
              {portfolio.map((p, i) => {
                const value = p.shares * p.market.currentMid;
                const isSelected = i === selectedIdx;
                return (
                  <button
                    key={p.market.conditionIdHex}
                    type="button"
                    onClick={() => setSelectedIdx(i)}
                    className={[
                      "w-full rounded-[2px] border px-2.5 py-2 text-left transition-colors",
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
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1 font-mono text-[11px] text-chalk-100 leading-snug truncate">
                        {p.market.shortName}
                      </div>
                      {p.real ? (
                        <span className="shrink-0 rounded-[2px] border border-signal-green/40 px-1.5 py-px text-[8px] uppercase tracking-[0.2em] text-signal-green">
                          live
                        </span>
                      ) : (
                        <span className="shrink-0 rounded-[2px] border border-ink-600 px-1.5 py-px text-[8px] uppercase tracking-[0.2em] text-chalk-500">
                          demo
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-2 font-mono text-[9.5px] text-chalk-400">
                      <span style={{ color: kingdom.color }}>
                        {p.market.side}@{p.market.currentMid.toFixed(2)}
                      </span>
                      <span>·</span>
                      <span>{p.shares.toLocaleString()} shrs</span>
                      <span className="ml-auto text-chalk-200">
                        ${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </Step>

          <Step title="loan amount">
            <div className="mb-2 flex items-baseline justify-between font-mono text-[10px]">
              <span className="text-chalk-400">max loan</span>
              <span className="text-chalk-200">
                ${maxLoanUsdc.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                <span className="ml-1 text-chalk-500">
                  ({(HAIRCUT_BPS / 100).toFixed(0)}%)
                </span>
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <NumberInput
                label="usdc"
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
            <div className="mt-2 flex items-center justify-between font-mono text-[9.5px] text-chalk-400">
              <span>≈ {apr.toFixed(1)}% APR</span>
              <span>
                interest{" "}
                <span className="text-chalk-200">
                  ${((principalNum * apr) / 100 * (Number(maturityDays) / 365)).toFixed(2)}
                </span>
              </span>
            </div>
          </Step>

          <button
            disabled={!isConnected || !selected || !principalOk || stage.kind === "submitting"}
            onClick={() => void onSubmit()}
            className={[
              "mt-3 w-full rounded-[2px] border border-black/40 px-3 py-2 font-mono text-[11px] uppercase tracking-[0.22em] font-medium",
              "transition-transform duration-150 active:translate-y-[1px] disabled:cursor-not-allowed disabled:opacity-40",
              "shadow-[inset_0_-2px_0_0_rgba(0,0,0,0.4),inset_0_1px_0_0_rgba(255,255,255,0.18)]",
            ].join(" ")}
            style={{ background: kingdom.color, color: "#0b0b0e", boxShadow: `0 0 20px -8px ${kingdom.color}` }}
          >
            {stage.kind === "submitting"
              ? stage.step ?? "council deliberating…"
              : `submit to ${kingdom.displayName} council`}
          </button>

          {stage.kind === "submitted" ? (
            <ApprovalReceipt stage={stage} kingdom={kingdom} onDismiss={onClose} />
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
          className="overflow-y-auto rounded-[2px] border border-ink-700 bg-ink-900 p-3"
          style={{ borderColor: `${kingdom.color}33` }}
        >
          <div className="mb-2 font-mono text-[9px] uppercase tracking-[0.22em] text-chalk-500">
            council · live feed
          </div>
          {filteredFeed.length === 0 ? (
            <div className="flex h-full min-h-[140px] items-center justify-center px-4 text-center font-mono text-[10px] text-chalk-600">
              {stage.kind === "submitting"
                ? "waiting for council activity…"
                : stage.kind === "input"
                  ? "submit a loan to start the council"
                  : "•••"}
            </div>
          ) : (
            <ul className="space-y-1.5">
              {filteredFeed.map((e) => (
                <li
                  key={e.id}
                  className="rounded-[2px] border border-ink-700 bg-ink-800/50 px-2 py-1.5"
                >
                  <div className="font-mono text-[8.5px] uppercase tracking-[0.18em] text-chalk-500">
                    {labelForFeed(e.type)}
                  </div>
                  <div className="mt-0.5 font-mono text-[10.5px] text-chalk-200 leading-snug">
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

// ---------------------------------------------------------------------------
// ApprovalReceipt — fixed-position popup that overlays the modal once a
// loan submission lands. Shows the audit-chain identifiers a verifier
// cares about: the TEE-derived signer (origination EOA), the
// loan.origination event id (the audit-chain root for this loan), the
// on-chain or synthesised tx hash with a Basescan link, and the
// borrower wallet. Click outside or press the X to dismiss.
// ---------------------------------------------------------------------------

interface ApprovalReceiptProps {
  readonly stage: Extract<FormStage, { kind: "submitted" }>;
  readonly kingdom: Kingdom;
  readonly onDismiss: () => void;
}

function ApprovalReceipt({ stage, kingdom, onDismiss }: ApprovalReceiptProps): JSX.Element {
  const principal = (Number(stage.principalUsdc6) / 1_000_000).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const haircutPct = (stage.haircutBps / 100).toFixed(1);
  // Real path → live Basescan link. Demo path → no real tx; we still
  // show the synthesised hash for narrative completeness but suppress
  // the (broken) explorer link.
  const txExplorerHref =
    stage.real === true && stage.txHash
      ? `https://basescan.org/tx/${stage.txHash}`
      : null;
  const eventVerifyHref = stage.originationId
    ? `https://verify.eigencloud.xyz/app/0x95F2AB29fAa9A4C834B06B0514428d63C6e0E80d`
    : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Loan approved"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/85 px-6 backdrop-blur-sm"
      onClick={onDismiss}
    >
      <div
        className="w-full max-w-[460px] rounded-[3px] border border-signal-green/55 bg-ink-900 p-5 shadow-[0_0_50px_-10px_rgba(120,255,170,0.4)]"
        style={{ borderColor: `${kingdom.color}88` }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.22em] text-signal-green">
            <span className="text-base leading-none">✓</span>
            <span>{stage.real === true ? "loan originated on chain" : "loan approved"}</span>
          </div>
          <button
            onClick={onDismiss}
            aria-label="Close"
            className="rounded-[2px] border border-ink-700 px-2 py-0.5 font-mono text-[10px] text-chalk-500 hover:bg-ink-800 hover:text-chalk-200"
          >
            ×
          </button>
        </div>

        <div
          className="mt-3 rounded-[2px] border border-ink-700 bg-ink-800/60 p-3"
          style={{ borderColor: `${kingdom.color}33` }}
        >
          <div className="font-mono text-[9px] uppercase tracking-[0.22em] text-chalk-500">
            principal
          </div>
          <div className="mt-0.5 font-mono text-[18px] text-chalk-100">
            ${principal} <span className="text-[11px] text-chalk-500">USDC</span>
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-chalk-500">
            haircut {haircutPct}% · underwritten by {kingdom.displayName}
          </div>
        </div>

        <div className="mt-4 space-y-2 font-mono text-[10.5px]">
          <ReceiptRow label="signed event" value={stage.originationId ?? stage.loanId} href={eventVerifyHref} />
          <ReceiptRow
            label="tx hash"
            value={stage.txHash ?? "n/a"}
            href={txExplorerHref}
            sub={stage.real === true ? null : "synthesised (demo path · no on-chain broadcast)"}
          />
          <ReceiptRow label="signed by" value={stage.teeAddress ?? "(unset)"} sub="TEE-derived origination EOA" />
          <ReceiptRow label="borrower" value={stage.borrower ?? "(unset)"} />
        </div>

        <div className="mt-5 flex gap-2">
          <button
            onClick={onDismiss}
            className="flex-1 rounded-[2px] border border-ink-700 bg-ink-800 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-chalk-300 hover:bg-ink-700"
          >
            close
          </button>
          {eventVerifyHref ? (
            <a
              href={eventVerifyHref}
              target="_blank"
              rel="noreferrer"
              className="flex-1 rounded-[2px] border border-signal-green/40 bg-signal-green/15 px-3 py-2 text-center font-mono text-[10px] uppercase tracking-[0.18em] text-signal-green hover:bg-signal-green/25"
            >
              verify on eigencloud ↗
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}

interface ReceiptRowProps {
  readonly label: string;
  readonly value: string;
  readonly href?: string | null;
  readonly sub?: string | null;
}

function ReceiptRow({ label, value, href, sub }: ReceiptRowProps): JSX.Element {
  const display = value.length > 22 ? `${value.slice(0, 12)}…${value.slice(-6)}` : value;
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-ink-700 pb-1.5 last:border-b-0 last:pb-0">
      <div className="text-[9px] uppercase tracking-[0.22em] text-chalk-500 shrink-0">
        {label}
      </div>
      <div className="text-right">
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="text-chalk-100 hover:text-signal-green"
          >
            {display} <span className="text-[9px]">↗</span>
          </a>
        ) : (
          <span className="text-chalk-100">{display}</span>
        )}
        {sub ? (
          <div className="mt-0.5 text-[9px] text-chalk-500 normal-case tracking-normal">
            {sub}
          </div>
        ) : null}
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
  readonly n?: number;
  readonly title: string;
  readonly done?: boolean;
  readonly children: React.ReactNode;
}

function Step({ n, title, done = false, children }: StepProps): JSX.Element {
  return (
    <section className="mb-3">
      <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.22em] text-chalk-500">
        {done ? "✓ " : n !== undefined ? `${String(n)}. ` : ""}
        {title}
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
      <div className="mb-0.5 font-mono text-[9px] uppercase tracking-[0.18em] text-chalk-500">
        {label}
      </div>
      <div className="flex items-center rounded-[2px] border border-ink-700 bg-ink-900 focus-within:border-chalk-500">
        {prefix ? (
          <span className="pl-1.5 font-mono text-[11px] text-chalk-400">{prefix}</span>
        ) : null}
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-transparent px-1.5 py-1 font-mono text-[11px] text-chalk-200 outline-none"
        />
      </div>
    </label>
  );
}

interface RealBorrowArgs {
  /** Borrower as registered on VantaVault — the Polymarket
   *  DepositWallet that actually owns the CTF tokens, not the user's
   *  connected EOA. */
  readonly borrower: Address;
  /** User's connected EOA — owns the DepositWallet, signs the
   *  EIP-712 Batch the relayer submits. */
  readonly eoa: Address;
  /** Relayer auth — either L1-derived CLOB credentials (preferred,
   *  signed once via "connect polymarket") or a long-lived
   *  RELAYER_API_KEY pasted from Polymarket developer settings. */
  readonly auth: RelayerAuth;
  readonly signTypedDataAsync: ReturnType<
    typeof useSignTypedData
  >["signTypedDataAsync"];
  readonly tokenId: string;
  readonly conditionIdHex: string;
  readonly principalUsdc6: bigint;
  readonly maturityTsUnix: number;
  readonly shares: number;
  readonly setStage: (s: FormStage) => void;
}

/**
 * The real borrow path. Five steps, each surfaced as a stage in the
 * modal so the user knows what's happening:
 *   1. Ensure VantaVault recognises the borrower-PROXY
 *      (one-shot register; runtime admin pays gas).
 *   2. EOA signs a meta-tx that Polymarket's relayer submits on the
 *      proxy's behalf — the proxy then calls
 *      `CTF.safeTransferFrom(proxy → VantaVault)`. This is the only
 *      shape that works with Polymarket-managed Safe wallets; the
 *      EOA cannot directly transfer tokens it doesn't own.
 *   3. Wait for the runtime to sign a loan.pledge event citing the
 *      relayed transfer (SSE; up to ~90s).
 *   4. POST /api/origination with the pledgeEventId → real
 *      LoanBook.originate broadcast on Base mainnet.
 *   5. Surface the resulting loanId + tx hash.
 */
async function runRealBorrow(args: RealBorrowArgs): Promise<void> {
  // 1. Register the PROXY on VantaVault if needed. The proxy will be
  //    the `from` of the upcoming TransferSingle and VantaVault gates
  //    onERC1155Received by `borrowerRegistry[from]` (I-VV-1), so it
  //    is the proxy — not the EOA — that must be registered.
  args.setStage({ kind: "submitting", step: "checking proxy registration…" });
  const statusRes = await fetch(
    `/api/runtime/borrower/status?borrower=${args.borrower}`,
  );
  const statusBody = (await statusRes.json()) as
    | { ok: true; registered: boolean }
    | { error: string };
  if (!("ok" in statusBody) || !statusBody.ok) {
    throw new Error(
      "borrower_status_failed: " + ("error" in statusBody ? statusBody.error : "unknown"),
    );
  }
  if (!statusBody.registered) {
    args.setStage({
      kind: "submitting",
      step: "registering proxy on vantavault (gas paid by tee)…",
    });
    const regRes = await fetch("/api/runtime/borrower/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ borrower: args.borrower }),
    });
    const regBody = (await regRes.json()) as
      | { ok: true; alreadyRegistered: boolean; txHash?: string }
      | { error: string; detail?: string };
    if (!regRes.ok || !("ok" in regBody) || !regBody.ok) {
      throw new Error(
        "register_failed: " + ("error" in regBody ? regBody.error : "unknown"),
      );
    }
    // Wait briefly so the Polygon node sees the registration before
    // we ask the proxy to send tokens (ERC-1155 onReceived would
    // revert if the registry hasn't caught up).
    await new Promise((r) => setTimeout(r, 4_000));
  }

  // 2. EOA signs the relayer EIP-712 Batch. Polymarket's relayer pays
  //    gas and submits the wallet's `executeBatch([safeTransferFrom(
  //    wallet → vault, ...)])` on Polygon. We get back a relayer
  //    transaction id to poll.
  const pledgeAmount = BigInt(Math.max(1, args.shares)) * 1_000_000n;
  args.setStage({
    kind: "submitting",
    step: "sign relayer batch in your wallet (polygon)…",
  });
  const relayerTxId = await submitWalletCtfTransfer({
    auth: args.auth,
    eoa: args.eoa,
    wallet: args.borrower,
    ctfAddress: POLYMARKET_CTF_ADDRESS as Address,
    tokenId: BigInt(args.tokenId),
    amount: pledgeAmount,
    recipient: VANTA_VAULT_ADDRESS as Address,
    chainId: POLYMARKET_CTF_CHAIN_ID,
    signTypedData: (typedArgs) =>
      args.signTypedDataAsync({
        domain: typedArgs.domain,
        types: typedArgs.types,
        primaryType: typedArgs.primaryType,
        message: typedArgs.message,
      }),
  });
  args.setStage({
    kind: "submitting",
    step: `relayer queued (${relayerTxId.slice(0, 8)}…) — waiting for polygon mining…`,
  });
  const txHash = await pollRelayerTx({
    auth: args.auth,
    transactionId: relayerTxId,
    timeoutMs: 120_000,
  });

  // 3. Wait for the runtime to sign a loan.pledge event citing this tx.
  args.setStage({
    kind: "submitting",
    step: "waiting for tee to sign loan.pledge (up to 30s)…",
  });
  const pledgeEventId = await waitForPledgeEvent({
    borrower: args.borrower,
    txHash,
    timeoutMs: 90_000,
  });
  if (pledgeEventId === null) {
    throw new Error(
      "pledge_event_timeout: tee didn't see vantavault transfer within 90s",
    );
  }

  // 4. Real origination on Base mainnet.
  args.setStage({
    kind: "submitting",
    step: "submitting to /api/origination (loanbook on base)…",
  });
  const origRes = await fetch("/api/runtime/origination", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      pledgeEventId,
      positionId: args.tokenId,
      requestedPrincipalCapUsdc6: args.principalUsdc6.toString(),
      maturityTs: args.maturityTsUnix,
    }),
  });
  const origBody = (await origRes.json()) as
    | {
        loanId: string;
        txHash: string;
        blockNumber: number;
        haircutBps: number;
        principalUsdc6: string;
        eventId?: string;
        teeAddress?: string;
        borrower?: string;
      }
    | { error: string };
  if (!origRes.ok || "error" in origBody) {
    throw new Error("origination_failed: " + ("error" in origBody ? origBody.error : "unknown"));
  }

  args.setStage({
    kind: "submitted",
    loanId: origBody.loanId,
    principalUsdc6: origBody.principalUsdc6,
    haircutBps: origBody.haircutBps,
    real: true,
    txHash: origBody.txHash,
    ...(origBody.eventId !== undefined ? { originationId: origBody.eventId } : {}),
    ...(origBody.teeAddress !== undefined ? { teeAddress: origBody.teeAddress } : {}),
    ...(origBody.borrower !== undefined ? { borrower: origBody.borrower } : {}),
  });
}

interface WaitArgs {
  readonly borrower: `0x${string}`;
  readonly txHash: `0x${string}`;
  readonly timeoutMs: number;
}

/**
 * Open a fresh SSE subscription and resolve when a loan.pledge event
 * arrives whose body cites our pledge tx hash. Falls back to scanning
 * recent events via /api/events in case the SSE connection drops.
 */
async function waitForPledgeEvent(args: WaitArgs): Promise<string | null> {
  const deadline = Date.now() + args.timeoutMs;
  const txLower = args.txHash.toLowerCase();
  const borrowerLower = args.borrower.toLowerCase();

  return new Promise<string | null>((resolve) => {
    const stream = sseStream();
    let settled = false;
    const finish = (id: string | null): void => {
      if (settled) return;
      settled = true;
      off();
      clearInterval(poller);
      resolve(id);
    };
    const off = stream.subscribe((e) => {
      if (e.type !== "loan.pledge") return;
      const body = (e as { body?: Record<string, unknown> }).body;
      if (!body) return;
      const tx = String(body["tx_hash"] ?? "").toLowerCase();
      const bp = String(body["borrower_proxy"] ?? "").toLowerCase();
      if (tx === txLower && bp === borrowerLower) finish(e.id);
    });
    // Polling fallback for the case where the event landed before
    // subscribe resolved or the SSE socket flapped.
    const poller = setInterval(async () => {
      if (Date.now() > deadline) {
        finish(null);
        return;
      }
      try {
        const r = await fetch("/api/runtime/events?limit=50");
        const j = (await r.json()) as { events?: { id: string; type: string; body?: Record<string, unknown> }[] };
        for (const ev of j.events ?? []) {
          if (ev.type !== "loan.pledge") continue;
          const tx = String(ev.body?.["tx_hash"] ?? "").toLowerCase();
          const bp = String(ev.body?.["borrower_proxy"] ?? "").toLowerCase();
          if (tx === txLower && bp === borrowerLower) {
            finish(ev.id);
            return;
          }
        }
      } catch {
        /* ignore — SSE may still deliver */
      }
    }, 4_000);
  });
}
