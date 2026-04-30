/**
 * Pledge-path eligibility check (I-PL-4 + I-PL-7).
 *
 * Orchestrates the four reads canonical-reference §3 pins as the
 * "authoritative read sequence":
 *
 *   1. CTF `payoutDenominator(conditionId)` — if non-zero, the market is
 *      resolved (`reportPayouts` has fired). Primary resolved-check.
 *   2. CTF `getOutcomeSlotCount(conditionId)` — must equal the caller's
 *      declared `outcome_slot_count`. A mismatch indicates the condition
 *      was prepared with a different slot count than the borrower thinks
 *      — refuse rather than pledge into the wrong CTF position shape.
 *   3. UMA `getQuestion(questionId)` — `paused`, `reset`, `refund` flags.
 *      Any active flag rejects the pledge.
 *   4. CLOB resolution (`closed` + `winners`) — if it contradicts the
 *      on-chain state (I-PL-7), reject.
 *
 * The UMA read returns `paused`, `reset`, and `refund` as separate
 * booleans. Because the current adapter revision folds "in dispute"
 * under the `reset` flag, this module surfaces `reset` as its own
 * `PledgeEligibility` reason; a future adapter revision that separates
 * `disputed` can use the existing `disputed` enum slot without a
 * compatibility break.
 */

import type { PublicClient } from "viem";

import type {
  ConditionId,
  QuestionId,
  UmaQuestion,
} from "@vanta/venue-poly";
import {
  readOutcomeSlotCount,
  readPayoutDenominator,
} from "@vanta/venue-poly";

import type { ClobResolutionSnapshot, PledgeEligibility } from "./types.js";

/**
 * Narrow contract for the injected UMA reader. `@vanta/venue-poly`
 * exports `readQuestion` with exactly this shape; the contract is kept
 * local so tests can fake it without pulling the full viem client into
 * scope.
 */
export type ReadQuestionFn = (
  client: PublicClient,
  questionId: QuestionId,
) => Promise<UmaQuestion>;

export interface CheckEligibilityArgs {
  readonly client: PublicClient;
  readonly readQuestion: ReadQuestionFn;
  readonly conditionId: ConditionId;
  readonly questionId: QuestionId;
  readonly outcomeSlotCount: bigint;
  readonly marketResolutionFromClob: ClobResolutionSnapshot;
}

/**
 * Returns `{ ok: true }` when every I-PL-4 + I-PL-7 gate passes. Failed
 * gates surface as a typed reason; the caller converts that into an
 * `ineligible` PledgeError at the orchestrator boundary.
 */
export async function checkEligibility(
  args: CheckEligibilityArgs,
): Promise<PledgeEligibility> {
  const denominator = await readPayoutDenominator(args.client, args.conditionId);
  if (denominator !== 0n) {
    return { ok: false, reason: "resolved" };
  }

  const onChainSlotCount = await readOutcomeSlotCount(
    args.client,
    args.conditionId,
  );
  if (onChainSlotCount !== args.outcomeSlotCount) {
    return { ok: false, reason: "slot_count_mismatch" };
  }

  const question = await args.readQuestion(args.client, args.questionId);
  if (question.paused) {
    return { ok: false, reason: "halted" };
  }
  if (question.reset) {
    return { ok: false, reason: "reset" };
  }
  if (question.refund) {
    return { ok: false, reason: "refund" };
  }

  // I-PL-7: on-chain says unresolved (denominator === 0). If CLOB says
  // closed with at least one winner, the two disagree — reject.
  const clobDeclaresWinner =
    args.marketResolutionFromClob.closed &&
    args.marketResolutionFromClob.winners.length > 0;
  if (clobDeclaresWinner) {
    return { ok: false, reason: "clob_disagrees" };
  }

  return { ok: true };
}
