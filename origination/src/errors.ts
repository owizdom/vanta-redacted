/**
 * Typed errors for the @vanta/origination module.
 *
 * Mirrors the shape established in @vanta/pledge: a single error class,
 * a closed `code` union, and a frozen `detail: Record<string, unknown>`
 * plus `cause: unknown` for the original error.
 *
 * Hard rule: `detail` NEVER carries private keys, raw signatures, the
 * MNEMONIC, or entropy-bearing hex. Safe fields: loanId, borrower
 * address, principal, haircut bps, blockNumbers as strings, tx hashes.
 */

export type OriginationErrorCode =
  // I-OR-1: cited pledge event must have confirmation_depth >= 5
  | "pledge_not_finalized"
  // I-OR-5: borrower in OriginationRequest must match pledge event's
  // borrower_proxy.
  | "borrower_mismatch"
  // Pre-broadcast input validation
  | "params_invalid"
  // LoanBook.originate(...) reverted or the wallet client refused to
  // submit the transaction.
  | "loanbook_call_failed"
  // Receipt did not arrive at the expected confirmation depth within
  // the configured polling budget.
  | "finality_timeout"
  // Reorg detected: block hash observed at first-confirm differs from
  // the one observed at the final confirmation depth.
  | "params_hash_mismatch"
  // Building or signing the loan.origination event itself failed.
  | "event_sign_failed"
  // RPC could not be reached during a poll.
  | "rpc_unreachable";

export class OriginationError extends Error {
  public override readonly name: "OriginationError" = "OriginationError";
  public readonly code: OriginationErrorCode;
  public readonly detail: Readonly<Record<string, unknown>>;
  public override readonly cause?: unknown;

  public constructor(
    code: OriginationErrorCode,
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
