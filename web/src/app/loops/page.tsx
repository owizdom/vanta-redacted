import Link from "next/link";

import { LoopStatus } from "../_components/loop-status";

export default function LoopsPage(): JSX.Element {
  return (
    <main className="min-h-screen">
      <header className="border-b border-ink-800/60 bg-ink-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2 font-display text-lg font-semibold">
            <span className="inline-block h-2 w-2 animate-pulse-dot rounded-full bg-signal-green" />
            VANTA
          </Link>
          <Link href="/" className="text-sm text-chalk-200 hover:text-chalk-50">
            ← back
          </Link>
        </div>
      </header>
      <div className="mx-auto max-w-6xl px-6 pt-12">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-chalk-400">
          paper §7
        </p>
        <h1 className="mt-3 font-display text-4xl font-semibold tracking-tight sm:text-6xl">
          Continuous reasoning loops.
        </h1>
        <p className="mt-6 max-w-2xl text-chalk-200">
          The agent doesn't stop after a loan mints. Four loops watch the
          credit position, the formula's calibration, the runway and oracle
          health, and the candidate-market pipeline. None of them can move
          funds — they reason and sign traces; the contract gates and the
          lender quorum act.
        </p>
      </div>
      <LoopStatus />
    </main>
  );
}
