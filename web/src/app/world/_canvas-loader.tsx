/**
 * Client-only loader for the Three.js scene.
 *
 * Three.js modules touch `window` at import time, so they fail during
 * Next's server-render pass. Wrapping `VantaWorld` in `next/dynamic`
 * with `ssr: false` defers module loading to the browser and keeps
 * the page itself a server component (so it can still
 * `fetchAgents()` server-side).
 */
"use client";

import dynamic from "next/dynamic";

import type { V3AgentSummary } from "@/lib/runtime";

const VantaWorld = dynamic(
  () => import("@/app/_components/vanta-world").then((m) => m.VantaWorld),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full w-full items-center justify-center rounded-2xl border border-ink-800 bg-ink-900/60 font-mono text-xs uppercase tracking-[0.22em] text-chalk-500">
        loading 3D scene…
      </div>
    ),
  },
);

export interface CanvasLoaderProps {
  readonly agents: readonly V3AgentSummary[];
}

export function CanvasLoader({ agents }: CanvasLoaderProps): JSX.Element {
  return <VantaWorld agents={agents} />;
}
