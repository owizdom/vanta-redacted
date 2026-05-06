/**
 * /world — Three.js multi-VANTA plaza viewer.
 *
 * Single client-side page: fetches agents via the runtime's
 * `/api/agents` proxy and renders the Three.js scene directly. No
 * `next/dynamic`, no SSR boundary — keeps the bundle straightforward
 * and the failure surface small.
 */

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { VantaWorld } from "@/app/_components/vanta-world";
import { fetchAgents, type V3AgentSummary } from "@/lib/runtime";

export default function WorldPage(): JSX.Element {
  const [agents, setAgents] = useState<readonly V3AgentSummary[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchAgents()
      .then((rows) => {
        if (!cancelled) {
          setAgents(rows);
          setLoaded(true);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setErr(e instanceof Error ? e.message : "fetch_failed");
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="relative min-h-screen overflow-hidden bg-ink-950">
      <div className="grid-bg absolute inset-0" aria-hidden />

      <div className="relative z-10 mx-auto flex h-screen max-w-7xl flex-col gap-6 px-6 py-8">
        <header className="flex items-baseline justify-between border-b border-ink-800 pb-4">
          <div className="flex items-baseline gap-6">
            <Link
              href="/"
              className="font-mono text-xs uppercase tracking-[0.22em] text-chalk-400 hover:text-chalk-200"
            >
              ← VANTA
            </Link>
            <h1 className="font-display text-2xl font-semibold text-chalk-50">
              Plaza
            </h1>
            <span className="font-mono text-xs text-chalk-500">
              {loaded ? `${String(agents.length)} VANTAs registered` : "loading…"}
            </span>
          </div>
          <div className="flex gap-3 font-mono text-xs">
            <Link href="/marketplace" className="text-chalk-400 hover:text-chalk-200">
              marketplace
            </Link>
          </div>
        </header>

        {err !== null ? (
          <div className="rounded-2xl border border-rose-900/80 bg-rose-950/40 p-6 font-mono text-sm text-rose-200">
            failed to load agents: {err}
          </div>
        ) : (
          <div className="min-h-[600px] flex-1">
            <VantaWorld agents={agents} />
          </div>
        )}

        <footer className="flex items-center justify-between text-xs text-chalk-500">
          <div className="font-mono">scene rendered with three.js — no minecraft, no docker</div>
          <div className="flex gap-4">
            {agents.map((a) => (
              <Link
                key={a.agent_id}
                href={`/agent/${String(a.agent_id)}`}
                className="flex items-center gap-2 hover:text-chalk-200"
              >
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: a.color_hex }}
                  aria-hidden
                />
                <span className="font-mono">{a.name}</span>
              </Link>
            ))}
          </div>
        </footer>
      </div>
    </main>
  );
}
