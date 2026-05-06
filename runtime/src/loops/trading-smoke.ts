/**
 * Smoke test for the v3 trading loop (paper-trading mode).
 *
 *   pnpm --filter @vanta/runtime smoke:trading
 *
 * Three watched markets, a deterministic paper belief engine, an
 * in-memory portfolio + executor, one tick. Asserts:
 *
 *   - every market emits a `belief.updated` event
 *   - markets that satisfy entry-policy emit a paired
 *     `reasoning.trace` + `trade.decision`
 *   - executor is called exactly once per non-hold decision and
 *     emits `trade.executed`
 *   - markets that fail the policy emit a `reasoning.trace` (HOLD
 *     trace) and no `trade.decision`
 *
 * No LLM, no chain, no Polymarket. Pure event flow + decide-policy.
 */

import { createHash } from "node:crypto";

import { asSha256Hex, type Sha256Hex } from "@vanta/tee";

import {
  createPaperBeliefEngine,
  type BeliefRequest,
} from "../services/belief-engine.js";
import {
  DEFAULT_DECIDE_POLICY,
  type Decision,
  type MarketSnapshot,
  type OpenPosition,
  type Portfolio,
} from "../services/decide-policy.js";

import {
  createTradingLoop,
  type WatchedMarket,
  type ExecuteDecisionFn,
} from "./trading.js";
import type { EventSink, LoopClock, LoopContext } from "./types.js";

interface CapturedEvent {
  readonly type: string;
  readonly body: object;
  readonly parentIds: readonly Sha256Hex[];
  readonly id: Sha256Hex;
}

function makeInMemorySink(): {
  readonly sink: EventSink;
  readonly events: CapturedEvent[];
} {
  const events: CapturedEvent[] = [];
  let counter = 0;
  const sink: EventSink = {
    async emit({ type, body, parentIds }) {
      counter += 1;
      const seed = `${String(counter)}|${type}|${JSON.stringify(body)}|${parentIds.join(",")}`;
      const id = asSha256Hex(createHash("sha256").update(seed).digest("hex"));
      events.push({ type, body, parentIds, id });
      return id;
    },
  };
  return { sink, events };
}

function makeFakeClock(seedMs: number): LoopClock {
  return { nowMs: () => seedMs };
}

const NOW_MS = Date.UTC(2026, 4, 5);
const GENESIS_ID = asSha256Hex("0".repeat(64));
const AGENT_ID = 0;

function makeCtx(sink: EventSink): LoopContext {
  const stubClient = {} as unknown as LoopContext["base"];
  return {
    base: stubClient,
    amoy: stubClient,
    events: sink,
    clock: makeFakeClock(NOW_MS),
    genesisId: GENESIS_ID,
  };
}

interface ScriptedMarket {
  readonly market: WatchedMarket;
  readonly mid: number;
  readonly depth_5pct_usdc6: bigint;
}

const MK_HEDGES: Sha256Hex = asSha256Hex("a".repeat(64));
const MK_NEUTRAL: Sha256Hex = asSha256Hex("b".repeat(64));
const MK_DEEP: Sha256Hex = asSha256Hex("c".repeat(64));

const SCRIPT: readonly ScriptedMarket[] = [
  // Wide gap, deep book → ENTER expected
  {
    market: {
      market_id: MK_HEDGES,
      market_question: "Will the Fed cut rates by Q3 2026?",
      time_to_resolution_seconds: 60 * 86_400,
      recent_trade_count: 142,
    },
    mid: 0.18,
    depth_5pct_usdc6: 50_000_000_000n, // $50k
  },
  // Tiny gap → HOLD
  {
    market: {
      market_id: MK_NEUTRAL,
      market_question: "Will OpenAI announce GPT-6 by end of 2026?",
      time_to_resolution_seconds: 240 * 86_400,
      recent_trade_count: 88,
    },
    mid: 0.50,
    depth_5pct_usdc6: 25_000_000_000n,
  },
  // Wide gap, shallow book → HOLD on depth gate
  {
    market: {
      market_id: MK_DEEP,
      market_question: "Will SpaceX hit 200 launches in 2026?",
      time_to_resolution_seconds: 200 * 86_400,
      recent_trade_count: 31,
    },
    mid: 0.88,
    depth_5pct_usdc6: 100_000_000n, // $100, way below 1.2× any sensible size
  },
];

/** Bullish thesis: belief sits 12pp above mid for low-priced markets,
 *  and 12pp below for high-priced markets. Wide-gap entries on both
 *  sides. */
function bullishBias(req: BeliefRequest): number {
  return req.current_mid < 0.5 ? +0.12 : -0.12;
}

async function smokeTrading(): Promise<void> {
  console.log("--- trading loop (paper mode) ---");
  const { sink, events } = makeInMemorySink();
  const ctx = makeCtx(sink);

  const portfolio: Portfolio = {
    free_usdc6: 5_000_000_000n, // $5k free
    open_notional_usdc6: 0n,
    max_aum_usdc6: 10_000_000_000n, // $10k cap
    positions: [] as readonly OpenPosition[],
  };

  const belief = createPaperBeliefEngine({
    agent_id: AGENT_ID,
    thesisBias: bullishBias,
  });

  const executed: Decision[] = [];
  const execute: ExecuteDecisionFn = async (decision, beliefEventId, decisionEventId) => {
    executed.push(decision);
    if (decision.action === "enter") {
      await sink.emit({
        type: "trade.executed",
        body: {
          agent_id: AGENT_ID,
          position_id: asSha256Hex(
            createHash("sha256")
              .update(`pos:${decision.market_id}`)
              .digest("hex"),
          ),
          market_id: decision.market_id,
          side: decision.side,
          size_usdc6: decision.size_usdc6.toString(),
          entry_price_bps: Math.max(1, Math.min(9_999, decision.mid_centibps / 100)),
          tx_hash: asSha256Hex("e".repeat(64)),
          block_number: 1,
          block_hash: asSha256Hex("f".repeat(64)),
          attestation_hash: asSha256Hex("d".repeat(64)),
        },
        parentIds: [GENESIS_ID, beliefEventId, decisionEventId],
      });
    }
  };

  const loop = createTradingLoop({
    ctx,
    agent_id: AGENT_ID,
    listWatched: () => Promise.resolve(SCRIPT.map((s) => s.market)),
    fetchSnapshot: async (m): Promise<MarketSnapshot> => {
      const found = SCRIPT.find((s) => s.market.market_id === m.market_id);
      if (!found) throw new Error(`no scripted snapshot for ${m.market_id}`);
      return Promise.resolve({
        market_id: m.market_id,
        mid: found.mid,
        depth_5pct_usdc6: found.depth_5pct_usdc6,
      });
    },
    readPortfolio: () => Promise.resolve(portfolio),
    belief,
    execute,
    policy: DEFAULT_DECIDE_POLICY,
  });

  await loop.runTick();

  console.log(`emitted ${String(events.length)} events:`);
  for (const e of events) {
    const tail =
      e.type === "trade.decision"
        ? ` action=${(e.body as { action: string }).action} side=${(e.body as { side: string }).side} size=${(e.body as { size_usdc6: string }).size_usdc6}`
        : e.type === "belief.updated"
          ? ` belief_centibps=${String((e.body as { belief_centibps: number }).belief_centibps)} mid_centibps=${String((e.body as { mid_centibps: number }).mid_centibps)}`
          : "";
    console.log(`  ${e.type}${tail} (parents=${String(e.parentIds.length)})`);
  }

  // ----- assertions -----
  const beliefs = events.filter((e) => e.type === "belief.updated");
  if (beliefs.length !== SCRIPT.length) {
    throw new Error(
      `expected ${String(SCRIPT.length)} belief.updated events, got ${String(beliefs.length)}`,
    );
  }

  const traces = events.filter((e) => e.type === "reasoning.trace");
  if (traces.length !== SCRIPT.length) {
    throw new Error(
      `expected ${String(SCRIPT.length)} reasoning.trace events (one per market), got ${String(traces.length)}`,
    );
  }

  const decisions = events.filter((e) => e.type === "trade.decision");
  if (decisions.length !== 1) {
    throw new Error(
      `expected exactly 1 trade.decision (only MK_HEDGES passes all gates), got ${String(decisions.length)}`,
    );
  }
  const decisionMarket = (decisions[0]?.body as { market_id: string }).market_id;
  if (decisionMarket !== MK_HEDGES) {
    throw new Error(
      `expected the decision on MK_HEDGES, got ${decisionMarket}`,
    );
  }

  const executedEvents = events.filter((e) => e.type === "trade.executed");
  if (executedEvents.length !== 1) {
    throw new Error(
      `expected 1 trade.executed (executor stub fires on ENTER), got ${String(executedEvents.length)}`,
    );
  }

  if (executed.length !== 1 || executed[0]?.action !== "enter") {
    throw new Error(
      `expected exactly 1 ENTER decision passed to executor, got ${String(executed.length)} (${executed[0]?.action ?? "none"})`,
    );
  }
}

async function main(): Promise<void> {
  await smokeTrading();
  console.log("\nOK");
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
