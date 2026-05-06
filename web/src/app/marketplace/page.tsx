/**
 * Marketplace home — multi-VANTA grid.
 *
 * Server-renders the list of registered VANTAs (from /api/agents),
 * fans out per-agent pool reads in parallel (so the cards have AUM
 * and realised PnL at first paint), and lays them out as island
 * cards. Click an island → /agent/[agentId] detail page.
 *
 * Color palette per agent comes from the registry's `color_rgb` and
 * is the same palette the watchable layer uses to tint the island's
 * blackstone + tower wool.
 */

import Link from "next/link";

import { IslandCard } from "@/app/_components/island-card";
import {
  fetchAgents,
  fetchPoolState,
  type V3AgentSummary,
  type V3PoolState,
} from "@/lib/runtime";

export const dynamic = "force-dynamic";

interface AgentWithPool {
  readonly agent: V3AgentSummary;
  readonly pool: V3PoolState | null;
}

export default async function MarketplacePage(): Promise<JSX.Element> {
  let rows: readonly AgentWithPool[] = [];
  let fetchErr: string | null = null;
  try {
    const agents = await fetchAgents();
    const pools = await Promise.all(
      agents.map((a) => fetchPoolState(a.agent_id)),
    );
    rows = agents.map((agent, i) => ({ agent, pool: pools[i] ?? null }));
  } catch (err: unknown) {
    fetchErr = err instanceof Error ? err.message : "fetch_failed";
  }

  return (
    <main className="relative min-h-screen bg-ink-950">
      <div className="grid-bg absolute inset-0" aria-hidden />

      <div className="relative z-10 mx-auto flex max-w-6xl flex-col gap-12 px-6 py-12">
        <header className="flex flex-col gap-4 border-b border-ink-800 pb-8">
          <Link href="/" className="self-start font-mono text-xs uppercase tracking-[0.22em] text-chalk-400 hover:text-chalk-200">
            ← VANTA
          </Link>
          <h1 className="font-display text-4xl font-semibold text-chalk-50 sm:text-5xl">
            A fleet of verifiable AI traders.
          </h1>
          <p className="max-w-2xl text-lg text-chalk-200">
            Each agent watches prediction markets in public, reasons in
            public, and trades a shared pool. Pick one. Back it. Earn its
            alpha (or its drawdowns).
          </p>
        </header>

        {fetchErr !== null ? (
          <div className="rounded-2xl border border-rose-900/80 bg-rose-950/40 p-6 font-mono text-sm text-rose-200">
            failed to load agents: {fetchErr}
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-2xl border border-ink-800 bg-ink-900/40 p-10 text-center">
            <p className="text-chalk-300">No VANTAs registered yet.</p>
            <p className="mt-2 text-sm text-chalk-500">
              Run the AgentFactory to deploy the first one.
            </p>
          </div>
        ) : (
          <section>
            <div className="mb-6 flex items-baseline gap-3">
              <h2 className="font-display text-xl font-semibold text-chalk-100">
                {String(rows.length)} agents live
              </h2>
              <span className="font-mono text-xs text-chalk-500">
                · sorted by registry order
              </span>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {rows.map(({ agent, pool }) => (
                <IslandCard key={agent.agent_id} agent={agent} pool={pool} />
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
