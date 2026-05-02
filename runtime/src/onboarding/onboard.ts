/**
 * Onboarding cycle — paper §6.
 *
 * Every six hours (configurable), iterate the candidate-market list,
 * run each candidate through the gate floor + agent reasoning, and
 * emit the signed `loop.onboard_decision` + sibling `reasoning.trace`
 * pair into the event log.
 *
 * Authority bounds:
 *   - At most 3 onboard decisions per 24h (`ENVELOPE_V0.maxOnboardsPer24h`).
 *     The contract enforces this; we front-run by short-circuiting
 *     additional candidates after the third onboard within the rolling
 *     24h window.
 *   - Per-market `cap_initial_usdc ≤ ENVELOPE_V0.probationCapInitialUsdc`
 *     ($25k) for the first `probationDays` days.
 *   - LTV ≤ `LOAN_INVARIANTS_V0.ltvCeilingBps` (50%).
 *
 * The agent has no apply authority outside the envelope: a contract
 * revert is the safety net of last resort if the off-chain runtime
 * tries to emit a malformed OnboardEvent.
 */

import { ENVELOPE_V0 } from "@vanta/constitution";
import { asSha256Hex, type Sha256Hex } from "@vanta/tee";

import type {
  EventSink,
  LoopClock,
  LoopContext,
  ReasoningLoop,
  ReasoningTraceBody,
} from "../loops/types.js";

import { evaluateGateFloor } from "./gates.js";
import { stubDeterministicJudge, type JudgeFn } from "./llm-judge.js";
import { inputsHash, reason, type ExposureSnapshot } from "./reasoning.js";
import type {
  CandidateInputs,
  GateFloorVerdict,
  OnboardDecisionBody,
  OnboardingTickResult,
} from "./types.js";

export type FetchCandidatesFn = () => Promise<readonly CandidateInputs[]>;
export type FetchExposureFn = () => Promise<ExposureSnapshot>;

export interface OnboardingLoopArgs {
  readonly ctx: LoopContext;
  readonly fetchCandidates: FetchCandidatesFn;
  readonly fetchExposure: FetchExposureFn;
  /** LLM judge for `text_score`. Defaults to the deterministic stub. */
  readonly judge?: JudgeFn;
  /** Tick cadence in seconds. Default: 6h per paper §6. */
  readonly tickSeconds?: number;
  readonly sleepMs?: (ms: number) => Promise<void>;
}

const DEFAULT_TICK_SECONDS = 6 * 60 * 60;
const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Rolling window of timestamps for the `maxOnboardsPer24h` gate. */
class OnboardWindow {
  private timestamps: number[] = [];
  recordOnboard(nowMs: number): void {
    this.timestamps.push(nowMs);
    this.prune(nowMs);
  }
  countWithin24h(nowMs: number): number {
    this.prune(nowMs);
    return this.timestamps.length;
  }
  private prune(nowMs: number): void {
    const cutoff = nowMs - 24 * 60 * 60 * 1_000;
    this.timestamps = this.timestamps.filter((t) => t >= cutoff);
  }
}

function buildRejectionTrace(args: {
  readonly candidate: CandidateInputs;
  readonly verdict: GateFloorVerdict;
  readonly textScore: number;
  readonly nowMs: number;
}): ReasoningTraceBody {
  const { candidate, verdict, textScore, nowMs } = args;
  const failed = verdict.results.filter((r) => !r.pass);
  const inputs: Record<string, string | number> = {
    market_id: candidate.market_id,
    depth_5pct_usdc: candidate.depth_5pct_usdc,
    dispute_30d_count: candidate.dispute_30d_count,
    age_days: candidate.age_days,
    vol_7d: candidate.vol_7d.toFixed(6),
    tags: candidate.tags.join(","),
    nowMs,
  };
  return {
    subject_event_id: asSha256Hex("0".repeat(64)),
    subject_event_type: "loop.onboard_decision",
    inputs_summary: inputs,
    intermediate_scores: {
      gates_total: verdict.results.length,
      gates_failed: failed.length,
      text_score: textScore,
    },
    decision_rationale: `Gate floor rejected: ${failed.map((f) => f.gate).join(", ")}. ${failed.map((f) => f.reason).join(" | ")}`,
    dissenting_considerations: "",
    model_id: "",
    prompt_hash: "",
  };
}

async function processCandidate(args: {
  readonly candidate: CandidateInputs;
  readonly events: EventSink;
  readonly genesisId: Sha256Hex;
  readonly clock: LoopClock;
  readonly judge: JudgeFn;
  readonly exposure: ExposureSnapshot;
  readonly window: OnboardWindow;
}): Promise<OnboardingTickResult> {
  const { candidate, events, genesisId, clock, judge, exposure, window } = args;

  const nowMs = clock.nowMs();

  // 1. LLM judge first — its score feeds the gate floor.
  const judgeOut = await judge({ text: candidate.text });

  // 2. Gate floor.
  const verdict = evaluateGateFloor(candidate, judgeOut.score);

  // 3. If gate floor fails, emit a rejection trace + decision and short-circuit.
  if (!verdict.all_pass) {
    const trace = buildRejectionTrace({
      candidate,
      verdict,
      textScore: judgeOut.score,
      nowMs,
    });
    const traceId = await events.emit({
      type: "reasoning.trace",
      body: trace,
      parentIds: [genesisId],
    });
    const body: OnboardDecisionBody = {
      market_id: candidate.market_id,
      inputs_hash: asSha256Hex(inputsHash(candidate)),
      trace_hash: traceId,
      decision: "reject",
      ltv_max_bps: 0,
      cap_initial_usdc: "0",
      rate_alpha: "0",
      rate_beta: "0",
      rate_gamma: "0",
      rate_tau_gap_days: "0",
      timestamp_ms: nowMs,
      gate_results: verdict.results.map((r) => ({ gate: r.gate, pass: r.pass })),
    };
    const decisionId = await events.emit({
      type: "loop.onboard_decision",
      body,
      parentIds: [genesisId, traceId],
    });
    return {
      market_id: candidate.market_id,
      gate_verdict: verdict,
      reasoning: null,
      trace,
      emitted: { trace_id: traceId, decision_id: decisionId },
    };
  }

  // 4. Gate floor passed → enforce throughput cap (paper §6 safety floor).
  const onboardCount24h = window.countWithin24h(nowMs);
  if (onboardCount24h >= ENVELOPE_V0.maxOnboardsPer24h) {
    // Throughput cap exceeded. Flag for human review rather than reject —
    // the candidate would have been onboardable were it not for the cap.
    const trace: ReasoningTraceBody = {
      subject_event_id: asSha256Hex("0".repeat(64)),
      subject_event_type: "loop.onboard_decision",
      inputs_summary: {
        market_id: candidate.market_id,
        text_score: judgeOut.score,
        rolling_24h_count: onboardCount24h,
        max_per_24h: ENVELOPE_V0.maxOnboardsPer24h,
      },
      intermediate_scores: {
        rolling_24h_count: onboardCount24h,
      },
      decision_rationale: `Gate floor passed but ${String(onboardCount24h)} onboards already in trailing 24h (max ${String(ENVELOPE_V0.maxOnboardsPer24h)}). Deferring to next cycle.`,
      dissenting_considerations: "",
      model_id: "",
      prompt_hash: "",
    };
    const traceId = await events.emit({
      type: "reasoning.trace",
      body: trace,
      parentIds: [genesisId],
    });
    const body: OnboardDecisionBody = {
      market_id: candidate.market_id,
      inputs_hash: asSha256Hex(inputsHash(candidate)),
      trace_hash: traceId,
      decision: "flag_for_human_review",
      ltv_max_bps: 0,
      cap_initial_usdc: "0",
      rate_alpha: "0",
      rate_beta: "0",
      rate_gamma: "0",
      rate_tau_gap_days: "0",
      timestamp_ms: nowMs,
      gate_results: verdict.results.map((r) => ({ gate: r.gate, pass: r.pass })),
    };
    const decisionId = await events.emit({
      type: "loop.onboard_decision",
      body,
      parentIds: [genesisId, traceId],
    });
    return {
      market_id: candidate.market_id,
      gate_verdict: verdict,
      reasoning: null,
      trace,
      emitted: { trace_id: traceId, decision_id: decisionId },
    };
  }

  // 5. Reason above the floor.
  const reasoning = reason({ candidate, judge: judgeOut, exposure });

  const trace: ReasoningTraceBody = {
    subject_event_id: asSha256Hex("0".repeat(64)), // re-stamped post-emit
    subject_event_type: "loop.onboard_decision",
    inputs_summary: {
      market_id: candidate.market_id,
      depth_5pct_usdc: candidate.depth_5pct_usdc,
      vol_7d: candidate.vol_7d.toFixed(6),
      age_days: candidate.age_days,
      tags: candidate.tags.join(","),
      text_score: reasoning.intermediate_scores["llm_score"] ?? 0,
    },
    intermediate_scores: reasoning.intermediate_scores,
    decision_rationale: reasoning.rationale,
    dissenting_considerations: reasoning.dissent,
    model_id: reasoning.model_id,
    prompt_hash: reasoning.prompt_hash,
  };
  const traceId = await events.emit({
    type: "reasoning.trace",
    body: trace,
    parentIds: [genesisId],
  });

  const body: OnboardDecisionBody = {
    market_id: candidate.market_id,
    inputs_hash: asSha256Hex(inputsHash(candidate)),
    trace_hash: traceId,
    decision: reasoning.decision,
    ltv_max_bps: reasoning.ltv_max_bps,
    cap_initial_usdc: reasoning.cap_initial_usdc,
    rate_alpha:
      "alpha" in reasoning.rate_params ? reasoning.rate_params.alpha.toFixed(6) : "0",
    rate_beta:
      "beta" in reasoning.rate_params ? reasoning.rate_params.beta.toFixed(6) : "0",
    rate_gamma:
      "gamma" in reasoning.rate_params ? reasoning.rate_params.gamma.toFixed(6) : "0",
    rate_tau_gap_days:
      "tau_gap_days" in reasoning.rate_params
        ? reasoning.rate_params.tau_gap_days.toFixed(6)
        : "0",
    timestamp_ms: nowMs,
    gate_results: verdict.results.map((r) => ({ gate: r.gate, pass: r.pass })),
  };
  const decisionId = await events.emit({
    type: "loop.onboard_decision",
    body,
    parentIds: [genesisId, traceId],
  });

  if (reasoning.decision === "onboard") {
    window.recordOnboard(nowMs);
  }

  return {
    market_id: candidate.market_id,
    gate_verdict: verdict,
    reasoning,
    trace,
    emitted: { trace_id: traceId, decision_id: decisionId },
  };
}

export function createOnboardingLoop(args: OnboardingLoopArgs): ReasoningLoop {
  const tickMs = (args.tickSeconds ?? DEFAULT_TICK_SECONDS) * 1_000;
  const sleep = args.sleepMs ?? realSleep;
  const judge = args.judge ?? stubDeterministicJudge;
  const window = new OnboardWindow();
  let stopping = false;
  let inFlight: Promise<void> = Promise.resolve();
  let lastTickAt: number | null = null;

  const runTick = async (): Promise<void> => {
    try {
      const candidates = await args.fetchCandidates();
      if (candidates.length === 0) {
        lastTickAt = args.ctx.clock.nowMs();
        return;
      }
      const exposure = await args.fetchExposure();
      for (const candidate of candidates) {
        if (stopping) return;
        try {
          await processCandidate({
            candidate,
            events: args.ctx.events,
            genesisId: args.ctx.genesisId,
            clock: args.ctx.clock,
            judge,
            exposure,
            window,
          });
        } catch (err: unknown) {
          // eslint-disable-next-line no-console
          console.warn(
            `vanta/onboarding: candidate ${candidate.market_id} failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    } catch (err: unknown) {
      // eslint-disable-next-line no-console
      console.warn(
        `vanta/onboarding: tick failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    lastTickAt = args.ctx.clock.nowMs();
  };

  const start = (): void => {
    void (async () => {
      while (!stopping) {
        inFlight = runTick();
        await inFlight;
        if (stopping) return;
        await sleep(tickMs);
      }
    })();
  };

  const stop = async (): Promise<void> => {
    stopping = true;
    await inFlight;
  };

  return {
    name: "onboarding",
    start,
    stop,
    runTick,
    lastTickAtMs: () => lastTickAt,
    tickIntervalMs: tickMs,
  };
}
