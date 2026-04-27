/**
 * `decodeEvent` — external decode entrypoint (spec §1.5).
 *
 * Steps (spec §6 Decode):
 *   1. Prototype-pollution regex reject on raw JSON (I-EV-9).
 *   2. `JSON.parse`; throws → `json_parse_failed`.
 *   3. NFC audit on every string field reachable from the envelope
 *      (I-EV-10); any non-NFC string → `utf8_non_nfc`.
 *   4. Strict discriminated-union parse (spec §D3).
 *   5. Brand stamp on id / signing pubkey / hashes via downstream use.
 *
 * No side effects beyond parsing. Never reads from disk / network.
 */

import { EventsError } from "./errors.js";
import { VantaEventSchema, enforceGenesisParentShape } from "./schemas.js";
import { brandStampEvent } from "./types.js";
import type { VantaEvent } from "./types.js";

export type DecodeResult =
  | { readonly ok: true; readonly event: VantaEvent }
  | { readonly ok: false; readonly error: EventsError };

/**
 * Raw-JSON regex guard (I-EV-9). Keys encoded as JSON strings look like
 * `"__proto__":` or `"constructor":` with arbitrary whitespace; the
 * regex allows any whitespace between the closing `"` and `:`.
 *
 * This is pre-parse, so it also matches occurrences inside string
 * values. That's the conservative choice (spec §D9, "pre-parse guard"):
 * reject any event whose serialized form contains these reserved
 * identifiers, even as legitimate body content, rather than risk a
 * prototype-walking bug in a future parser.
 */
const PROTO_POLLUTION_RE = /"(?:__proto__|constructor)"\s*:/u;

/**
 * Walk an already-parsed JSON value and throw `utf8_non_nfc` if any
 * string is not equal to its NFC form.
 */
function assertNfc(value: unknown, path: string): void {
  if (typeof value === "string") {
    if (value !== value.normalize("NFC")) {
      throw new EventsError(
        "utf8_non_nfc",
        "string field is not in Unicode Normalization Form C",
        { path },
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      assertNfc(value[i], `${path}[${String(i)}]`);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const k of Object.keys(record)) {
      if (k !== k.normalize("NFC")) {
        throw new EventsError("utf8_non_nfc", "object key is not in NFC", {
          path: `${path}.${k}`,
        });
      }
      assertNfc(record[k], `${path}.${k}`);
    }
  }
}

/**
 * Decode a raw JSON string into a validated `VantaEvent`. No signature
 * verification happens here — callers pair this with `verifyEvent`.
 *
 * Returns a tagged-union result; never throws on malformed input
 * (matches spec §1.5 `DecodeResult`). Internal sanity violations may
 * still throw (caller bug).
 */
export function decodeEvent(rawJson: string): DecodeResult {
  if (PROTO_POLLUTION_RE.test(rawJson)) {
    return {
      ok: false,
      error: new EventsError(
        "prototype_pollution",
        "raw JSON contains reserved identifier __proto__ or constructor",
      ),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err: unknown) {
    return {
      ok: false,
      error: new EventsError(
        "json_parse_failed",
        err instanceof Error ? err.message : "JSON.parse threw non-Error",
      ),
    };
  }

  try {
    assertNfc(parsed, "$");
  } catch (err: unknown) {
    if (err instanceof EventsError) {
      return { ok: false, error: err };
    }
    return {
      ok: false,
      error: new EventsError(
        "utf8_non_nfc",
        err instanceof Error ? err.message : "NFC check threw non-Error",
      ),
    };
  }

  const strictParse = VantaEventSchema.safeParse(parsed);
  if (!strictParse.success) {
    // `type_unknown` when the discriminator is missing or not in the enum.
    const hasUnknownType = strictParse.error.issues.some(
      (iss) => iss.path[0] === "type",
    );
    return {
      ok: false,
      error: new EventsError(
        hasUnknownType ? "type_unknown" : "schema_invalid",
        "event did not match VantaEventSchema",
        { zodIssues: String(strictParse.error.issues.length) },
      ),
    };
  }

  // The discriminated-union refine already enforces I-EV-4, but surface
  // a precise code here in case a future schema change drops the refine.
  if (
    !enforceGenesisParentShape(
      strictParse.data.type,
      strictParse.data.parent_ids.length,
    )
  ) {
    return {
      ok: false,
      error: new EventsError(
        "genesis_missing_parent_shape",
        "parent_ids shape does not match event type",
        { type: strictParse.data.type },
      ),
    };
  }

  return { ok: true, event: brandStampEvent(strictParse.data) };
}
