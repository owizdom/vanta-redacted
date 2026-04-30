/**
 * Typed errors for the @vanta/verify CLI.
 *
 * The CLI is the only consumer; we still keep a closed `code` union so
 * downstream callers (CI scripts, exit-code mappers) can switch on the
 * shape without parsing strings.
 */

export type VerifyErrorCode =
  | "http_non_200"
  | "invalid_response_shape"
  | "genesis_mismatch"
  | "signature_invalid"
  | "params_hash_mismatch"
  | "chain_too_deep"
  | "rpc_unreachable"
  | "usage_error"
  | "id_mismatch"
  | "parent_missing";

export class VerifyError extends Error {
  public override readonly name: "VerifyError" = "VerifyError";
  public readonly code: VerifyErrorCode;
  public readonly detail: Readonly<Record<string, unknown>>;
  public override readonly cause?: unknown;

  public constructor(
    code: VerifyErrorCode,
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
