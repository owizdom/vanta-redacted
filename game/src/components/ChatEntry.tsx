import { useState } from "react";

import { kingdomForAgentId, type ReasoningEvent } from "../lib/stream";
import { formatUsdc6, relativeTime, shortHash } from "../lib/runtime";

interface Props {
  readonly event: ReasoningEvent;
}

/**
 * One row in the chat panel. Collapsed by default — click to expand
 * the full prompt+response and the TEE attestation hash. Runtime
 * events (deposits, trade.executed, trade.closed) get a subtle glow
 * border tinted to the agent's kingdom colour so they stand out.
 */
export function ChatEntry({ event }: Props): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const kingdom = kingdomForAgentId(event.agentId);
  const color = kingdom?.color ?? "#9b6bff";

  const isWeighty =
    event.type === "trade.executed" ||
    event.type === "trade.closed" ||
    event.type === "pool.deposit" ||
    event.type === "pool.withdraw" ||
    event.type === "loan.origination" ||
    event.type === "loan.settlement" ||
    event.type === "loan.liquidation" ||
    event.type === "loop.credit_tick";

  const isNpcThought = event.type === "npc.thought";
  const isCouncilSynth = event.type === "council.synthesised";

  const typeLabel = labelForType(event.type);

  const copyHash = (e: React.MouseEvent<HTMLButtonElement>): void => {
    e.stopPropagation();
    if (event.attestationHash) {
      void navigator.clipboard.writeText(event.attestationHash);
    }
  };

  // Visual treatments per type:
  //   - npc.thought: dimmed + italic + speaker name. The townsfolk
  //     are "ambient" relative to the agent's primary line.
  //   - council.synthesised: bright, kingdom-tinted ring, "council"
  //     badge — this is the moment the agent updates its mind.
  //   - weighty (trade.executed/closed, pool.deposit/withdraw): glow
  //     ring tinted to the agent.
  return (
    <article
      onClick={() => setExpanded((v) => !v)}
      className={[
        "group relative cursor-pointer rounded-[2px] border p-3 font-mono text-[11px] transition-colors duration-150",
        isNpcThought
          ? "border-ink-800 bg-ink-900/45 hover:border-ink-700"
          : "border-ink-700 bg-ink-900/85 hover:border-ink-600",
        isCouncilSynth
          ? "ring-1 ring-[var(--glow)]/60 shadow-[0_0_28px_-8px_var(--glow)]"
          : isWeighty
            ? "shadow-[0_0_24px_-8px_var(--glow)] ring-1 ring-[var(--glow)]/40"
            : "",
      ].join(" ")}
      style={
        {
          ["--glow" as string]: color,
        } as React.CSSProperties
      }
    >
      <header className="mb-1.5 flex items-center gap-2">
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{
            backgroundColor: color,
            boxShadow: `0 0 6px ${color}`,
            opacity: isNpcThought ? 0.55 : 1,
          }}
        />
        {isNpcThought && event.speakerName ? (
          <>
            <span className="font-medium text-chalk-300 truncate">
              {event.speakerName}
            </span>
            <span className="text-chalk-600">·</span>
            <span className="text-chalk-500">
              of {kingdom?.displayName ?? `agent-${String(event.agentId)}`}
            </span>
          </>
        ) : (
          <>
            <span className="font-medium text-chalk-100">
              {kingdom?.displayName ?? `agent-${String(event.agentId)}`}
            </span>
            <span className="text-chalk-500">·</span>
            <span className="text-chalk-400">{typeLabel}</span>
          </>
        )}
        <span className="ml-auto text-[10px] text-chalk-500">
          {relativeTime(event.timestamp)}
        </span>
      </header>

      {event.market ? (
        <div className="mb-1 truncate text-[10px] uppercase tracking-[0.18em] text-chalk-500">
          polymarket: {event.market}
        </div>
      ) : null}

      <p
        className={[
          "leading-relaxed",
          isNpcThought ? "text-chalk-300 italic" : "text-chalk-200",
          isCouncilSynth ? "font-medium text-chalk-100" : "",
        ].join(" ")}
      >
        {isNpcThought ? `“${event.summary}”` : event.summary}
      </p>

      {isCouncilSynth ? (
        <div
          className="mt-2 inline-block rounded-[2px] border px-2 py-0.5 text-[9px] uppercase tracking-[0.22em]"
          style={{ borderColor: `${color}88`, color }}
        >
          council · synthesised
        </div>
      ) : null}

      {event.action ? (
        <div
          className="mt-2 inline-block rounded-[2px] border px-2 py-0.5 text-[10px] uppercase tracking-[0.18em]"
          style={{ borderColor: `${color}88`, color }}
        >
          {event.action}
        </div>
      ) : null}

      {event.amountUsdc6 ? (
        <div className="mt-2 inline-block rounded-[2px] bg-ink-800 px-2 py-0.5 text-[10px] text-signal-green">
          {formatUsdc6(event.amountUsdc6)}
        </div>
      ) : null}

      {expanded ? (
        <div className="mt-3 space-y-3 border-t border-ink-700 pt-3">
          <pre className="whitespace-pre-wrap break-words text-[10px] leading-relaxed text-chalk-300">
            {event.detail}
          </pre>
          {event.attestationHash ? (
            <div className="flex items-center gap-2 rounded-[2px] bg-ink-800/80 px-2 py-1.5">
              <span className="text-[9px] uppercase tracking-[0.18em] text-chalk-500">
                attestation
              </span>
              <span className="text-[10px] text-chalk-200">
                {shortHash(event.attestationHash, 8, 6)}
              </span>
              <button
                onClick={copyHash}
                className="ml-auto rounded-[2px] border border-ink-600 px-2 py-0.5 text-[9px] uppercase tracking-[0.18em] text-chalk-400 hover:text-chalk-100"
              >
                copy
              </button>
            </div>
          ) : null}
          <div className="text-[9px] uppercase tracking-[0.18em] text-chalk-500">
            click row to collapse
          </div>
        </div>
      ) : null}
    </article>
  );
}

function labelForType(t: ReasoningEvent["type"]): string {
  switch (t) {
    case "reasoning.trace":
      return "reasoned";
    case "belief.updated":
      return "belief shifted";
    case "trade.decision":
      return "decided";
    case "trade.executed":
      return "executed";
    case "trade.closed":
      return "closed";
    case "pool.deposit":
      return "deposit";
    case "pool.withdraw":
      return "withdraw";
    case "npc.thought":
      return "townsperson";
    case "council.synthesised":
      return "weighed council";
    case "loan.origination":
      return "underwrote loan";
    case "loan.pledge":
      return "pledge accepted";
    case "loan.mark":
      return "re-marked loan";
    case "loan.settlement":
      return "loan settled";
    case "loan.liquidation":
      return "loan liquidated";
    case "loop.credit_tick":
      return "credit tick";
    case "op.inference":
      return "model call";
    case "loop.onboard_decision":
      return "onboard decision";
  }
}
