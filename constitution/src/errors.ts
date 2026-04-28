/**
 * Typed error surface for @vanta/constitution.
 *
 * Every parse/evaluate failure throws a `ConstitutionError` carrying a
 * closed-set `code` (spec §4) and an optional structural `detail` object.
 *
 * Hard rule (spec §4 final paragraph):
 * `detail` MUST NOT contain private-key material, raw constitution bytes,
 * or any value larger than a short diagnostic string. Safe fields are
 * short paths, observed-vs-required integers, hex digests, booleans, and
 * well-formed field names.
 */

/**
 * Closed union of every failure surface in the constitution module.
 * Ordered as in spec §4: structural → semantic → genesis signing.
 */
export type ConstitutionErrorCode =
  // Structural (zod layer).
  | "CONSTITUTION_JSON_MALFORMED"
  | "CONSTITUTION_SCHEMA_VIOLATION"
  // Semantic (validateSemantic).
  | "UNSUPPORTED_SCHEMA_VERSION"
  | "AGENT_NAME_MISMATCH"
  | "INVALID_AGENT_PK"
  | "INVALID_THRESHOLD"
  | "STEWARDS_COUNT_MISMATCH"
  | "BPS_OUT_OF_RANGE"
  | "RISK_ENVELOPE_BOUND_VIOLATION"
  | "TREASURY_CEILING_EXCEEDS_SAFE_INT"
  | "TREASURY_AGGREGATE_CEILING_INCONSISTENT"
  | "CHAIN_ID_UNSUPPORTED"
  | "EMERGENCY_HALT_DURATION_INVALID"
  | "TIMELOCK_BOUND_VIOLATION"
  // Genesis signing.
  | "GENESIS_PUBKEY_MISMATCH"
  | "GENESIS_SIGNING_FAILED"
  | "GENESIS_SIGNATURE_ARRAY_NONEMPTY";

/**
 * The single error type raised by @vanta/constitution.
 *
 * `detail` is `Record<string, unknown>` but callers are required (by
 * contract above) to populate it only with small, non-sensitive
 * diagnostic values. The error message itself is a short human-readable
 * string; integrations that need machine-readable routing MUST branch on
 * `code`, never on the message.
 */
export class ConstitutionError extends Error {
  public override readonly name: "ConstitutionError" = "ConstitutionError";
  public readonly code: ConstitutionErrorCode;
  public readonly detail: Readonly<Record<string, unknown>>;

  public constructor(
    code: ConstitutionErrorCode,
    message: string,
    detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.code = code;
    this.detail = Object.freeze({ ...detail });
  }
}
