"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { fmtUsdc, shortAddress, useWallet } from "@/lib/wallet";

import { AgentChip } from "./agent-chip";
import { AppFooter } from "./app-footer";
import { openWelcomeModal, WelcomeModal } from "./welcome-modal";

export function AppShell({ children }: { readonly children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex min-h-screen flex-col bg-ink-950 text-chalk-50">
      <PixelStrip />
      <TopNav />
      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-8">{children}</main>
      <AppFooter />
      <WelcomeModal />
    </div>
  );
}

function PixelStrip(): JSX.Element {
  return (
    <div
      aria-hidden
      className="h-3 w-full"
      style={{
        backgroundImage: "repeating-conic-gradient(#6c54ff 0% 25%, #c8b9ff 0% 50%)",
        backgroundSize: "8px 8px",
      }}
    />
  );
}

function TopNav(): JSX.Element {
  const wallet = useWallet();

  return (
    <header className="border-b border-ink-800 bg-ink-950">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-3.5">
        <div className="flex items-center gap-7">
          <Link href="/" className="flex items-center gap-2">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-violet-500 font-display text-base font-semibold leading-none text-chalk-50">
              V
            </span>
            <span className="font-display text-lg font-semibold tracking-tight">VANTA</span>
          </Link>
          <nav className="hidden items-center gap-5 text-sm text-chalk-400 lg:flex">
            <Link href="/app" className="font-medium text-chalk-50">
              Markets
            </Link>
            <Link href="/app/positions" className="hover:text-chalk-50">
              Positions
            </Link>
            <Link href="/events" className="hover:text-chalk-50">
              Events
            </Link>
            <Link href="/paper" className="hover:text-chalk-50">
              Docs
            </Link>
            <button
              type="button"
              onClick={openWelcomeModal}
              className="rounded-full border border-ink-700 bg-ink-900 px-3 py-1 text-xs text-chalk-300 transition hover:border-ink-600 hover:text-chalk-50"
            >
              How it works ?
            </button>
          </nav>
        </div>

        <div className="flex items-center gap-2">
          <AgentChip />

          {wallet.connected ? (
            <>
              <BalancePill />
              <AccountChip />
            </>
          ) : (
            <button
              type="button"
              onClick={wallet.openConnect}
              className="rounded-md bg-violet-500 px-4 py-2 text-sm font-medium text-chalk-50 transition hover:bg-violet"
            >
              Connect
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

function BalancePill(): JSX.Element {
  const { balanceUsdc, mode } = useWallet();
  return (
    <div className="hidden items-center gap-1.5 rounded-md border border-ink-800 bg-ink-900 px-3 py-1.5 sm:flex">
      <span className="grid h-4 w-4 place-items-center rounded-full bg-violet-500 font-mono text-[8px] font-semibold text-chalk-50">
        $
      </span>
      <span className="font-mono text-sm font-medium text-chalk-50">
        {fmtUsdc(balanceUsdc)}
      </span>
      {mode === "demo" && (
        <span className="rounded bg-accent-orange/15 px-1 font-mono text-[9px] uppercase tracking-[0.16em] text-accent-orange">
          demo
        </span>
      )}
    </div>
  );
}

function AccountChip(): JSX.Element {
  const { address, mode, disconnect } = useWallet();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent): void {
      if (wrapRef.current !== null && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 rounded-md bg-violet-500 px-3 py-2 text-sm font-medium text-chalk-50 transition hover:bg-violet"
      >
        <span className="grid h-5 w-5 place-items-center rounded-full bg-chalk-50/20 font-mono text-[10px]">
          {mode === "demo" ? "D" : "·"}
        </span>
        <span className="font-mono text-xs">{shortAddress(address)}</span>
        <svg viewBox="0 0 8 8" className="h-2 w-2" fill="currentColor" aria-hidden>
          <path d="M4 5.5 1 2.5h6L4 5.5Z" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-[calc(100%+6px)] z-30 w-56 overflow-hidden rounded-lg border border-ink-800 bg-ink-950 shadow-xl">
          <div className="border-b border-ink-800 px-3 py-2.5">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-chalk-500">
              {mode === "demo" ? "demo account" : "connected"}
            </p>
            <p className="mt-0.5 truncate font-mono text-xs text-chalk-100">{address ?? "—"}</p>
          </div>
          <button
            type="button"
            onClick={() => {
              disconnect();
              setOpen(false);
            }}
            className="block w-full px-3 py-2.5 text-left text-sm text-chalk-200 hover:bg-ink-900"
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
