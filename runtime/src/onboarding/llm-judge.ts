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
 * Deterministic stub judge. Maps text features to a score so smoke
 * tests are reproducible. Replaced in Phase 11 with the real
 * AI-gateway-backed three-role rotation.
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
