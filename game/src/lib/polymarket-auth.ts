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

interface BuilderApiKeyListEntry {
  readonly key: string;
  readonly createdAt?: string;
  readonly revokedAt?: string;
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
 * Two-step credential derivation: L1 sign → CLOB creds → bootstrap
 * Builder creds. **Builder creds are what the relayer accepts**, not
 * CLOB creds (the relayer's `POLY_BUILDER_*` namespace is disjoint
 * from CLOB's `POLY_*` L2 namespace). We persist only the Builder
 * triple, since that's what every relayer call HMACs against.
 *
 * Flow:
 *   1. EIP-712 sign ClobAuth domain
 *   2. GET /auth/derive-api-key — idempotent, deterministic CLOB creds
 *   3. POST /auth/builder-api-key, L2-auth'd with the CLOB creds —
 *      returns fresh Builder creds. POST creates a new builder key
 *      each call; on hitting Polymarket's per-account quota the
 *      endpoint 4xx's and we surface the error so the user can
 *      revoke one in polymarket.com developer settings.
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

  // 1. CLOB creds (idempotent, no quota — `POST /auth/api-key` would
  // create a fresh CLOB triple each time and quickly hit the 5-key
  // ceiling for any long-time Polymarket user).
  const clobRes = await fetch(`${CLOB_BASE}/auth/derive-api-key`, {
    method: "GET",
    headers: {
      POLY_ADDRESS: args.eoa,
      POLY_SIGNATURE: signature,
      POLY_TIMESTAMP: timestamp,
      POLY_NONCE: "0",
    },
  });
  if (!clobRes.ok) {
    throw new Error(
      `clob derive-api-key ${String(clobRes.status)}: ${(await clobRes.text()).slice(0, 200)}`,
    );
  }
  const clobOut = (await clobRes.json()) as {
    apiKey?: string;
    secret?: string;
    passphrase?: string;
  };
  if (
    typeof clobOut.apiKey !== "string" ||
    typeof clobOut.secret !== "string" ||
    typeof clobOut.passphrase !== "string"
  ) {
    throw new Error(
      `clob auth-key: missing credential fields in response ${JSON.stringify(clobOut).slice(0, 200)}`,
    );
  }
  const clobCreds: ApiCreds = {
    key: clobOut.apiKey,
    secret: clobOut.secret,
    passphrase: clobOut.passphrase,
  };

  // 2. List existing builder keys — if any unrevoked one is already
  // registered for this user, we can't recover its secret (the GET
  // shape doesn't surface it) but knowing it's there tells us to use
  // `POST` of an *additional* key rather than tripping the quota
  // check on a duplicate. In practice Polymarket allows multiple
  // active builder keys per account so the POST below is safe; this
  // GET is observational only and used to give better errors.
  const listTs = Math.floor(Date.now() / 1000);
  const listSig = await buildHmacSignature(
    clobCreds.secret,
    listTs,
    "GET",
    "/auth/builder-api-key",
  );
  await fetch(`${CLOB_BASE}/auth/builder-api-key`, {
    method: "GET",
    headers: {
      POLY_ADDRESS: args.eoa,
      POLY_API_KEY: clobCreds.key,
      POLY_PASSPHRASE: clobCreds.passphrase,
      POLY_SIGNATURE: listSig,
      POLY_TIMESTAMP: String(listTs),
    },
  });

  // 3. Create a fresh Builder key. The response is the only place
  // the HMAC secret is ever returned in cleartext — persist
  // immediately. If you need to rotate later, revoke + recreate.
  const createTs = Math.floor(Date.now() / 1000);
  const createSig = await buildHmacSignature(
    clobCreds.secret,
    createTs,
    "POST",
    "/auth/builder-api-key",
  );
  const builderRes = await fetch(`${CLOB_BASE}/auth/builder-api-key`, {
    method: "POST",
    headers: {
      POLY_ADDRESS: args.eoa,
      POLY_API_KEY: clobCreds.key,
      POLY_PASSPHRASE: clobCreds.passphrase,
      POLY_SIGNATURE: createSig,
      POLY_TIMESTAMP: String(createTs),
    },
  });
  if (!builderRes.ok) {
    throw new Error(
      `clob create-builder-key ${String(builderRes.status)}: ${(await builderRes.text()).slice(0, 200)}`,
    );
  }
  const builderOut = (await builderRes.json()) as Partial<ApiCreds> & {
    apiKey?: string;
  };
  // Polymarket has been inconsistent with `apiKey` vs `key` field
  // naming across services — accept either.
  const builderKey =
    typeof builderOut.key === "string"
      ? builderOut.key
      : typeof builderOut.apiKey === "string"
        ? builderOut.apiKey
        : undefined;
  if (
    typeof builderKey !== "string" ||
    typeof builderOut.secret !== "string" ||
    typeof builderOut.passphrase !== "string"
  ) {
    throw new Error(
      `clob create-builder-key: missing credential fields ${JSON.stringify(builderOut).slice(0, 200)}`,
    );
  }
  return {
    key: builderKey,
    secret: builderOut.secret,
    passphrase: builderOut.passphrase,
  };
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
