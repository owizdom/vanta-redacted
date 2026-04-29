/**
 * Typed errors for the @vanta/mark module.
 *
 * Mirrors the TeeError / EventsError / TreasuryError pattern: `code`,
 * frozen `context: Record<string, string>`, `name: "MarkError"`.
 *
 * `MarkSparseSignal` is NOT a true error — it is a dedicated class used
 * as a control-flow signal by `builder.buildLoanMarkBody`, so the caller
 * can distinguish "window invalid, emit op.mark_sparse" from other
 * failure modes. Both classes extend `Error` so uncaught instances
 * surface in stack traces.
 *
 * Hard rule: `context` NEVER contains raw response bodies, private keys,
 * or other entropy-bearing payloads. Safe fields: hostnames, HTTP
 * statuses, field names, deviation floats. The SPKI hex is
 * intentionally safe (it is a public pin value).
 */

export type MarkErrorCode =
  | "tls_spki_pin_mismatch"
  | "http_non_200"
  | "response_schema_invalid"
  | "cross_check_divergence"
  | "bootstrap_price_unavailable";

export class MarkError extends Error {
  public override readonly name = "MarkError" as const;
  public readonly code: MarkErrorCode;
  public readonly context: Readonly<Record<string, string>>;

  public constructor(
    code: MarkErrorCode,
    message: string,
    context: Record<string, string> = {},
  ) {
    super(message);
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}

/**
 * The four "window invalid" reasons reported back to the caller so
 * `op.mark_sparse` can embed the correct enum (events schema:
 * `insufficient_trades | coverage_gap | cross_check_disagreement |
 * single_trade_dominance`). `cross_check_disagreement` is raised by
 * `builder.buildLoanMarkBody` after the cross-check, not by
 * `twap.computeTwap` which cannot see the server TWAP.
 */
export type SparseReason =
  | "insufficient_trades"
  | "coverage_gap"
  | "single_trade_dominance"
  | "cross_check_disagreement";

/**
 * Control-flow signal thrown by `buildLoanMarkBody` when the window is
 * unusable. Consumed by `poller` to translate into an `op.mark_sparse`
 * event. Fields are exactly the inputs `buildMarkSparseBody` needs.
 */
export class MarkSparseSignal extends Error {
  public override readonly name = "MarkSparseSignal" as const;
  public readonly reason: SparseReason;
  public readonly context: Readonly<Record<string, string>>;

  public constructor(
    reason: SparseReason,
    message: string,
    context: Record<string, string> = {},
  ) {
    super(message);
    this.reason = reason;
    this.context = Object.freeze({ ...context });
  }
}
