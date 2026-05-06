import { useEffect, useMemo, useRef, useState } from "react";

import { ChatEntry } from "./ChatEntry";
import {
  KINGDOM_LIST,
  type Kingdom,
} from "../lib/kingdoms";
import { type ReasoningEvent } from "../lib/stream";

interface Props {
  /** Events lifted from the parent so other panels (detail card)
   * can read the same feed without spawning a second subscription. */
  readonly events: readonly ReasoningEvent[];
}

/**
 * Right-side chat panel. Renders events lifted from the parent.
 * Auto-scrolls to bottom unless the cursor is over the panel (so
 * users can read without the feed yanking them down).
 *
 * Top legend has 3 colour dots. Click to mute / unmute a channel.
 */
export function ChatPanel({ events }: Props): JSX.Element {
  const [enabled, setEnabled] = useState<ReadonlySet<number>>(
    () => new Set(KINGDOM_LIST.map((k) => k.agentId)),
  );
  const [hovering, setHovering] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on new events unless user is hovering.
  useEffect(() => {
    if (hovering) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [events, hovering]);

  const filtered = useMemo(
    () => events.filter((e) => enabled.has(e.agentId)),
    [events, enabled],
  );

  const toggle = (agentId: number, soloOnDouble = false): void => {
    setEnabled((prev) => {
      const next = new Set(prev);
      if (soloOnDouble && next.size === 1 && next.has(agentId)) {
        // un-solo: re-enable all
        for (const k of KINGDOM_LIST) next.add(k.agentId);
      } else if (next.has(agentId)) {
        next.delete(agentId);
        if (next.size === 0) for (const k of KINGDOM_LIST) next.add(k.agentId);
      } else {
        next.add(agentId);
      }
      return next;
    });
  };

  return (
    <aside
      className="pointer-events-auto absolute right-4 top-20 bottom-20 z-10 flex w-[360px] flex-col rounded-[2px] border border-ink-700 bg-ink-950/85 shadow-[0_24px_48px_-12px_rgba(0,0,0,0.75)] backdrop-blur-md"
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <header className="flex items-center justify-between border-b border-ink-800 px-3 py-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-chalk-500">
          live reasoning
        </div>
        <div className="flex items-center gap-1.5">
          {KINGDOM_LIST.map((k) => (
            <Toggle
              key={k.key}
              kingdom={k}
              active={enabled.has(k.agentId)}
              onToggle={() => toggle(k.agentId)}
            />
          ))}
        </div>
      </header>

      <div
        ref={scrollRef}
        className="flex-1 space-y-2 overflow-y-auto p-3 [scrollbar-width:thin]"
      >
        {filtered.length === 0 ? (
          <div className="grid h-full place-items-center text-center font-mono text-[10px] uppercase tracking-[0.18em] text-chalk-500">
            <div>
              <span className="block mb-2 animate-pulseDot">•••</span>
              waiting for the first reasoning…
            </div>
          </div>
        ) : (
          filtered.map((e) => <ChatEntry key={e.id} event={e} />)
        )}
      </div>

      <footer className="border-t border-ink-800 px-3 py-2 font-mono text-[9px] uppercase tracking-[0.22em] text-chalk-500">
        {filtered.length} entries · click a row to expand
      </footer>
    </aside>
  );
}

interface ToggleProps {
  readonly kingdom: Kingdom;
  readonly active: boolean;
  readonly onToggle: () => void;
}

function Toggle({ kingdom, active, onToggle }: ToggleProps): JSX.Element {
  return (
    <button
      onClick={onToggle}
      title={`${kingdom.displayName} — click to ${active ? "mute" : "unmute"}`}
      className="group flex items-center gap-1 rounded-[2px] border border-transparent px-1.5 py-0.5 transition-colors hover:border-ink-700"
    >
      <span
        className="inline-block h-2.5 w-2.5 rounded-full transition-opacity"
        style={{
          backgroundColor: kingdom.color,
          boxShadow: active ? `0 0 6px ${kingdom.color}` : "none",
          opacity: active ? 1 : 0.25,
        }}
      />
      <span
        className={[
          "text-[9px] uppercase tracking-[0.22em] transition-colors",
          active ? "text-chalk-200" : "text-chalk-500",
        ].join(" ")}
      >
        {kingdom.key}
      </span>
    </button>
  );
}
