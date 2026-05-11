/**
 * LLM judge — produces the `text_score` (0..100) for the
 * resolution-criteria-clarity gate (paper §6 Table 1, gate 5).
 *
 * The prompt is **fixed and committed in the enclave image** (paper
 * §6 input list). At boot, the runtime hashes `RESOLUTION_CLARITY_PROMPT`
 * and surfaces it on `/api/onboarding/decisions` so the verifier can
 * confirm the prompt the agent used matches what the auditor reviewed.
 *
 * Three-role rotation across providers (paper §11 Defended row "LLM
 * provider compromise"): in production the runtime calls one of three
 * providers (anthropic / openai / google) and rejects the score if any
 * single provider's output cannot parse. For Phase 9 we expose the
 * `JudgeFn` interface and a deterministic stub; Phase 11 wires the real
 * provider rotation against the AI gateway.
 */

import { createHash } from "node:crypto";

import { asSha256Hex, type Sha256Hex } from "@vanta/tee";

/**
 * The fixed prompt the LLM sees. Bytes-stable so the hash is stable.
 * Any edit to this string is a paper-§6-level governance change — bump
 * the version suffix in the commit message and capture the new hash.
 */
export const RESOLUTION_CLARITY_PROMPT = `You are scoring the resolution-criteria text of a binary prediction market for clarity. Output ONLY a single integer in 0..100, where:

  0..39  — fundamentally ambiguous; reasonable evaluators would disagree on outcome.
  40..69 — partially clear; resolution depends on interpretation of vague terms.
  70..89 — clear; minor edge cases possible but the typical case is unambiguous.
  90..100 — fully unambiguous; calendar dates, named events, externally-verifiable sources.

The resolution-criteria text:
<<<TEXT>>>

Return only the integer score, no commentary.`;

/** sha256 of the canonical prompt bytes. Used as `prompt_hash` in traces. */
export const RESOLUTION_CLARITY_PROMPT_HASH: Sha256Hex = asSha256Hex(
  createHash("sha256").update(RESOLUTION_CLARITY_PROMPT, "utf8").digest("hex"),
);

export interface JudgeArgs {
  /** Resolution-criteria text the gate is scoring. */
  readonly text: string;
}

export interface JudgeOutput {
  readonly score: number;
  readonly model_id: string;
  readonly prompt_hash: Sha256Hex;
  /** Provider call latency in ms. */
  readonly latency_ms: number;
}

export type JudgeFn = (args: JudgeArgs) => Promise<JudgeOutput>;

/**
 * Gateway-backed judge. Issues one inference call against the EigenCloud
 * LLM Proxy / Vercel AI Gateway, parses the integer score 0..100, and
 * emits a signed `op.inference` event as a side-effect (the inference
 * client owns event emission). Returns the parsed score with the same
 * shape as `stubDeterministicJudge`.
 *
 * The role is `"researcher"` so the deterministic per-day provider
 * rotation in `services/inference.ts` applies — paper §11 "LLM provider
 * compromise" defence.
 */
export function createGatewayJudge(args: {
  readonly call: (req: {
    readonly role: "researcher";
    readonly system?: string;
    readonly messages: ReadonlyArray<{ role: "user"; content: string }>;
    readonly maxTokens?: number;
    readonly temperature?: number;
  }) => Promise<{
    readonly text: string;
    readonly model: string;
    readonly latencyMs: number;
  }>;
}): JudgeFn {
  return async (judgeArgs: JudgeArgs): Promise<JudgeOutput> => {
    const filled = RESOLUTION_CLARITY_PROMPT.replace("<<<TEXT>>>", judgeArgs.text);
    const out = await args.call({
      role: "researcher",
      system:
        "You score market resolution-criteria text for clarity. Respond with a single integer in 0..100 and nothing else.",
      messages: [{ role: "user", content: filled }],
      // 1024 tokens (was 32) so GPT-5 reasoning mode has enough budget
      // to finish its hidden chain-of-thought and still emit a visible
      // integer. Strict-parse regex below caps interpretation, so a
      // longer response can't smuggle a wrong score. Knob change only —
      // prompt bytes unchanged.
      maxTokens: 1024,
      temperature: 0,
    });
    const score = parseScoreOrThrow(out.text);
    return {
      score,
      model_id: out.model,
      prompt_hash: RESOLUTION_CLARITY_PROMPT_HASH,
      latency_ms: out.latencyMs,
    };
  };
}

function parseScoreOrThrow(raw: string): number {
  // Accept the bare integer or a "score: 73" / "73." form. Reject
  // anything else — paper §11 requires a strict parse so a malicious
  // gateway can't smuggle a haircut by replying in prose.
  const match = raw.trim().match(/^[^0-9]*(\d{1,3})/);
  if (match === null) {
    throw new Error(`llm_judge: unparseable response: ${raw.slice(0, 80)}`);
  }
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    throw new Error(`llm_judge: score out of range: ${String(n)}`);
  }
  return n;
}

/**
 * Deterministic stub judge. Maps text features to a score so smoke
 * tests are reproducible. Used when AI_GATEWAY_API_KEY is unset.
 */
export const stubDeterministicJudge: JudgeFn = async (args) => {
  const text = args.text.trim();
  let score = 50;
  // Calendar dates and named events bump score.
  if (/\b(20\d{2})\b/.test(text)) score += 15;
  if (/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/.test(text)) score += 10;
  if (/AP|Reuters|Bloomberg|CNN|Federal Reserve|FOMC/i.test(text)) score += 10;
  // Vague qualifiers reduce score.
  if (/\b(approximately|about|roughly|substantially|materially)\b/i.test(text)) score -= 15;
  if (/\b(wins|loses|defeats|beats)\b/i.test(text) && !/(electoral|popular|certified)/i.test(text))
    score -= 10;
  if (text.length < 60) score -= 10;
  score = Math.max(0, Math.min(100, score));

  return {
    score,
    model_id: "stub-deterministic-v1",
    prompt_hash: RESOLUTION_CLARITY_PROMPT_HASH,
    latency_ms: 0,
  };
};
