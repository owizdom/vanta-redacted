import { useEffect, useState } from "react";

import { LandingMenu } from "../components/LandingMenu";
import { fetchAgents, type V3AgentSummary } from "../lib/runtime";
import { VantaWorld } from "../scenes/VantaWorld";

/**
 * Landing route. Slow auto-rotating world fills the background; the
 * menu overlay sits in front of it. Until /api/agents responds we
 * pass an empty array so the world renders with default colours.
 */
export function Landing(): JSX.Element {
  const [agents, setAgents] = useState<readonly V3AgentSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchAgents()
      .then((rows) => {
        if (!cancelled) setAgents(rows);
      })
      .catch(() => {
        // Runtime not up — fall through with [] so world still renders.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="fixed inset-0 overflow-hidden bg-ink-950">
      <div className="absolute inset-0">
        <VantaWorld agents={agents} autoOrbit hideOverlays />
      </div>
      {/* dim wash so menu chrome reads */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-ink-950/40 via-transparent to-ink-950/70" />
      <LandingMenu />
    </main>
  );
}
