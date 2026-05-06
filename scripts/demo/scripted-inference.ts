/**
 * Scripted inference for the demo. Implements `CouncilInferenceFn`
 * from `runtime/src/services/npc-council.ts` so the council can run
 * end-to-end without a live LLM.
 *
 * Key property: every event the council emits using this function is
 * still a real TEE-signed envelope (op.inference, npc.thought,
 * council.synthesised). The only thing that's "scripted" is the text
 * the model returned. The bytes go through the same buildAndSign
 * pipeline a live Haiku call would; auditors see the same shape.
 *
 * Determinism: same persona + same market question ⇒ same thought
 * line every run. Same vote set ⇒ same synthesis. This keeps the
 * demo reproducible across resets (good for screenshots).
 *
 * Wire it up:
 *   const inference = createScriptedInference();
 *   const council = createNpcCouncil({ ..., runInference: inference });
 *
 * Honors `DEMO_LLM=1` upstream — when set, the demo runner uses the
 * real `adaptInferenceClient` instead of this and we never even
 * import this file.
 */

import { createHash } from "node:crypto";

import { asSha256Hex, type Sha256Hex } from "@vanta/tee";

import { ALL_PERSONAS, type NpcPersona } from "../../runtime/src/services/npc-personas.ts";
import type { CouncilInferenceFn } from "../../runtime/src/services/npc-council.ts";

import { pickThought, PERSONA_THOUGHTS } from "./personas-script.ts";

interface ScriptedInferenceOpts {
  /**
   * Cap on simulated end-to-end latency. Real Haiku ≈ 250-700 ms; we
   * stay in that band so the demo "feels" right and event timestamps
   * spread realistically.
   */
  readonly maxLatencyMs?: number;
  /**
   * Override clock — used by event-log seeders that backdate
   * historical events to specific timestamps.
   */
  readonly nowMs?: () => number;
}

const DEFAULT_MAX_LATENCY_MS = 600;

/** Map bias [-3..+3] → offset on belief in [-0.18, +0.18]. */
function biasToBeliefOffset(bias: number): number {
  return Math.max(-0.18, Math.min(0.18, bias * 0.06));
}

/** Map abs(bias) [0..3] → confidence in [0.5, 0.85]. */
function biasToConfidence(bias: number): number {
  const c = 0.55 + Math.abs(bias) * 0.1;
  return Math.max(0.5, Math.min(0.85, c));
}

function clampUnit(x: number): number {
  if (x < 0.02) return 0.02;
  if (x > 0.98) return 0.98;
  return x;
}

/** Tiny deterministic hash, identical to personas-script.ts. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; ++i) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

function sha256Hex(input: string): Sha256Hex {
  return asSha256Hex(createHash("sha256").update(input).digest("hex"));
}

interface UserPromptParse {
  readonly market_question: string;
  readonly current_mid: number;
  readonly prior_belief: number;
  readonly prior_confidence: number;
  readonly persona: NpcPersona | null;
  readonly votes: ReadonlyArray<{
    readonly slug: string;
    readonly displayName: string;
    readonly thought: string;
    readonly belief: number;
    readonly confidence: number;
  }>;
}

const SUBJECT_RE = /^(?:Market|Loan \+ market):\s*(.+)$/m;
const MID_RE = /^Current market mid:\s*([0-9.]+)$/m;
const PRIOR_RE = /^(?:Your prior belief|Your prior loan-health|Agent's working belief|Agent's working loan-health estimate):\s*([0-9.]+)\s*\(confidence\s*([0-9.]+)\)/m;
const BLURB_RE = /^Persona blurb:\s*(.+)$/m;
const VOTE_RE = /^- (.+?) \(([^)]+)\):\s*"(.+?)" — belief ([0-9.]+),\s*confidence ([0-9.]+)$/gm;

function parseUserPrompt(user: string): UserPromptParse {
  const subject = SUBJECT_RE.exec(user)?.[1] ?? "";
  const mid = Number(MID_RE.exec(user)?.[1] ?? "0.5");
  const priorMatch = PRIOR_RE.exec(user);
  const prior = priorMatch ? Number(priorMatch[1]) : 0.5;
  const priorConfidence = priorMatch ? Number(priorMatch[2]) : 0.5;

  // Match the persona by blurb prefix (first 60 chars of blurb is unique).
  const blurb = BLURB_RE.exec(user)?.[1] ?? "";
  const persona = blurb
    ? (ALL_PERSONAS.find((p) => p.personaBlurb.slice(0, 40) === blurb.slice(0, 40)) ?? null)
    : null;

  const votes: UserPromptParse["votes"] = [];
  let m: RegExpExecArray | null;
  // Reset regex state
  VOTE_RE.lastIndex = 0;
  while ((m = VOTE_RE.exec(user)) !== null) {
    votes.push({
      displayName: m[1] ?? "",
      slug: m[2] ?? "",
      thought: m[3] ?? "",
      belief: Number(m[4]),
      confidence: Number(m[5]),
    });
  }

  return {
    market_question: subject,
    current_mid: mid,
    prior_belief: prior,
    prior_confidence: priorConfidence,
    persona,
    votes,
  };
}

interface ScriptedThoughtPayload {
  readonly thought: string;
  readonly belief: number;
  readonly confidence: number;
}

function buildThought(parse: UserPromptParse): ScriptedThoughtPayload {
  const personaSlug = parse.persona?.personaSlug ?? "fallback";
  const marketKey = parse.market_question || "fallback-market";
  const tpl = pickThought(personaSlug, marketKey);

  // Belief drifts off the prior in the direction of the chosen
  // template's bias, scaled to a plausible NPC adjustment.
  const offset = biasToBeliefOffset(tpl.bias);
  const belief = clampUnit(parse.prior_belief + offset);
  const confidence = biasToConfidence(tpl.bias);

  return {
    thought: tpl.text,
    belief,
    confidence,
  };
}

interface ScriptedSynthesisPayload {
  readonly belief: number;
  readonly confidence: number;
  readonly rationale: string;
}

function buildSynthesis(parse: UserPromptParse): ScriptedSynthesisPayload {
  if (parse.votes.length === 0) {
    return {
      belief: parse.prior_belief,
      confidence: parse.prior_confidence,
      rationale:
        "The committee abstained — no votes returned in time. The prior holds and the agent will proceed conservatively.",
    };
  }

  // Confidence-weighted average of votes, blended 50/50 with prior so
  // the council doesn't overshoot when only two voices show up.
  let num = parse.prior_belief * 0.5;
  let den = 0.5;
  let confSum = 0;
  for (const v of parse.votes) {
    const w = Math.max(0.1, v.confidence);
    num += v.belief * w;
    den += w;
    confSum += v.confidence;
  }
  const synthBelief = clampUnit(num / den);
  const synthConfidence = Math.max(
    0.5,
    Math.min(0.92, parse.prior_confidence * 0.4 + (confSum / parse.votes.length) * 0.6),
  );

  // Rationale: pick the two strongest-confidence voters and cite them.
  const ranked = [...parse.votes].sort((a, b) => b.confidence - a.confidence);
  const top = ranked.slice(0, Math.min(2, ranked.length));
  const direction = synthBelief > parse.prior_belief ? "up" : synthBelief < parse.prior_belief ? "down" : "flat";
  const movedClause =
    direction === "flat"
      ? "Net of the divergent voices, the committee held the prior"
      : `${top.map((v) => v.displayName.split(" ")[0] ?? v.slug).join(" and ")} pulled the loan-health ${direction}`;

  const cite =
    top.length >= 2
      ? `${top[0]!.displayName.split(" ")[0]} flagged "${top[0]!.thought.slice(0, 80)}", and ${top[1]!.displayName.split(" ")[0]} added "${top[1]!.thought.slice(0, 80)}".`
      : `${top[0]!.displayName.split(" ")[0]} noted: "${top[0]!.thought.slice(0, 120)}".`;

  return {
    belief: synthBelief,
    confidence: synthConfidence,
    rationale: `${movedClause}. ${cite}`,
  };
}

/**
 * Create the scripted inference function. The returned function
 * matches the `CouncilInferenceFn` contract exactly so the council
 * pipeline emits genuine TEE-signed events around the scripted text.
 */
export function createScriptedInference(opts: ScriptedInferenceOpts = {}): CouncilInferenceFn {
  const maxLatencyMs = opts.maxLatencyMs ?? DEFAULT_MAX_LATENCY_MS;
  const now = opts.nowMs ?? ((): number => Date.now());

  return async ({ system, user, intent }) => {
    const parse = parseUserPrompt(user);

    let payload: ScriptedThoughtPayload | ScriptedSynthesisPayload;
    if (intent === "thought") {
      payload = buildThought(parse);
    } else {
      payload = buildSynthesis(parse);
    }

    // The council's parsers expect strict JSON, no markdown fence.
    const text = JSON.stringify(payload);

    // Hashes are deterministic over (system, user, payload) so the
    // event chain replays byte-identically across runs.
    const requestCanonical = `${system}\n---\n${user}`;
    const requestHash = sha256Hex(requestCanonical);
    const responseHash = sha256Hex(text);

    // Latency band: thoughts are 'cheap small model' (faster), synthesis
    // is 'primary model' (slower). Mirrors real Haiku vs Sonnet timing
    // well enough for the demo to feel real.
    const seed = fnv1a(requestCanonical);
    const baseMs = intent === "thought" ? 220 : 380;
    const jitter = (seed % 200) + (intent === "thought" ? 0 : 80);
    const latencyMs = Math.min(maxLatencyMs, baseMs + jitter);

    // Token counts proportional to character length — close to what
    // tokenisers return for English JSON of this size.
    const promptTokens = Math.max(40, Math.round((system.length + user.length) / 4));
    const completionTokens = Math.max(12, Math.round(text.length / 4));

    return {
      text,
      model: intent === "thought" ? "claude-haiku-4-5-scripted" : "claude-sonnet-4-6-scripted",
      provider: "anthropic" as const,
      request_canonical_hash: requestHash,
      response_text_hash: responseHash,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      latency_ms: latencyMs,
      started_at_unix_ms: now() - latencyMs,
    };
  };
}

/**
 * Self-test entry point — verifies the function returns parseable
 * output for a known persona + market. Run with:
 *
 *   pnpm tsx scripts/demo/scripted-inference.ts
 */
async function selfTest(): Promise<void> {
  const fn = createScriptedInference();

  const personasWithThoughts = ALL_PERSONAS.filter(
    (p) => (PERSONA_THOUGHTS[p.personaSlug] ?? []).length > 0,
  );

  console.log(`scripted-inference self-test: ${String(personasWithThoughts.length)} personas`);

  for (const p of personasWithThoughts.slice(0, 3)) {
    const r1 = await fn({
      system: "You are an in-world citizen…",
      user: [
        `Persona blurb: ${p.personaBlurb}`,
        `Voice: ${p.promptVoice}`,
        "",
        "Loan + market: Will the Fed cut rates by 25bp at the next meeting?",
        "Current market mid: 0.5800",
        "Agent's working loan-health estimate: 0.7200 (confidence 0.65)",
      ].join("\n"),
      intent: "thought",
    });
    const r2 = await fn({
      system: "You are an in-world citizen…",
      user: [
        `Persona blurb: ${p.personaBlurb}`,
        `Voice: ${p.promptVoice}`,
        "",
        "Loan + market: Will the Fed cut rates by 25bp at the next meeting?",
        "Current market mid: 0.5800",
        "Agent's working loan-health estimate: 0.7200 (confidence 0.65)",
      ].join("\n"),
      intent: "thought",
    });
    if (r1.text !== r2.text) {
      throw new Error(`non-deterministic output for ${p.personaSlug}`);
    }
    if (r1.request_canonical_hash !== r2.request_canonical_hash) {
      throw new Error(`hashes drifted for ${p.personaSlug}`);
    }
    const parsed = JSON.parse(r1.text) as Record<string, unknown>;
    if (
      typeof parsed["belief"] !== "number" ||
      typeof parsed["confidence"] !== "number" ||
      typeof parsed["thought"] !== "string"
    ) {
      throw new Error(`malformed payload for ${p.personaSlug}: ${r1.text}`);
    }
    console.log(`  [${p.personaSlug}] ${String(parsed["thought"])}`);
    console.log(
      `     belief=${(parsed["belief"] as number).toFixed(3)} conf=${(parsed["confidence"] as number).toFixed(2)} latency=${String(r1.latency_ms)}ms`,
    );
  }

  // Synthesis test: feed two votes and confirm we get a parseable synthesis.
  const synth = await fn({
    system: "You are an autonomous prediction-market lending agent…",
    user: [
      "Loan + market: Will the Fed cut rates by 25bp at the next meeting?",
      "Current market mid: 0.5800",
      "Your prior loan-health: 0.7200 (confidence 0.65)",
      "",
      "Townsfolk who weighed in:",
      `- Brother Tomás the Cloister Scholar (cloister-scholar): "Volcker '79 taught us — when conviction breaks, it breaks fast." — belief 0.840, confidence 0.85`,
      `- Helga the Grain Merchant (grain-merchant): "Three of my regulars asked for terms last week." — belief 0.580, confidence 0.75`,
    ].join("\n"),
    intent: "synthesis",
  });
  const parsedSynth = JSON.parse(synth.text) as Record<string, unknown>;
  if (
    typeof parsedSynth["belief"] !== "number" ||
    typeof parsedSynth["confidence"] !== "number" ||
    typeof parsedSynth["rationale"] !== "string"
  ) {
    throw new Error(`malformed synthesis: ${synth.text}`);
  }
  console.log(
    `  [synthesis] belief=${(parsedSynth["belief"] as number).toFixed(3)} conf=${(parsedSynth["confidence"] as number).toFixed(2)}`,
  );
  console.log(`              rationale: ${String(parsedSynth["rationale"])}`);

  console.log("\nscripted-inference: OK");
}

if (process.argv[1] && process.argv[1].endsWith("scripted-inference.ts")) {
  selfTest().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
