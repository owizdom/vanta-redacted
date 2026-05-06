/**
 * Reasoning stream — the lifeblood of the chat panel.
 *
 * Real SSE only. We subscribe to the runtime's
 * `/api/runtime/events/stream` and translate each signed envelope
 * into a `ReasoningEvent` the chat UI can render. If the runtime is
 * silent the panel sits in its empty waiting state — we never inject
 * fake or placeholder activity.
 */

import { KINGDOM_LIST, kingdomForAgentId, type Kingdom } from "./kingdoms";

export type ReasoningEventType =
  | "reasoning.trace"
  | "belief.updated"
  | "trade.decision"
  | "trade.executed"
  | "trade.closed"
  | "pool.deposit"
  | "pool.withdraw"
  | "npc.thought"
  | "council.synthesised"
  // v3.5 lender events — first-class in the chat panel
  | "loan.origination"
  | "loan.pledge"
  | "loan.mark"
  | "loan.settlement"
  | "loan.liquidation"
  | "loop.credit_tick";

/** Single entry in the chat panel — one signed event from one agent. */
export interface ReasoningEvent {
  readonly id: string;
  readonly agentId: number;
  readonly type: ReasoningEventType;
  readonly timestamp: number;
  /** One-line headline shown collapsed. */
  readonly summary: string;
  /** Full detail shown on expand (multiline). */
  readonly detail: string;
  /** Polymarket question / condition_id, if applicable. */
  readonly market?: string;
  /** Action label e.g. "BUY YES @ 0.18 — $5.0k". */
  readonly action?: string;
  /** TEE attestation hash for the signed envelope. */
  readonly attestationHash?: string;
  /** USDC raw 6-decimals (for pool.* / trade.* amounts). */
  readonly amountUsdc6?: string;
  /** Speaker name for npc.thought (e.g. "Brother Tomás the Cloister Scholar"). */
  readonly speakerName?: string;
  /** Persona slug for npc.thought (e.g. "cloister-scholar"). */
  readonly speakerPersona?: string;
}

export type Unsubscribe = () => void;

export interface ReasoningStream {
  subscribe(handler: (e: ReasoningEvent) => void): Unsubscribe;
}

// ---------------------------------------------------------------------------
// Real SSE stream
// ---------------------------------------------------------------------------

/**
 * Subscribe to /api/runtime/events/stream and translate each signed
 * envelope into a ReasoningEvent. Auto-reconnect is handled by the
 * browser's EventSource implementation; we just clean up on unmount.
 */
export function sseStream(): ReasoningStream {
  return {
    subscribe(handler) {
      const es = new EventSource("/api/runtime/events/stream");
      es.onmessage = (msg) => {
        try {
          const raw = JSON.parse(String(msg.data)) as {
            id?: string;
            type?: string;
            timestamp?: number;
            body?: Record<string, unknown>;
          };
          const ev = translateRuntimeEvent(raw);
          if (ev) handler(ev);
        } catch {
          // Malformed SSE chunk — drop silently rather than crash UI.
        }
      };
      es.onerror = () => {
        // EventSource auto-reconnects with exponential backoff.
      };
      return () => {
        es.close();
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Runtime event → chat ReasoningEvent translator
// ---------------------------------------------------------------------------

/**
 * Some legacy v2 lender events (loan.origination, loan.mark, etc) pre-date
 * the v3 multi-VANTA schema and don't carry agent_id. We attribute them
 * to vanta-opus (agent_id=0, the original VANTA-zero) so they still
 * render in the chat panel under a kingdom colour. v3.5 production
 * wiring will extend these schemas to carry agent_id explicitly.
 */
const LEGACY_LOAN_TYPES = new Set<ReasoningEventType>([
  "loan.origination",
  "loan.pledge",
  "loan.mark",
  "loan.settlement",
  "loan.liquidation",
  "loop.credit_tick",
]);

function translateRuntimeEvent(raw: {
  id?: string;
  type?: string;
  timestamp?: number;
  body?: Record<string, unknown>;
}): ReasoningEvent | null {
  if (!raw.id || !raw.type || typeof raw.timestamp !== "number") return null;
  const body = raw.body ?? {};
  const t = raw.type as ReasoningEventType;
  let agentId =
    typeof body["agent_id"] === "number"
      ? (body["agent_id"] as number)
      : typeof body["agentId"] === "number"
        ? (body["agentId"] as number)
        : -1;
  if (agentId < 0 && LEGACY_LOAN_TYPES.has(t)) {
    agentId = 0;
  }
  if (agentId < 0) return null;
  // Credit ticks are deliberately omitted: they're noisy, mostly
  // numeric, and live in the operational layer rather than the
  // narrative layer. The chat panel surfaces *reasoning* — NPC
  // thoughts, council syntheses, deliberation traces, originations.
  // Health-tick mechanics belong on the loan card, not the feed.
  const known: ReasoningEventType[] = [
    "reasoning.trace",
    "belief.updated",
    "trade.decision",
    "trade.executed",
    "trade.closed",
    "pool.deposit",
    "pool.withdraw",
    "npc.thought",
    "council.synthesised",
    "loan.origination",
    "loan.pledge",
    "loan.mark",
    "loan.settlement",
    "loan.liquidation",
  ];
  if (!known.includes(t)) return null;

  // Per-type summary + detail derivation. The detail string is what
  // the chat panel reveals when the user expands a row — it MUST read
  // as reasoning prose (decision_rationale, NPC thought, council
  // synthesis text), never as raw event JSON. Auditors who want the
  // raw envelope walk /api/events/:id; the chat panel is for humans.
  let summary = String(body["summary"] ?? raw.type);
  let detail = "";

  if (t === "npc.thought" && typeof body["thought"] === "string") {
    summary = body["thought"] as string;
    detail = `${String(body["npc_display_name"] ?? body["npc_id"] ?? "townsperson")} weighing in:\n\n"${body["thought"] as string}"\n\nbelief ${formatCentibps(body["belief_centibps"])}  ·  confidence ${formatBps(body["confidence_bps"])}`;
  } else if (
    t === "council.synthesised" &&
    typeof body["rationale"] === "string"
  ) {
    const prior = formatCentibps(body["prior_belief_centibps"]);
    const post = formatCentibps(body["synthesised_belief_centibps"]);
    const consumed =
      (body["npc_thought_event_ids"] as readonly string[] | undefined)?.length ?? 0;
    summary = `council weighed townsfolk · belief ${prior} → ${post}`;
    detail = `${body["rationale"] as string}\n\nthe agent re-evaluated after hearing ${String(consumed)} townsperson${consumed === 1 ? "" : "s"}.\nprior ${prior}  →  synthesised ${post}.`;
  } else if (t === "reasoning.trace") {
    const rationale =
      typeof body["decision_rationale"] === "string"
        ? (body["decision_rationale"] as string)
        : "";
    const dissent =
      typeof body["dissenting_considerations"] === "string"
        ? (body["dissenting_considerations"] as string)
        : "";
    const subjectType =
      typeof body["subject_event_type"] === "string"
        ? (body["subject_event_type"] as string)
        : "decision";
    summary = rationale.length > 0 ? rationale : `reasoning behind ${subjectType}`;
    detail = rationale.length > 0
      ? `${rationale}${dissent.length > 0 ? `\n\ndissent: ${dissent}` : ""}`
      : `reasoning trace for ${subjectType} (no rationale text recorded).`;
  } else if (t === "trade.decision") {
    const action = body["action"];
    const side = body["side"];
    const size = body["size_usdc6"];
    if (typeof action === "string" && typeof side === "string") {
      summary = `${action.toUpperCase()} ${side.toUpperCase()}${
        typeof size === "string" ? ` · size_usdc6=${size}` : ""
      }`;
    }
    detail = `the agent decided to ${typeof action === "string" ? action.toUpperCase() : "act"}${
      typeof side === "string" ? ` on the ${side.toUpperCase()} side` : ""
    }${typeof size === "string" ? `, sizing ${size} USDC6` : ""}.`;
  } else if (t === "trade.executed") {
    summary = `executed${
      typeof body["size_usdc6"] === "string"
        ? ` · ${body["size_usdc6"] as string} USDC6`
        : ""
    }`;
    detail = `position opened${
      typeof body["size_usdc6"] === "string"
        ? ` for ${body["size_usdc6"] as string} USDC6`
        : ""
    }${typeof body["entry_price_bps"] === "number" ? ` at ${(((body["entry_price_bps"] as number) / 10000) * 100).toFixed(2)}% mid` : ""}.`;
  } else if (t === "trade.closed") {
    summary = `position closed${
      typeof body["pnl_usdc6"] === "string"
        ? ` · pnl ${body["pnl_usdc6"] as string}`
        : ""
    }`;
    detail = `position closed${
      typeof body["pnl_usdc6"] === "string"
        ? `, realised PnL ${body["pnl_usdc6"] as string} USDC6`
        : ""
    }.`;
  } else if (t === "pool.deposit") {
    summary = `deposit${
      typeof body["usdc6_amount"] === "string"
        ? ` · ${body["usdc6_amount"] as string} USDC6`
        : ""
    }`;
    detail = `LP deposited${
      typeof body["usdc6_amount"] === "string"
        ? ` ${body["usdc6_amount"] as string} USDC6`
        : ""
    }${typeof body["depositor_addr"] === "string" ? ` from ${(body["depositor_addr"] as string).slice(0, 10)}…` : ""}.`;
  } else if (t === "pool.withdraw") {
    summary = `withdraw${
      typeof body["usdc6_returned"] === "string"
        ? ` · ${body["usdc6_returned"] as string} USDC6`
        : ""
    }`;
    detail = `LP redeemed shares${
      typeof body["usdc6_returned"] === "string"
        ? `, returned ${body["usdc6_returned"] as string} USDC6`
        : ""
    }.`;
  } else if (t === "belief.updated") {
    const blf = formatCentibps(body["belief_centibps"]);
    const mid = formatCentibps(body["mid_centibps"]);
    summary = `belief ${blf} (mid ${mid})`;
    detail = `the agent's belief about this market is now ${blf}, while the market mid is ${mid}.`;
  } else if (t === "loan.origination") {
    const principal = body["principal"] ?? body["principal_usdc6"];
    const haircut = body["haircut_bps"];
    summary = `loan originated${
      typeof principal === "string" ? ` · principal ${principal} USDC6` : ""
    }${typeof haircut === "number" ? ` · haircut ${(haircut / 100).toFixed(2)}%` : ""}`;
    detail = `loan underwritten and recorded on-chain${
      typeof principal === "string" ? `, principal ${principal} USDC6` : ""
    }${typeof haircut === "number" ? ` at ${(haircut / 100).toFixed(2)}% haircut` : ""}.`;
  } else if (t === "loan.pledge") {
    summary = `pledge accepted${
      typeof body["amount"] === "string"
        ? ` · ${body["amount"] as string} CTF tokens`
        : ""
    }`;
    detail = `borrower's CTF position escrowed in VantaVault${
      typeof body["amount"] === "string"
        ? `, ${body["amount"] as string} CTF tokens locked`
        : ""
    }.`;
  } else if (t === "loan.mark") {
    summary = `loan re-marked${
      typeof body["twap"] === "string"
        ? ` · TWAP ${body["twap"] as string}`
        : ""
    }`;
    detail = `30-min TWAP refreshed from CLOB${
      typeof body["twap"] === "string" ? ` to ${body["twap"] as string}` : ""
    }.`;
  } else if (t === "loan.settlement") {
    summary = `loan settled${
      typeof body["amount"] === "string"
        ? ` · returned ${body["amount"] as string}`
        : ""
    }`;
    detail = `borrower repaid in full${
      typeof body["amount"] === "string"
        ? `, returned ${body["amount"] as string} USDC6 to the pool`
        : ""
    }.`;
  } else if (t === "loan.liquidation") {
    summary = `loan LIQUIDATED${
      typeof body["reason"] === "string"
        ? ` — ${body["reason"] as string}`
        : ""
    }`;
    detail = `loan was force-closed${
      typeof body["reason"] === "string"
        ? ` (${body["reason"] as string})`
        : ""
    }.`;
  } else if (t === "loop.credit_tick") {
    const flag = typeof body["flag"] === "string" ? (body["flag"] as string) : "ok";
    const ltv = typeof body["ltv_current_bps"] === "number" ? body["ltv_current_bps"] : 0;
    summary = `credit tick · flag ${flag.toUpperCase()} · LTV ${(ltv / 100).toFixed(2)}%`;
    const flagText: Record<string, string> = {
      ok: "loan is comfortably under the freeze threshold; no action.",
      watch: "within the watch band — monitoring closely.",
      freeze_request: "approaching freeze threshold; prepared to mark and call.",
    };
    detail = `${flagText[flag] ?? "credit health observed."} current LTV ${(ltv / 100).toFixed(2)}%.`;
  }

  // Final guard: never render raw event JSON. If a downstream type
  // slipped through without a detail string, fall back to the summary
  // line so the expanded view stays readable.
  if (detail.length === 0) detail = summary;

  return {
    id: raw.id,
    agentId,
    type: t,
    timestamp: raw.timestamp,
    summary,
    detail,
    market:
      typeof body["market_id"] === "string"
        ? (body["market_id"] as string)
        : undefined,
    action:
      typeof body["action"] === "string"
        ? (body["action"] as string)
        : undefined,
    attestationHash:
      typeof body["attestation_hash"] === "string"
        ? (body["attestation_hash"] as string)
        : undefined,
    amountUsdc6:
      typeof body["amount_usdc6"] === "string"
        ? (body["amount_usdc6"] as string)
        : typeof body["proceeds_usdc6"] === "string"
          ? (body["proceeds_usdc6"] as string)
          : typeof body["usdc6_amount"] === "string"
            ? (body["usdc6_amount"] as string)
            : typeof body["usdc6_returned"] === "string"
              ? (body["usdc6_returned"] as string)
              : undefined,
    speakerName:
      typeof body["npc_display_name"] === "string"
        ? (body["npc_display_name"] as string)
        : undefined,
    speakerPersona:
      typeof body["npc_persona"] === "string"
        ? (body["npc_persona"] as string)
        : undefined,
  };
}

function formatCentibps(v: unknown): string {
  if (typeof v !== "number") return "—";
  return (v / 1_000_000).toFixed(3);
}

function formatBps(v: unknown): string {
  if (typeof v !== "number") return "—";
  return (v / 10_000).toFixed(2);
}

// ---------------------------------------------------------------------------
// Helpers used by the chat UI
// ---------------------------------------------------------------------------

/** Apply enabled-agent filter to a stream of events. */
export function filterByAgents(
  events: readonly ReasoningEvent[],
  enabledAgentIds: ReadonlySet<number>,
): readonly ReasoningEvent[] {
  return events.filter((e) => enabledAgentIds.has(e.agentId));
}

/** All kingdoms for the legend. */
export function allKingdoms(): readonly Kingdom[] {
  return KINGDOM_LIST;
}

export { kingdomForAgentId };
