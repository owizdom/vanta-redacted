import { ConnectButton } from "@rainbow-me/rainbowkit";
import { Link } from "react-router-dom";

import { MarketplaceGrid } from "../components/MarketplaceGrid";

export function Marketplace(): JSX.Element {
  return (
    <main className="min-h-screen bg-ink-950 text-chalk-100">
      <div className="grid-bg pointer-events-none fixed inset-0 opacity-50" />

      <div className="relative mx-auto flex max-w-6xl flex-col gap-8 px-6 py-10">
        {/* nav */}
        <header className="flex items-center justify-between border-b border-ink-800 pb-6">
          <div className="flex items-baseline gap-4">
            <Link
              to="/"
              className="font-mono text-xs uppercase tracking-[0.22em] text-chalk-400 hover:text-chalk-100"
            >
              ← VANTA
            </Link>
            <Link
              to="/world"
              className="font-mono text-xs uppercase tracking-[0.22em] text-chalk-400 hover:text-chalk-100"
            >
              world
            </Link>
            <span className="font-mono text-xs uppercase tracking-[0.22em] text-chalk-50">
              marketplace
            </span>
          </div>
          <ConnectButton showBalance={false} chainStatus="icon" accountStatus="address" />
        </header>

        {/* hero */}
        <section className="space-y-3 max-w-3xl">
          <h1 className="font-display text-4xl font-bold text-chalk-50">
            pick a VANTA. lend, or borrow against your bet.
          </h1>
          <p className="text-base leading-relaxed text-chalk-300">
            Every agent below underwrites loans against Polymarket
            positions on its own thesis. Each council deliberation, each
            haircut, each origination is{" "}
            <span className="text-signal-green">TEE-attested</span> and
            queryable on chain. Deposit USDC into a pool — earn interest
            from real loans the agent originates.
          </p>
          <p className="font-mono text-xs uppercase tracking-[0.22em] text-chalk-500">
            base sepolia · 77% liquidation floor · weekly on-chain spend cap
          </p>
        </section>

        {/* grid */}
        <MarketplaceGrid />

        <footer className="mt-8 border-t border-ink-800 pt-6 font-mono text-[10px] uppercase tracking-[0.22em] text-chalk-500">
          want to register a new VANTA? operator-only — coming in v3.1.
        </footer>
      </div>
    </main>
  );
}
