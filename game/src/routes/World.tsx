import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { AgentDetailCard } from "../components/AgentDetailCard";
import { AudioToggle } from "../components/AudioToggle";
import { ChatPanel } from "../components/ChatPanel";
import { HowItWorksModal } from "../components/HowItWorksModal";
import { MadeSovereignWith } from "../components/MadeSovereignWith";
import { playSfx, sfxForEventType } from "../lib/audio";
import { fetchAgents, type V3AgentSummary } from "../lib/runtime";
import { sseStream, type ReasoningEvent } from "../lib/stream";
import { narrateEvent } from "../lib/narrator";
import { speakCouncil, speakNarrator } from "../lib/voice";
import { VantaWorld } from "../scenes/VantaWorld";

const ACTIVITY_WINDOW_MS = 30_000;
const ACTIVITY_NORM = 8; // events/30s that map to activity = 1.0

const MAX_ENTRIES = 200;

/**
 * /world — the active game view. World fills the screen with HUD
 * overlays. Clicking a kingdom ring opens the AgentDetailCard.
 *
 * Reasoning stream is subscribed at this level so both the chat
 * panel and the detail card consume the same feed without spawning
 * duplicate subscriptions.
 */
export function World(): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialAgentId = (() => {
    const raw = searchParams.get("agent");
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  })();

  const [agents, setAgents] = useState<readonly V3AgentSummary[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<number | null>(initialAgentId);
  const [events, setEvents] = useState<readonly ReasoningEvent[]>([]);
  const [showHowItWorks, setShowHowItWorks] = useState(false);

  // Sync the URL param when the user opens / closes a card so deep links work.
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (selectedAgentId === null) {
      next.delete("agent");
    } else {
      next.set("agent", String(selectedAgentId));
    }
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAgentId]);

  // Fetch agents.
  useEffect(() => {
    let cancelled = false;
    fetchAgents()
      .then((rows) => {
        if (!cancelled) setAgents(rows);
      })
      .catch((e: unknown) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : "fetch_failed");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Subscribe to the runtime's signed-event SSE stream. Real only —
  // the panel sits in its empty waiting state until the runtime
  // emits its first event.
  //
  // Per-event we also dispatch a short SFX (audio engine no-ops if
  // the user hasn't unmuted) and, on `council.synthesised`, queue
  // a TTS line for the agent's voice persona via the proxied
  // ElevenLabs endpoint (no-ops if no key is configured).
  useEffect(() => {
    const stream = sseStream();
    const off = stream.subscribe((e) => {
      setEvents((prev) => {
        const next = [...prev, e];
        if (next.length > MAX_ENTRIES) next.splice(0, next.length - MAX_ENTRIES);
        return next;
      });
      // Audio reaction. Every event triggers an SFX (no-op when
      // muted). `council.synthesised` fires a kingdom-voice line.
      // Other events go through the narrator (Antoni), throttled
      // to a 25-40s gap so it threads commentary without dominating.
      const sfx = sfxForEventType(e.type);
      if (sfx !== null) playSfx(sfx);
      if (e.type === "council.synthesised") {
        const body = (e as unknown as { body?: { rationale?: string } }).body;
        const rationale = body?.rationale ?? "The council has reached a decision.";
        void speakCouncil(e.agentId, rationale);
      } else {
        const line = narrateEvent(e);
        if (line !== null) void speakNarrator(line);
      }
    });
    return off;
  }, []);

  // Compute per-agent activity (events per ACTIVITY_WINDOW_MS, normalised
  // into 0..1) so the kingdom rings + lights can pulse on real chatter.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 2000);
    return () => window.clearInterval(id);
  }, []);

  const activity = useMemo(() => {
    const counts: Record<number, number> = {};
    const cutoff = now - ACTIVITY_WINDOW_MS;
    for (const e of events) {
      if (e.timestamp < cutoff) continue;
      counts[e.agentId] = (counts[e.agentId] ?? 0) + 1;
    }
    const out: Record<number, number> = {};
    for (const k of Object.keys(counts)) {
      const agentId = Number(k);
      const n = counts[agentId] ?? 0;
      out[agentId] = Math.min(1, n / ACTIVITY_NORM);
    }
    return out;
  }, [events, now]);

  return (
    <main className="fixed inset-0 overflow-hidden bg-ink-950">
      <div className="absolute inset-0">
        <VantaWorld
          agents={agents}
          hideOverlays
          onAgentClick={setSelectedAgentId}
          activity={activity}
        />
      </div>

      {/* top-left nav */}
      <header className="pointer-events-none absolute left-4 top-4 z-10 flex items-baseline gap-3">
        <Link
          to="/"
          className="pointer-events-auto rounded-[2px] border border-ink-700 bg-ink-900/85 px-3 py-1.5 font-mono text-xs uppercase tracking-[0.22em] text-chalk-300 hover:text-chalk-50"
        >
          ← VANTA
        </Link>
        <span className="rounded-[2px] border border-ink-700 bg-ink-900/85 px-3 py-1.5 font-mono text-xs uppercase tracking-[0.22em] text-chalk-500">
          {agents.length} VANTAs registered
        </span>
      </header>

      {/* top-right wallet */}
      <div className="pointer-events-none absolute right-4 top-4 z-10 flex items-center gap-3">
        <button
          type="button"
          onClick={() => setShowHowItWorks(true)}
          className="pointer-events-auto grid h-7 w-7 place-items-center rounded-[2px] border border-ink-700 bg-ink-900/85 font-mono text-[11px] font-semibold text-chalk-300 hover:text-chalk-50"
          aria-label="how it works"
          title="how it works"
        >
          ?
        </button>
        <AudioToggle />
        <span className="pointer-events-auto rounded-[2px] border border-ink-700 bg-ink-900/85 px-3 py-1.5">
          <MadeSovereignWith size="sm" />
        </span>
        <div className="pointer-events-auto">
          <ConnectButton showBalance={false} chainStatus="icon" accountStatus="address" />
        </div>
      </div>

      {/* live reasoning chat panel */}
      <ChatPanel events={events} />

      <HowItWorksModal
        open={showHowItWorks}
        onClose={() => setShowHowItWorks(false)}
      />

      {/* footer hint */}
      <footer className="pointer-events-none absolute bottom-4 left-4 z-10 rounded-[2px] border border-ink-700 bg-ink-900/85 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.22em] text-chalk-400">
        drag to orbit · scroll to zoom · click a glowing ring to lend or borrow
      </footer>

      {err ? (
        <div className="pointer-events-auto absolute left-1/2 top-20 z-20 -translate-x-1/2 rounded-[2px] border border-signal-red/60 bg-ink-900/95 px-4 py-2 font-mono text-xs text-signal-red">
          runtime offline: {err}
        </div>
      ) : null}

      {/* agent detail layer (slice 3) */}
      <AgentDetailCard
        agentId={selectedAgentId}
        latestReasoning={events}
        onClose={() => setSelectedAgentId(null)}
        onBack={() => setSelectedAgentId(null)}
      />
    </main>
  );
}
