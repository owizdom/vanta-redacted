/**
 * Onboarding cycle types — paper §6.
 *
 * The cycle has two layers (paper §6 "Two layers"):
 *   - **Gate floor**: 7 hard contract-enforced gates (Table 1). Failed
 *     gate = auto-reject regardless of agent reasoning.
 *   - **Agent reasoning above floor**: synthesizes resolution-criteria
 *     text, monitors depth-shape evolution, flags cluster correlations.
 *     Outputs decision + cap_initial_usdc (≤ $25k probation) + ltv_max_bps.
 *
 * Both layers emit signed events:
 *   - `loop.onboard_decision` (primary, includes `trace_hash`)
 *   - `reasoning.trace` (sibling, full chain-of-thought)
 *
 * The contract honors `loop.onboard_decision` only if signature verifies,
 * attestation is fresh, `block.timestamp - timestamp < 5min`, and the
 * envelope bounds (3/24h, ≤$25k probation) are satisfied — paper §6
 * "Signed event schema" + "Safety floor."
 */

import type { Sha256Hex } from "@vanta/tee";

import type { ReasoningTraceBody } from "../loops/types.js";

/**
 * The seven inputs the runtime collects per candidate market each
 * onboarding cycle (paper §6 input list). Numeric inputs feed the gate
 * floor; text inputs feed the LLM judge + agent reasoning.
 */
export interface CandidateInputs {
  /** Polymarket condition id, branded for log binding. */
  readonly market_id: Sha256Hex;
  /** USDC notional needed to move best-bid by 5%, uint256 decimal wei. */
  readonly depth_5pct_usdc: string;
  /** Count of UMA disputes against this resolver in the last 30 days. */
  readonly dispute_30d_count: number;
  /** Days since market creation. */
  readonly age_days: number;
  /** 7-day realized volatility of mid-price (price units). */
  readonly vol_7d: number;
  /** keccak256 of the full resolution-criteria text. */
  readonly text_hash: Sha256Hex;
  /** Verbatim resolution-criteria text — fed to the LLM judge. */
  readonly text: string;
  /** Pre-registered correlation tags (must be subset of `TAG_REGISTRY_V0`). */
  readonly tags: readonly string[];
  /** UMA resolver address — must be in the whitelist. */
  readonly resolver_address: `0x${string}`;
  /** Polymarket standard-template family hash, or null if no match. */
  readonly nearest_template_hash: Sha256Hex | null;
  /** Hamming distance from the candidate text to the nearest template. */
  readonly text_template_hamming: number;
  /**
   * Trailing 30 days of depth_5pct snapshots, oldest-first. Used by the
   * agent's depth-shape-evolution analysis above the floor.
   */
  readonly depth_history_30d: readonly string[];
}

/** Result of evaluating one gate. */
export interface GateResult {
  readonly gate: string;
  readonly pass: boolean;
  readonly observed: string;
  readonly threshold: string;
  readonly reason: string;
}

/** Gate-floor verdict for a candidate. */
export interface GateFloorVerdict {
  readonly all_pass: boolean;
  readonly results: readonly GateResult[];
}

/**
 * The agent's reasoning above the gate floor. Produced only when the
 * floor passes. Outputs feed the OnboardEvent body and the trace.
 */
export interface AgentReasoningOutput {
  readonly decision: "onboard" | "reject" | "flag_for_human_review";
  /** Per-market borrow cap during 7-day probation, USDC wei (≤ $25k). */
  readonly cap_initial_usdc: string;
  /** Per-market LTV ceiling, bps. Bounded above by 50% per LOAN_INVARIANTS_V0. */
  readonly ltv_max_bps: number;
  /** Optional rate parameter overrides; empty object when using calibration baselines. */
  readonly rate_params:
    | Readonly<{ alpha: number; beta: number; gamma: number; tau_gap_days: number }>
    | Readonly<Record<string, never>>;
  /** Inputs to the trace's `intermediate_scores`. */
  readonly intermediate_scores: Readonly<Record<string, number>>;
  /** Plain-text rationale (≤ 4096 chars). */
  readonly rationale: string;
  /** Plain-text dissent (≤ 2048 chars). */
  readonly dissent: string;
  /** LLM model id (empty when reasoning was deterministic). */
  readonly model_id: string;
  /** sha256 of the canonical prompt bytes. */
  readonly prompt_hash: Sha256Hex;
}

/**
 * Body of the primary onboarding event. Mirrors the `OnboardEvent`
 * schema in paper §6.
 */
export interface OnboardDecisionBody {
  readonly market_id: Sha256Hex;
  /** keccak256 over canonical inputs (`depth || disputes || age || vol || text_hash || tags`). */
  readonly inputs_hash: Sha256Hex;
  /** sibling reasoning.trace event id. */
  readonly trace_hash: Sha256Hex;
  readonly decision: "onboard" | "reject" | "flag_for_human_review";
  readonly ltv_max_bps: number;
  readonly cap_initial_usdc: string;
  readonly rate_alpha: string;
  readonly rate_beta: string;
  readonly rate_gamma: string;
  readonly rate_tau_gap_days: string;
  readonly timestamp_ms: number;
  /**
   * Subset of gates and their pass/fail — published verbatim for
   * verifier audit. The full inputs are committed via `inputs_hash`.
   */
  readonly gate_results: ReadonlyArray<{
    readonly gate: string;
    readonly pass: boolean;
  }>;
}

/** What the onboarding tick observed plus what it decided. */
export interface OnboardingTickResult {
  readonly market_id: Sha256Hex;
  readonly gate_verdict: GateFloorVerdict;
  readonly reasoning: AgentReasoningOutput | null;
  readonly trace: ReasoningTraceBody;
  readonly emitted: {
    readonly trace_id: Sha256Hex;
    readonly decision_id: Sha256Hex;
  };
}
