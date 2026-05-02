"use client";

import { useEffect, useState } from "react";
import { useConnect, type Connector } from "wagmi";

import { useWallet } from "@/lib/wallet";

export function ConnectModal(): JSX.Element | null {
  const { connectModalOpen, closeConnect, enterDemo } = useWallet();
  const { connectors, connectAsync, error } = useConnect();
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!connectModalOpen) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") closeConnect();
    }
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [connectModalOpen, closeConnect]);

  if (!connectModalOpen) return null;

  async function pick(connector: Connector): Promise<void> {
    setBusy(connector.uid);
    try {
      await connectAsync({ connector });
      closeConnect();
    } catch {
      // wagmi sets `error` already; surface inline below.
    } finally {
      setBusy(null);
    }
  }

  // Dedupe connectors by name (injected often double-registers — e.g. MetaMask
  // shows up via both EIP-6963 detection and the legacy injected fallback).
  const seen = new Set<string>();
  const uniqueConnectors: Connector[] = [];
  for (const c of connectors) {
    const key = (c.name ?? c.id).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueConnectors.push(c);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 backdrop-blur-sm sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label="Connect a wallet"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={closeConnect}
        className="absolute inset-0 cursor-default"
      />
      <div className="relative w-full max-w-[420px] overflow-hidden rounded-t-2xl border border-ink-800 bg-ink-950 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.6)] sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-ink-800 px-5 py-4">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-chalk-400">
              Connect
            </p>
            <h2 className="font-display text-lg font-semibold tracking-tight text-chalk-50">
              Choose a wallet
            </h2>
          </div>
          <button
            type="button"
            onClick={closeConnect}
            aria-label="Close"
            className="grid h-8 w-8 place-items-center rounded-md text-chalk-400 hover:bg-ink-800 hover:text-chalk-200"
          >
            <svg
              viewBox="0 0 14 14"
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path d="M2 2l10 10M12 2 2 12" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="px-3 pt-3">
          <p className="px-2 pb-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-chalk-500">
            Wallets
          </p>
          {uniqueConnectors.length === 0 ? (
            <p className="px-2 py-3 text-sm text-chalk-400">
              No wallets detected. Install MetaMask or scan with WalletConnect.
            </p>
          ) : (
            <ul className="space-y-1">
              {uniqueConnectors.map((c) => (
                <li key={c.uid}>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void pick(c)}
                    className="group flex w-full items-center gap-3 rounded-md px-2 py-2.5 text-left transition hover:bg-ink-900 disabled:opacity-60"
                  >
                    <ConnectorIcon connector={c} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-chalk-50">
                        {connectorDisplayName(c)}
                      </span>
                      <span className="block truncate text-[11px] text-chalk-400">
                        {connectorTagline(c)}
                      </span>
                    </span>
                    {busy === c.uid ? (
                      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-chalk-400">
                        connecting…
                      </span>
                    ) : c.type === "injected" ? (
                      <span className="rounded bg-violet-500/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.16em] text-violet-300">
                        installed
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {error !== null && (
            <p className="mt-2 px-2 text-[11px] text-signal-red">{error.message}</p>
          )}
        </div>

        <div className="mt-2 border-t border-ink-800 bg-gradient-to-br from-violet-500/8 via-ink-950 to-ink-950 px-3 py-3">
          <p className="px-2 pb-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-chalk-500">
            Try without a wallet
          </p>
          <button
            type="button"
            onClick={() => enterDemo()}
            className="group flex w-full items-center gap-3 rounded-md border border-violet-500/30 bg-violet-500/10 px-2 py-2.5 text-left transition hover:border-violet-500/60 hover:bg-violet-500/15"
          >
            <span className="grid h-9 w-9 place-items-center rounded-md bg-violet-500 font-display text-sm font-bold text-chalk-50">
              D
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="text-sm font-medium text-chalk-50">Demo account</span>
                <span className="rounded bg-accent-orange/15 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.16em] text-accent-orange">
                  one click
                </span>
              </span>
              <span className="mt-0.5 block text-[11px] text-chalk-300">
                Pre-funded with $5,000 USDC · pledge any market · no signatures
              </span>
            </span>
            <svg viewBox="0 0 12 12" className="h-3 w-3 text-violet-200" fill="currentColor">
              <path d="M4 1.5 8 6l-4 4.5L3 9.5 6 6 3 2.5 4 1.5Z" />
            </svg>
          </button>
        </div>

        <p className="border-t border-ink-800 px-5 py-3 text-center text-[11px] text-chalk-500">
          By connecting you accept the{" "}
          <a href="/paper" className="text-chalk-400 underline-offset-2 hover:underline">
            terms
          </a>
          . Real-wallet pledges are TEE-signed and on-chain.
        </p>
      </div>
    </div>
  );
}

// ----- helpers -----

function connectorDisplayName(c: Connector): string {
  // wagmi often picks up the wallet's branded name via EIP-6963; fall back to id.
  return c.name ?? c.id;
}

function connectorTagline(c: Connector): string {
  switch (c.type) {
    case "injected":
      return "Browser extension · auto-detected";
    case "walletConnect":
      return "Scan with any mobile wallet";
    case "coinbaseWallet":
      return "Self-custodial wallet from Coinbase";
    default:
      return c.type ?? "Connector";
  }
}

function ConnectorIcon({ connector }: { readonly connector: Connector }): JSX.Element {
  if (connector.icon !== undefined && connector.icon !== "") {
    return (
      <span className="grid h-9 w-9 place-items-center overflow-hidden rounded-md bg-ink-900">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={connector.icon}
          alt={connector.name ?? connector.id}
          className="h-7 w-7 object-contain"
        />
      </span>
    );
  }
  // Fallback monogram from the connector name.
  const ch = (connector.name ?? connector.id).charAt(0).toUpperCase();
  return (
    <span className="grid h-9 w-9 place-items-center rounded-md bg-ink-900 font-display text-sm font-semibold text-chalk-200">
      {ch}
    </span>
  );
}
