/**
 * HTTP client with TLS SPKI pinning and attestation capture.
 *
 * Why Node `https` instead of `fetch`:
 *   `fetch` (undici) does not expose the negotiated TLS certificate.
 *   We need the leaf cert's SPKI DER to check against a pinned SHA-256.
 *   Node's `https.request` emits `secureConnect` on the socket, from
 *   which we can reach `socket.getPeerCertificate(true)` and extract
 *   `pubkey.export({type: 'spki', format: 'der'})`.
 *
 * Pipeline per request (canonical-reference.md §4.5, I-MK-4):
 *   1. Open a TLS socket to {host}{path}.
 *   2. On `secureConnect`, compute sha256(SPKI-DER) of the leaf cert
 *      and compare to the caller-supplied pin set (default: the
 *      canonical constant). Destroy the socket and reject on mismatch.
 *   3. Read the HTTP status + headers + body.
 *   4. On non-200, throw MarkError(`http_non_200`) with status+host+path
 *      in context.
 *   5. Parse the body as JSON; validate with the caller's zod schema.
 *   6. Compute `response_etag_or_digest`: use the `ETag` response
 *      header if present; else `sha256:{hex}` of the raw bytes. Both
 *      pass the events-schema ETag regex.
 *   7. Return `{ body, attestation }`.
 *
 * `httpGetWithAttestation` is the only exported surface. Every caller
 * in `clob.ts` goes through this single bottleneck. `__test` helpers
 * below are exposed via the index barrel *only* for test harnesses that
 * need to exercise specific internal helpers without spinning up a TLS
 * server. Production callers MUST NOT import from `__test`.
 */

import { createHash, X509Certificate, type KeyObject } from "node:crypto";
import * as https from "node:https";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import type { TLSSocket, DetailedPeerCertificate } from "node:tls";

import type { z } from "zod";

import { TLS_SPKI_SHA256_PIN } from "./constants.js";
import { MarkError } from "./errors.js";
import type { SourceAttestation } from "./types.js";

/**
 * Optional per-request overrides. `pinSet` defaults to the canonical
 * constant; tests inject a synthetic pin set; production can pass a
 * two-pin set covering leaf + intermediate so Google Trust Services
 * leaf-rotation (60-90d) doesn't page the watcher mid-epoch.
 *
 * `agent` is injectable so unit tests can mount a fake http-agent that
 * returns a programmed response without opening a real socket.
 */
export interface HttpGetWithAttestationOpts<T> {
  readonly host: string;
  readonly path: string;
  readonly schema: z.ZodType<T>;
  readonly pinSet?: readonly string[];
  readonly agent?: https.Agent | undefined;
  readonly port?: number;
  readonly timeoutMs?: number;
}

export interface HttpGetResult<T> {
  readonly body: T;
  readonly attestation: SourceAttestation;
}

/**
 * Shape we accept from `socket.getPeerCertificate(true)`. Node's type
 * for this surface is `DetailedPeerCertificate`, which carries the
 * `pubkey` `KeyObject` only on Node >= 17. We narrow to the field we
 * need and handle its absence as a pin-mismatch (fail closed).
 */
interface CertWithPubkey {
  readonly pubkey?: KeyObject;
}

/**
 * GET a resource, enforce the TLS SPKI pin on the leaf cert, decode the
 * body with the caller's zod schema, and return the decoded body + the
 * source attestation bundle for I-MK-4. On TLS-pin failure, HTTP
 * non-200, or schema validation failure, throws MarkError with a
 * structured code.
 */
export async function httpGetWithAttestation<T>(
  opts: HttpGetWithAttestationOpts<T>,
): Promise<HttpGetResult<T>> {
  const pins: readonly string[] =
    opts.pinSet !== undefined && opts.pinSet.length > 0
      ? opts.pinSet
      : [TLS_SPKI_SHA256_PIN];
  const timeoutMs =
    typeof opts.timeoutMs === "number" && opts.timeoutMs > 0
      ? opts.timeoutMs
      : 10_000;

  return new Promise<HttpGetResult<T>>((resolve, reject) => {
    const requestOpts: RequestOptions = {
      host: opts.host,
      port: typeof opts.port === "number" ? opts.port : 443,
      path: opts.path,
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "vanta-mark/0.0.0",
      },
      agent: opts.agent ?? false,
    };

    let capturedSpki: string | null = null;

    const req = https.request(requestOpts, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      res.on("end", () => {
        try {
          const raw = Buffer.concat(chunks);
          const status = res.statusCode ?? 0;

          if (status !== 200) {
            reject(
              new MarkError(
                "http_non_200",
                `GET ${opts.host}${opts.path} returned HTTP ${String(status)}`,
                {
                  host: opts.host,
                  path: opts.path,
                  status: String(status),
                },
              ),
            );
            return;
          }

          const decoded = decodeJsonWithSchema(
            raw,
            opts.schema,
            opts.host,
            opts.path,
          );
          if (!decoded.ok) {
            reject(decoded.error);
            return;
          }

          const responseEtag = computeResponseEtagOrDigest(
            pickEtagHeader(res.headers.etag),
            raw,
          );

          const attestation: SourceAttestation = Object.freeze({
            clob_hostname: opts.host,
            tls_spki_sha256: capturedSpki ?? "",
            http_status: status,
            response_etag_or_digest: responseEtag,
          });

          resolve({ body: decoded.value, attestation });
        } catch (err: unknown) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });

    req.on("socket", (socket) => {
      const tlsSocket = socket as TLSSocket;
      tlsSocket.on("secureConnect", () => {
        try {
          const cert = tlsSocket.getPeerCertificate(
            true,
          ) as unknown as DetailedPeerCertificate & CertWithPubkey;
          // Two paths to the SPKI DER, both supported by Node 20:
          //   1) `cert.pubkey` — historically a `KeyObject` on Node >= 17,
          //      but on some 20.x builds returns the raw EC point as a
          //      Buffer. Use it when it's a KeyObject.
          //   2) `cert.raw` — full X.509 DER. Always present when the
          //      peer delivered a leaf cert; we wrap it in
          //      `X509Certificate` and read its `.publicKey` (KeyObject).
          //      This is the robust path; we use it whenever the direct
          //      pubkey field isn't a KeyObject.
          let spkiDer: Buffer | null = null;
          const pk = cert.pubkey;
          if (pk !== undefined && typeof (pk as KeyObject).export === "function") {
            spkiDer = (pk as KeyObject).export({
              type: "spki",
              format: "der",
            }) as Buffer;
          } else if (cert.raw instanceof Buffer && cert.raw.length > 0) {
            const x509 = new X509Certificate(cert.raw);
            spkiDer = x509.publicKey.export({
              type: "spki",
              format: "der",
            }) as Buffer;
          }
          if (spkiDer === null) {
            destroyWithPinFail(
              req,
              tlsSocket,
              reject,
              "cert_missing_pubkey",
              opts,
              pins,
            );
            return;
          }
          const spkiSha256 = createHash("sha256")
            .update(spkiDer)
            .digest("hex");

          if (!pins.includes(spkiSha256)) {
            destroyWithPinFail(
              req,
              tlsSocket,
              reject,
              "pin_mismatch",
              opts,
              pins,
              spkiSha256,
            );
            return;
          }
          capturedSpki = spkiSha256;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          tlsSocket.destroy();
          req.destroy();
          reject(
            new MarkError(
              "tls_spki_pin_mismatch",
              `SPKI extraction failed: ${msg}`,
              { host: opts.host, path: opts.path },
            ),
          );
        }
      });
    });

    req.on("error", (err: Error) => {
      reject(err);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`request to ${opts.host}${opts.path} timed out`));
    });
    req.end();
  });
}

/**
 * Destroy socket + request, and reject with a `tls_spki_pin_mismatch`
 * carrying the reason in context. Kept as a local helper so the callsite
 * stays single-line per failure mode.
 */
function destroyWithPinFail(
  req: ClientRequest,
  tlsSocket: TLSSocket,
  reject: (e: Error) => void,
  reason: string,
  opts: { readonly host: string; readonly path: string },
  pins: readonly string[],
  observedSpki?: string,
): void {
  tlsSocket.destroy();
  req.destroy();
  const context: Record<string, string> = {
    host: opts.host,
    path: opts.path,
    reason,
    pins_configured: String(pins.length),
  };
  if (observedSpki !== undefined) {
    context["observed_spki"] = observedSpki;
  }
  reject(
    new MarkError(
      "tls_spki_pin_mismatch",
      `TLS SPKI pin check failed (${reason})`,
      context,
    ),
  );
}

/**
 * Normalize an `ETag` header. Node's `headers.etag` is typed broadly;
 * pick the first scalar value. The returned string is passed into the
 * `loan.mark` source-attestation `response_etag_or_digest` field, which
 * the events-schema ETag regex caps at 128 chars; we truncate to stay
 * within that bound. Exposed (via `__test`) so http.test.ts can unit-check.
 */
function pickEtagHeader(raw: string | string[] | undefined): string | null {
  if (raw === undefined) return null;
  const single = Array.isArray(raw) ? raw[0] : raw;
  if (single === undefined || single.length === 0) return null;
  return single.slice(0, 128);
}

/**
 * If an ETag was supplied, return it verbatim. Otherwise return
 * `sha256:{hex}` of the raw response bytes. Always non-empty, always
 * within the 128-char events-schema cap (sha256 form is 71 chars).
 */
function computeResponseEtagOrDigest(
  etag: string | null,
  raw: Buffer,
): string {
  if (etag !== null) return etag;
  return "sha256:" + createHash("sha256").update(raw).digest("hex");
}

interface DecodeOk<T> {
  readonly ok: true;
  readonly value: T;
}
interface DecodeErr {
  readonly ok: false;
  readonly error: MarkError;
}

/**
 * Parse JSON and validate against `schema`. Returns a discriminated
 * result rather than throwing so the caller (which lives inside a
 * promise executor) can route cleanly to `reject`.
 */
function decodeJsonWithSchema<T>(
  raw: Buffer,
  schema: z.ZodType<T>,
  host: string,
  path: string,
): DecodeOk<T> | DecodeErr {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: new MarkError(
        "response_schema_invalid",
        `response body is not valid JSON: ${msg}`,
        { host, path },
      ),
    };
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    const fieldName =
      first !== undefined ? first.path.map(String).join(".") : "<root>";
    return {
      ok: false,
      error: new MarkError(
        "response_schema_invalid",
        `response failed schema validation: ${result.error.message}`,
        { host, path, field: fieldName },
      ),
    };
  }
  return { ok: true, value: result.data };
}

/**
 * Internal helpers exposed as a namespace for tests. Not part of the
 * public API; `__test` prefix discourages external consumers.
 */
export const __test = {
  pickEtagHeader,
  computeResponseEtagOrDigest,
  decodeJsonWithSchema,
};
