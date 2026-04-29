/**
 * Typed errors for the @vanta/venue-poly module.
 *
 * Mirrors the shape established in @vanta/events and @vanta/treasury:
 * a single error class, a closed `code` union, and a frozen
 * `context: Record<string, string>` of safe-to-log key-value pairs.
 *
 * Hard rule: `context` NEVER carries private keys, raw signatures, the
 * MNEMONIC, or entropy-bearing hex. Safe fields: chainId (as string),
 * conditionId, proxyAddress, expected/actual lengths, expected/actual
 * v values for ECDSA malformed-signature diagnostics.
 */

export type VenuePolyErrorCode =
  // CTF / UMA read surface
  | "ctf_read_failed"
  | "uma_read_failed"
  | "chain_id_mismatch"
  | "rpc_unreachable"
  | "response_schema_invalid"
  // Gnosis Safe surface
  | "safe_bad_operation"
  | "safe_bad_signature_v"
  | "nonce_mismatch"
  | "owner_not_on_proxy"
  | "safe_read_failed"
  | "fallback_handler_mismatch";

export class VenuePolyError extends Error {
  public override readonly name: "VenuePolyError" = "VenuePolyError";
  public readonly code: VenuePolyErrorCode;
  public readonly context: Readonly<Record<string, string>>;

  public constructor(
    code: VenuePolyErrorCode,
    message: string,
    context: Record<string, string> = {},
  ) {
    super(message);
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}
