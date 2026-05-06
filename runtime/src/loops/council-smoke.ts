/**
 * Smoke test for the NPC council.
 *
 *   pnpm --filter @vanta/runtime smoke:council
 *
 * Runs one trading loop tick with a stub `runInference` that returns
 * pre-baked NPC thoughts and a synthesis result. Asserts:
 *
 *   - 2 npc.thought events emitted with the right persona ids
 *   - 1 council.synthesised event emitted that references those
 *     two thoughts via parent_ids and via npc_thought_event_ids
 *   - the synthesised belief is what the trading loop uses (visible
 *     because the bullish thesis on its own would HOLD on this market,
 *     but the synthesised belief crosses the entry threshold)
 *   - re-running the tick within the cooldown does NOT trigger a
 *     second council pass
 *
 * No real LLM, no chain.
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
  createNpcCouncil,
  type CouncilInferenceFn,
} from "../services/npc-council.js";

import {
  createTradingLoop,
  type WatchedMarket,
  type ExecuteDecisionFn,
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
      events.push({
        type,
        body: body as Record<string, unknown>,
        parentIds,
        id,
      });
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

const MK_RATES: Sha256Hex = asSha256Hex("a".repeat(64));

const SCRIPT_MARKET: WatchedMarket = {
  market_id: MK_RATES,
  market_question: "Will the Fed cut rates in June 2026?",
  time_to_resolution_seconds: 30 * 86_400,
  recent_trade_count: 200,
};

/**
 * Stub inference that produces canned NPC thoughts and a synthesis
 * result. Each call produces a unique response_text_hash so the
 * op.inference events have distinct ids.
 */
function makeStubInference(): {
  readonly fn: CouncilInferenceFn;
  thoughtCalls: number;
  synthCalls: number;
} {
  let thoughtCalls = 0;
  let synthCalls = 0;

  const fn: CouncilInferenceFn = async (args) => {
    let text: string;
    if (args.intent === "thought") {
      thoughtCalls += 1;
      // Two scripted opinions; both lean bullish (belief > mid).
      text =
        thoughtCalls === 1
          ? `{"thought": "Markets always rally before a cut, mark my words.", "belief": 0.42, "confidence": 0.7}`
          : `{"thought": "Wholesale credit is loosening — I see it at the docks.", "belief": 0.40, "confidence": 0.65}`;
    } else {
      synthCalls += 1;
      // Synthesis pushes belief well above the bullish prior so the
      // trading loop's decide() flips from HOLD → ENTER. We pick
      // 0.42 which gives a 24bps gap from mid 0.18 — comfortably
      // past the default 8bps gap threshold.
      text = `{"belief": 0.42, "confidence": 0.78, "rationale": "Tomás and Helga both point bullish, both credible on rate cycles. Lifting belief from 0.30 → 0.42."}`;
    }
    const tag = `${args.intent}:${String(args.intent === "thought" ? thoughtCalls : synthCalls)}`;
    const reqHash = asSha256Hex(
      createHash("sha256").update(`req:${tag}`).digest("hex"),
    );
    const resHash = asSha256Hex(
      createHash("sha256").update(`res:${tag}`).digest("hex"),
    );
    return {
      text,
      model: args.intent === "thought" ? "claude-haiku-4-5-20251001" : "claude-opus-4-7",
      provider: "anthropic" as const,
      request_canonical_hash: reqHash,
      response_text_hash: resHash,
      prompt_tokens: 200,
      completion_tokens: 60,
      latency_ms: 220,
      started_at_unix_ms: NOW_MS,
    };
  };

  return {
    fn,
    get thoughtCalls() {
      return thoughtCalls;
    },
    get synthCalls() {
      return synthCalls;
    },
  };
}

async function smokeCouncil(): Promise<void> {
  console.log("--- npc council (paper trading + stub LLM) ---");
  const { sink, events } = makeInMemorySink();
  const ctx = makeCtx(sink);

  const portfolio: Portfolio = {
    free_usdc6: 5_000_000_000n,
    open_notional_usdc6: 0n,
    max_aum_usdc6: 10_000_000_000n,
    positions: [] as readonly OpenPosition[],
  };

  // Bullish thesis nudges belief +12pp on a 0.18 mid → 0.30. With
  // default policy 8bps gap threshold this would normally PASS as an
  // ENTER on its own. We use a smaller bias here so the synthesis
  // is what actually crosses the line.
  const belief = createPaperBeliefEngine({
    agent_id: AGENT_ID,
    thesisBias: (req: BeliefRequest) => (req.current_mid < 0.5 ? +0.06 : -0.06),
  });

  const stub = makeStubInference();
  const stubFn: CouncilInferenceFn = stub.fn;

  // Council with a generous cooldown so the second tick is throttled.
  const council = createNpcCouncil({
    agent_id: AGENT_ID,
    events: sink,
    genesis_id: GENESIS_ID,
    runInference: stubFn,
    cooldownMs: 90_000,
    sampleSize: 2,
    nowMs: ctx.clock.nowMs,
  });

  const execute: ExecuteDecisionFn = async () => {
    /* no-op for this smoke */
  };

  const loop = createTradingLoop({
    ctx,
    agent_id: AGENT_ID,
    listWatched: () => Promise.resolve([SCRIPT_MARKET]),
    fetchSnapshot: async (): Promise<MarketSnapshot> =>
      Promise.resolve({
        market_id: MK_RATES,
        mid: 0.18,
        depth_5pct_usdc6: 50_000_000_000n,
      }),
    readPortfolio: () => Promise.resolve(portfolio),
    belief,
    execute,
    policy: DEFAULT_DECIDE_POLICY,
    council,
  });

  await loop.runTick();

  console.log(`emitted ${String(events.length)} events on tick 1:`);
  for (const e of events) {
    console.log(`  ${e.type} (parents=${String(e.parentIds.length)})`);
  }

  // ----- assertions -----
  const thoughts = events.filter((e) => e.type === "npc.thought");
  if (thoughts.length !== 2) {
    throw new Error(
      `expected 2 npc.thought events, got ${String(thoughts.length)}`,
    );
  }
  const thoughtIds = new Set(thoughts.map((t) => t.id));
  for (const t of thoughts) {
    const npcId = t.body["npc_id"] as string;
    if (!npcId.startsWith("vanta-opus.")) {
      throw new Error(`thought from wrong kingdom: ${npcId}`);
    }
  }

  const synths = events.filter((e) => e.type === "council.synthesised");
  if (synths.length !== 1) {
    throw new Error(
      `expected 1 council.synthesised, got ${String(synths.length)}`,
    );
  }
  const synth = synths[0]!;
  const refs = (synth.body["npc_thought_event_ids"] ?? []) as readonly string[];
  if (refs.length !== 2) {
    throw new Error(
      `synthesised event must reference 2 thoughts, got ${String(refs.length)}`,
    );
  }
  for (const r of refs) {
    if (!thoughtIds.has(r as Sha256Hex)) {
      throw new Error(`synthesised event references unknown thought id ${r}`);
    }
  }
  const synthParents = synth.parentIds;
  for (const r of refs) {
    if (!synthParents.includes(r as Sha256Hex)) {
      throw new Error(
        `synthesised event must list each thought id in parent_ids; missing ${r}`,
      );
    }
  }

  // The trading loop should now use the synthesised belief in decide().
  // 0.42 belief vs 0.18 mid → 24pp gap >> 8bps default → ENTER.
  const decisions = events.filter((e) => e.type === "trade.decision");
  if (decisions.length !== 1) {
    throw new Error(
      `expected exactly 1 trade.decision (synthesised belief should clear policy), got ${String(decisions.length)}`,
    );
  }
  const action = decisions[0]?.body["action"];
  if (action !== "enter") {
    throw new Error(
      `expected ENTER on synthesised belief, got ${String(action)}`,
    );
  }

  // ----- second tick within cooldown -----
  const beforeSecondTick = events.length;
  await loop.runTick();
  const newCouncilEvents = events
    .slice(beforeSecondTick)
    .filter(
      (e) => e.type === "npc.thought" || e.type === "council.synthesised",
    );
  if (newCouncilEvents.length !== 0) {
    throw new Error(
      `cooldown failed: second tick within window emitted ${String(newCouncilEvents.length)} council events`,
    );
  }
  if (stub.thoughtCalls !== 2 || stub.synthCalls !== 1) {
    throw new Error(
      `cooldown failed: stub LLM called ${String(stub.thoughtCalls)} thoughts + ${String(stub.synthCalls)} syntheses (expected 2 + 1)`,
    );
  }

  console.log(
    `\nsecond tick within cooldown emitted 0 new council events ✓ (stub called ${String(stub.thoughtCalls)} thoughts + ${String(stub.synthCalls)} syntheses)`,
  );
}

// ===========================================================================
// Lender-mode council pass — fed through credit.ts instead of trading.ts
// ===========================================================================

import {
  createCreditLoop,
  type ActiveLoanView,
  type CreditObservation,
} from "./credit.js";

const LOAN_ID: Sha256Hex = asSha256Hex("d".repeat(64));
const ORIG_ID: Sha256Hex = asSha256Hex("e".repeat(64));
const COND_ID: Sha256Hex = asSha256Hex("f".repeat(64));

function makeStubLenderInference(): {
  readonly fn: CouncilInferenceFn;
  thoughtCalls: number;
  synthCalls: number;
} {
  let thoughtCalls = 0;
  let synthCalls = 0;
  const fn: CouncilInferenceFn = async (args) => {
    let text: string;
    if (args.intent === "thought") {
      thoughtCalls += 1;
      // Lending-mode NPCs answer about loan health: belief ∈ [0,1] is
      // probability the loan is safely repaid. Both stub voices say
      // "this loan looks dicey" (0.55, 0.50) which sits below the
      // LTV-driven prior of ~0.65.
      text =
        thoughtCalls === 1
          ? `{"thought": "Polymarket book has thinned since the dispute filing — I'd want a wider haircut.", "belief": 0.55, "confidence": 0.7}`
          : `{"thought": "Maturity is close; if the price doesn't recover this week we're forcing a sale.", "belief": 0.50, "confidence": 0.65}`;
    } else {
      synthCalls += 1;
      text = `{"belief": 0.52, "confidence": 0.74, "rationale": "Tomás flags book thinning, Helga flags maturity pressure. Both credible. Lowering loan-health from 0.65 → 0.52; recommend tightening watch."}`;
    }
    const tag = `lender-${args.intent}:${String(args.intent === "thought" ? thoughtCalls : synthCalls)}`;
    const reqHash = asSha256Hex(
      createHash("sha256").update(`req:${tag}`).digest("hex"),
    );
    const resHash = asSha256Hex(
      createHash("sha256").update(`res:${tag}`).digest("hex"),
    );
    return {
      text,
      model:
        args.intent === "thought"
          ? "claude-haiku-4-5-20251001"
          : "claude-opus-4-7",
      provider: "anthropic" as const,
      request_canonical_hash: reqHash,
      response_text_hash: resHash,
      prompt_tokens: 220,
      completion_tokens: 70,
      latency_ms: 240,
      started_at_unix_ms: NOW_MS,
    };
  };
  return {
    fn,
    get thoughtCalls() {
      return thoughtCalls;
    },
    get synthCalls() {
      return synthCalls;
    },
  };
}

async function smokeLenderCouncil(): Promise<void> {
  console.log("\n--- npc council (paper lending + stub LLM) ---");
  const { sink, events } = makeInMemorySink();
  const ctx = makeCtx(sink);

  const stub = makeStubLenderInference();
  const council = createNpcCouncil({
    agent_id: AGENT_ID,
    events: sink,
    genesis_id: GENESIS_ID,
    runInference: stub.fn,
    cooldownMs: 90_000,
    sampleSize: 2,
    nowMs: ctx.clock.nowMs,
    mode: "lending",
  });

  // Active loan view: $5k principal against 10k notional CTF tokens
  // on a market priced ~0.40. Drives an LTV around the watch band so
  // the council's pessimism is plausibly load-bearing.
  const loan: ActiveLoanView = {
    loan_id: LOAN_ID,
    principal_usdc: "5000000000", // $5,000 in 6-decimal USDC
    notional_tokens: "10000",
    maturity_ts_ms: NOW_MS + 7 * 86_400_000,
    condition_id: COND_ID,
    token_id: "1",
    origination_event_id: ORIG_ID,
    originated_haircut_bps: 3500,
  };

  const observation: CreditObservation = {
    best_bid: "0.40",
    twap_30min: "0.42",
    depth_5pct_usdc: "12000000000",
    dispute_30d_count: 0,
    time_to_resolution_seconds: 7 * 86_400,
  };

  const loop = createCreditLoop({
    ctx,
    listActiveLoans: () => Promise.resolve([loan]),
    observe: () => Promise.resolve(observation),
    council,
    agent_id: AGENT_ID,
  });

  await loop.runTick();

  console.log(`emitted ${String(events.length)} events on lender tick:`);
  for (const e of events) {
    console.log(`  ${e.type} (parents=${String(e.parentIds.length)})`);
  }

  // ----- assertions -----
  const thoughts = events.filter((e) => e.type === "npc.thought");
  if (thoughts.length !== 2) {
    throw new Error(
      `lender: expected 2 npc.thought events, got ${String(thoughts.length)}`,
    );
  }
  for (const t of thoughts) {
    const npcId = t.body["npc_id"] as string;
    if (!npcId.startsWith("vanta-opus.")) {
      throw new Error(
        `lender: thought emitted from wrong kingdom: ${npcId}`,
      );
    }
  }

  const synths = events.filter((e) => e.type === "council.synthesised");
  if (synths.length !== 1) {
    throw new Error(
      `lender: expected 1 council.synthesised, got ${String(synths.length)}`,
    );
  }
  const synth = synths[0]!;

  const traces = events.filter((e) => e.type === "reasoning.trace");
  if (traces.length !== 1) {
    throw new Error(
      `lender: expected 1 reasoning.trace, got ${String(traces.length)}`,
    );
  }
  const trace = traces[0]!;
  if (!trace.parentIds.includes(synth.id)) {
    throw new Error(
      `lender: trace.parent_ids must include council.synthesised id; got ${trace.parentIds.join(",")}`,
    );
  }
  const traceRationale = trace.body["decision_rationale"] as string;
  if (!traceRationale.includes("Council weighed in")) {
    throw new Error(
      `lender: trace rationale must mention 'Council weighed in'; got: ${traceRationale.slice(0, 100)}`,
    );
  }

  const ticks = events.filter((e) => e.type === "loop.credit_tick");
  if (ticks.length !== 1) {
    throw new Error(
      `lender: expected 1 loop.credit_tick, got ${String(ticks.length)}`,
    );
  }
  if (!ticks[0]!.parentIds.includes(synth.id)) {
    throw new Error(
      `lender: credit_tick.parent_ids must include council.synthesised id`,
    );
  }

  // Cooldown: second tick within window must NOT re-call the LLM.
  const beforeSecond = events.length;
  await loop.runTick();
  const newCouncilEvents = events
    .slice(beforeSecond)
    .filter(
      (e) => e.type === "npc.thought" || e.type === "council.synthesised",
    );
  if (newCouncilEvents.length !== 0) {
    throw new Error(
      `lender cooldown failed: second tick emitted ${String(newCouncilEvents.length)} new council events`,
    );
  }
  if (stub.thoughtCalls !== 2 || stub.synthCalls !== 1) {
    throw new Error(
      `lender cooldown failed: stub LLM called ${String(stub.thoughtCalls)}+${String(stub.synthCalls)} (expected 2+1)`,
    );
  }

  console.log(
    `\nlender mode: trace cites council ✓, tick parents include synth id ✓, cooldown holds ✓ (stub called ${String(stub.thoughtCalls)}+${String(stub.synthCalls)})`,
  );
}

async function main(): Promise<void> {
  await smokeCouncil();
  await smokeLenderCouncil();
  console.log("\nOK");
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
