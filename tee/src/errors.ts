/**
 * Typed errors for the @vanta/tee module.
 *
 * Hard rule (spec §4): `context` is a `Record<string, string>` of
 * safe-to-log key-value pairs. It NEVER contains MNEMONIC bytes, HKDF
 * output bytes, KeyObject export bytes, or stack frames that reference
 * those. A regression test greps for entropy-looking hex in any
 * stringified `TeeState` or error.
 */

export type TeeErrorCode =
  | "no_identity_anchor"
  | "mnemonic_missing"
  | "mnemonic_invalid"
  | "attestation_unavailable"
  | "attestation_signature_mismatch"
  | "attestation_decrypt_failed"
  | "kms_server_unreachable"
  | "socket_unavailable"
  | "tdx_quote_inactive"
  | "hkdf_salt_reused"
  | "hkdf_info_mismatch"
  | "invalid_ikm"
  | "signing_not_initialized"
  | "signing_already_initialized"
  | "env_not_configured";

export class TeeError extends Error {
  public override readonly name: "TeeError" = "TeeError";
  public readonly code: TeeErrorCode;
  public readonly context: Readonly<Record<string, string>>;

  public constructor(code: TeeErrorCode, message: string, context: Record<string, string> = {}) {
    super(message);
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}
