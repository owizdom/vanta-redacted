/**
 * Narrator templates — turn an SSE event into a one-line spoken
 * observation. The narrator voice (Antoni, in voice.ts) reads these
 * over the world to give the feel of a live market broadcast.
 *
 * Constraints:
 *  - Templated only. No LLM. Cost-bounded, prod-deterministic.
 *  - One line per event, ≤ ~120 chars. Multiple variants per event
 *    type so consecutive narrations don't sound robotic.
 *  - Returns null when the event isn't worth narrating (e.g. credit
 *    ticks, marks — the event SFX layer covers those).
 *  - Always grounded in real body fields when present; falls back to
 *    a generic phrasing if a field is missing.
 *
 * The narrator's own throttle (25-40s) lives in voice.ts. This
 * module just produces text.
 */

import type { ReasoningEvent } from "./stream";

const AGENT_NAME: Record<number, string> = {
  0: "Opus",
  1: "GPT",
  2: "Gemini",
};

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)] as T;
}

function agentLabel(agentId: number): string {
  return AGENT_NAME[agentId] ?? "the agent";
}

function formatUsdc(raw: unknown): string | null {
  const n =
    typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  const usdc = n / 1_000_000;
  if (usdc < 1) return usdc.toFixed(2);
  return Math.round(usdc).toString();
}

function formatHaircutPct(raw: unknown): string | null {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return (n / 100).toFixed(0);
}

interface TemplateCtx {
  readonly agent: string;
  readonly body: Record<string, unknown>;
}

function tmplInference(ctx: TemplateCtx): string {
  return pick([
    `${ctx.agent} is running a fresh underwriting check.`,
    `${ctx.agent} has just turned its attention to a Polymarket position.`,
    `${ctx.agent} is reading a new market mark.`,
    `${ctx.agent} is contemplating the order book.`,
  ]);
}

function tmplPledge(ctx: TemplateCtx): string {
  const amt = formatUsdc(ctx.body["amount"]);
  if (amt !== null) {
    return pick([
      `A new pledge arrives at the ${ctx.agent} vault — ${amt} CTF tokens.`,
      `${ctx.agent} just received a fresh pledge of ${amt} tokens.`,
    ]);
  }
  return pick([
    `A new pledge arrives at the ${ctx.agent} vault.`,
    `${ctx.agent} just received fresh collateral.`,
  ]);
}

function tmplOrigination(ctx: TemplateCtx): string {
  const principal =
    formatUsdc(ctx.body["principal"]) ?? formatUsdc(ctx.body["principal_usdc6"]);
  const haircut = formatHaircutPct(ctx.body["haircut_bps"]);
  if (principal !== null && haircut !== null) {
    return pick([
      `${ctx.agent} has originated a loan. Principal: ${principal} USDC at ${haircut} percent haircut.`,
      `Loan signed by ${ctx.agent}. ${principal} USDC out, ${haircut} percent haircut applied.`,
    ]);
  }
  if (principal !== null) {
    return `${ctx.agent} has originated a loan. Principal: ${principal} USDC.`;
  }
  return pick([
    `${ctx.agent} has just originated a new loan.`,
    `A loan is opening in the ${ctx.agent} kingdom.`,
  ]);
}

function tmplSettlement(ctx: TemplateCtx): string {
  const amt = formatUsdc(ctx.body["amount"]);
  if (amt !== null) {
    return pick([
      `A loan has settled at maturity — ${amt} USDC returned to the pool.`,
      `${ctx.agent} just closed a position cleanly. ${amt} USDC back in the vault.`,
    ]);
  }
  return pick([
    `A loan has settled at maturity.`,
    `${ctx.agent} just closed a position cleanly.`,
  ]);
}

function tmplLiquidation(ctx: TemplateCtx): string {
  const reason =
    typeof ctx.body["reason"] === "string"
      ? (ctx.body["reason"] as string)
      : null;
  if (reason !== null) {
    return `A loan was liquidated in the ${ctx.agent} kingdom. Reason: ${reason}.`;
  }
  return pick([
    `${ctx.agent} just force-closed a position.`,
    `A liquidation event in the ${ctx.agent} kingdom.`,
  ]);
}

function tmplInflow(ctx: TemplateCtx): string {
  const amt = formatUsdc(ctx.body["amount"]);
  if (amt !== null) {
    return pick([
      `A buyer just paid ${amt} USDC for a signed quote.`,
      `Treasury inflow — ${amt} USDC from a service-agent payment.`,
    ]);
  }
  return pick([
    `A buyer just paid for a signed quote.`,
    `Treasury inflow — someone paid the agent for a market read.`,
  ]);
}

/**
 * Map an SSE event to a narration line, or null if the event
 * shouldn't be narrated. The narrator's own throttle (in voice.ts)
 * decides whether the line actually plays.
 */
export function narrateEvent(e: ReasoningEvent): string | null {
  const body =
    (e as unknown as { body?: Record<string, unknown> }).body ?? {};
  const ctx: TemplateCtx = { agent: agentLabel(e.agentId), body };
  switch (e.type) {
    case "op.inference":
      return tmplInference(ctx);
    case "loan.pledge":
      return tmplPledge(ctx);
    case "loan.origination":
      return tmplOrigination(ctx);
    case "loan.settlement":
      return tmplSettlement(ctx);
    case "loan.liquidation":
      return tmplLiquidation(ctx);
    case "treasury.inflow" as ReasoningEvent["type"]:
      return tmplInflow(ctx);
    default:
      // npc.thought, council.synthesised, loan.mark, loop.* — skip.
      // npc.thought + council.synthesised are kingdom-voice territory.
      // Marks + ticks are too frequent and the SFX layer covers them.
      return null;
  }
}
