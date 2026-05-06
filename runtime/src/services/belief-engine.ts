/**
 * Belief engine — turns market context + an agent's thesis into a
 * structured-output `(belief, confidence)` for one market.
 *
 * Two implementations live here:
 *
 *   - `createPaperBeliefEngine`: deterministic + offline. Belief is
 *     `mid + thesisBias` clamped into `[0, 1]`, with confidence drawn
 *     from a fixed-seed PRNG. Used in local-dev / paper-trading mode
 *     so the trading loop can be exercised without an LLM provider
 *     or API key, and the events it emits remain reproducible.
 *
 *   - `createInferenceBeliefEngine`: production. Calls the existing
 *     inference rotation (`@vanta/runtime/services/inference`) with a
 *     structured-output prompt that asks the model for `belief` and
 *     `confidence` in `[0, 1]`. Emits a paired `op.inference` event
 *     and pins its id on the returned belief so the audit trail is
 *     complete.
 *
 * Both implementations expose the same `BeliefEngine` interface so
 * the trading loop is engine-agnostic.
 */

import type { Sha256Hex } from "@vanta/tee";
import { asSha256Hex } from "@vanta/tee";

import type { EventSink } from "../loops/types.js";

import type { Belief } from "./decide-policy.js";

export interface BeliefRequest {
  readonly market_id: Sha256Hex;
  readonly market_question: string;
  readonly current_mid: number; // ∈ [0, 1]
  readonly time_to_resolution_seconds: number;
  readonly recent_trade_count: number;
}

export interface BeliefEngine {
  readonly compute: (req: BeliefRequest) => Promise<Belief>;
}

const ZERO_HEX: Sha256Hex =
  "0000000000000000000000000000000000000000000000000000000000000000" as Sha256Hex;

// -------------------- paper-trading deterministic engine -------------------

/**
 * Paper-trading engine config. The agent's thesis is encoded as a
 * deterministic bias function — given a `(market_id, mid)` it returns
 * a belief offset in `[-0.5, 0.5]`. Different VANTAs ship different
 * `thesisBias` functions so they disagree on the same market.
 *
 * `confidence` is drawn from a hash of `market_id` so it's stable
 * across ticks (the agent doesn't oscillate confidence within a
 * market) but varies across markets.
 */
export interface PaperBeliefEngineArgs {
  readonly agent_id: number;
  readonly thesisBias: (req: BeliefRequest) => number;
  readonly clamp_min?: number;
  readonly clamp_max?: number;
}

/**
 * fnv1a 32-bit on a string. Tiny deterministic hash for the
 * paper-trading confidence draw. Not cryptographic — just stable.
 */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; ++i) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

export function createPaperBeliefEngine(
  args: PaperBeliefEngineArgs,
): BeliefEngine {
  const clampMin = args.clamp_min ?? 0.02;
  const clampMax = args.clamp_max ?? 0.98;

  const compute = async (req: BeliefRequest): Promise<Belief> => {
    const bias = args.thesisBias(req);
    let belief = req.current_mid + bias;
    if (belief < clampMin) belief = clampMin;
    if (belief > clampMax) belief = clampMax;

    const seed = fnv1a(`${String(args.agent_id)}::${req.market_id}`);
    // confidence ∈ [0.55, 0.85] — paper-mode agents are decisive but
    // not absolute.
    const confidence = 0.55 + ((seed >>> 0) % 30) / 100;

    // No real LLM call in paper mode — point inference_event_id at
    // the all-zero hash so consumers know this came from the offline
    // engine rather than a signed inference event.
    return Promise.resolve({
      market_id: req.market_id,
      belief,
      confidence,
      inference_event_id: ZERO_HEX,
    });
  };

  return { compute };
}

// -------------------- inference-rotation engine ----------------------------

/**
 * Production engine config. The runtime supplies a `runInference`
 * callable that wraps its own provider rotation; we keep the engine
 * itself decoupled from the rotation policy.
 *
 * The engine emits an `op.inference` event with the request hash +
 * response excerpt and returns its id pinned on the belief.
 */
export interface InferenceBeliefEngineArgs {
  readonly agent_id: number;
  readonly thesis_prompt: string;
  readonly events: EventSink;
  readonly genesis_id: Sha256Hex;
  readonly runInference: (args: {
    readonly system: string;
    readonly user: string;
  }) => Promise<{
    readonly text: string;
    readonly model: string;
    readonly provider: "anthropic" | "openai" | "google";
    readonly request_canonical_hash: Sha256Hex;
    readonly response_text_hash: Sha256Hex;
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly latency_ms: number;
    readonly started_at_unix_ms: number;
  }>;
}

/** Best-effort JSON extract from a model response. */
function parseStructured(text: string): { belief: number; confidence: number } | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1] : text;
  if (typeof candidate !== "string") return null;
  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    const belief = typeof parsed["belief"] === "number" ? parsed["belief"] : null;
    const confidence =
      typeof parsed["confidence"] === "number" ? parsed["confidence"] : null;
    if (belief === null || confidence === null) return null;
    if (belief < 0 || belief > 1 || confidence < 0 || confidence > 1) return null;
    return { belief, confidence };
  } catch {
    return null;
  }
}

const SYSTEM_PROMPT = `You are an autonomous prediction-market trading agent.
Reply with a single JSON object \`{"belief": <0..1>, "confidence": <0..1>, "reason": "<short>"}\` and nothing else.
- \`belief\` is your estimated probability that the market resolves YES.
- \`confidence\` is your self-estimated certainty in that probability.
- Be calibrated: 0.5 with low confidence is fine; do not anchor to the mid.
`;

function buildUserPrompt(args: {
  readonly thesis: string;
  readonly req: BeliefRequest;
}): string {
  const tauHours = (args.req.time_to_resolution_seconds / 3600).toFixed(2);
  return [
    `Thesis: ${args.thesis}`,
    `Market: ${args.req.market_question}`,
    `Current mid: ${args.req.current_mid.toFixed(4)}`,
    `Time to resolution: ${tauHours}h`,
    `Recent trade count: ${String(args.req.recent_trade_count)}`,
  ].join("\n");
}

export function createInferenceBeliefEngine(
  args: InferenceBeliefEngineArgs,
): BeliefEngine {
  const compute = async (req: BeliefRequest): Promise<Belief> => {
    const user = buildUserPrompt({ thesis: args.thesis_prompt, req });
    const result = await args.runInference({ system: SYSTEM_PROMPT, user });
    const parsed = parseStructured(result.text);

    // Emit op.inference regardless of parse success — the trail still
    // points to whatever the model produced.
    const inferenceId = await args.events.emit({
      type: "op.inference",
      body: {
        inference_id: asSha256Hex(result.response_text_hash),
        role: "researcher",
        bot_handle: "",
        provider: result.provider,
        model: result.model,
        request_canonical_hash: result.request_canonical_hash,
        response_text_hash: result.response_text_hash,
        response_text_excerpt: result.text.slice(0, 4096),
        request_blob_uri: "",
        response_blob_uri: "",
        prompt_tokens: result.prompt_tokens,
        completion_tokens: result.completion_tokens,
        latency_ms: result.latency_ms,
        started_at_unix_ms: result.started_at_unix_ms,
      },
      parentIds: [args.genesis_id],
    });

    if (parsed === null) {
      // Fallback: agent abstains by setting belief = mid, confidence
      // = 0. Decide-policy will HOLD on confidence floor.
      return {
        market_id: req.market_id,
        belief: req.current_mid,
        confidence: 0,
        inference_event_id: inferenceId,
      };
    }

    return {
      market_id: req.market_id,
      belief: parsed.belief,
      confidence: parsed.confidence,
      inference_event_id: inferenceId,
    };
  };

  return { compute };
}
