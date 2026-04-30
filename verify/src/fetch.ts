/**
 * HTTP fetchers for the verifier CLI.
 *
 * Three endpoints are queried:
 *
 *   - `/api/tee`           — `{ signingPubKey, attestationJwt, active }`.
 *   - `/api/constitution`  — the canonical constitution body + its hash.
 *   - `/api/events/:id`    — a single signed event.
 *
 * Each response is shape-checked with strict zod; an unexpected shape
 * surfaces as `invalid_response_shape` with the field path included in
 * `detail`. Non-2xx HTTP responses surface as `http_non_200`.
 *
 * Uses the global `fetch` (Node 20+ ships it). The CLI accepts the
 * server's base URL as a positional argument and concatenates the
 * paths above; we deliberately do NOT add a trailing-slash heuristic
 * because that would mask user typos.
 */

import { z } from "zod";

import { VerifyError } from "./errors.js";

const HEX64 = /^[0-9a-f]{64}$/;

const teeResponseSchema = z
  .object({
    signingPubKey: z.string().regex(HEX64, "must be 64-char lowercase hex"),
    attestationJwt: z.string(),
    active: z.boolean(),
    /** Optional pointer to the latest event id; if present we use it as
     *  the default `--event` start when none is supplied. */
    tipEventId: z
      .string()
      .regex(HEX64, "must be 64-char lowercase hex")
      .optional(),
  })
  .passthrough();

const constitutionResponseSchema = z
  .object({
    /** sha256 of the canonical constitution bytes. */
    hash: z.string().regex(HEX64, "must be 64-char lowercase hex"),
    /** Echo of the canonical body the hash covers. */
    body: z.unknown(),
  })
  .passthrough();

const eventResponseSchema = z
  .object({
    id: z.string().regex(HEX64, "must be 64-char lowercase hex"),
    type: z.string(),
    parent_ids: z.array(z.string().regex(HEX64)),
  })
  .passthrough();

export interface TeeResponse {
  readonly signingPubKey: string;
  readonly attestationJwt: string;
  readonly active: boolean;
  readonly tipEventId?: string;
}

export interface ConstitutionResponse {
  readonly hash: string;
  readonly body: unknown;
}

/** A signed VANTA event as returned by the server. Shape is
 *  intentionally loose at the fetch layer — `verifyEvent` from
 *  `@vanta/events` runs strict zod itself. */
export interface RawEventResponse {
  readonly id: string;
  readonly type: string;
  readonly parent_ids: readonly string[];
  readonly [k: string]: unknown;
}

function joinUrl(base: string, path: string): string {
  // Defensive: caller passes "https://host" or "https://host/"; we
  // append `path` exactly once with a single slash separator.
  if (base.endsWith("/")) {
    return base.slice(0, -1) + path;
  }
  return base + path;
}

async function fetchJson<T>(
  url: string,
  schema: z.ZodSchema<T>,
): Promise<T> {
  let res: Response;
  try {
    res = await globalThis.fetch(url);
  } catch (cause: unknown) {
    throw new VerifyError(
      "rpc_unreachable",
      `fetch failed: ${cause instanceof Error ? cause.message : "unknown"}`,
      { url },
      cause,
    );
  }
  if (!res.ok) {
    throw new VerifyError(
      "http_non_200",
      `HTTP ${String(res.status)} from ${url}`,
      { status: String(res.status), url },
    );
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (cause: unknown) {
    throw new VerifyError(
      "invalid_response_shape",
      `response is not valid JSON: ${
        cause instanceof Error ? cause.message : "unknown"
      }`,
      { url },
      cause,
    );
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new VerifyError(
      "invalid_response_shape",
      `response did not match expected schema (${String(parsed.error.issues.length)} issues)`,
      {
        url,
        firstIssue: parsed.error.issues[0]
          ? parsed.error.issues[0].message
          : "no issues",
      },
    );
  }
  return parsed.data;
}

export async function fetchTee(baseUrl: string): Promise<TeeResponse> {
  const parsed = await fetchJson(
    joinUrl(baseUrl, "/api/tee"),
    teeResponseSchema,
  );
  // Re-pack to drop unknown fields (zod `.passthrough()` retains them)
  // and to satisfy `exactOptionalPropertyTypes`: omit `tipEventId`
  // entirely when undefined rather than including the explicit
  // `undefined` value.
  const out: TeeResponse =
    parsed.tipEventId !== undefined
      ? {
          signingPubKey: parsed.signingPubKey,
          attestationJwt: parsed.attestationJwt,
          active: parsed.active,
          tipEventId: parsed.tipEventId,
        }
      : {
          signingPubKey: parsed.signingPubKey,
          attestationJwt: parsed.attestationJwt,
          active: parsed.active,
        };
  return out;
}

export async function fetchConstitution(
  baseUrl: string,
): Promise<ConstitutionResponse> {
  const parsed = await fetchJson(
    joinUrl(baseUrl, "/api/constitution"),
    constitutionResponseSchema,
  );
  return {
    hash: parsed.hash,
    body: parsed.body,
  };
}

export async function fetchEvent(
  baseUrl: string,
  id: string,
): Promise<RawEventResponse> {
  const parsed = await fetchJson(
    joinUrl(baseUrl, `/api/events/${id}`),
    eventResponseSchema,
  );
  return parsed as unknown as RawEventResponse;
}
