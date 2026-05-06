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

// ----------------------- v3 trading-loop bodies ---------------------------
//
// Every v3 body carries `agent_id` so fleet-host consumers can filter the
// log per-VANTA. agent_id matches AgentRegistry.agentId — sequential from
// 0, never reused. Probabilities are encoded as centibps (0..1_000_000 →
// 0%..100% with 4-decimal precision) for beliefs/mids; bps (0..10_000)
// for confidences and on-chain prices that match contract `uint32`
// fields. Gap can be signed because the agent's belief may sit above OR
// below the market mid — `gap_bps` is a signed integer in [-10_000,
// 10_000].

/**
 * `trade.decision` — the trading loop's decision event for a single
 * market in a single tick. Three actions: `enter` (open a new position),
 * `hold` (no change), `exit` (close an existing position). `side` is
 * meaningful only for `enter` (and the position's recorded side for
 * `exit`). `position_id` is the all-zero hex placeholder for `enter`
 * (the runtime mints it next when calling `PositionBook.open`) and the
 * existing position id for `hold`/`exit`.
 *
 * `trace_hash` pins the paired `reasoning.trace` event; `belief_event_id`
 * pins the most recent `belief.updated` event the loop consumed when
 * making this decision (so a verifier can walk back to the LLM call).
 */
export interface TradeDecisionBody {
  readonly agent_id: number;
  readonly market_id: Sha256Hex;
  readonly action: "enter" | "hold" | "exit";
  readonly side: "yes" | "no";
  readonly size_usdc6: string;
  readonly belief_centibps: number;
  readonly confidence_bps: number;
  readonly mid_centibps: number;
  readonly gap_bps: number;
  readonly position_id: Sha256Hex;
  readonly trace_hash: Sha256Hex;
  readonly belief_event_id: Sha256Hex;
}

/**
 * `trade.executed` — post-image of a confirmed `PositionBook.open(...)`
 * tx. Field shapes match the on-chain `Position` struct: `size_usdc6` is
 * the cost basis, `entry_price_bps` is uint32 in [1, 9999] (matches the
 * contract's strict-inequality bounds — neither 0 nor 1.0 is a sensible
 * binary entry price). `tx_hash` and `block_number` cite the chain
 * record; `attestation_hash` is the off-chain decision-event commitment.
 */
export interface TradeExecutedBody {
  readonly agent_id: number;
  readonly position_id: Sha256Hex;
  readonly market_id: Sha256Hex;
  readonly side: "yes" | "no";
  readonly size_usdc6: string;
  readonly entry_price_bps: number;
  readonly tx_hash: Sha256Hex;
  readonly block_number: number;
  readonly block_hash: Sha256Hex;
  readonly attestation_hash: Sha256Hex;
}

/**
 * `trade.closed` — post-image of a confirmed `PositionBook.close(...)`
 * tx. `pnl_usdc6` is signed (the agent can lose more than nothing —
 * USDC is non-negative on chain but the realised PnL may be negative;
 * carried as a decimal string with optional leading `-`). `holding_seconds`
 * is `closed_at - opened_at` from the contract's recorded timestamps.
 */
export interface TradeClosedBody {
  readonly agent_id: number;
  readonly position_id: Sha256Hex;
  readonly exit_price_bps: number;
  readonly proceeds_usdc6: string;
  readonly cost_basis_usdc6: string;
  readonly pnl_usdc6: string;
  readonly holding_seconds: number;
  readonly tx_hash: Sha256Hex;
  readonly block_number: number;
  readonly block_hash: Sha256Hex;
  readonly attestation_hash: Sha256Hex;
}

/**
 * `pool.deposit` — confirmed ERC-4626 deposit into an `AgentPoolVault`.
 * `share_price_usdc6_per_share_e18` is the share price at deposit
 * scaled to 1e18 (so a price of 1.0 USDC/share is `10**18`); this keeps
 * the field a non-negative integer string instead of a fraction.
 */
export interface PoolDepositBody {
  readonly agent_id: number;
  readonly depositor_addr: EthAddressHex;
  readonly usdc6_amount: string;
  readonly shares_minted: string;
  readonly share_price_usdc6_per_share_e18: string;
  readonly tx_hash: Sha256Hex;
  readonly block_number: number;
}

/**
 * `pool.withdraw` — confirmed ERC-4626 redeem from an `AgentPoolVault`.
 */
export interface PoolWithdrawBody {
  readonly agent_id: number;
  readonly withdrawer_addr: EthAddressHex;
  readonly shares_redeemed: string;
  readonly usdc6_returned: string;
  readonly share_price_usdc6_per_share_e18: string;
  readonly tx_hash: Sha256Hex;
  readonly block_number: number;
}

/**
 * `belief.updated` — agent's structured-output belief about a single
 * market, signed at the moment the belief is computed (not when the
 * trade executes). `inference_event_id` pins the `op.inference` event
 * that produced the belief (so a verifier can walk back to the LLM
 * prompt/response). `mid_centibps` is the market mid the loop saw in
 * the same tick — signed `gap_bps` is a derived field, retained on
 * the event so consumers don't need both events to compute the mismatch.
 */
export interface BeliefUpdatedBody {
  readonly agent_id: number;
  readonly market_id: Sha256Hex;
  readonly belief_centibps: number;
  readonly confidence_bps: number;
  readonly mid_centibps: number;
  readonly gap_bps: number;
  readonly inference_event_id: Sha256Hex;
}

/**
 * `visitor.island_entered` — emitted by the bridge plugin when a
 * Minecraft visitor steps onto an island's interact pad. The runtime
 * uses this to scope subsequent `/back N` or `/deposit N` chat-bridge
 * commands to that VANTA's pool. `visitor_handle` is the Bukkit player
 * name; `world_name` distinguishes overworld / nether / custom.
 */
export interface VisitorIslandEnteredBody {
  readonly agent_id: number;
  readonly visitor_handle: string;
  readonly world_name: string;
  readonly position_x: number;
  readonly position_y: number;
  readonly position_z: number;
}

/**
 * `npc.thought` — one signed opinion from a single in-world NPC about
 * a market the agent is currently watching. Each NPC has a fixed
 * deterministic identity (`npc_id`) and a persona that biases its
 * reasoning style (a Cloister Scholar cites history, a Grain Merchant
 * speaks in real-economy terms, etc).
 *
 * Council step: every ~90s per (agent, market) the runtime samples
 * 2-3 NPCs from the agent's kingdom and asks each via a cheap
 * Anthropic-Haiku inference call for `(belief, confidence, thought)`
 * grounded in their persona. Each NPC's response becomes one signed
 * `npc.thought` event with parent_ids pointing at the underlying
 * `op.inference` and the `belief.updated` for the same market.
 *
 * The thought string is short (≤ 280 chars, twitter-ish) so the
 * frontend can render it inline in the chat panel without expanding.
 */
export interface NpcThoughtBody {
  readonly agent_id: number;
  readonly npc_id: string;
  readonly npc_persona: string;
  readonly npc_display_name: string;
  readonly market_id: Sha256Hex;
  readonly thought: string;
  readonly belief_centibps: number;
  readonly confidence_bps: number;
  readonly inference_event_id: Sha256Hex;
}

/**
 * `council.synthesised` — emitted when the agent has weighed N recent
 * `npc.thought` events for a market and produced a re-evaluated
 * belief. `npc_thought_event_ids` enumerates the exact thoughts that
 * were consumed, giving the audit trail "this belief move came from
 * these citizens." `prior_belief_centibps` is the belief BEFORE the
 * synthesis (from `belief.updated`); `synthesised_belief_centibps` is
 * the belief AFTER. The trading loop then uses the synthesised value
 * for its decide step.
 *
 * `rationale` is the agent's free-text explanation, capped at 4096
 * chars to match `reasoning.trace`. Auditors can replay the chain by
 * walking the parent_ids: synthesis → thoughts → underlying inference
 * calls → original belief.updated.
 */
export interface CouncilSynthesisedBody {
  readonly agent_id: number;
  readonly market_id: Sha256Hex;
  readonly npc_thought_event_ids: readonly Sha256Hex[];
  readonly prior_belief_centibps: number;
  readonly synthesised_belief_centibps: number;
  readonly delta_centibps: number;
  readonly synthesised_confidence_bps: number;
  readonly rationale: string;
  readonly inference_event_id: Sha256Hex;
}
