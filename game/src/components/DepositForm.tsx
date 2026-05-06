import { useEffect, useMemo, useState } from "react";
import { type Address, type Hex } from "viem";
import {
  useAccount,
  useReadContract,
  useReadContracts,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";

import {
  AGENT_POOL_VAULT_ABI,
  ERC20_ABI,
  USDC_ADDRESS,
  explorerTxUrl,
  formatUsdcRaw,
  parseUsdcInput,
} from "../lib/contracts";
import type { Kingdom } from "../lib/kingdoms";
import { formatUsdc6 } from "../lib/runtime";

interface Props {
  readonly kingdom: Kingdom;
  readonly poolAddress: Address;
  /** Optional banner for after a successful deposit. */
  readonly onDeposited?: () => void;
}

type Phase =
  | { kind: "idle" }
  | { kind: "approving"; hash: Hex }
  | { kind: "depositing"; hash: Hex }
  | { kind: "withdrawing"; hash: Hex }
  | { kind: "done"; hash: Hex; label: string };

/**
 * Stage-2 deposit form. Two-step path: approve USDC → deposit.
 * Both calls are real; on success we surface the tx hash + a
 * basescan link.
 *
 * The "withdraw" lane is shown only when the depositor already
 * holds vault shares.
 */
export function DepositForm({ kingdom, poolAddress, onDeposited }: Props): JSX.Element {
  const { address, isConnected } = useAccount();
  const [input, setInput] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const inputRaw = parseUsdcInput(input);

  // ---- reads ----
  const reads = useReadContracts({
    allowFailure: true,
    contracts:
      address !== undefined
        ? [
            {
              address: USDC_ADDRESS,
              abi: ERC20_ABI,
              functionName: "balanceOf",
              args: [address],
            },
            {
              address: USDC_ADDRESS,
              abi: ERC20_ABI,
              functionName: "allowance",
              args: [address, poolAddress],
            },
            {
              address: poolAddress,
              abi: AGENT_POOL_VAULT_ABI,
              functionName: "balanceOf",
              args: [address],
            },
            {
              address: poolAddress,
              abi: AGENT_POOL_VAULT_ABI,
              functionName: "maxDeposit",
              args: [address],
            },
            {
              address: poolAddress,
              abi: AGENT_POOL_VAULT_ABI,
              functionName: "convertToAssets",
              // dummy value; refetch with real shareBal once we know it
              args: [0n],
            },
          ]
        : [],
    query: { refetchInterval: 12_000 },
  });

  const usdcBal = (reads.data?.[0]?.result as bigint | undefined) ?? 0n;
  const allowance = (reads.data?.[1]?.result as bigint | undefined) ?? 0n;
  const shareBal = (reads.data?.[2]?.result as bigint | undefined) ?? 0n;
  const maxDeposit = (reads.data?.[3]?.result as bigint | undefined) ?? 0n;

  // Preview shares the user would receive for `inputRaw`.
  const preview = useReadContract({
    address: poolAddress,
    abi: AGENT_POOL_VAULT_ABI,
    functionName: "previewDeposit",
    args: [inputRaw ?? 0n],
    query: {
      enabled: inputRaw !== null && inputRaw > 0n,
    },
  });

  // Convert current shares to assets for the "your position" line.
  const positionAssets = useReadContract({
    address: poolAddress,
    abi: AGENT_POOL_VAULT_ABI,
    functionName: "convertToAssets",
    args: [shareBal],
    query: {
      enabled: shareBal > 0n,
      refetchInterval: 12_000,
    },
  });

  // ---- writes ----
  const { writeContractAsync } = useWriteContract();

  // Watch the latest tx hash for confirmation.
  const txHash =
    phase.kind === "approving" || phase.kind === "depositing" || phase.kind === "withdrawing"
      ? phase.hash
      : undefined;

  const wait = useWaitForTransactionReceipt({ hash: txHash });

  // After confirmation, advance phase.
  useEffect(() => {
    if (!wait.data || phase.kind === "idle" || phase.kind === "done") return;
    if (phase.kind === "approving") {
      setPhase({ kind: "idle" });
      void reads.refetch();
    } else if (phase.kind === "depositing") {
      setPhase({ kind: "done", hash: phase.hash, label: "deposit confirmed" });
      setInput("");
      void reads.refetch();
      onDeposited?.();
    } else if (phase.kind === "withdrawing") {
      setPhase({ kind: "done", hash: phase.hash, label: "withdrawal confirmed" });
      void reads.refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wait.data]);

  // ---- handlers ----
  const onApprove = async (): Promise<void> => {
    if (inputRaw === null || address === undefined) return;
    try {
      const hash = await writeContractAsync({
        address: USDC_ADDRESS,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [poolAddress, inputRaw],
      });
      setPhase({ kind: "approving", hash });
    } catch (e) {
      console.error("[approve]", e);
    }
  };

  const onDeposit = async (): Promise<void> => {
    if (inputRaw === null || address === undefined) return;
    try {
      const hash = await writeContractAsync({
        address: poolAddress,
        abi: AGENT_POOL_VAULT_ABI,
        functionName: "deposit",
        args: [inputRaw, address],
      });
      setPhase({ kind: "depositing", hash });
    } catch (e) {
      console.error("[deposit]", e);
    }
  };

  const onWithdraw = async (): Promise<void> => {
    if (address === undefined || shareBal === 0n) return;
    try {
      const assets = (positionAssets.data as bigint | undefined) ?? 0n;
      if (assets === 0n) return;
      const hash = await writeContractAsync({
        address: poolAddress,
        abi: AGENT_POOL_VAULT_ABI,
        functionName: "withdraw",
        args: [assets, address, address],
      });
      setPhase({ kind: "withdrawing", hash });
    } catch (e) {
      console.error("[withdraw]", e);
    }
  };

  // ---- derived UI state ----
  const needsApproval =
    inputRaw !== null && inputRaw > 0n && allowance < inputRaw;
  const insufficient = inputRaw !== null && inputRaw > usdcBal;
  const overCap = inputRaw !== null && maxDeposit > 0n && inputRaw > maxDeposit;

  const previewShares = (preview.data as bigint | undefined) ?? 0n;
  const positionUsdc = (positionAssets.data as bigint | undefined) ?? 0n;

  const busy =
    phase.kind === "approving" ||
    phase.kind === "depositing" ||
    phase.kind === "withdrawing";

  if (!isConnected) {
    return (
      <div className="rounded-[2px] border border-ink-700 bg-ink-800/60 p-4 font-mono text-[10px] uppercase tracking-[0.22em] text-chalk-400">
        connect a wallet to lend into this VANTA's pool
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between text-[10px] uppercase tracking-[0.22em] text-chalk-500 font-mono">
        <span>lend into {kingdom.displayName}</span>
        <span>USDC bal {formatUsdcRaw(usdcBal)}</span>
      </div>

      <div className="flex gap-2">
        <input
          inputMode="decimal"
          placeholder="0.00"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
          className={[
            "flex-1 rounded-[2px] border bg-ink-950 px-3 py-2 font-mono text-sm text-chalk-100",
            "border-ink-700 focus:border-opus focus:outline-none",
            "disabled:opacity-50",
          ].join(" ")}
        />
        <span className="grid place-items-center rounded-[2px] border border-ink-700 bg-ink-800 px-3 font-mono text-xs text-chalk-300">
          USDC
        </span>
      </div>

      {/* preview line */}
      <div className="grid grid-cols-2 gap-3 rounded-[2px] border border-ink-700 bg-ink-800/40 p-2.5 font-mono text-[10px]">
        <Row k="vLP shares" v={previewShares > 0n ? `${formatUsdcRaw(previewShares, 4).slice(1)} vLP` : "—"} />
        <Row k="cap remaining" v={maxDeposit > 0n ? formatUsdcRaw(maxDeposit) : "—"} />
        <Row k="origination fee" v="up to 5% (capped on chain)" />
        <Row k="liquidation floor" v="77% LTV" />
      </div>

      {insufficient ? (
        <Notice tone="red">insufficient USDC balance</Notice>
      ) : null}
      {overCap ? (
        <Notice tone="amber">amount exceeds per-VANTA AUM cap</Notice>
      ) : null}

      <div className="flex gap-2">
        {needsApproval ? (
          <ActionButton
            disabled={inputRaw === null || insufficient || overCap || busy}
            onClick={() => void onApprove()}
            color={kingdom.color}
            label={
              phase.kind === "approving" ? "approving…" : `1. approve USDC`
            }
          />
        ) : (
          <ActionButton
            disabled={inputRaw === null || inputRaw === 0n || insufficient || overCap || busy}
            onClick={() => void onDeposit()}
            color={kingdom.color}
            label={
              phase.kind === "depositing" ? "depositing…" : `lend to ${kingdom.key}`
            }
          />
        )}
      </div>

      {phase.kind === "done" ? (
        <a
          href={explorerTxUrl(phase.hash)}
          target="_blank"
          rel="noreferrer"
          className="block rounded-[2px] border border-signal-green/60 bg-signal-green/10 p-2.5 font-mono text-[10px] text-signal-green hover:bg-signal-green/20"
        >
          {phase.label} · {phase.hash.slice(0, 10)}… ↗
        </a>
      ) : null}

      {/* existing position */}
      {shareBal > 0n ? (
        <div className="mt-3 space-y-2 rounded-[2px] border border-ink-700 bg-ink-800/40 p-3">
          <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.22em] text-chalk-500">
            <span>your stake</span>
            <span className="text-chalk-300">
              {formatUsdcRaw(shareBal, 4).slice(1)} v{kingdom.key}
            </span>
          </div>
          <div className="flex items-center justify-between font-mono text-xs">
            <span className="text-chalk-400">current value</span>
            <span className="font-display font-semibold text-chalk-100">
              {positionUsdc > 0n ? formatUsdc6(positionUsdc.toString()) : "—"}
            </span>
          </div>
          <button
            disabled={busy}
            onClick={() => void onWithdraw()}
            className="w-full rounded-[2px] border border-ink-700 bg-ink-900 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.22em] text-chalk-300 hover:border-ink-600 hover:text-chalk-100 disabled:opacity-50"
          >
            {phase.kind === "withdrawing" ? "withdrawing…" : "withdraw all"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

interface ActionButtonProps {
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly color: string;
  readonly label: string;
}

function ActionButton({ disabled, onClick, color, label }: ActionButtonProps): JSX.Element {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={[
        "flex-1 rounded-[2px] border border-black/40 px-4 py-2.5 font-mono text-xs uppercase tracking-[0.22em] font-medium",
        "transition-transform duration-150 active:translate-y-[2px] disabled:cursor-not-allowed disabled:opacity-40",
        "shadow-[inset_0_-3px_0_0_rgba(0,0,0,0.45),inset_0_2px_0_0_rgba(255,255,255,0.18)]",
      ].join(" ")}
      style={{
        background: color,
        color: "#0b0b0e",
        boxShadow: `0 0 24px -6px ${color}`,
      }}
    >
      {label}
    </button>
  );
}

function Row({ k, v }: { readonly k: string; readonly v: string }): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[9px] uppercase tracking-[0.22em] text-chalk-500">{k}</span>
      <span className="text-chalk-200">{v}</span>
    </div>
  );
}

function Notice({ tone, children }: { readonly tone: "red" | "amber"; readonly children: React.ReactNode }): JSX.Element {
  const cls =
    tone === "red"
      ? "border-signal-red/50 bg-signal-red/10 text-signal-red"
      : "border-signal-amber/50 bg-signal-amber/10 text-signal-amber";
  return (
    <div className={`rounded-[2px] border p-2 font-mono text-[10px] ${cls}`}>{children}</div>
  );
}
