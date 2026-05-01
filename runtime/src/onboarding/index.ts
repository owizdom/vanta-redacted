/**
 * @vanta/runtime/onboarding — paper §6 onboarding cycle.
 *
 * Public surface:
 *   - createOnboardingLoop  — 6-hour scheduler
 *   - evaluateGateFloor     — pure gate evaluation
 *   - reason                — agent reasoning above the floor
 *   - stubDeterministicJudge — Phase 9 LLM-judge stub
 *   - RESOLUTION_CLARITY_PROMPT / RESOLUTION_CLARITY_PROMPT_HASH
 */

export { createOnboardingLoop } from "./onboard.js";
export type {
  OnboardingLoopArgs,
  FetchCandidatesFn,
  FetchExposureFn,
} from "./onboard.js";

export { evaluateGateFloor, PUBLISHED_GATE_NAMES } from "./gates.js";

export { reason, inputsHash } from "./reasoning.js";
export type { ExposureSnapshot } from "./reasoning.js";

export {
  stubDeterministicJudge,
  RESOLUTION_CLARITY_PROMPT,
  RESOLUTION_CLARITY_PROMPT_HASH,
} from "./llm-judge.js";
export type { JudgeArgs, JudgeFn, JudgeOutput } from "./llm-judge.js";

export type {
  AgentReasoningOutput,
  CandidateInputs,
  GateFloorVerdict,
  GateResult,
  OnboardDecisionBody,
  OnboardingTickResult,
} from "./types.js";
