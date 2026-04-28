/**
 * Canonical encoding + domain-separated SHA-256 hash + parse pipeline.
 *
 * # Hash chain
 *
 * ```text
 * constitutionHash = sha256(CONSTITUTION_DOMAIN || jcs(body))
 * ```
 *
 * Where `CONSTITUTION_DOMAIN = "vanta-constitution-v1\n"` (trailing
 * newline delimits the tag from the hashed input — same convention as
 * `@vanta/tee` attestation preimage).
 *
 * `jcs(body)` is RFC 8785 JSON Canonicalization applied to
 * `ConstitutionBody`. The typed schema forbids floats (all monetary
 * fields are integer or bps), so IEEE-754 serialization traps are
 * structurally out of reach.
 *
 * # Parse pipeline
 *
 * Two layers, composed in `parseConstitutionBody`:
 *
 * 1. **Structural (zod).** `constitutionBodySchema.parse` with
 *    `.strict()` at every level. Unknown top-level / nested keys,
 *    wrong types, missing required fields → `CONSTITUTION_JSON_MALFORMED`
 *    or `CONSTITUTION_SCHEMA_VIOLATION`.
 * 2. **Semantic.** `validateSemantic` — range checks, safe-int
 *    ceilings, chain IDs, timelock bounds.
 */

import { createHash } from "node:crypto";

import canonicalize from "canonicalize";

import { asSha256Hex } from "@vanta/tee";
import type { Sha256Hex } from "@vanta/tee";

import { ConstitutionError } from "./errors.js";
import { constitutionBodySchema } from "./schema.js";
import type { ConstitutionBody } from "./schema.js";
import { validateSemantic } from "./semantic.js";

/**
 * Domain-separation prefix for the constitution hash. Bumped if the
 * preimage construction ever changes.
 */
export const CONSTITUTION_DOMAIN = "vanta-constitution-v1\n" as const;

const DOMAIN_BYTES = Buffer.from(CONSTITUTION_DOMAIN, "utf8");

/**
 * Canonically encode a `ConstitutionBody` to RFC 8785 JCS UTF-8 bytes.
 *
 * Deterministic: two callers encoding a semantically-equal body produce
 * byte-identical output. Single source of truth for the hash preimage.
 *
 * `canonicalize@3.0.0` (Samuel Erdtman, RFC 8785 co-author) is the
 * same dependency used by `@vanta/events`; pinning the exact version
 * across packages ensures that a constitution hashed at genesis will
 * re-hash identically when re-validated anywhere in the workspace.
 *
 * Throws `CONSTITUTION_JSON_MALFORMED` if the canonicaliser rejects the
 * input (unreachable in practice — the typed body has no NaN, no
 * `undefined`, no cycles — but catch-and-rebrand keeps the error
 * surface closed).
 */
export function encodeCanonicalBody(body: ConstitutionBody): Uint8Array {
  let jcs: string | undefined;
  try {
    jcs = canonicalize(body);
  } catch (cause) {
    throw new ConstitutionError(
      "CONSTITUTION_JSON_MALFORMED",
      "RFC 8785 canonicalisation of constitution body failed",
      { cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }
  if (typeof jcs !== "string") {
    throw new ConstitutionError(
      "CONSTITUTION_JSON_MALFORMED",
      "canonicalize returned non-string output",
      {},
    );
  }
  return Buffer.from(jcs, "utf8");
}

/**
 * Compute the 32-byte domain-separated SHA-256 hash of a
 * `ConstitutionBody`, returned as a branded 64-char lowercase-hex
 * `Sha256Hex`.
 *
 * `sha256(CONSTITUTION_DOMAIN || jcs(body))`.
 */
export function constitutionHash(body: ConstitutionBody): Sha256Hex {
  const jcsBytes = encodeCanonicalBody(body);
  const hasher = createHash("sha256");
  hasher.update(DOMAIN_BYTES);
  hasher.update(jcsBytes);
  const digestHex = hasher.digest("hex");
  return asSha256Hex(digestHex);
}

/**
 * Full two-layer parse pipeline.
 *
 * Accepts either a JSON string (runs `JSON.parse` first) or an already-
 * parsed unknown. Returns a validated `ConstitutionBody`. Throws
 * `ConstitutionError` with the matching code on any layer failure.
 *
 * Layers: zod structural → validateSemantic.
 */
export function parseConstitutionBody(
  input: string | unknown,
): ConstitutionBody {
  // Layer 0: if string, JSON.parse.
  let parsed: unknown;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input);
    } catch (cause) {
      throw new ConstitutionError(
        "CONSTITUTION_JSON_MALFORMED",
        "JSON parse failed",
        { cause: cause instanceof Error ? cause.message : String(cause) },
      );
    }
  } else {
    parsed = input;
  }

  // Layer 1: zod structural.
  const result = constitutionBodySchema.safeParse(parsed);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const path =
      firstIssue !== undefined ? firstIssue.path.join(".") : "<root>";
    const message =
      firstIssue !== undefined
        ? firstIssue.message
        : "schema validation failed";
    throw new ConstitutionError(
      "CONSTITUTION_SCHEMA_VIOLATION",
      `schema violation at ${path}: ${message}`,
      { path, issues: result.error.issues.length },
    );
  }
  const body = result.data;

  // Layer 2: semantic.
  validateSemantic(body);

  return body;
}
