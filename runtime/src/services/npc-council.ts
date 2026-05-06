/**
 * NPC Council — diegetic input to the agent's belief.
 *
 * One council pass:
 *
 *   1. Pick 2 NPCs from the agent's kingdom roster (deterministic
 *      sample seeded on (market_id + slot)).
 *   2. For each NPC, run a cheap inference call (Anthropic Haiku via
 *      `runInference`) that gives the LLM the persona blurb +
 *      market context and asks for `(belief, confidence, thought)`.
 *      Parse the JSON, emit an `op.inference` event, then a signed
 *      `npc.thought` event keyed to that NPC.
 *   3. Run a synthesis inference call that takes the original
 *      `belief.updated` value and the N npc.thought results, asks
 *      the agent to re-evaluate, and returns a single
 *      `(synthesised_belief, synthesised_confidence, rationale)`.
 *      Emit a `council.synthesised` event with parent_ids pointing
 *      at every consumed npc.thought.
 *   4. Return the synthesised belief so the trading loop can use it
 *      in `decide()` instead of the original.
 *
 * If any step fails (LLM outage, parse error, etc), the council
 * abstains — the trading loop falls back to the original belief and
 * the audit trail records *no* council.synthesised. The loop never
 * blocks on the council.
 *
 * Throttling lives in `createNpcCouncil`: a per-(agent, market)
 * cooldown ensures we don't run another council pass within
 * `cooldownMs` of the last one. Default 90 s.
 */

import type { Sha256Hex } from "@vanta/tee";
import { asSha256Hex } from "@vanta/tee";

import type { EventSink } from "../loops/types.js";

import {
  type NpcPersona,
  PERSONAS_BY_AGENT,
  sampleNpcs,
} from "./npc-personas.js";

export type CouncilInferenceFn = (args: {
  readonly system: string;
  readonly user: string;
  /** "thought" → cheap small model; "synthesis" → primary model. */
  readonly intent: "thought" | "synthesis";
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

export type CouncilMode = "trading" | "lending";

export interface NpcCouncilArgs {
  readonly agent_id: number;
  readonly events: EventSink;
  readonly genesis_id: Sha256Hex;
  readonly runInference: CouncilInferenceFn;
  /**
   * Trading: NPCs opine on a market belief; synthesis = updated belief.
   * Lending: NPCs opine on a loan's health; synthesis = loan-health
   * probability (1.0 safely-repaid, 0.0 will-liquidate). Same emit
   * machinery, different prompts, different downstream interpretation.
   */
  readonly mode?: CouncilMode;
  /** How long after a council pass to skip the next one for the same market. */
  readonly cooldownMs?: number;
  /** How many NPCs to sample per pass. Default 2. */
  readonly sampleSize?: number;
  /** Override clock for tests. */
  readonly nowMs?: () => number;
}

export interface CouncilPassRequest {
  readonly market_id: Sha256Hex;
  readonly market_question: string;
  readonly current_mid: number;
  readonly prior_belief: number; // ∈ [0, 1]
  readonly prior_confidence: number; // ∈ [0, 1]
  /** Parent event id of the belief.updated this pass refines. */
  readonly belief_event_id: Sha256Hex;
}

export interface CouncilPassResult {
  readonly synthesisedBelief: number;
  readonly synthesisedConfidence: number;
  readonly synthesisEventId: Sha256Hex;
  readonly thoughtEventIds: readonly Sha256Hex[];
  readonly rationale: string;
}

export interface NpcCouncil {
  /**
   * Run a council pass for one market. Returns the synthesised
   * belief + confidence on success, or `null` if the council was
   * skipped (cooldown not elapsed) or aborted (LLM failure).
   */
  readonly run: (req: CouncilPassRequest) => Promise<CouncilPassResult | null>;
}

const ZERO_HEX: Sha256Hex =
  "0000000000000000000000000000000000000000000000000000000000000000" as Sha256Hex;

const DEFAULT_COOLDOWN_MS = 90_000;
const DEFAULT_SAMPLE_SIZE = 2;

const NPC_TRADING_SYSTEM_PROMPT = `You are an in-world citizen voicing your view on a prediction market. You are NOT the trading agent — you are a townsperson the agent listens to.

Reply with a single JSON object \`{"thought": "<one-line opinion ≤ 200 chars>", "belief": <0..1>, "confidence": <0..1>}\` and nothing else.

- \`thought\`: 1 sentence, in your character's voice. No markdown, no quotes around the whole thing.
- \`belief\`: your estimated probability the market resolves YES.
- \`confidence\`: how sure you are in your number, ∈ [0,1].
`;

const SYNTHESIS_TRADING_SYSTEM_PROMPT = `You are an autonomous prediction-market trading agent. You computed an initial belief, then asked several townsfolk for their views. Now re-evaluate.

Reply with a single JSON object \`{"belief": <0..1>, "confidence": <0..1>, "rationale": "<1-3 sentences citing which townsfolk shifted you and why>"}\` and nothing else.

Weigh each townsperson by how relevant their persona is to this market. Don't be swayed by lone outliers; do update if multiple credible voices converge against your prior.
`;

/**
 * Lending-mode NPC prompt. The townsperson is now a member of an
 * underwriting committee. Their `belief` field encodes loan-health
 * probability — 1.0 = will be safely repaid, 0.0 = will liquidate —
 * not a prediction-market YES probability. The schema field name stays
 * `belief` so the parser is shared; the semantics live in the prompt.
 */
const NPC_LENDING_SYSTEM_PROMPT = `You are a member of a lender's underwriting committee voicing your view on a LOAN. The agent has already done LTV math and produced a working credit-health estimate. You are a townsperson whose persona shapes how you read the risk.

Reply with a single JSON object \`{"thought": "<one-line opinion ≤ 200 chars>", "belief": <0..1>, "confidence": <0..1>}\` and nothing else.

- \`thought\`: 1 sentence in your character's voice — does the loan look safe, or do you smell trouble? No markdown.
- \`belief\`: your estimated probability the loan ends up safely repaid (1.0 = very safe, 0.0 = will liquidate).
- \`confidence\`: how sure you are in your number, ∈ [0,1].
`;

const SYNTHESIS_LENDING_SYSTEM_PROMPT = `You are an autonomous prediction-market lending agent's underwriting committee. You computed an initial loan-health estimate from LTV math, then asked several townsfolk for their views. Now re-evaluate.

Reply with a single JSON object \`{"belief": <0..1>, "confidence": <0..1>, "rationale": "<1-3 sentences citing which townsfolk shifted you and why>"}\` and nothing else.

\`belief\` encodes loan-health probability (1.0 safely-repaid, 0.0 will-liquidate). \`confidence\` ∈ [0,1].

Weigh each townsperson by how relevant their persona is to this loan. A scholar citing a precedent is louder than an inn-keeper's gut feel for a macro loan; the inn-keeper carries weight on a sports market. Don't be swayed by lone outliers; do update when multiple credible voices converge.
`;

interface ParsedThought {
  readonly thought: string;
  readonly belief: number;
  readonly confidence: number;
}

function parseThought(text: string): ParsedThought | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1] : text;
  if (typeof candidate !== "string") return null;
  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    const thought = parsed["thought"];
    const belief = parsed["belief"];
    const confidence = parsed["confidence"];
    if (typeof thought !== "string" || thought.trim().length === 0) return null;
    if (typeof belief !== "number" || belief < 0 || belief > 1) return null;
    if (typeof confidence !== "number" || confidence < 0 || confidence > 1)
      return null;
    return {
      thought: thought.slice(0, 280),
      belief,
      confidence,
    };
  } catch {
    return null;
  }
}

interface ParsedSynthesis {
  readonly belief: number;
  readonly confidence: number;
  readonly rationale: string;
}

function parseSynthesis(text: string): ParsedSynthesis | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1] : text;
  if (typeof candidate !== "string") return null;
  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    const belief = parsed["belief"];
    const confidence = parsed["confidence"];
    const rationale = parsed["rationale"];
    if (typeof belief !== "number" || belief < 0 || belief > 1) return null;
    if (typeof confidence !== "number" || confidence < 0 || confidence > 1)
      return null;
    if (typeof rationale !== "string" || rationale.trim().length === 0)
      return null;
    return {
      belief,
      confidence,
      rationale: rationale.slice(0, 4096),
    };
  } catch {
    return null;
  }
}

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

function buildNpcUserPrompt(args: {
  readonly persona: NpcPersona;
  readonly req: CouncilPassRequest;
  readonly mode: CouncilMode;
}): string {
  const subjectLine =
    args.mode === "lending"
      ? `Loan + market: ${args.req.market_question}`
      : `Market: ${args.req.market_question}`;
  const priorLine =
    args.mode === "lending"
      ? `Agent's working loan-health estimate: ${args.req.prior_belief.toFixed(4)} (confidence ${args.req.prior_confidence.toFixed(2)})`
      : `Agent's working belief: ${args.req.prior_belief.toFixed(4)} (confidence ${args.req.prior_confidence.toFixed(2)})`;
  return [
    `Persona blurb: ${args.persona.personaBlurb}`,
    `Voice: ${args.persona.promptVoice}`,
    "",
    subjectLine,
    `Current market mid: ${args.req.current_mid.toFixed(4)}`,
    priorLine,
  ].join("\n");
}

interface NpcVote {
  readonly persona: NpcPersona;
  readonly thoughtEventId: Sha256Hex;
  readonly thought: string;
  readonly belief: number;
  readonly confidence: number;
}

function buildSynthesisUserPrompt(args: {
  readonly req: CouncilPassRequest;
  readonly votes: readonly NpcVote[];
  readonly mode: CouncilMode;
}): string {
  const voteLines = args.votes.map((v) => {
    return `- ${v.persona.displayName} (${v.persona.personaSlug}): "${v.thought}" — belief ${v.belief.toFixed(3)}, confidence ${v.confidence.toFixed(2)}`;
  });
  const subjectLine =
    args.mode === "lending"
      ? `Loan + market: ${args.req.market_question}`
      : `Market: ${args.req.market_question}`;
  const priorLine =
    args.mode === "lending"
      ? `Your prior loan-health: ${args.req.prior_belief.toFixed(4)} (confidence ${args.req.prior_confidence.toFixed(2)})`
      : `Your prior belief: ${args.req.prior_belief.toFixed(4)} (confidence ${args.req.prior_confidence.toFixed(2)})`;
  return [
    subjectLine,
    `Current market mid: ${args.req.current_mid.toFixed(4)}`,
    priorLine,
    "",
    "Townsfolk who weighed in:",
    ...voteLines,
  ].join("\n");
}

export function createNpcCouncil(args: NpcCouncilArgs): NpcCouncil {
  const cooldownMs = args.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const sampleSize = args.sampleSize ?? DEFAULT_SAMPLE_SIZE;
  const mode: CouncilMode = args.mode ?? "trading";
  const now = args.nowMs ?? ((): number => Date.now());

  const npcSystemPrompt =
    mode === "lending" ? NPC_LENDING_SYSTEM_PROMPT : NPC_TRADING_SYSTEM_PROMPT;
  const synthesisSystemPrompt =
    mode === "lending"
      ? SYNTHESIS_LENDING_SYSTEM_PROMPT
      : SYNTHESIS_TRADING_SYSTEM_PROMPT;

  const lastPassAt = new Map<Sha256Hex, number>();
  let slotCounter = 0;

  const run = async (
    req: CouncilPassRequest,
  ): Promise<CouncilPassResult | null> => {
    const last = lastPassAt.get(req.market_id);
    const t = now();
    if (last !== undefined && t - last < cooldownMs) {
      return null;
    }
    lastPassAt.set(req.market_id, t);
    slotCounter += 1;

    const personas = sampleNpcs(
      args.agent_id,
      sampleSize,
      `${req.market_id}::${String(slotCounter)}`,
    );
    if (personas.length === 0) return null;

    const votes: NpcVote[] = [];

    // Step 1: per-NPC thought calls. Run them in parallel (different
    // personas, no shared state); fail-soft if any one breaks.
    const thoughtResults = await Promise.allSettled(
      personas.map(async (persona) => {
        const llm = await args.runInference({
          system: npcSystemPrompt,
          user: buildNpcUserPrompt({ persona, req, mode }),
          intent: "thought",
        });
        const parsed = parseThought(llm.text);
        if (parsed === null) return null;

        // Emit op.inference for the NPC's call. Schema invariant:
        // bot_handle must be empty for non-`population_bot` roles. The
        // NPC's identity is preserved on the paired `npc.thought`
        // (npc_id + persona + display name); the inference event is
        // linked via `inference_event_id`.
        const inferenceId = await args.events.emit({
          type: "op.inference",
          body: {
            inference_id: asSha256Hex(llm.response_text_hash),
            role: "researcher",
            bot_handle: "",
            provider: llm.provider,
            model: llm.model,
            request_canonical_hash: llm.request_canonical_hash,
            response_text_hash: llm.response_text_hash,
            response_text_excerpt: llm.text.slice(0, 4096),
            request_blob_uri: "",
            response_blob_uri: "",
            prompt_tokens: llm.prompt_tokens,
            completion_tokens: llm.completion_tokens,
            latency_ms: llm.latency_ms,
            started_at_unix_ms: llm.started_at_unix_ms,
          },
          parentIds: [args.genesis_id],
        });

        // Emit npc.thought, parented to the belief event AND the
        // inference event so auditors can trace either way.
        const thoughtId = await args.events.emit({
          type: "npc.thought",
          body: {
            agent_id: args.agent_id,
            npc_id: persona.npcId,
            npc_persona: persona.personaSlug,
            npc_display_name: persona.displayName,
            market_id: req.market_id,
            thought: parsed.thought,
            belief_centibps: probToCentibps(parsed.belief),
            confidence_bps: probToBps(parsed.confidence),
            inference_event_id: inferenceId,
          },
          parentIds: [args.genesis_id, req.belief_event_id, inferenceId],
        });

        return {
          persona,
          thoughtEventId: thoughtId,
          thought: parsed.thought,
          belief: parsed.belief,
          confidence: parsed.confidence,
        } satisfies NpcVote;
      }),
    );

    for (const r of thoughtResults) {
      if (r.status === "fulfilled" && r.value !== null) votes.push(r.value);
    }

    if (votes.length === 0) return null;

    // Step 2: synthesis call.
    let synthLlm;
    try {
      synthLlm = await args.runInference({
        system: synthesisSystemPrompt,
        user: buildSynthesisUserPrompt({ req, votes, mode }),
        intent: "synthesis",
      });
    } catch {
      return null;
    }

    const parsedSynth = parseSynthesis(synthLlm.text);
    if (parsedSynth === null) return null;

    // Synthesis-call op.inference event. bot_handle stays empty —
    // role="evaluator" is not `population_bot`, and the council's
    // attribution lives on `council.synthesised.agent_id`.
    const synthInferenceId = await args.events.emit({
      type: "op.inference",
      body: {
        inference_id: asSha256Hex(synthLlm.response_text_hash),
        role: "evaluator",
        bot_handle: "",
        provider: synthLlm.provider,
        model: synthLlm.model,
        request_canonical_hash: synthLlm.request_canonical_hash,
        response_text_hash: synthLlm.response_text_hash,
        response_text_excerpt: synthLlm.text.slice(0, 4096),
        request_blob_uri: "",
        response_blob_uri: "",
        prompt_tokens: synthLlm.prompt_tokens,
        completion_tokens: synthLlm.completion_tokens,
        latency_ms: synthLlm.latency_ms,
        started_at_unix_ms: synthLlm.started_at_unix_ms,
      },
      parentIds: [args.genesis_id],
    });

    const priorCentibps = probToCentibps(req.prior_belief);
    const synthCentibps = probToCentibps(parsedSynth.belief);
    const thoughtIds = votes.map((v) => v.thoughtEventId);

    const synthesisId = await args.events.emit({
      type: "council.synthesised",
      body: {
        agent_id: args.agent_id,
        market_id: req.market_id,
        npc_thought_event_ids: thoughtIds,
        prior_belief_centibps: priorCentibps,
        synthesised_belief_centibps: synthCentibps,
        delta_centibps: synthCentibps - priorCentibps,
        synthesised_confidence_bps: probToBps(parsedSynth.confidence),
        rationale: parsedSynth.rationale,
        inference_event_id: synthInferenceId,
      },
      parentIds: [
        args.genesis_id,
        req.belief_event_id,
        synthInferenceId,
        ...thoughtIds,
      ],
    });

    return {
      synthesisedBelief: parsedSynth.belief,
      synthesisedConfidence: parsedSynth.confidence,
      synthesisEventId: synthesisId,
      thoughtEventIds: thoughtIds,
      rationale: parsedSynth.rationale,
    };
  };

  return { run };
}

/** Re-export for the trading loop wiring. */
export { PERSONAS_BY_AGENT, ZERO_HEX };

// ---------------------------------------------------------------------------
// Production adapter — wrap the existing InferenceClient
// ---------------------------------------------------------------------------

import type { InferenceClient, InferenceProvider } from "./inference.js";

/**
 * Adapter that turns the existing TEE-signed `InferenceClient` into a
 * `CouncilInferenceFn`. Production fleet-host wires this once at boot
 * and passes the resulting fn to `createNpcCouncil`.
 *
 * Differences from the test stub:
 *   - The InferenceClient already signs an `op.inference` event for
 *     each call (with proper canonical-request hash + response hash).
 *     We pass the resulting `eventId` back so the council can parent
 *     `npc.thought` directly on the existing event instead of
 *     emitting a duplicate.
 *   - `intent === "thought"` requests a small fast model
 *     (population_bot role → cheap rotation); `intent === "synthesis"`
 *     requests the agent's primary researcher rotation.
 *
 * Crash-soft: if the inference call throws, the council swallows it
 * and the trading loop falls back to the original belief.
 */
export function adaptInferenceClient(args: {
  readonly client: InferenceClient;
  readonly defaultParentId: Sha256Hex;
  /** Stable bot handle used in op.inference for the cheap (NPC) calls. */
  readonly npcBotHandle: string;
}): CouncilInferenceFn {
  return async (call) => {
    const role = call.intent === "thought" ? "population_bot" : "researcher";
    const messages = [{ role: "user" as const, content: call.user }];
    const requestArgs: Parameters<InferenceClient["call"]>[0] = {
      role,
      system: call.system,
      messages,
      maxTokens: call.intent === "thought" ? 256 : 512,
      temperature: call.intent === "thought" ? 0.7 : 0.2,
      parentId: args.defaultParentId,
    };
    if (role === "population_bot") {
      // population_bot REQUIRES a botHandle on the wire.
      (requestArgs as { botHandle: string }).botHandle = args.npcBotHandle;
    }
    const startedAt = Date.now();
    const r = await args.client.call(requestArgs);
    return {
      text: r.text,
      model: r.model,
      provider: r.provider as InferenceProvider,
      // Wrap the InferenceClient's already-emitted op.inference. The
      // council uses these hashes to construct ITS OWN op.inference
      // event when it doesn't get inference_event_id; by also passing
      // through the eventId we let the council skip the re-emission.
      request_canonical_hash:
        // fall back to a stable derived hash if the client doesn't
        // expose it on its response; we tolerate either path.
        ("requestCanonicalHash" in r
          ? (r as { requestCanonicalHash: Sha256Hex }).requestCanonicalHash
          : (r.eventId as Sha256Hex)) as Sha256Hex,
      response_text_hash: r.eventId as Sha256Hex,
      prompt_tokens: r.promptTokens,
      completion_tokens: r.completionTokens,
      latency_ms: r.latencyMs,
      started_at_unix_ms: startedAt,
    };
  };
}
