/**
 * Zod schemas for VANTA events (spec §1, §3).
 *
 * - Discriminated union over `type` (spec §D3).
 * - `.strict()` at envelope AND body levels; no unknown fields anywhere.
 * - Two derived schemas (spec §D11):
 *     `envelopePermissiveSchema` — permits id==="" and signature==="";
 *        used by `buildAndSign` Step 2 before signing.
 *     `VantaEventSchema`         — final strict schema with id+sig filled;
 *        used by `buildAndSign` Step 6 and by `decodeEvent`.
 * - Top-level `.refine()` enforces I-EV-4 (genesis ⇔ parent_ids empty).
 * - `timestamp`/`epoch` are integer refinements (I-EV-8 style for ms).
 * - Body interfaces (`bodies.ts`) MUST structurally correspond to
 *   `bodySchemas[k]` (spec §D12).
 *
 * Week-2 additions — the pledge/mark/feed-health bodies (`loan.pledge`,
 * `loan.mark`, `loan.pledge_revoked`, `loan.mark_revoked`,
 * `op.mark_gap`, `op.mark_sparse`) carry invariant-level refinements
 * (confirmation depth ≥ 5, watchdog depth ≥ 12, TWAP `http_status ===
 * 200`, window end > start, etc.) via `.refine(...)` with precise error
 * messages so rejection tests can match by message.
 */

import { z } from "zod";

/**
 * 64-char lowercase hex. Used for ids, attestation/kms hashes, signing
 * pubkey. We do NOT brand here; branding happens after parse in code
 * that has access to the typed brand constructor.
 */
const HEX64 = /^[0-9a-f]{64}$/;
const hex64 = z.string().regex(HEX64, "must be 64-char lowercase hex");

/** 128-char lowercase hex. Ed25519 signature as hex (64 bytes * 2). */
const HEX128 = /^[0-9a-f]{128}$/;
const hex128 = z.string().regex(HEX128, "must be 128-char lowercase hex");

/** 0x-prefixed 40-hex-char Ethereum address (lowercase preferred). */
const ETH_ADDR = /^0x[0-9a-fA-F]{40}$/;
const ethAddr = z.string().regex(ETH_ADDR, "must be 0x-prefixed 20-byte hex");

/** Decimal-only string: strictly `^\d+$` (I-EV-8). No decimals, no signs. */
const DECIMAL_STR = /^\d+$/;
const amountStr = z.string().regex(DECIMAL_STR, "must be decimal-digit string");

/**
 * uint256 decimal string: either `"0"` or a leading-non-zero decimal.
 * Used for `loan.pledge.position_id`, `loan.pledge.amount`,
 * `loan.mark.token_id`. No leading zeros on non-zero values (that would
 * let "00000" canonicalize differently from "0"). See canonical-reference
 * §3 "Position-id encoding".
 */
const UINT256_DECIMAL = /^[1-9][0-9]*$|^0$/;
const uint256DecimalStr = z
  .string()
  .regex(UINT256_DECIMAL, "must be a uint256 decimal string with no leading zeros");

/**
 * TWAP decimal string bounded in [0, 1] — binary prediction-market
 * prices. Matches `"0"`, `"0.5"`, `"0.999"`, `"1"`, `"1.0"`, `"1.00"`.
 * Rejects `"1.5"`, `"-0"`, `"1.1"`, `"01"`, anything with a sign.
 * Canonical form — canonicalize@3.0.0 preserves string bytes, so
 * there's no risk of "0.5" vs "0.50" producing different ids.
 */
const TWAP_BOUNDED_01 = /^0(\.[0-9]+)?$|^1(\.0+)?$/;
const twapBoundedStr = z
  .string()
  .regex(TWAP_BOUNDED_01, "must be a decimal string in [0, 1]");

/**
 * RFC 1123 hostname regex. Accepts `clob.polymarket.com`,
 * `data-api.polymarket.com`, single-label `localhost`. Labels are 1–63
 * chars, start/end with alphanumeric, may contain hyphens. Total length
 * cap (253) enforced by zod `.max()`. Case-insensitive.
 */
const HOSTNAME_RE =
  /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const hostnameStr = z
  .string()
  .min(1, "hostname must be non-empty")
  .max(253, "hostname must be <= 253 chars")
  .regex(HOSTNAME_RE, "must be a valid RFC 1123 hostname");

/**
 * ETag or response-digest token. Allowed chars match the HTTP ETag
 * grammar superset we actually emit: hex digest bytes (sha256 or
 * similar), word chars for opaque tokens, and the quoting + prefix
 * characters (`"`, `-`, `_`) used by common servers. Length cap guards
 * against adversarial attestations stuffing an enormous value.
 */
const ETAG_RE = /^[A-Za-z0-9_\-"]+$/;
const etagOrDigestStr = z
  .string()
  .min(1, "etag/digest must be non-empty")
  .max(128, "etag/digest must be <= 128 chars")
  .regex(ETAG_RE, "must be etag or hex-digest token");

/** Integer refinement used for `timestamp` (ms) and `epoch`. */
const integerNumber = z.number().refine((n) => Number.isInteger(n), {
  message: "must be an integer",
});

/** Non-negative integer (e.g. `log_index`, `trade_count`). */
const nonNegativeInteger = integerNumber.refine((n) => n >= 0, {
  message: "must be a non-negative integer",
});

/** Strictly positive integer (e.g. unix seconds, block numbers when nonzero). */
const positiveInteger = integerNumber.refine((n) => n > 0, {
  message: "must be a positive integer",
});

/** Tee sub-object on the envelope (spec §1.2). `tdxQuoteHash` is literal null. */
const teeInnerSchema = z
  .object({
    signingPubKey: hex64,
    kmsKeyHash: hex64,
    tdxQuoteHash: z.null(),
    attestationJwtHash: hex64,
  })
  .strict();

// ------------------- Body schemas -------------------

const teeAttestationBodySchema = z
  .object({
    signingPubKey: hex64,
    kmsPublicKeyHash: hex64,
    attestationJwtHash: hex64,
    audience: z.string(),
    enclaveIdentityHash: hex64,
    degraded: z.boolean(),
    bootedAt: integerNumber,
  })
  .strict();

const constitutionalGenesisBodySchema = z
  .object({
    constitutionHash: hex64,
    constitutionUri: z.string(),
    stewardAddrs: z.array(ethAddr).readonly(),
    quorum: integerNumber,
  })
  .strict();

const treasuryInflowBodySchema = z
  .object({
    txHash: hex64,
    chainId: integerNumber,
    asset: z.string(),
    amount: amountStr,
    fromAddr: ethAddr,
    toAddr: ethAddr,
    blockNumber: integerNumber,
  })
  .strict();

const treasuryOutflowBodySchema = z
  .object({
    txHash: hex64,
    chainId: integerNumber,
    asset: z.string(),
    amount: amountStr,
    toAddr: ethAddr,
  })
  .strict();

/**
 * `loan.origination` — post-image of a confirmed `LoanBook.originate(...)`
 * tx (I-OR-3'). Refinements:
 *   - `haircut_bps` ∈ [0, 10000] (matches contract `uint32 haircutBps`
 *     domain; ≤ 10000 keeps the haircut as a basis-points value)
 *   - `maturity_ts_unix > 0` (uint64 unix seconds; non-zero keeps the
 *     event physically meaningful)
 *   - `block_number > 0` (positive int)
 */
const HAIRCUT_BPS_MAX = 10000;
const loanOriginationBodySchema = z
  .object({
    loan_id: hex64,
    borrower: ethAddr,
    principal: amountStr,
    haircut_bps: nonNegativeInteger,
    maturity_ts_unix: positiveInteger,
    attestation_hash: hex64,
    tx_hash: hex64,
    block_number: positiveInteger,
    block_hash: hex64,
    params_hash: hex64,
  })
  .strict()
  .refine((b) => b.haircut_bps <= HAIRCUT_BPS_MAX, {
    message: `loan_origination_haircut_bps_out_of_range: must be in [0, ${String(HAIRCUT_BPS_MAX)}]`,
    path: ["haircut_bps"],
  });

const loanSettlementBodySchema = z
  .object({
    loanId: hex64,
    amount: amountStr,
    borrowerAddr: ethAddr,
  })
  .strict();

const loanLiquidationBodySchema = z
  .object({
    loanId: hex64,
    amount: amountStr,
    borrowerAddr: ethAddr,
    reason: z.string(),
  })
  .strict();

// ---------------- Week 2 bodies — pledge / mark / feed-health ----------------

/**
 * Amoy finality constant. 5 blocks (~10s) is the spec-pinned choice;
 * Amoy Heimdall v2 reorgs are capped at 2 blocks in the wild. A pledge
 * emitted below depth 5 can still be rolled back on a 2-block reorg —
 * reject at the schema layer so builders can't accidentally bypass it.
 */
const MIN_PLEDGE_CONFIRMATION_DEPTH = 5;

/**
 * Watchdog depth for I-PL-6 / I-MK-5 revocations. 12 blocks is
 * strictly greater than the emit depth; USDC release and liquidation
 * decisions gate on this depth. Enforced at the schema layer so
 * revocation events below depth 12 cannot be signed by accident.
 */
const MIN_WATCHDOG_DEPTH = 12;

/** HTTP status codes allowed for `op.mark_gap`. `0` = transport error. */
const MARK_GAP_ALLOWED_HTTP_STATUSES: readonly number[] = [
  0, 429, 500, 502, 503, 504,
];

const loanPledgeBodySchema = z
  .object({
    loan_id: hex64,
    borrower_proxy: ethAddr,
    position_id: uint256DecimalStr,
    amount: uint256DecimalStr,
    vault_address: ethAddr,
    tx_hash: hex64,
    block_number: nonNegativeInteger,
    block_hash: hex64,
    log_index: nonNegativeInteger,
    confirmation_depth: integerNumber,
    condition_id: hex64,
  })
  .strict()
  .refine((b) => b.confirmation_depth >= MIN_PLEDGE_CONFIRMATION_DEPTH, {
    message: `loan_pledge_confirmation_depth_below_min: must be >= ${String(MIN_PLEDGE_CONFIRMATION_DEPTH)}`,
    path: ["confirmation_depth"],
  });

const loanMarkSourceAttestationSchema = z
  .object({
    clob_hostname: hostnameStr,
    tls_spki_sha256: hex64,
    http_status: integerNumber,
    response_etag_or_digest: etagOrDigestStr,
  })
  .strict()
  .refine((a) => a.http_status === 200, {
    message: "loan_mark_http_status_not_200: source attestation must carry HTTP 200",
    path: ["http_status"],
  });

const loanMarkBodySchema = z
  .object({
    loan_id: hex64,
    token_id: uint256DecimalStr,
    condition_id: hex64,
    window_start_unix: positiveInteger,
    window_end_unix: positiveInteger,
    twap: twapBoundedStr,
    trade_count: nonNegativeInteger,
    source_block_range: z
      .tuple([nonNegativeInteger, nonNegativeInteger])
      .refine(([s, e]) => s <= e, {
        message: "loan_mark_source_block_range_inverted: [0] must be <= [1]",
      }),
    source_attestation: loanMarkSourceAttestationSchema,
  })
  .strict()
  .refine((b) => b.window_end_unix > b.window_start_unix, {
    message: "loan_mark_window_end_before_start: window_end_unix must be > window_start_unix",
    path: ["window_end_unix"],
  });

const loanRevocationReasonEnum = z.enum([
  "block_reorg",
  "log_missing",
  "block_hash_mismatch",
]);

const loanPledgeRevokedBodySchema = z
  .object({
    original_pledge_id: hex64,
    reason: loanRevocationReasonEnum,
    watchdog_depth: integerNumber,
    observed_at_block: nonNegativeInteger,
  })
  .strict()
  .refine((b) => b.watchdog_depth >= MIN_WATCHDOG_DEPTH, {
    message: `loan_pledge_revoked_watchdog_depth_below_min: must be >= ${String(MIN_WATCHDOG_DEPTH)}`,
    path: ["watchdog_depth"],
  });

const loanMarkRevokedBodySchema = z
  .object({
    original_mark_id: hex64,
    reason: loanRevocationReasonEnum,
    watchdog_depth: integerNumber,
    observed_at_block: nonNegativeInteger,
  })
  .strict()
  .refine((b) => b.watchdog_depth >= MIN_WATCHDOG_DEPTH, {
    message: `loan_mark_revoked_watchdog_depth_below_min: must be >= ${String(MIN_WATCHDOG_DEPTH)}`,
    path: ["watchdog_depth"],
  });

const opMarkGapBodySchema = z
  .object({
    clob_hostname: hostnameStr,
    http_status: integerNumber,
    first_failure_unix: positiveInteger,
    duration_seconds: nonNegativeInteger,
    affected_condition_ids: z
      .array(hex64)
      .min(1, "affected_condition_ids must be non-empty")
      .readonly(),
  })
  .strict()
  .refine(
    (b) => MARK_GAP_ALLOWED_HTTP_STATUSES.includes(b.http_status),
    {
      message:
        "op_mark_gap_http_status_not_allowed: http_status must be one of {0, 429, 500, 502, 503, 504}",
      path: ["http_status"],
    },
  );

const opMarkSparseBodySchema = z
  .object({
    condition_id: hex64,
    token_id: uint256DecimalStr,
    window_start_unix: positiveInteger,
    window_end_unix: positiveInteger,
    reason: z.enum([
      "insufficient_trades",
      "coverage_gap",
      "cross_check_disagreement",
      "single_trade_dominance",
    ]),
    trade_count: nonNegativeInteger,
    aggregate_notional_usdc: amountStr,
  })
  .strict()
  .refine((b) => b.window_end_unix > b.window_start_unix, {
    message:
      "op_mark_sparse_window_end_before_start: window_end_unix must be > window_start_unix",
    path: ["window_end_unix"],
  });

/**
 * `op.inference` — audit record for an LLM call (wizard / bot / model
 * loop). Inline excerpt capped at 4096 chars to keep the event log
 * bounded; full request and response live behind their respective
 * blob URIs (empty when not persisted, hash is still binding).
 *
 * Role / bot_handle pairing is enforced: the bot_handle MUST be empty
 * when the role is not `population_bot`, and MUST be non-empty when it
 * is. This prevents a non-bot inference call from being attributed to
 * a named bot, and vice-versa.
 */
const INFERENCE_EXCERPT_MAX = 4096;
const INFERENCE_BLOB_URI_MAX = 4096;
const INFERENCE_BOT_HANDLE_RE = /^[a-z0-9_-]{1,64}$/;

const inferenceBotHandleStr = z
  .string()
  .max(64, "bot_handle must be <= 64 chars");

const inferenceBlobUriStr = z
  .string()
  .max(INFERENCE_BLOB_URI_MAX, `blob_uri must be <= ${String(INFERENCE_BLOB_URI_MAX)} chars`);

const opInferenceBodySchema = z
  .object({
    inference_id: hex64,
    role: z.enum([
      "researcher",
      "evaluator",
      "adversary",
      "wizard",
      "population_bot",
    ]),
    bot_handle: inferenceBotHandleStr,
    provider: z.enum(["anthropic", "openai", "google"]),
    model: z.string().min(1, "model must be non-empty").max(128, "model must be <= 128 chars"),
    request_canonical_hash: hex64,
    response_text_hash: hex64,
    response_text_excerpt: z
      .string()
      .max(INFERENCE_EXCERPT_MAX, `response_text_excerpt must be <= ${String(INFERENCE_EXCERPT_MAX)} chars`),
    request_blob_uri: inferenceBlobUriStr,
    response_blob_uri: inferenceBlobUriStr,
    prompt_tokens: nonNegativeInteger,
    completion_tokens: nonNegativeInteger,
    latency_ms: nonNegativeInteger,
    started_at_unix_ms: positiveInteger,
  })
  .strict()
  .refine(
    (b) => {
      if (b.role === "population_bot") {
        return b.bot_handle.length > 0 && INFERENCE_BOT_HANDLE_RE.test(b.bot_handle);
      }
      return b.bot_handle.length === 0;
    },
    {
      message:
        "op_inference_bot_handle_role_mismatch: bot_handle must be a-z0-9_- iff role==='population_bot' (else empty)",
      path: ["bot_handle"],
    },
  );

// ----------------- Phase 8/9: reasoning-loop body schemas ------------------

const TRACE_RATIONALE_MAX = 4096;
const TRACE_DISSENT_MAX = 2048;

const reasoningTraceBodySchema = z
  .object({
    subject_event_id: hex64,
    subject_event_type: z.string().min(1).max(64),
    inputs_summary: z.record(z.union([z.string(), z.number()])),
    intermediate_scores: z.record(z.number()),
    decision_rationale: z
      .string()
      .max(TRACE_RATIONALE_MAX, `decision_rationale must be <= ${String(TRACE_RATIONALE_MAX)} chars`),
    dissenting_considerations: z
      .string()
      .max(TRACE_DISSENT_MAX, `dissenting_considerations must be <= ${String(TRACE_DISSENT_MAX)} chars`),
    model_id: z.string().max(128),
    prompt_hash: z.union([z.literal(""), hex64]),
  })
  .strict();

const loopCreditTickBodySchema = z
  .object({
    loan_id: hex64,
    collateral_value_usdc: amountStr,
    ltv_current_bps: nonNegativeInteger,
    trace_hash: hex64,
    flag: z.enum(["ok", "watch", "freeze_request"]),
    best_bid: twapBoundedStr,
    twap_30min: twapBoundedStr,
    depth_5pct_usdc: amountStr,
    time_to_resolution_seconds: nonNegativeInteger,
    dispute_30d_count: nonNegativeInteger,
  })
  .strict();

const loopCalibrationProposalBodySchema = z
  .object({
    proposal_id: hex64,
    proposed_alpha: z.string().min(1),
    proposed_beta: z.string().min(1),
    proposed_gamma: z.string().min(1),
    proposed_tau_gap_days: z.string().min(1),
    replay_dataset_hash: hex64,
    realized_lgd_bps: nonNegativeInteger,
    predicted_lgd_bps: nonNegativeInteger,
    error_bps: nonNegativeInteger,
    timelock_expires_at_unix_ms: positiveInteger,
    trace_hash: hex64,
  })
  .strict();

const loopOnboardDecisionBodySchema = z
  .object({
    market_id: hex64,
    inputs_hash: hex64,
    trace_hash: hex64,
    decision: z.enum(["onboard", "reject", "flag_for_human_review"]),
    ltv_max_bps: z.number().int().min(0).max(10_000),
    cap_initial_usdc: amountStr,
    rate_alpha: z.string().min(1),
    rate_beta: z.string().min(1),
    rate_gamma: z.string().min(1),
    rate_tau_gap_days: z.string().min(1),
    timestamp_ms: positiveInteger,
    gate_results: z
      .array(
        z
          .object({
            gate: z.string().min(1),
            pass: z.boolean(),
          })
          .strict(),
      )
      .readonly(),
  })
  .strict();

const opTreasuryAlertBodySchema = z
  .object({
    alert_id: hex64,
    treasury_balance_usdc: amountStr,
    runway_days: z.number().int(),
    threshold_runway_days: nonNegativeInteger,
    severity: z.enum(["warning", "critical"]),
    trace_hash: hex64,
  })
  .strict();

const opOperationalAnomalyBodySchema = z
  .object({
    anomaly_id: hex64,
    kind: z.enum([
      "gas_spike",
      "inference_cost_spike",
      "oracle_read_failure",
      "rpc_unhealthy",
    ]),
    value: z.string().min(1),
    baseline: z.string().min(1),
    detail: z.string().max(1024),
    trace_hash: hex64,
  })
  .strict();

// ----------------------- v3 trading-loop body schemas ---------------------
//
// Probabilities and prices in v3 use two units:
//   - centibps: 0..1_000_000 → 0%..100% with 4 decimal places of
//     precision. Used for `belief_centibps` and `mid_centibps`.
//   - bps: 0..10_000 → 0%..100% with 2 decimal places. Used for
//     `confidence_bps` and on-chain prices that match the contract's
//     `uint32 priceBps` fields. `entry_price_bps` is strictly bounded
//     to [1, 9999] (mirrors the contract's PriceOutOfRange revert).
//   - `gap_bps`: signed integer in [-10_000, 10_000]. Negative when the
//     agent's belief sits below the market mid.
//
// `agent_id` is `nonNegativeInteger` everywhere — AgentRegistry assigns
// agent ids sequentially from 0 and never reuses them, so the wire
// shape is the same as a `count` field.

const BELIEF_CENTIBPS_MAX = 1_000_000;
const PROB_BPS_MAX = 10_000;
const ENTRY_PRICE_BPS_MIN = 1;
const ENTRY_PRICE_BPS_MAX = 9_999;
const GAP_BPS_MIN = -10_000;
const GAP_BPS_MAX = 10_000;

const beliefCentibpsField = nonNegativeInteger.refine(
  (n) => n <= BELIEF_CENTIBPS_MAX,
  {
    message: `belief_centibps must be in [0, ${String(BELIEF_CENTIBPS_MAX)}]`,
  },
);

const probBpsField = nonNegativeInteger.refine((n) => n <= PROB_BPS_MAX, {
  message: `confidence_bps must be in [0, ${String(PROB_BPS_MAX)}]`,
});

const gapBpsField = integerNumber.refine(
  (n) => n >= GAP_BPS_MIN && n <= GAP_BPS_MAX,
  {
    message: `gap_bps must be in [${String(GAP_BPS_MIN)}, ${String(GAP_BPS_MAX)}]`,
  },
);

/**
 * Delta of two `belief_centibps` values. Each side is in [0, 1_000_000],
 * so the delta range is [-1_000_000, 1_000_000]. Distinct from `gap_bps`
 * (basis points, ±10_000) because a centibps delta can exceed ±10_000
 * — a 10pp belief shift is 100_000 centibps and a council synthesis can
 * legitimately move belief by that much.
 */
const DELTA_CENTIBPS_MIN = -BELIEF_CENTIBPS_MAX;
const DELTA_CENTIBPS_MAX = BELIEF_CENTIBPS_MAX;
const deltaCentibpsField = integerNumber.refine(
  (n) => n >= DELTA_CENTIBPS_MIN && n <= DELTA_CENTIBPS_MAX,
  {
    message: `delta_centibps must be in [${String(DELTA_CENTIBPS_MIN)}, ${String(DELTA_CENTIBPS_MAX)}]`,
  },
);

const entryPriceBpsField = nonNegativeInteger.refine(
  (n) => n >= ENTRY_PRICE_BPS_MIN && n <= ENTRY_PRICE_BPS_MAX,
  {
    message: `entry_price_bps must be in [${String(ENTRY_PRICE_BPS_MIN)}, ${String(ENTRY_PRICE_BPS_MAX)}]`,
  },
);

const exitPriceBpsField = nonNegativeInteger.refine(
  (n) => n <= PROB_BPS_MAX,
  { message: `exit_price_bps must be in [0, ${String(PROB_BPS_MAX)}]` },
);

const tradeSideEnum = z.enum(["yes", "no"]);

/** Signed decimal-digit string: optional leading `-`, then digits. */
const SIGNED_DECIMAL_STR = /^-?\d+$/;
const signedAmountStr = z
  .string()
  .regex(SIGNED_DECIMAL_STR, "must be a (possibly signed) decimal-digit string");

const tradeDecisionBodySchema = z
  .object({
    agent_id: nonNegativeInteger,
    market_id: hex64,
    action: z.enum(["enter", "hold", "exit"]),
    side: tradeSideEnum,
    size_usdc6: amountStr,
    belief_centibps: beliefCentibpsField,
    confidence_bps: probBpsField,
    mid_centibps: beliefCentibpsField,
    gap_bps: gapBpsField,
    position_id: hex64,
    trace_hash: hex64,
    belief_event_id: hex64,
  })
  .strict();

const tradeExecutedBodySchema = z
  .object({
    agent_id: nonNegativeInteger,
    position_id: hex64,
    market_id: hex64,
    side: tradeSideEnum,
    size_usdc6: amountStr,
    entry_price_bps: entryPriceBpsField,
    tx_hash: hex64,
    block_number: positiveInteger,
    block_hash: hex64,
    attestation_hash: hex64,
  })
  .strict();

const tradeClosedBodySchema = z
  .object({
    agent_id: nonNegativeInteger,
    position_id: hex64,
    exit_price_bps: exitPriceBpsField,
    proceeds_usdc6: amountStr,
    cost_basis_usdc6: amountStr,
    pnl_usdc6: signedAmountStr,
    holding_seconds: nonNegativeInteger,
    tx_hash: hex64,
    block_number: positiveInteger,
    block_hash: hex64,
    attestation_hash: hex64,
  })
  .strict();

const poolDepositBodySchema = z
  .object({
    agent_id: nonNegativeInteger,
    depositor_addr: ethAddr,
    usdc6_amount: amountStr,
    shares_minted: amountStr,
    share_price_usdc6_per_share_e18: amountStr,
    tx_hash: hex64,
    block_number: positiveInteger,
  })
  .strict();

const poolWithdrawBodySchema = z
  .object({
    agent_id: nonNegativeInteger,
    withdrawer_addr: ethAddr,
    shares_redeemed: amountStr,
    usdc6_returned: amountStr,
    share_price_usdc6_per_share_e18: amountStr,
    tx_hash: hex64,
    block_number: positiveInteger,
  })
  .strict();

const beliefUpdatedBodySchema = z
  .object({
    agent_id: nonNegativeInteger,
    market_id: hex64,
    belief_centibps: beliefCentibpsField,
    confidence_bps: probBpsField,
    mid_centibps: beliefCentibpsField,
    gap_bps: gapBpsField,
    inference_event_id: hex64,
  })
  .strict();

/** Bukkit player-name grammar: 3-16 chars, alnum + underscore. */
const VISITOR_HANDLE_RE = /^[A-Za-z0-9_]{3,16}$/;

const visitorIslandEnteredBodySchema = z
  .object({
    agent_id: nonNegativeInteger,
    visitor_handle: z
      .string()
      .regex(
        VISITOR_HANDLE_RE,
        "visitor_handle must be 3-16 chars of [A-Za-z0-9_] (Bukkit grammar)",
      ),
    world_name: z.string().min(1).max(64),
    position_x: integerNumber,
    position_y: integerNumber,
    position_z: integerNumber,
  })
  .strict();

/**
 * NPC id grammar: `<kingdom>.<persona-slug>.<index>` — e.g.
 * `vanta-opus.cloister-scholar.1`. Lowercase alpha + dots + dashes
 * + digits, 4..64 chars. The trailing `<index>` segment may be purely
 * numeric (the runtime + persona registry use `.1`, `.2`, etc.), so
 * the third segment is permitted to start with `[a-z0-9]`.
 */
const NPC_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.[a-z][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/;
const npcIdField = z
  .string()
  .min(4)
  .max(64)
  .regex(
    NPC_ID_RE,
    "npc_id must match <kingdom>.<persona-slug>.<index> (lowercase, dot-separated)",
  );

const npcThoughtBodySchema = z
  .object({
    agent_id: nonNegativeInteger,
    npc_id: npcIdField,
    npc_persona: z.string().min(1).max(64),
    npc_display_name: z.string().min(1).max(64),
    market_id: hex64,
    thought: z.string().min(1).max(280),
    belief_centibps: beliefCentibpsField,
    confidence_bps: probBpsField,
    inference_event_id: hex64,
  })
  .strict();

const councilSynthesisedBodySchema = z
  .object({
    agent_id: nonNegativeInteger,
    market_id: hex64,
    npc_thought_event_ids: z.array(hex64).min(1).max(8).readonly(),
    prior_belief_centibps: beliefCentibpsField,
    synthesised_belief_centibps: beliefCentibpsField,
    delta_centibps: deltaCentibpsField,
    synthesised_confidence_bps: probBpsField,
    rationale: z.string().min(1).max(4096),
    inference_event_id: hex64,
  })
  .strict()
  .refine(
    (b) =>
      b.delta_centibps ===
      b.synthesised_belief_centibps - b.prior_belief_centibps,
    {
      message:
        "council.synthesised: delta_centibps must equal synthesised_belief_centibps - prior_belief_centibps",
    },
  );

/** Body-schema registry, keyed by discriminator (spec §D12 correspondence). */
export const bodySchemas = {
  "tee.attestation": teeAttestationBodySchema,
  "constitutional.genesis": constitutionalGenesisBodySchema,
  "treasury.inflow": treasuryInflowBodySchema,
  "treasury.outflow": treasuryOutflowBodySchema,
  "loan.origination": loanOriginationBodySchema,
  "loan.pledge": loanPledgeBodySchema,
  "loan.mark": loanMarkBodySchema,
  "loan.pledge_revoked": loanPledgeRevokedBodySchema,
  "loan.mark_revoked": loanMarkRevokedBodySchema,
  "loan.settlement": loanSettlementBodySchema,
  "loan.liquidation": loanLiquidationBodySchema,
  "op.mark_gap": opMarkGapBodySchema,
  "op.mark_sparse": opMarkSparseBodySchema,
  "op.inference": opInferenceBodySchema,
  "reasoning.trace": reasoningTraceBodySchema,
  "loop.credit_tick": loopCreditTickBodySchema,
  "loop.calibration_proposal": loopCalibrationProposalBodySchema,
  "loop.onboard_decision": loopOnboardDecisionBodySchema,
  "op.treasury_alert": opTreasuryAlertBodySchema,
  "op.operational_anomaly": opOperationalAnomalyBodySchema,
  "trade.decision": tradeDecisionBodySchema,
  "trade.executed": tradeExecutedBodySchema,
  "trade.closed": tradeClosedBodySchema,
  "pool.deposit": poolDepositBodySchema,
  "pool.withdraw": poolWithdrawBodySchema,
  "belief.updated": beliefUpdatedBodySchema,
  "visitor.island_entered": visitorIslandEnteredBodySchema,
  "npc.thought": npcThoughtBodySchema,
  "council.synthesised": councilSynthesisedBodySchema,
} as const;

// ------------------- Envelope schemas -------------------

/**
 * Permissive envelope schema (spec §D11). Accepts `id === ""` and
 * `signature === ""` so the Step 2 parse in `buildAndSign` can validate
 * shape before signing. All other fields are strict.
 */
const idFieldPermissive = z.union([z.literal(""), hex64]);
const signatureFieldPermissive = z.union([z.literal(""), hex128]);

/** Shared fields between permissive and strict envelopes. */
const envelopeCommonShape = {
  version: z.literal("v1"),
  parent_ids: z.array(hex64).readonly(),
  lineage: z.string(),
  timestamp: integerNumber,
  epoch: integerNumber,
  tee: teeInnerSchema,
  instance: z.string(),
} as const;

/**
 * Body-schema row for a given event type. A few of the Week-2 bodies
 * use `.refine(...)`, which replaces the underlying `ZodObject` with a
 * `ZodEffects<ZodObject<...>>`. We erase the specific schema type to a
 * concrete `ZodType<Record<string, unknown>>` so `body` stays a
 * *required* schema in the output tuple (erasing to
 * `ZodType<unknown>` lets TS infer `body?: unknown`, which breaks
 * `brandStampEvent`'s input contract downstream).
 */
type BodySchemaErased = z.ZodType<Record<string, unknown>>;

function buildVariantPermissive<T extends keyof typeof bodySchemas>(
  t: T,
): z.ZodObject<{
  id: typeof idFieldPermissive;
  type: z.ZodLiteral<T>;
  signature: typeof signatureFieldPermissive;
  body: BodySchemaErased;
  version: typeof envelopeCommonShape.version;
  parent_ids: typeof envelopeCommonShape.parent_ids;
  lineage: typeof envelopeCommonShape.lineage;
  timestamp: typeof envelopeCommonShape.timestamp;
  epoch: typeof envelopeCommonShape.epoch;
  tee: typeof envelopeCommonShape.tee;
  instance: typeof envelopeCommonShape.instance;
}> {
  return z
    .object({
      id: idFieldPermissive,
      type: z.literal(t),
      signature: signatureFieldPermissive,
      body: eraseBody(bodySchemas[t]),
      ...envelopeCommonShape,
    })
    .strict();
}

function buildVariantStrict<T extends keyof typeof bodySchemas>(
  t: T,
): z.ZodObject<{
  id: typeof hex64;
  type: z.ZodLiteral<T>;
  signature: typeof hex128;
  body: BodySchemaErased;
  version: typeof envelopeCommonShape.version;
  parent_ids: typeof envelopeCommonShape.parent_ids;
  lineage: typeof envelopeCommonShape.lineage;
  timestamp: typeof envelopeCommonShape.timestamp;
  epoch: typeof envelopeCommonShape.epoch;
  tee: typeof envelopeCommonShape.tee;
  instance: typeof envelopeCommonShape.instance;
}> {
  return z
    .object({
      id: hex64,
      type: z.literal(t),
      signature: hex128,
      body: eraseBody(bodySchemas[t]),
      ...envelopeCommonShape,
    })
    .strict();
}

/**
 * Erase a specific body schema's type to the common `BodySchemaErased`
 * shape so the discriminated-union variant factories can assemble a
 * heterogeneous mix of `ZodObject`s and `.refine()`-wrapped
 * `ZodEffects`. Narrowing the individual schema type would force the
 * factory's output tuple to commit to one-or-the-other; the erasure is
 * load-bearing but isolated to this one helper.
 */
function eraseBody(s: unknown): BodySchemaErased {
  return s as BodySchemaErased;
}

/**
 * Discriminated union over `type` — permissive variant. Used in build
 * Step 2 (post-preimage-assembly, pre-sign).
 */
export const envelopePermissiveSchema = z
  .discriminatedUnion("type", [
    buildVariantPermissive("tee.attestation"),
    buildVariantPermissive("constitutional.genesis"),
    buildVariantPermissive("treasury.inflow"),
    buildVariantPermissive("treasury.outflow"),
    buildVariantPermissive("loan.origination"),
    buildVariantPermissive("loan.pledge"),
    buildVariantPermissive("loan.mark"),
    buildVariantPermissive("loan.pledge_revoked"),
    buildVariantPermissive("loan.mark_revoked"),
    buildVariantPermissive("loan.settlement"),
    buildVariantPermissive("loan.liquidation"),
    buildVariantPermissive("op.mark_gap"),
    buildVariantPermissive("op.mark_sparse"),
    buildVariantPermissive("op.inference"),
    buildVariantPermissive("reasoning.trace"),
    buildVariantPermissive("loop.credit_tick"),
    buildVariantPermissive("loop.calibration_proposal"),
    buildVariantPermissive("loop.onboard_decision"),
    buildVariantPermissive("op.treasury_alert"),
    buildVariantPermissive("op.operational_anomaly"),
    buildVariantPermissive("trade.decision"),
    buildVariantPermissive("trade.executed"),
    buildVariantPermissive("trade.closed"),
    buildVariantPermissive("pool.deposit"),
    buildVariantPermissive("pool.withdraw"),
    buildVariantPermissive("belief.updated"),
    buildVariantPermissive("visitor.island_entered"),
    buildVariantPermissive("npc.thought"),
    buildVariantPermissive("council.synthesised"),
  ])
  .refine(
    (ev) => enforceGenesisParentShape(ev.type, ev.parent_ids.length),
    {
      message: "genesis_missing_parent_shape: type vs parent_ids mismatch",
    },
  );

/** Strict envelope — id+sig populated. Final parse + external decode use this. */
export const envelopeStrictSchema = z
  .discriminatedUnion("type", [
    buildVariantStrict("tee.attestation"),
    buildVariantStrict("constitutional.genesis"),
    buildVariantStrict("treasury.inflow"),
    buildVariantStrict("treasury.outflow"),
    buildVariantStrict("loan.origination"),
    buildVariantStrict("loan.pledge"),
    buildVariantStrict("loan.mark"),
    buildVariantStrict("loan.pledge_revoked"),
    buildVariantStrict("loan.mark_revoked"),
    buildVariantStrict("loan.settlement"),
    buildVariantStrict("loan.liquidation"),
    buildVariantStrict("op.mark_gap"),
    buildVariantStrict("op.mark_sparse"),
    buildVariantStrict("op.inference"),
    buildVariantStrict("reasoning.trace"),
    buildVariantStrict("loop.credit_tick"),
    buildVariantStrict("loop.calibration_proposal"),
    buildVariantStrict("loop.onboard_decision"),
    buildVariantStrict("op.treasury_alert"),
    buildVariantStrict("op.operational_anomaly"),
    buildVariantStrict("trade.decision"),
    buildVariantStrict("trade.executed"),
    buildVariantStrict("trade.closed"),
    buildVariantStrict("pool.deposit"),
    buildVariantStrict("pool.withdraw"),
    buildVariantStrict("belief.updated"),
    buildVariantStrict("visitor.island_entered"),
    buildVariantStrict("npc.thought"),
    buildVariantStrict("council.synthesised"),
  ])
  .refine(
    (ev) => enforceGenesisParentShape(ev.type, ev.parent_ids.length),
    {
      message: "genesis_missing_parent_shape: type vs parent_ids mismatch",
    },
  );

/** Canonical name used in `decode.ts` and `build.ts` for the final parse. */
export const VantaEventSchema = envelopeStrictSchema;

/**
 * I-EV-4 enforcement helper: genesis ⇔ parent_ids.length === 0.
 * Exported so `build.ts` and `decode.ts` can produce a precise
 * `genesis_missing_parent_shape` error code (zod's refine-only message
 * is too coarse).
 */
export function enforceGenesisParentShape(
  type: string,
  parentIdsLen: number,
): boolean {
  if (type === "constitutional.genesis") {
    return parentIdsLen === 0;
  }
  return parentIdsLen > 0;
}
