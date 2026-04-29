/**
 * Body builders.
 *
 * `buildLoanMarkBody` is the orchestrator. On sparse-window inputs it
 * throws `MarkSparseSignal` (control-flow, not error), so the caller can
 * translate the signal to a `buildMarkSparseBody` call without parsing
 * error messages.
 *
 * `buildMarkGapBody` and `buildMarkSparseBody` are pure constructors.
 * They produce the body shapes that `events.buildAndSign` accepts for
 * `op.mark_gap` / `op.mark_sparse`.
 *
 * Cross-check (I-MK-3 "cross_check_disagreement"): if the caller
 * supplies `prices_history_twap`, we reject the window if
 * |ours - server| > CROSS_CHECK_MAX_DEVIATION. The absolute form is
 * used (not relative) because prices live in [0, 1], so a 2% absolute
 * deviation == 2% relative at the unit scale we care about. The signal
 * uses `reason: "cross_check_disagreement"` for the sparse event; the
 * `MarkError.cross_check_divergence` code is used for the throwback to
 * the caller.
 */

import type {
  LoanMarkBody,
  OpMarkGapBody,
  OpMarkSparseBody,
} from "@vanta/events";

import { CROSS_CHECK_MAX_DEVIATION } from "./constants.js";
import { MarkError, MarkSparseSignal, type SparseReason } from "./errors.js";
import { computeTwap, type TwapResult } from "./twap.js";
import type { SourceAttestation, Trade } from "./types.js";
import type { Sha256Hex } from "@vanta/tee";

export interface BuildLoanMarkBodyArgs {
  readonly loan_id: Sha256Hex;
  readonly token_id: string;
  readonly condition_id: Sha256Hex;
  readonly window_start_unix: number;
  readonly window_end_unix: number;
  readonly trades: readonly Trade[];
  readonly bootstrap_price: string;
  readonly attestation: SourceAttestation;
  readonly source_block_range: readonly [number, number];
  readonly prices_history_twap?: string;
}

export function buildLoanMarkBody(args: BuildLoanMarkBodyArgs): LoanMarkBody {
  const result: TwapResult = computeTwap(
    args.trades,
    {
      startUnix: args.window_start_unix,
      endUnix: args.window_end_unix,
    },
    args.bootstrap_price,
  );

  if (!result.valid) {
    throw new MarkSparseSignal(
      result.reason,
      `mark window invalid: ${result.reason}`,
      {
        token_id: args.token_id,
        trade_count: String(result.trade_count),
        denominator: String(result.denominator),
      },
    );
  }

  // Cross-check vs /prices-history (I-MK-3).
  if (typeof args.prices_history_twap === "string") {
    const oursNum = Number(result.twap);
    const serverNum = Number(args.prices_history_twap);
    if (!Number.isFinite(serverNum) || serverNum < 0 || serverNum > 1) {
      throw new MarkError(
        "cross_check_divergence",
        "prices_history_twap is not a decimal in [0, 1]",
        {
          token_id: args.token_id,
          server_twap: args.prices_history_twap,
        },
      );
    }
    const deviation = Math.abs(oursNum - serverNum);
    if (deviation > CROSS_CHECK_MAX_DEVIATION) {
      // We signal sparse-disagreement rather than raise a pure MarkError
      // so the poller can emit `op.mark_sparse` consistently. Callers
      // who want the hard error can branch on `MarkError` explicitly.
      throw new MarkSparseSignal(
        "cross_check_disagreement",
        `server TWAP disagrees by ${deviation.toFixed(6)}`,
        {
          token_id: args.token_id,
          ours: result.twap,
          server: args.prices_history_twap,
          deviation: deviation.toFixed(6),
        },
      );
    }
  }

  const body: LoanMarkBody = {
    loan_id: args.loan_id,
    token_id: args.token_id,
    condition_id: args.condition_id,
    window_start_unix: args.window_start_unix,
    window_end_unix: args.window_end_unix,
    twap: result.twap,
    trade_count: args.trades.length,
    source_block_range: [
      args.source_block_range[0],
      args.source_block_range[1],
    ],
    source_attestation: {
      clob_hostname: args.attestation.clob_hostname,
      tls_spki_sha256: args.attestation.tls_spki_sha256,
      http_status: args.attestation.http_status,
      response_etag_or_digest: args.attestation.response_etag_or_digest,
    },
  };
  return body;
}

export interface BuildMarkGapBodyArgs {
  readonly clob_hostname: string;
  readonly http_status: number;
  readonly first_failure_unix: number;
  readonly duration_seconds: number;
  readonly affected_condition_ids: readonly Sha256Hex[];
}

export function buildMarkGapBody(args: BuildMarkGapBodyArgs): OpMarkGapBody {
  const body: OpMarkGapBody = {
    clob_hostname: args.clob_hostname,
    http_status: args.http_status,
    first_failure_unix: args.first_failure_unix,
    duration_seconds: args.duration_seconds,
    affected_condition_ids: [...args.affected_condition_ids],
  };
  return body;
}

export interface BuildMarkSparseBodyArgs {
  readonly condition_id: Sha256Hex;
  readonly token_id: string;
  readonly window_start_unix: number;
  readonly window_end_unix: number;
  readonly reason: SparseReason;
  readonly trade_count: number;
  readonly aggregate_notional_usdc: string;
}

export function buildMarkSparseBody(
  args: BuildMarkSparseBodyArgs,
): OpMarkSparseBody {
  const body: OpMarkSparseBody = {
    condition_id: args.condition_id,
    token_id: args.token_id,
    window_start_unix: args.window_start_unix,
    window_end_unix: args.window_end_unix,
    reason: args.reason,
    trade_count: args.trade_count,
    aggregate_notional_usdc: args.aggregate_notional_usdc,
  };
  return body;
}
