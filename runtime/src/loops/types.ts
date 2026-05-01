/**
 * Shared types for the three continuous reasoning loops (paper §7).
 *
 * The loops are paper-§7 load-bearing: they are what makes VANTA an
 * agent doing reasoning rather than a periodic script over hard-coded
 * gates. None of them can move funds, change formula parameters in
 * production, or onboard markets outside the §6 envelope (paper §7
 * "What the loops are not").
 *
 * `EventSink` is the abstract write surface every loop emits to. Phase 11
 * wires it to the canonical `@vanta/events` build/sign pipeline; for
 * unit/integration tests and local-dev runs it can be backed by a JSONL
 * file or in-memory sink.
 */

import type { PublicClient } from "viem";

import type { Sha256Hex } from "@vanta/tee";

/**
 * A loop's view of "now". Wall-clock by default; tests inject a fake.
 */
export interface LoopClock {
  nowMs(): number;
}

/**
 * The abstract write surface every loop emits to. Returns the event id
 * (sha256 of canonical JSON, RFC 8785). Implementations:
 *   - prod: sign with the in-enclave Ed25519 key via @vanta/events.buildAndSign
 *   - dev: write JSONL with a local-only signature
 *   - test: append to an array in memory
 *
 * `parentIds` carries the lineage — every non-genesis event must have at
 * least one parent (Invariant I-EV-4 in @vanta/events/schemas). Loop
 * events typically parent on `[genesis_id, prior_tick_id]` so the chain
 * is walkable.
 */
export interface EventSink {
  emit(args: {
    readonly type: string;
    readonly body: object;
    readonly parentIds: readonly Sha256Hex[];
  }): Promise<Sha256Hex>;
}

/**
 * Shared context every loop's `tick` receives. Built by the runtime at
 * boot from the bootstrap wiring.
 */
export interface LoopContext {
  /** Base Sepolia / Base mainnet RPC client. LpVault, LoanBook, AnchorRegistry live here. */
  readonly base: PublicClient;
  /** Polygon Amoy / Polygon mainnet RPC client. VantaVault and Polymarket CTF live here. */
  readonly amoy: PublicClient;
  /** Append-only signed event log. */
  readonly events: EventSink;
  /** Wall-clock or fake. */
  readonly clock: LoopClock;
  /** Genesis event id — every event in the log parents transitively to this. */
  readonly genesisId: Sha256Hex;
}

/**
 * The decision rationale a loop produces alongside its primary event.
 * Pinned as a sibling `reasoning.trace` event so the chain-of-thought
 * is auditable without bloating the primary event.
 */
export interface ReasoningTraceBody {
  /** Sibling primary event id this trace explains. */
  readonly subject_event_id: Sha256Hex;
  /** Subject event type, for fast filtering. */
  readonly subject_event_type: string;
  /**
   * Compact structured snapshot of the inputs the loop saw on this
   * tick. Numeric values are stringified to keep canonical JSON stable
   * across platforms.
   */
  readonly inputs_summary: Readonly<Record<string, string | number>>;
  /** Intermediate scores the agent computed on the way to its decision. */
  readonly intermediate_scores: Readonly<Record<string, number>>;
  /** Plain-text rationale. Capped at 4096 chars in the canonical schema. */
  readonly decision_rationale: string;
  /** Plain-text dissent considerations. Capped at 2048 chars. */
  readonly dissenting_considerations: string;
  /** LLM model id used for any inference within this trace, or empty if no LLM. */
  readonly model_id: string;
  /** sha256 of the canonical prompt bytes used. Empty if no LLM call. */
  readonly prompt_hash: string;
}

/** Credit-loop tick flag (paper §7 credit loop description). */
export type CreditFlag = "ok" | "watch" | "freeze_request";

export interface CreditTickBody {
  readonly loan_id: Sha256Hex;
  /** V = p * (1 - h_applied) * N — uint256 decimal as string. */
  readonly collateral_value_usdc: string;
  readonly ltv_current_bps: number;
  /** sibling reasoning.trace event id */
  readonly trace_hash: Sha256Hex;
  readonly flag: CreditFlag;
  readonly best_bid: string;
  readonly twap_30min: string;
  readonly depth_5pct_usdc: string;
  readonly time_to_resolution_seconds: number;
  readonly dispute_30d_count: number;
}

export interface CalibrationProposalBody {
  readonly proposal_id: Sha256Hex;
  readonly proposed_alpha: string;
  readonly proposed_beta: string;
  readonly proposed_gamma: string;
  readonly proposed_tau_gap_days: string;
  /** sha256 of the public dataset slice the replay was run against. */
  readonly replay_dataset_hash: Sha256Hex;
  /** Realized loss-given-default in bps from the replay. */
  readonly realized_lgd_bps: number;
  /** Formula's pre-loss prediction in bps. */
  readonly predicted_lgd_bps: number;
  /** abs(realized - predicted) in bps. The trigger metric. */
  readonly error_bps: number;
  /** Multisig timelock expiry — proposal cannot apply before this. */
  readonly timelock_expires_at_unix_ms: number;
  readonly trace_hash: Sha256Hex;
}

export interface TreasuryAlertBody {
  readonly alert_id: Sha256Hex;
  readonly treasury_balance_usdc: string;
  readonly runway_days: number;
  readonly threshold_runway_days: number;
  readonly severity: "warning" | "critical";
  readonly trace_hash: Sha256Hex;
}

export interface OperationalAnomalyBody {
  readonly anomaly_id: Sha256Hex;
  readonly kind:
    | "gas_spike"
    | "inference_cost_spike"
    | "oracle_read_failure"
    | "rpc_unhealthy";
  /** Observed value, decimal-string. */
  readonly value: string;
  /** Baseline (e.g. 95th percentile of trailing 30 days), decimal-string. */
  readonly baseline: string;
  /** Short detail string. */
  readonly detail: string;
  readonly trace_hash: Sha256Hex;
}

/**
 * A loop with start/stop semantics + a test-only single-tick pump.
 * Mirrors the shape of v1's `MarkLoop` for parity with the runtime
 * wiring code.
 */
export interface ReasoningLoop {
  readonly name: string;
  readonly start: () => void;
  readonly stop: () => Promise<void>;
  /** For tests: run one tick synchronously. */
  readonly runTick: () => Promise<void>;
}
