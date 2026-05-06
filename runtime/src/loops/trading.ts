/**
 * Trading loop — paper §7 evolved into v3's "fund-style trading
 * agent." Per VANTA, per tick:
 *
 *   1. List the agent's watched markets (from PortfolioReader).
 *   2. Read each market's current mid + book depth.
 *   3. Read open positions + portfolio totals.
 *   4. For each market, ask the belief engine for `(belief,
 *      confidence)` (LLM call in prod; deterministic stub in paper
 *      mode).
 *   5. Run decide-policy → `Decision` (enter/hold/exit + size).
 *   6. Emit `belief.updated` (always) + `reasoning.trace` + then,
 *      for non-hold decisions, `trade.decision`. The executor (Phase
 *      C) consumes `trade.decision` events to actually call
 *      `PositionBook.open(...)` and emits the resulting
 *      `trade.executed` event.
 *
 * The loop is per-VANTA: the runtime fleet host instantiates one
 * loop per registered agent at boot. Each loop's `agent_id`,
 * `genesis_id`, and `events` sink are pinned at construction.
 *
 * Paper-trading mode (default in local-dev) uses
 * `createPaperBeliefEngine` so the loop runs without an LLM
 * provider; the events still have full lineage and the on-chain
 * write is performed by a stub executor that emits a synthetic
 * `trade.executed`. Real Polymarket CLOB writes land in Phase C.
 */

import type { Sha256Hex } from "@vanta/tee";

import type {
  EventSink,
  LoopClock,
  LoopContext,
  ReasoningLoop,
  ReasoningTraceBody,
} from "./types.js";
import type { BeliefEngine, BeliefRequest } from "../services/belief-engine.js";
import type {
  Decision,
  DecidePolicyParams,
  MarketSnapshot,
  Portfolio,
} from "../services/decide-policy.js";
import { decide } from "../services/decide-policy.js";
import type { NpcCouncil } from "../services/npc-council.js";

/**
 * The trading loop's view of one watched market. Pulled by
 * PortfolioReader/MarketsCache (paper-mode: a hardcoded list).
 */
export interface WatchedMarket {
  readonly market_id: Sha256Hex;
  readonly market_question: string;
  readonly time_to_resolution_seconds: number;
  readonly recent_trade_count: number;
}

/**
 * Adapter that the runtime supplies. Paper-mode wires it to a
 * fixture file; production wires it to `@vanta/mark.fetchMidpoint`
 * + `fetchBook`.
 */
export type FetchSnapshotFn = (m: WatchedMarket) => Promise<MarketSnapshot>;

/**
 * Adapter that reads the per-VANTA portfolio. In production this
 * reads `AgentPoolVault.totalAssets()` + `PositionBook` open
 * positions. In paper mode it tracks an in-memory ledger.
 */
export type ReadPortfolioFn = () => Promise<Portfolio>;

/**
 * Paper-mode executor: consume a non-hold decision and emit a
 * synthetic `trade.executed` / `trade.closed`. Production wiring
 * (Phase C) replaces this with a real Polymarket CLOB call +
 * `PositionBook.open(...)` confirmation.
 */
export type ExecuteDecisionFn = (
  decision: Decision,
  beliefEventId: Sha256Hex,
  decisionEventId: Sha256Hex,
) => Promise<void>;

export interface TradingLoopArgs {
  readonly ctx: LoopContext;
  readonly agent_id: number;
  readonly listWatched: () => Promise<readonly WatchedMarket[]>;
  readonly fetchSnapshot: FetchSnapshotFn;
  readonly readPortfolio: ReadPortfolioFn;
  readonly belief: BeliefEngine;
  readonly execute: ExecuteDecisionFn;
  readonly policy: DecidePolicyParams;
  /**
   * Optional NPC council. When present, the loop runs a council pass
   * after `belief.compute` and uses the synthesised belief in
   * `decide()`. When absent, the loop behaves exactly as before.
   * Council failures fall back to the original belief silently.
   */
  readonly council?: NpcCouncil;
  /** Tick cadence in seconds. Default 60. */
  readonly tickSeconds?: number;
  /** Override sleep; tests bypass timers. */
  readonly sleepMs?: (ms: number) => Promise<void>;
}

const DEFAULT_TICK_SECONDS = 60;
const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function probToCentibps(p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1_000_000;
  return Math.round(p * 1_000_000);
}

function probToBps(p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 10_000;
  return Math.round(p * 10_000);
}

function buildTraceBody(args: {
  readonly subjectEventId: Sha256Hex;
  readonly market: WatchedMarket;
  readonly snapshot: MarketSnapshot;
  readonly decision: Decision;
}): ReasoningTraceBody {
  const { subjectEventId, market, snapshot, decision } = args;
  const midPct = (snapshot.mid * 100).toFixed(2);
  const beliefPct = (decision.belief_centibps / 10_000).toFixed(2);
  const gapPct = (decision.gap_bps / 100).toFixed(2);

  const rationale =
    decision.action === "enter"
      ? `Edge: belief ${beliefPct}% vs mid ${midPct}% (gap ${gapPct}pp). Entering ${decision.side.toUpperCase()} size=${decision.size_usdc6.toString()}. ${decision.reason}.`
      : decision.action === "exit"
        ? `Exit: belief ${beliefPct}% has converged with mid ${midPct}% (gap ${gapPct}pp). Closing position. ${decision.reason}.`
        : `Hold: ${decision.reason}.`;

  return {
    subject_event_id: subjectEventId,
    subject_event_type:
      decision.action === "hold" ? "belief.updated" : "trade.decision",
    inputs_summary: {
      market_id: market.market_id,
      market_question: market.market_question.slice(0, 200),
      mid: snapshot.mid.toFixed(4),
      depth_5pct_usdc6: snapshot.depth_5pct_usdc6.toString(),
      time_to_resolution_seconds: market.time_to_resolution_seconds,
      recent_trade_count: market.recent_trade_count,
    },
    intermediate_scores: {
      mid_centibps: decision.mid_centibps,
      belief_centibps: decision.belief_centibps,
      confidence_bps: decision.confidence_bps,
      gap_bps: decision.gap_bps,
    },
    decision_rationale: rationale,
    dissenting_considerations: "",
    model_id: "",
    prompt_hash: "",
  };
}

const ZERO_HEX: Sha256Hex =
  "0000000000000000000000000000000000000000000000000000000000000000" as Sha256Hex;

async function tickOne(args: {
  readonly agent_id: number;
  readonly market: WatchedMarket;
  readonly fetchSnapshot: FetchSnapshotFn;
  readonly belief: BeliefEngine;
  readonly portfolio: Portfolio;
  readonly policy: DecidePolicyParams;
  readonly events: EventSink;
  readonly genesisId: Sha256Hex;
  readonly execute: ExecuteDecisionFn;
  readonly council?: NpcCouncil;
}): Promise<void> {
  const snapshot = await args.fetchSnapshot(args.market);

  const beliefReq: BeliefRequest = {
    market_id: args.market.market_id,
    market_question: args.market.market_question,
    current_mid: snapshot.mid,
    time_to_resolution_seconds: args.market.time_to_resolution_seconds,
    recent_trade_count: args.market.recent_trade_count,
  };
  let belief = await args.belief.compute(beliefReq);

  const beliefEventId = await args.events.emit({
    type: "belief.updated",
    body: {
      agent_id: args.agent_id,
      market_id: args.market.market_id,
      belief_centibps: probToCentibps(belief.belief),
      confidence_bps: probToBps(belief.confidence),
      mid_centibps: probToCentibps(snapshot.mid),
      gap_bps: probToBps(belief.belief) - probToBps(snapshot.mid),
      inference_event_id: belief.inference_event_id,
    },
    parentIds: [args.genesisId],
  });

  // Council pass — fold townsfolk thoughts into the working belief.
  // Cooldown lives in the council itself; if it returns null we
  // proceed with the original belief unchanged. Failures are logged
  // and swallowed so a council outage never blocks a trade.
  if (args.council) {
    try {
      const synth = await args.council.run({
        market_id: args.market.market_id,
        market_question: args.market.market_question,
        current_mid: snapshot.mid,
        prior_belief: belief.belief,
        prior_confidence: belief.confidence,
        belief_event_id: beliefEventId,
      });
      if (synth !== null) {
        belief = {
          market_id: belief.market_id,
          belief: synth.synthesisedBelief,
          confidence: synth.synthesisedConfidence,
          inference_event_id: synth.synthesisEventId,
        };
      }
    } catch (err: unknown) {
      // eslint-disable-next-line no-console
      console.warn(
        `vanta/trading-loop[agent=${String(args.agent_id)}]: council pass for ${args.market.market_id} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const decision = decide({
    snapshot,
    belief,
    portfolio: args.portfolio,
    params: args.policy,
  });

  if (decision.action === "hold") {
    // Trace explains the HOLD; no primary event for the no-op.
    const traceBody = buildTraceBody({
      subjectEventId: beliefEventId,
      market: args.market,
      snapshot,
      decision,
    });
    await args.events.emit({
      type: "reasoning.trace",
      body: traceBody,
      parentIds: [args.genesisId, beliefEventId],
    });
    return;
  }

  // Non-hold: emit reasoning.trace before the primary so the trace
  // can pin the upcoming primary's id (we use the belief event as
  // the trace's subject for the schema, but the primary will pin
  // back via trace_hash).
  const traceBody = buildTraceBody({
    subjectEventId: beliefEventId,
    market: args.market,
    snapshot,
    decision,
  });
  const traceId = await args.events.emit({
    type: "reasoning.trace",
    body: traceBody,
    parentIds: [args.genesisId, beliefEventId],
  });

  const decisionEventId = await args.events.emit({
    type: "trade.decision",
    body: {
      agent_id: args.agent_id,
      market_id: args.market.market_id,
      action: decision.action,
      side: decision.side,
      size_usdc6: decision.size_usdc6.toString(),
      belief_centibps: decision.belief_centibps,
      confidence_bps: decision.confidence_bps,
      mid_centibps: decision.mid_centibps,
      gap_bps: decision.gap_bps,
      position_id: decision.position_id,
      trace_hash: traceId,
      belief_event_id: beliefEventId,
    },
    parentIds: [args.genesisId, beliefEventId, traceId],
  });

  await args.execute(decision, beliefEventId, decisionEventId);
}

export function createTradingLoop(args: TradingLoopArgs): ReasoningLoop {
  const tickMs = (args.tickSeconds ?? DEFAULT_TICK_SECONDS) * 1_000;
  const sleep = args.sleepMs ?? realSleep;
  let stopping = false;
  let inFlight: Promise<void> = Promise.resolve();
  let lastTickAt: number | null = null;

  const runTick = async (): Promise<void> => {
    const watched = await args.listWatched();
    const portfolio = await args.readPortfolio();
    for (const market of watched) {
      if (stopping) return;
      try {
        const base = {
          agent_id: args.agent_id,
          market,
          fetchSnapshot: args.fetchSnapshot,
          belief: args.belief,
          portfolio,
          policy: args.policy,
          events: args.ctx.events,
          genesisId: args.ctx.genesisId,
          execute: args.execute,
        };
        await tickOne(
          args.council === undefined
            ? base
            : { ...base, council: args.council },
        );
      } catch (err: unknown) {
        // eslint-disable-next-line no-console
        console.warn(
          `vanta/trading-loop[agent=${String(args.agent_id)}]: tick for ${market.market_id} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    lastTickAt = args.ctx.clock.nowMs();
  };

  const start = (): void => {
    void (async () => {
      while (!stopping) {
        inFlight = runTick();
        await inFlight;
        if (stopping) return;
        await sleep(tickMs);
      }
    })();
  };

  const stop = async (): Promise<void> => {
    stopping = true;
    await inFlight;
  };

  return {
    name: `trading-${String(args.agent_id)}`,
    start,
    stop,
    runTick,
    lastTickAtMs: () => lastTickAt,
    tickIntervalMs: tickMs,
  };
}

export type { LoopClock };
export { ZERO_HEX };
