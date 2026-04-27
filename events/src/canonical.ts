/**
 * RFC 8785 (JSON Canonicalization Scheme) wrapper.
 *
 * Cite: spec §1.7, §5, §D2, P1 "canonicalize@3.0.0 (Samuel Erdtman,
 * RFC 8785 co-author)."
 *
 * Responsibilities:
 *   1. NFC-normalize every string reachable from the input (I-EV-10).
 *   2. Walk the value and reject JSON-illegal or unsafe inputs
 *      (NaN, ±Infinity, undefined, bigint, symbol, function) and any
 *      object containing `__proto__` / `constructor` keys (I-EV-9).
 *   3. Hand the cleaned copy to `canonicalize@3.0.0` and return a
 *      branded `Uint8Array`.
 *
 * Any failure throws `EventsError` with code `canonical_json_failed` or
 * `prototype_pollution`. No `any`, no `as any`.
 */

import canonicalize from "canonicalize";

import { EventsError } from "./errors.js";
import type { CanonicalJsonBytes } from "./types.js";

type JsonSafe =
  | null
  | boolean
  | number
  | string
  | readonly JsonSafe[]
  | { readonly [k: string]: JsonSafe };

/**
 * Maximum recursion depth. Events are shallow; this is a DoS guard on
 * adversarial decode paths.
 */
const MAX_DEPTH = 64;

/**
 * Normalize a value for canonicalization.
 *
 * Throws:
 *  - `prototype_pollution` on `__proto__` / `constructor` keys.
 *  - `canonical_json_failed` on NaN, ±Infinity, bigint, symbol,
 *    function, undefined, or recursion beyond `MAX_DEPTH`.
 */
function normalizeForCanonical(value: unknown, depth: number): JsonSafe {
  if (depth > MAX_DEPTH) {
    throw new EventsError(
      "canonical_json_failed",
      "canonical depth exceeded",
      { maxDepth: String(MAX_DEPTH) },
    );
  }

  if (value === null) {
    return null;
  }

  const t = typeof value;
  if (t === "boolean") {
    return value as boolean;
  }
  if (t === "string") {
    return (value as string).normalize("NFC");
  }
  if (t === "number") {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new EventsError(
        "canonical_json_failed",
        "non-finite number is not canonicalizable",
        { value: Number.isNaN(n) ? "NaN" : n > 0 ? "Infinity" : "-Infinity" },
      );
    }
    return n;
  }
  if (t === "undefined") {
    throw new EventsError(
      "canonical_json_failed",
      "undefined is not a JSON value",
    );
  }
  if (t === "bigint") {
    throw new EventsError(
      "canonical_json_failed",
      "bigint is not a JSON value",
    );
  }
  if (t === "symbol") {
    throw new EventsError(
      "canonical_json_failed",
      "symbol is not a JSON value",
    );
  }
  if (t === "function") {
    throw new EventsError(
      "canonical_json_failed",
      "function is not a JSON value",
    );
  }

  if (Array.isArray(value)) {
    const out: JsonSafe[] = [];
    for (const item of value) {
      out.push(normalizeForCanonical(item, depth + 1));
    }
    return out;
  }

  // Remaining case: non-null, non-array `object`. Anything else
  // (functions, symbols, etc.) was rejected above.
  const record = value as Record<string, unknown>;
  const out: Record<string, JsonSafe> = Object.create(null) as Record<string, JsonSafe>;
  // `Object.keys` skips the prototype chain; combined with the
  // literal-key guard below this closes the prototype-pollution path.
  for (const k of Object.keys(record)) {
    if (k === "__proto__" || k === "constructor") {
      throw new EventsError(
        "prototype_pollution",
        "reserved key in canonicalized input",
        { offendingKey: k },
      );
    }
    out[k.normalize("NFC")] = normalizeForCanonical(record[k], depth + 1);
  }
  return out;
}

/**
 * Visit `value` without mutating it; throw on any input the canonical
 * path cannot serialize. Exposed for differential testing (spec §1.7).
 */
export function assertCanonicalizable(value: unknown): void {
  normalizeForCanonical(value, 0);
}

/**
 * Canonicalize `value` per RFC 8785 and return branded UTF-8 bytes.
 *
 * The single canonical pipeline:
 *   1. `normalizeForCanonical` — NFC strings, reject unsafe scalars,
 *      reject prototype-pollution keys.
 *   2. `canonicalize()@3.0.0` — RFC 8785 string.
 *   3. `Buffer.from(str, "utf8")` — serialize to bytes.
 *   4. Brand the bytes so only callers who went through this function
 *      can pass the output to signing or id routines.
 */
export function canonicalJsonBytes(value: unknown): CanonicalJsonBytes {
  const safe = normalizeForCanonical(value, 0);
  let str: string | undefined;
  try {
    str = canonicalize(safe);
  } catch (err: unknown) {
    throw new EventsError(
      "canonical_json_failed",
      err instanceof Error ? err.message : "canonicalize threw a non-Error",
    );
  }
  if (typeof str !== "string") {
    // canonicalize returns undefined for values it deems unencodable
    // (e.g. nested undefined, cycles). We already cleaned these, so
    // this is a library regression — surface it explicitly.
    throw new EventsError(
      "canonical_json_failed",
      "canonicalize returned non-string output",
    );
  }
  const bytes = new Uint8Array(Buffer.from(str, "utf8"));
  return bytes as CanonicalJsonBytes;
}
