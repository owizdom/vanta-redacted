/**
 * Typed errors for the @vanta/pledge module.
 *
 * Mirrors the shape established in @vanta/events, @vanta/treasury, and
 * @vanta/venue-poly: a single error class, a closed `code` union, and a
 * frozen `detail: Record<string, unknown>` plus `cause: unknown` for the
 * original error.
 *
 * Hard rule: `detail` NEVER carries private keys, raw signatures, the
 * MNEMONIC, or entropy-bearing hex. Safe fields: loanId, proxyAddress,
 * blockNumbers as strings, expected/actual amounts, fallback-handler
 * addresses, chain ids.
 */

export type PledgeErrorCode =
  // I-PL-3
  | "proxy_not_in_registry"
  | "fallback_handler_mismatch"
  // I-PL-4 / I-PL-7
  | "ineligible"
  // I-PL-1 pre-check
  | "insufficient_balance"
  // Safe meta-tx broadcast
  | "safe_broadcast_failed"
  // I-PL-2
  | "finality_timeout"
  | "receipt_not_available"
  | "transfer_log_not_found"
  | "transfer_value_zero"
  // I-PL-1 post-check
  | "post_transfer_balance_too_low"
  // I-PL-6
  | "watchdog_start_failed"
  // Hygiene
  | "chain_id_mismatch"
  | "rpc_unreachable";

export class PledgeError extends Error {
  public override readonly name: "PledgeError" = "PledgeError";
  public readonly code: PledgeErrorCode;
  public readonly detail: Readonly<Record<string, unknown>>;
  public override readonly cause?: unknown;

  public constructor(
    code: PledgeErrorCode,
    message: string,
    detail: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(message);
    this.code = code;
    this.detail = Object.freeze({ ...detail });
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}
