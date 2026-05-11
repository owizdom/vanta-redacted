/**
 * Polymarket L1 auth + Builder HMAC — derives a per-user API
 * credential triple `{key, secret, passphrase}` from a single EIP-712
 * signature, then signs subsequent relayer requests with builder
 * HMAC headers. Replaces the manual "paste your RELAYER_API_KEY" UX.
 *
 * Two endpoints:
 *   - L1 auth   : `POST clob.polymarket.com/auth/api-key` returns
 *                 fresh creds when called with a valid EIP-712
 *                 ClobAuth signature. CORS is `*` so the browser can
 *                 hit it directly.
 *   - L2 / Builder: `relayer-v2.polymarket.com/submit` accepts
 *                 `POLY_BUILDER_*` HMAC headers (verified via CORS
 *                 preflight). Same `{key, secret, passphrase}` triple
 *                 the CLOB issues.
 *
 * The signing scheme + HMAC details mirror Polymarket's open-source
 * `@polymarket/clob-client` (`src/signing`, `src/headers`) so the
 * server-side verifier accepts our requests. Built in-house rather
 * than imported to keep the bundle slim and avoid ethers-v5 dragging.
 */

import type { Address, Hex } from "viem";

const CLOB_BASE = "https://clob.polymarket.com";
const CLOB_AUTH_MESSAGE = "This message attests that I control the given wallet";

export interface ApiCreds {
  /** Polymarket-issued opaque key id. */
  readonly key: string;
  /** Base64-encoded HMAC secret. */
  readonly secret: string;
  /** Polymarket-issued passphrase string. */
  readonly passphrase: string;
}

const CLOB_AUTH_TYPES = {
  ClobAuth: [
    { name: "address", type: "address" },
    { name: "timestamp", type: "string" },
    { name: "nonce", type: "uint256" },
    { name: "message", type: "string" },
  ],
} as const;

export interface DeriveApiKeyArgs {
  readonly eoa: Address;
  /** Chain id for the EIP-712 domain. Polygon mainnet = 137. */
  readonly chainId: number;
  /** wagmi `signTypedDataAsync` — signs the ClobAuth typed message. */
  readonly signTypedData: (args: {
    readonly domain: {
      readonly name: "ClobAuthDomain";
      readonly version: "1";
      readonly chainId: number;
    };
    readonly types: typeof CLOB_AUTH_TYPES;
    readonly primaryType: "ClobAuth";
    readonly message: {
      readonly address: Address;
      readonly timestamp: string;
      readonly nonce: bigint;
      readonly message: string;
    };
  }) => Promise<Hex>;
}

/**
 * Sign a ClobAuth EIP-712 message, then POST to the CLOB
 * `/auth/api-key` endpoint. Returns the issued credentials.
 *
 * Polymarket reissues credentials each call — caller should persist
 * the returned triple (e.g. `localStorage`) so we sign only once per
 * browser session.
 */
export async function deriveApiKey(args: DeriveApiKeyArgs): Promise<ApiCreds> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = 0n;

  const signature = await args.signTypedData({
    domain: {
      name: "ClobAuthDomain",
      version: "1",
      chainId: args.chainId,
    },
    types: CLOB_AUTH_TYPES,
    primaryType: "ClobAuth",
    message: {
      address: args.eoa,
      timestamp,
      nonce,
      message: CLOB_AUTH_MESSAGE,
    },
  });

  // `/auth/derive-api-key` is idempotent — deterministic credentials
  // for a given (eoa, signature) pair, no quota issues. The sibling
  // `POST /auth/api-key` *creates* new keys and 400s with "Could not
  // create api key" once the user's key quota is hit, which most
  // long-time Polymarket users have already exceeded. See clob-client
  // `deriveApiKey()` for the canonical implementation.
  const res = await fetch(`${CLOB_BASE}/auth/derive-api-key`, {
    method: "GET",
    headers: {
      POLY_ADDRESS: args.eoa,
      POLY_SIGNATURE: signature,
      POLY_TIMESTAMP: timestamp,
      POLY_NONCE: "0",
    },
  });
  if (!res.ok) {
    throw new Error(
      `clob derive-api-key ${String(res.status)}: ${(await res.text()).slice(0, 200)}`,
    );
  }
  const out = (await res.json()) as {
    apiKey?: string;
    secret?: string;
    passphrase?: string;
  };
  if (
    typeof out.apiKey !== "string" ||
    typeof out.secret !== "string" ||
    typeof out.passphrase !== "string"
  ) {
    throw new Error(
      `clob auth-key: missing credential fields in response ${JSON.stringify(out).slice(0, 200)}`,
    );
  }
  return { key: out.apiKey, secret: out.secret, passphrase: out.passphrase };
}

/**
 * Convert a base64 / base64url string to a Uint8Array. Polymarket
 * returns the HMAC secret as base64url (RFC 4648 §5) so we need to
 * normalize `-`→`+`, `_`→`/` before atob (per the clob-client
 * `signing/hmac.ts` reference).
 */
function base64ToBytes(b64: string): ArrayBuffer {
  const normalized = b64.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out.buffer;
}

function bytesToBase64Url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.byteLength; i++)
    bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * Compute the canonical Polymarket HMAC signature over
 * `timestamp + method + path + body`. Url-safe base64. Used for both
 * CLOB L2 calls and relayer Builder headers (Polymarket runs the same
 * verifier on both surfaces).
 */
export async function buildHmacSignature(
  secret: string,
  timestamp: number,
  method: string,
  requestPath: string,
  body?: string,
): Promise<string> {
  const message = `${String(timestamp)}${method}${requestPath}${body ?? ""}`;
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    base64ToBytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return bytesToBase64Url(sig);
}

export interface BuilderHeaderArgs {
  readonly creds: ApiCreds;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: string;
  readonly timestamp?: number;
}

/**
 * Construct the four `POLY_BUILDER_*` headers the relayer expects
 * when authenticated by issuer key (vs `RELAYER_API_KEY` opaque mode).
 * `path` should be a relayer-rooted path like `/submit`.
 */
export async function builderHeaders(
  args: BuilderHeaderArgs,
): Promise<Record<string, string>> {
  const ts = args.timestamp ?? Math.floor(Date.now() / 1000);
  const sig = await buildHmacSignature(
    args.creds.secret,
    ts,
    args.method,
    args.path,
    args.body,
  );
  return {
    POLY_BUILDER_API_KEY: args.creds.key,
    POLY_BUILDER_PASSPHRASE: args.creds.passphrase,
    POLY_BUILDER_SIGNATURE: sig,
    POLY_BUILDER_TIMESTAMP: String(ts),
  };
}
