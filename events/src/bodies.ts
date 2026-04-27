/**
 * Body interfaces per event type (spec §1.2, §3).
 *
 * Full bodies: `tee.attestation`, `constitutional.genesis`,
 * `treasury.inflow`, and the Week-2 pledge/mark/feed-health set
 * (`loan.pledge`, `loan.mark`, `loan.pledge_revoked`,
 * `loan.mark_revoked`, `op.mark_gap`, `op.mark_sparse`). Remaining
 * bodies are typed stubs (spec §9 — full shapes will be added when
 * defined). Every stub still carries typed fields; never
 * `Record<string, unknown>`.
 *
 * The TypeScript interfaces here structurally correspond to the
 * `bodySchemas` zod objects in `schemas.ts` (spec §D12). A type-only
 * assertion file should hold them in lockstep.
 */

import type { Sha256Hex, SigningPubKeyHex } from "@vanta/tee";

/** 0x-prefixed lowercase 20-byte Ethereum address, 42 chars total. */
export type EthAddressHex = `0x${string}`;

/**
 * `tee.attestation` — first event in the chain, binds the enclave's
 * signing pubkey to the KMS-minted attestation JWT. Fields reflect
 * TEE-SPEC §1.3 attestation bundle surface.
 */
export interface TeeAttestationBody {
  readonly signingPubKey: SigningPubKeyHex;
  readonly kmsPublicKeyHash: Sha256Hex;
  readonly attestationJwtHash: Sha256Hex;
  readonly audience: string;
  readonly enclaveIdentityHash: Sha256Hex;
  readonly degraded: boolean;
  readonly bootedAt: number;
}

/**
 * `constitutional.genesis` — the root of governance (BM1 §3.4; V7 §1 I5).
 * `constitutionHash` is the sha256 of the canonical constitution bytes
 * and MUST match the content pinned on-chain.
 */
export interface ConstitutionalGenesisBody {
  readonly constitutionHash: Sha256Hex;
  readonly constitutionUri: string;
  readonly stewardAddrs: readonly EthAddressHex[];
  readonly quorum: number;
}

/**
 * `treasury.inflow` — a credited deposit to the treasury. Monetary
 * amounts are decimal-digit strings (I-EV-8); `txHash` is chain-native
 * hex.
 */
export interface TreasuryInflowBody {
  readonly txHash: Sha256Hex;
  readonly chainId: number;
  readonly asset: string;
  readonly amount: string;
  readonly fromAddr: EthAddressHex;
  readonly toAddr: EthAddressHex;
  readonly blockNumber: number;
}

export interface TreasuryOutflowBody {
  readonly txHash: Sha256Hex;
  readonly chainId: number;
  readonly asset: string;
  readonly amount: string;
  readonly toAddr: EthAddressHex;
}

/**
 * `loan.origination` — post-image of a confirmed `LoanBook.originate(...)`
 * tx on Base Sepolia. The event is signed AFTER the tx reaches
 * confirmation depth >= 2; a crash mid-flight leaves no phantom
 * origination because the event isn't persisted until the tx is
 * confirmed.
 *
 * I-OR-3' (post-image): `paramsHash` MUST equal
 *   `keccak256(abi.encode(borrower, principal, haircutBps, maturityTs))`,
 * matching the value stamped on-chain by `LoanBook.originate`. The
 * verifier (CLI) cross-checks `LoanBook.loans(loanId).paramsHash`
 * against this field per I-OR-2.
 *
 * Field types match the on-chain `LoanBook.Loan` struct exactly:
 *   - principal: USDC wei (6 decimals), uint256 → decimal string
 *   - haircut_bps: uint32 (matches `Loan.haircutBps`; 0..10000 enforced
 *     at the schema layer)
 *   - maturity_ts_unix: uint64 unix seconds (must be > 0)
 */
export interface LoanOriginationBody {
  readonly loan_id: Sha256Hex;
  readonly borrower: EthAddressHex;
  readonly principal: string;
  readonly haircut_bps: number;
  readonly maturity_ts_unix: number;
  readonly attestation_hash: Sha256Hex;
  readonly tx_hash: Sha256Hex;
  readonly block_number: number;
  readonly block_hash: Sha256Hex;
  readonly params_hash: Sha256Hex;
}

export interface LoanSettlementBody {
  readonly loanId: Sha256Hex;
  readonly amount: string;
  readonly borrowerAddr: EthAddressHex;
}

export interface LoanLiquidationBody {
  readonly loanId: Sha256Hex;
  readonly amount: string;
  readonly borrowerAddr: EthAddressHex;
  readonly reason: string;
}

// ---------------- Week 2 pledge / mark / feed-health bodies ----------------

/**
 * `loan.pledge` — signed after the Amoy Gnosis Safe proxy successfully
 * calls `CTF.safeTransferFrom(proxy, vault, positionId, amount, "0x")`
 * and the emitting log is seen at confirmation depth ≥ 5 (spec-pinned
 * finality-policy choice; Amoy Heimdall v2 reorgs cap at 2 blocks —
 * see canonical-reference.md §1 "Finality policy"). `block_hash` is
 * load-bearing for I-PL-6: the watchdog re-reads the cited block at
 * depth ≥ 12 and emits `loan.pledge_revoked` if it disappears.
 *
 * Field shapes reflect canonical-reference.md §2 + invariants
 * I-PL-3 / I-PL-5 / I-PL-6. Amounts and position ids are uint256; we
 * carry them as decimal-digit strings per I-EV-8.
 */
export interface LoanPledgeBody {
  readonly loan_id: Sha256Hex;
  readonly borrower_proxy: EthAddressHex;
  readonly position_id: string;
  readonly amount: string;
  readonly vault_address: EthAddressHex;
  readonly tx_hash: Sha256Hex;
  readonly block_number: number;
  readonly block_hash: Sha256Hex;
  readonly log_index: number;
  readonly confirmation_depth: number;
  readonly condition_id: Sha256Hex;
}

/**
 * `loan.mark` — a 30-minute TWAP read from a Polymarket CLOB endpoint,
 * with the source attestation bundle required by I-MK-4. TWAP is a
 * decimal string in `[0, 1]` (binary market price). The source
 * attestation embeds the CLOB hostname, the SPKI SHA-256 pin
 * (canonical-reference.md §4 pin: `0652e1f1…a3cc` as of 2026-04-24),
 * the observed HTTP status (must be 200 for a usable mark; gap events
 * carry 429/5xx), and an ETag or response digest so the exact response
 * can be re-hashed and cross-checked.
 *
 * `source_block_range` is the `[start, end]` block range containing
 * the trades aggregated into the TWAP (for cross-checking against the
 * on-chain CTF state per I-PL-7).
 */
export interface LoanMarkBody {
  readonly loan_id: Sha256Hex;
  readonly token_id: string;
  readonly condition_id: Sha256Hex;
  readonly window_start_unix: number;
  readonly window_end_unix: number;
  readonly twap: string;
  readonly trade_count: number;
  readonly source_block_range: readonly [number, number];
  readonly source_attestation: {
    readonly clob_hostname: string;
    readonly tls_spki_sha256: string;
    readonly http_status: number;
    readonly response_etag_or_digest: string;
  };
}

/**
 * `loan.pledge_revoked` — emitted by the I-PL-6 watchdog at depth ≥ 12
 * when a previously-emitted `loan.pledge`'s cited log no longer exists
 * on canonical chain (reorg / missing log / block-hash mismatch).
 * Load-bearing for the USDC release gate: treasury release depends on
 * watchdog depth, not emit depth.
 */
export interface LoanPledgeRevokedBody {
  readonly original_pledge_id: Sha256Hex;
  readonly reason: "block_reorg" | "log_missing" | "block_hash_mismatch";
  readonly watchdog_depth: number;
  readonly observed_at_block: number;
}

/**
 * `loan.mark_revoked` — I-MK-5 symmetric to I-PL-6 but for a cited
 * trade log on the CLOB-referenced on-chain settlement. Emitted by the
 * depth-12 watchdog; liquidation decisions gate on watchdog depth, not
 * emit depth.
 */
export interface LoanMarkRevokedBody {
  readonly original_mark_id: Sha256Hex;
  readonly reason: "block_reorg" | "log_missing" | "block_hash_mismatch";
  readonly watchdog_depth: number;
  readonly observed_at_block: number;
}

/**
 * `op.mark_gap` — feed-health event emitted on the first CLOB failure
 * (HTTP 429 or 5xx per I-MK-2; `http_status: 0` signals a transport
 * error / connection refused). Affected markets are quarantined until
 * a fresh `200` clears. `affected_condition_ids` is non-empty because
 * emitting a gap with zero affected markets would be meaningless.
 */
export interface OpMarkGapBody {
  readonly clob_hostname: string;
  readonly http_status: number;
  readonly first_failure_unix: number;
  readonly duration_seconds: number;
  readonly affected_condition_ids: readonly Sha256Hex[];
}

/**
 * `op.mark_sparse` — feed-health event emitted when a TWAP window
 * fails I-MK-3: too few trades, coverage gap > 5 min, disagreement
 * against the server-side `/prices-history` cross-check, or a single
 * trade dominating > 50% of window notional. Blocks the window from
 * being used for liquidation decisions. `aggregate_notional_usdc` is a
 * decimal string (USDC has 6 decimals; caller is responsible for fixed
 * rounding — can be `"0"`).
 */
export interface OpMarkSparseBody {
  readonly condition_id: Sha256Hex;
  readonly token_id: string;
  readonly window_start_unix: number;
  readonly window_end_unix: number;
  readonly reason:
    | "insufficient_trades"
    | "coverage_gap"
    | "cross_check_disagreement"
    | "single_trade_dominance";
  readonly trade_count: number;
  readonly aggregate_notional_usdc: string;
}

/**
 * `op.inference` — audit record for a single LLM call made by the
 * runtime, the wizard, the population bots, or the model loop. Signed
 * after the response returns (or after a hard error is finalised) so
 * the call's metadata is part of the immutable event log.
 *
 * Privacy / size discipline:
 *
 *   - `request_canonical_hash` is sha256 of the RFC-8785 canonical
 *     bytes of the inference request body (system + messages + sampling
 *     params). Replays of the same request produce the same hash.
 *   - `response_text_hash` is sha256 of the utf-8 bytes of the response
 *     text only — token-usage and provider metadata are NOT hashed (so
 *     a non-deterministic response from the same provider for the same
 *     hash can still be cross-checked).
 *   - `response_text_excerpt` is the first 4096 characters of the
 *     response, inline so the log is human-readable without the blob.
 *   - `request_blob_uri` / `response_blob_uri` carry the persistence
 *     pointer (`file://` for local dev, `walrus://` / `https://` for
 *     hosted). Empty string when the runtime has not persisted the
 *     full body — the hash is still binding.
 *
 * `bot_handle` is non-empty iff `role === "population_bot"`; the schema
 * enforces this so a wizard call can't masquerade as a bot.
 */
export interface OpInferenceBody {
  readonly inference_id: Sha256Hex;
  readonly role:
    | "researcher"
    | "evaluator"
    | "adversary"
    | "wizard"
    | "population_bot";
  readonly bot_handle: string;
  readonly provider: "anthropic" | "openai" | "google";
  readonly model: string;
  readonly request_canonical_hash: Sha256Hex;
  readonly response_text_hash: Sha256Hex;
  readonly response_text_excerpt: string;
  readonly request_blob_uri: string;
  readonly response_blob_uri: string;
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly latency_ms: number;
  readonly started_at_unix_ms: number;
}

// -------------------- Phase 8/9: reasoning loop bodies ----------------------

/**
 * `reasoning.trace` — sibling event that carries the chain-of-thought
 * for any primary loop / onboarding event. Pinned via `trace_hash` on
 * the primary so a verifier can pair them. Plain-text rationale + dissent
 * are capped at the schema layer; the inputs/scores blocks are open
 * `Record<string, …>` because the loop authors decide what to log.
 *
 * Subject id may be the all-zero hex placeholder when the trace is
 * emitted before its primary (the loops emit trace first, then primary,
 * so the subject id can only be back-stamped if needed).
 */
export interface ReasoningTraceBody {
  readonly subject_event_id: Sha256Hex;
  readonly subject_event_type: string;
  readonly inputs_summary: Readonly<Record<string, string | number>>;
  readonly intermediate_scores: Readonly<Record<string, number>>;
  readonly decision_rationale: string;
  readonly dissenting_considerations: string;
  readonly model_id: string;
  readonly prompt_hash: string;
}

/** `loop.credit_tick` — paper §7 Credit loop primary event. */
export interface LoopCreditTickBody {
  readonly loan_id: Sha256Hex;
  readonly collateral_value_usdc: string;
  readonly ltv_current_bps: number;
  readonly trace_hash: Sha256Hex;
  readonly flag: "ok" | "watch" | "freeze_request";
  readonly best_bid: string;
  readonly twap_30min: string;
  readonly depth_5pct_usdc: string;
  readonly time_to_resolution_seconds: number;
  readonly dispute_30d_count: number;
}

/**
 * `loop.calibration_proposal` — paper §7 Model loop. NOT self-actuating:
 * proposal flows to the 4-of-7 lender multisig with a 7-day timelock
 * (paper §11 T8). Field shapes mirror @vanta/runtime/loops/types.
 */
export interface LoopCalibrationProposalBody {
  readonly proposal_id: Sha256Hex;
  readonly proposed_alpha: string;
  readonly proposed_beta: string;
  readonly proposed_gamma: string;
  readonly proposed_tau_gap_days: string;
  readonly replay_dataset_hash: Sha256Hex;
  readonly realized_lgd_bps: number;
  readonly predicted_lgd_bps: number;
  readonly error_bps: number;
  readonly timelock_expires_at_unix_ms: number;
  readonly trace_hash: Sha256Hex;
}

/**
 * `loop.onboard_decision` — paper §6 onboarding decision. Decisions
 * fall into three buckets: `onboard`, `reject`, `flag_for_human_review`.
 * Cap and LTV cap are zero on rejects/flags. Rate params reflect what
 * the agent's reasoning would have proposed (zero on rejects).
 */
export interface LoopOnboardDecisionBody {
  readonly market_id: Sha256Hex;
  readonly inputs_hash: Sha256Hex;
  readonly trace_hash: Sha256Hex;
  readonly decision: "onboard" | "reject" | "flag_for_human_review";
  readonly ltv_max_bps: number;
  readonly cap_initial_usdc: string;
  readonly rate_alpha: string;
  readonly rate_beta: string;
  readonly rate_gamma: string;
  readonly rate_tau_gap_days: string;
  readonly timestamp_ms: number;
  readonly gate_results: ReadonlyArray<{
    readonly gate: string;
    readonly pass: boolean;
  }>;
}

/** `op.treasury_alert` — paper §7 Operational loop runway alert. */
export interface OpTreasuryAlertBody {
  readonly alert_id: Sha256Hex;
  readonly treasury_balance_usdc: string;
  readonly runway_days: number;
  readonly threshold_runway_days: number;
  readonly severity: "warning" | "critical";
  readonly trace_hash: Sha256Hex;
}

/** `op.operational_anomaly` — gas / inference / oracle / RPC anomaly. */
export interface OpOperationalAnomalyBody {
  readonly anomaly_id: Sha256Hex;
  readonly kind:
    | "gas_spike"
    | "inference_cost_spike"
    | "oracle_read_failure"
    | "rpc_unhealthy";
  readonly value: string;
  readonly baseline: string;
  readonly detail: string;
  readonly trace_hash: Sha256Hex;
}
