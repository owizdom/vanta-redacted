/**
 * Typed errors for the @vanta/events module.
 *
 * Hard rule (spec §4): `context` is a `Record<string, string>` of
 * safe-to-log key-value pairs. It NEVER contains full event payloads,
 * private keys, raw canonical bytes, or `MNEMONIC`. Safe fields:
 * `eventId`, `type`, `offendingKey`, `field`, `expectedLen`, `actualLen`.
 */

export type EventsErrorCode =
  | "schema_invalid"
  | "id_mismatch"
  | "signature_invalid"
  | "signer_mismatch"
  | "parent_missing"
  | "canonical_json_failed"
  | "type_unknown"
  | "prototype_pollution"
  | "signer_pubkey_malformed"
  | "genesis_missing_parent_shape"
  | "transitive_genesis_unreachable"
  | "cycle_detected"
  | "multiple_genesis_found"
  | "utf8_non_nfc"
  | "timestamp_not_integer"
  | "amount_not_decimal_string"
  | "json_parse_failed"
  | "depth_exceeded";

export class EventsError extends Error {
  public override readonly name = "EventsError" as const;
  public readonly code: EventsErrorCode;
  public readonly context: Readonly<Record<string, string>>;

  public constructor(
    code: EventsErrorCode,
    message: string,
    context: Record<string, string> = {},
  ) {
    super(message);
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}
