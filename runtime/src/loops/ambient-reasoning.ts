/**
 * Ambient reasoning loop — keeps the chat panel alive with live
 * underwriting analysis on real Polymarket markets, all signed
 * inside the TEE.
 *
 * Per tick:
 *   1. Pick the next agent in rotation (opus → gpt → gemini).
 *   2. Pick a random market from the cache that has a usable mid.
 *   3. Build an underwriting prompt with the agent's persona and
 *      the live numbers (mid, volume, liquidity, time-to-resolution).
 *   4. Call inference.call(...). The InferenceClient automatically
 *      builds and signs an op.inference event into the log; SSE
 *      broadcasts it to every connected UI as the agent's
 *      "model call" entry.
 *
 * The earlier external `scripts/heartbeat.sh` did this from the
 * developer's laptop. This loop runs in-TEE so the agents reason
 * autonomously even when no operator is connected — the trust story
 * the private preview programme expects.
 */

import type {
  InferenceClient,
  InferenceProvider,
} from "../services/inference.js";
import type {
  MarketsCache,
  MarketSnapshot,
} from "../services/markets-cache.js";
import type { LoopClock, ReasoningLoop } from "./types.js";

interface AgentPersona {
  readonly name: "opus" | "gpt" | "gemini";
  readonly provider: InferenceProvider;
  readonly system: string;
}

const AGENTS: readonly AgentPersona[] = [
  {
    name: "opus",
    provider: "anthropic",
    system:
      "You are vanta-opus, an autonomous prediction-market underwriter focused on macro, rates, and geopolitics. Reply in 2-3 plain-English sentences citing current mid, depth, and time-to-resolution. End with a concrete underwriting view (lend / haircut / pass) and a haircut figure when you would lend. No fluff, no greetings.",
  },
  {
    name: "gpt",
    provider: "openai",
    system:
      "You are vanta-gpt, an autonomous prediction-market underwriter focused on sports and cultural markets. Reply in 2-3 plain-English sentences citing current mid, book depth, and event timing. End with a concrete underwriting view (lend / haircut / pass), giving a haircut figure when you would lend. No fluff.",
  },
  {
    name: "gemini",
    provider: "google",
    system:
      "You are vanta-gemini, an autonomous prediction-market underwriter focused on US political markets. Reply in 2-3 plain-English sentences citing current mid, base rates, and resolution clarity. Close with a concrete underwriting view (lend / haircut / pass) and a haircut figure when you would lend. No fluff.",
  },
];

function buildPrompt(market: MarketSnapshot): string {
  const q = market.question ?? "untitled market";
  const parts: string[] = [`Polymarket market: "${q}".`];
  const yesMid = market.mid.yes !== null ? Number(market.mid.yes) : null;
  const noMid = market.mid.no !== null ? Number(market.mid.no) : null;
  const midParts: string[] = [];
  if (yesMid !== null && Number.isFinite(yesMid)) {
    midParts.push(`YES at $${yesMid.toFixed(3)}`);
  }
  if (noMid !== null && Number.isFinite(noMid)) {
    midParts.push(`NO at $${noMid.toFixed(3)}`);
  }
  if (midParts.length > 0) parts.push(`Live: ${midParts.join(", ")}.`);
  if (market.volumeUsd !== null) {
    parts.push(`Total volume $${(market.volumeUsd / 1_000_000).toFixed(1)}M.`);
  }
  if (market.volume24hUsd !== null) {
    parts.push(
      `24h volume $${Math.round(market.volume24hUsd).toLocaleString("en-US")}.`,
    );
  }
  if (market.liquidityUsd !== null) {
    parts.push(
      `Book liquidity $${Math.round(market.liquidityUsd).toLocaleString("en-US")}.`,
    );
  }
  if (market.endDateIso !== null) {
    const d = Date.parse(market.endDateIso);
    if (Number.isFinite(d)) {
      const days = Math.max(0, Math.floor((d - Date.now()) / 86_400_000));
      parts.push(`~${days} days to resolution.`);
    }
  }
  parts.push(
    "As an underwriter, would you lend USDC against a holder of the YES side, and at what haircut?",
  );
  return parts.join(" ");
}

function pickMarket(
  snapshots: readonly MarketSnapshot[],
): MarketSnapshot | null {
  const usable = snapshots.filter((m) => {
    if (m.closed) return false;
    const y = m.mid.yes !== null ? Number(m.mid.yes) : null;
    const n = m.mid.no !== null ? Number(m.mid.no) : null;
    const yOk = y !== null && Number.isFinite(y) && y > 0 && y < 1;
    const nOk = n !== null && Number.isFinite(n) && n > 0 && n < 1;
    return yOk || nOk;
  });
  if (usable.length === 0) return null;
  return usable[Math.floor(Math.random() * usable.length)] ?? null;
}

export interface CreateAmbientReasoningLoopOpts {
  readonly inference: InferenceClient;
  readonly marketsCache: MarketsCache;
  readonly clock: LoopClock;
  readonly tickSeconds: number;
  /**
   * Max output tokens per call. Reasoning-mode providers (GPT-5,
   * Gemini 2.5 Pro) consume the bulk of their budget on hidden
   * chain-of-thought; 4096 leaves enough headroom to emit visible
   * 2-3 sentence reasoning past the CoT. Anthropic uses much less.
   */
  readonly maxTokens?: number;
  readonly log?: {
    info: (msg: object) => void;
    error: (msg: object) => void;
  };
}

export function createAmbientReasoningLoop(
  opts: CreateAmbientReasoningLoopOpts,
): ReasoningLoop {
  let cycle = 0;
  let lastTickMs: number | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let inFlight = false;
  const maxTokens = opts.maxTokens ?? 4096;

  const tick = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const agent = AGENTS[cycle % AGENTS.length]!;
      const market = pickMarket(opts.marketsCache.snapshotAll());
      if (market === null) {
        opts.log?.info({
          msg: "ambient_reasoning_skip_no_markets",
          agent: agent.name,
        });
        return;
      }
      const prompt = buildPrompt(market);
      const r = await opts.inference.call({
        role: "researcher",
        system: agent.system,
        messages: [{ role: "user", content: prompt }],
        maxTokens,
        temperature: 0,
        providerHint: agent.provider,
      });
      lastTickMs = opts.clock.nowMs();
      opts.log?.info({
        msg: "ambient_reasoning_tick",
        agent: agent.name,
        provider: agent.provider,
        model: r.model,
        completion_tokens: r.completionTokens,
        text_excerpt: r.text.slice(0, 96),
        market: market.ownerLabel ?? market.conditionId.slice(0, 12),
      });
    } catch (err) {
      opts.log?.error({
        msg: "ambient_reasoning_tick_failed",
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      cycle++;
      inFlight = false;
    }
  };

  return {
    name: "ambient-reasoning",
    start() {
      if (timer !== null) return;
      void tick();
      timer = setInterval(() => void tick(), opts.tickSeconds * 1000);
    },
    async stop() {
      stopped = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    async runTick() {
      await tick();
    },
    lastTickAtMs() {
      return lastTickMs;
    },
    tickIntervalMs: opts.tickSeconds * 1000,
  };
}
