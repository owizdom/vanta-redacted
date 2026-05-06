/**
 * Multi-VANTA end-to-end smoke (Phase F).
 *
 *   pnpm --filter @vanta/runtime smoke:multi-vanta
 *
 * Exercises the full v3 fleet pattern in-memory:
 *
 *   - Two trading loops, one per agent. Different paper-belief
 *     biases so the agents disagree on the same market.
 *   - Shared event sink. Asserts every emitted event carries the
 *     correct `agent_id`.
 *   - Each agent reads from its own portfolio + executes against its
 *     own (synthetic) executor.
 *   - Asserts agent-A's events do not bleed into agent-B's filter
 *     (and vice versa).
 *   - Builds a fixture registry + pool readers from the same agent
 *     IDs and runs the agents-route smoke against the same fastify
 *     instance, confirming per-agent state matches the loop output.
 *
 * No chain, no LLM, no Polymarket. Run before any real-deploy work.
 */

import { createHash } from "node:crypto";

import Fastify from "fastify";
import { asSha256Hex, type Sha256Hex } from "@vanta/tee";

import { registerAgentsRoutes } from "../http/routes/agents.js";
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
  createFixturePoolReader,
  type PoolReader,
} from "../services/pool-reader.js";
import {
  createFixtureRegistryReader,
  type FixtureAgent,
} from "../services/agent-registry-reader.js";

import {
  createTradingLoop,
  type ExecuteDecisionFn,
  type WatchedMarket,
} from "./trading.js";
import type { EventSink, LoopClock, LoopContext } from "./types.js";

interface CapturedEvent {
  readonly type: string;
  readonly body: Record<string, unknown>;
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
      events.push({ type, body: body as Record<string, unknown>, parentIds, id });
      return id;
    },
  };
  return { sink, events };
}

const NOW_MS = Date.UTC(2026, 4, 5);

function makeCtx(sink: EventSink): LoopContext {
  const stubClient = {} as unknown as LoopContext["base"];
  const clock: LoopClock = { nowMs: () => NOW_MS };
  return {
    base: stubClient,
    amoy: stubClient,
    events: sink,
    clock,
    genesisId: asSha256Hex("0".repeat(64)),
  };
}

const MARKET_FOMC: Sha256Hex = asSha256Hex("a".repeat(64));
const MARKET_GPT6: Sha256Hex = asSha256Hex("b".repeat(64));

const SHARED_WATCHED: readonly WatchedMarket[] = [
  {
    market_id: MARKET_FOMC,
    market_question: "Will the Fed cut rates by Q3 2026?",
    time_to_resolution_seconds: 60 * 86_400,
    recent_trade_count: 142,
  },
  {
    market_id: MARKET_GPT6,
    market_question: "Will OpenAI announce GPT-6 by end of 2026?",
    time_to_resolution_seconds: 240 * 86_400,
    recent_trade_count: 88,
  },
];

const MARKET_MIDS = new Map<Sha256Hex, number>([
  [MARKET_FOMC, 0.18],
  [MARKET_GPT6, 0.50],
]);

function fetchSnapshot(m: WatchedMarket): Promise<MarketSnapshot> {
  const mid = MARKET_MIDS.get(m.market_id);
  if (mid === undefined) throw new Error(`no fixture mid for ${m.market_id}`);
  return Promise.resolve({
    market_id: m.market_id,
    mid,
    depth_5pct_usdc6: 50_000_000_000n,
  });
}

/** Bullish bias: belief sits 12pp above mid for low-priced, below for high. */
function bullishBias(req: BeliefRequest): number {
  return req.current_mid < 0.5 ? +0.12 : -0.12;
}

/** Bearish bias: belief sits 12pp below mid for low-priced, above for high. */
function bearishBias(req: BeliefRequest): number {
  return req.current_mid < 0.5 ? -0.12 : +0.12;
}

interface AgentRig {
  readonly agentId: number;
  readonly portfolio: Portfolio;
  readonly executed: Decision[];
}

async function smokeMultiVanta(): Promise<void> {
  console.log("--- multi-VANTA fleet smoke ---");
  const { sink, events } = makeInMemorySink();
  const ctx = makeCtx(sink);

  // Two agents, two theses. Each owns its own portfolio + executor
  // ledger so we can verify per-agent isolation.
  const rigA: AgentRig = {
    agentId: 0,
    portfolio: {
      free_usdc6: 5_000_000_000n,
      open_notional_usdc6: 0n,
      max_aum_usdc6: 10_000_000_000n,
      positions: [] as readonly OpenPosition[],
    },
    executed: [],
  };
  const rigB: AgentRig = {
    agentId: 1,
    portfolio: {
      free_usdc6: 8_000_000_000n,
      open_notional_usdc6: 0n,
      max_aum_usdc6: 10_000_000_000n,
      positions: [] as readonly OpenPosition[],
    },
    executed: [],
  };

  const beliefA = createPaperBeliefEngine({
    agent_id: rigA.agentId,
    thesisBias: bullishBias,
  });
  const beliefB = createPaperBeliefEngine({
    agent_id: rigB.agentId,
    thesisBias: bearishBias,
  });

  function makeExecutor(rig: AgentRig): ExecuteDecisionFn {
    return async (decision, beliefEventId, decisionEventId) => {
      rig.executed.push(decision);
      if (decision.action !== "enter") return;
      await sink.emit({
        type: "trade.executed",
        body: {
          agent_id: rig.agentId,
          position_id: asSha256Hex(
            createHash("sha256")
              .update(`pos:${String(rig.agentId)}:${decision.market_id}`)
              .digest("hex"),
          ),
          market_id: decision.market_id,
          side: decision.side,
          size_usdc6: decision.size_usdc6.toString(),
          entry_price_bps: Math.max(1, Math.min(9_999, Math.floor(decision.mid_centibps / 100))),
          tx_hash: asSha256Hex("e".repeat(64)),
          block_number: 1,
          block_hash: asSha256Hex("f".repeat(64)),
          attestation_hash: asSha256Hex("d".repeat(64)),
        },
        parentIds: [ctx.genesisId, beliefEventId, decisionEventId],
      });
    };
  }

  const loopA = createTradingLoop({
    ctx,
    agent_id: rigA.agentId,
    listWatched: () => Promise.resolve(SHARED_WATCHED),
    fetchSnapshot,
    readPortfolio: () => Promise.resolve(rigA.portfolio),
    belief: beliefA,
    execute: makeExecutor(rigA),
    policy: DEFAULT_DECIDE_POLICY,
  });
  const loopB = createTradingLoop({
    ctx,
    agent_id: rigB.agentId,
    listWatched: () => Promise.resolve(SHARED_WATCHED),
    fetchSnapshot,
    readPortfolio: () => Promise.resolve(rigB.portfolio),
    belief: beliefB,
    execute: makeExecutor(rigB),
    policy: DEFAULT_DECIDE_POLICY,
  });

  await Promise.all([loopA.runTick(), loopB.runTick()]);

  console.log(`emitted ${String(events.length)} events total`);
  const byAgent = new Map<number, CapturedEvent[]>();
  for (const e of events) {
    const aid = (e.body["agent_id"] as number | undefined) ?? -1;
    let bucket = byAgent.get(aid);
    if (bucket === undefined) {
      bucket = [];
      byAgent.set(aid, bucket);
    }
    bucket.push(e);
  }
  for (const [aid, bucket] of byAgent) {
    console.log(`  agent ${String(aid)}: ${String(bucket.length)} events`);
  }

  // ----- assertions -----
  const aEvents = byAgent.get(0) ?? [];
  const bEvents = byAgent.get(1) ?? [];
  // (reasoning.trace events have no agent_id field; they're keyed by parent
  //  lineage. They land in the -1 bucket for this smoke.)
  const traceEvents = byAgent.get(-1) ?? [];

  if (aEvents.length === 0) throw new Error("agent 0 produced zero events");
  if (bEvents.length === 0) throw new Error("agent 1 produced zero events");

  for (const e of aEvents) {
    if (e.body["agent_id"] !== 0) {
      throw new Error(`agent-0 event mis-tagged: ${JSON.stringify(e.body["agent_id"])}`);
    }
  }
  for (const e of bEvents) {
    if (e.body["agent_id"] !== 1) {
      throw new Error(`agent-1 event mis-tagged: ${JSON.stringify(e.body["agent_id"])}`);
    }
  }

  // Each agent saw both markets.
  const aMarketsSeen = new Set(
    aEvents
      .filter((e) => e.type === "belief.updated")
      .map((e) => e.body["market_id"] as string),
  );
  const bMarketsSeen = new Set(
    bEvents
      .filter((e) => e.type === "belief.updated")
      .map((e) => e.body["market_id"] as string),
  );
  if (aMarketsSeen.size !== SHARED_WATCHED.length) {
    throw new Error(`agent 0 missed markets: saw ${String(aMarketsSeen.size)} / ${String(SHARED_WATCHED.length)}`);
  }
  if (bMarketsSeen.size !== SHARED_WATCHED.length) {
    throw new Error(`agent 1 missed markets: saw ${String(bMarketsSeen.size)} / ${String(SHARED_WATCHED.length)}`);
  }

  // Each agent emits one reasoning.trace per market, regardless of HOLD.
  if (traceEvents.length !== SHARED_WATCHED.length * 2) {
    throw new Error(
      `expected ${String(SHARED_WATCHED.length * 2)} reasoning.trace events, got ${String(traceEvents.length)}`,
    );
  }

  // Disagreement check: bullish + bearish theses should produce
  // different signed gaps for at least one shared market.
  for (const market of SHARED_WATCHED) {
    const aBelief = aEvents.find(
      (e) => e.type === "belief.updated" && e.body["market_id"] === market.market_id,
    );
    const bBelief = bEvents.find(
      (e) => e.type === "belief.updated" && e.body["market_id"] === market.market_id,
    );
    if (!aBelief || !bBelief) {
      throw new Error(`missing belief for ${market.market_id}`);
    }
    const aGap = aBelief.body["gap_bps"] as number;
    const bGap = bBelief.body["gap_bps"] as number;
    if (Math.sign(aGap) === Math.sign(bGap) && aGap !== 0) {
      throw new Error(
        `expected disagreement on ${market.market_id}: aGap=${String(aGap)} bGap=${String(bGap)}`,
      );
    }
  }
  console.log("agents disagree on every market — bullish vs bearish theses confirmed");

  // ----- registry + pool routes side check -----
  const fixtureAgents: readonly FixtureAgent[] = [
    {
      agent_id: 0,
      name: "vanta-bull",
      thesis: "bullish bias",
      color_rgb: 0x9b6bff,
      pool: "0x0000000000000000000000000000000000000a01",
      position_book: "0x0000000000000000000000000000000000000a02",
      op_cap: "0x0000000000000000000000000000000000000a03",
      operator: "0x0000000000000000000000000000000000000a04",
      registered_at_unix: NOW_MS / 1000,
      paused: false,
      image_digest: "0x" + "0".repeat(64) as `0x${string}`,
      attestation_hash: "0x" + "0".repeat(64) as `0x${string}`,
      island_offset: { x: 0, z: 0 },
    },
    {
      agent_id: 1,
      name: "vanta-bear",
      thesis: "bearish bias",
      color_rgb: 0x4287f5,
      pool: "0x0000000000000000000000000000000000000b01",
      position_book: "0x0000000000000000000000000000000000000b02",
      op_cap: "0x0000000000000000000000000000000000000b03",
      operator: "0x0000000000000000000000000000000000000b04",
      registered_at_unix: NOW_MS / 1000,
      paused: false,
      image_digest: "0x" + "0".repeat(64) as `0x${string}`,
      attestation_hash: "0x" + "0".repeat(64) as `0x${string}`,
      island_offset: { x: 0, z: -200 },
    },
  ];
  const registry = createFixtureRegistryReader(fixtureAgents);
  const poolReaders = new Map<number, PoolReader>([
    [
      0,
      createFixturePoolReader({
        agent_id: 0,
        pool: fixtureAgents[0]!.pool,
        position_book: fixtureAgents[0]!.position_book,
        nav_usdc6: rigA.portfolio.free_usdc6,
        total_supply: 1_000_000_000n,
        max_aum_usdc6: rigA.portfolio.max_aum_usdc6,
        open_notional_usdc6: 0n,
        lifetime_cost_basis_usdc6: 0n,
        lifetime_proceeds_usdc6: 0n,
      }),
    ],
    [
      1,
      createFixturePoolReader({
        agent_id: 1,
        pool: fixtureAgents[1]!.pool,
        position_book: fixtureAgents[1]!.position_book,
        nav_usdc6: rigB.portfolio.free_usdc6,
        total_supply: 1_500_000_000n,
        max_aum_usdc6: rigB.portfolio.max_aum_usdc6,
        open_notional_usdc6: 0n,
        lifetime_cost_basis_usdc6: 0n,
        lifetime_proceeds_usdc6: 0n,
      }),
    ],
  ]);

  const app = Fastify({ logger: false });
  await registerAgentsRoutes(app, { registry, poolReaders });

  const listResp = await app.inject({ method: "GET", url: "/api/agents" });
  const list = JSON.parse(listResp.body) as { agents: { agent_id: number; name: string }[] };
  if (list.agents.length !== 2) throw new Error(`/api/agents expected 2, got ${String(list.agents.length)}`);

  const pool0 = JSON.parse(
    (await app.inject({ method: "GET", url: "/api/pool/0/state" })).body,
  ) as { nav_usdc6: string };
  const pool1 = JSON.parse(
    (await app.inject({ method: "GET", url: "/api/pool/1/state" })).body,
  ) as { nav_usdc6: string };

  if (pool0.nav_usdc6 !== rigA.portfolio.free_usdc6.toString()) {
    throw new Error(`pool 0 nav mismatch: ${pool0.nav_usdc6} vs ${rigA.portfolio.free_usdc6.toString()}`);
  }
  if (pool1.nav_usdc6 !== rigB.portfolio.free_usdc6.toString()) {
    throw new Error(`pool 1 nav mismatch: ${pool1.nav_usdc6} vs ${rigB.portfolio.free_usdc6.toString()}`);
  }
  console.log(`/api/pool/0/state nav=${pool0.nav_usdc6}; /api/pool/1/state nav=${pool1.nav_usdc6}`);

  await app.close();
}

async function main(): Promise<void> {
  await smokeMultiVanta();
  console.log("\nOK");
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
