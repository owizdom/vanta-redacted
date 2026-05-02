/**
 * X402 outbound client — symmetric counterpart of the inbound
 * `installX402Hook` plugin in `x402.ts`. Wraps fetch so that any 402
 * challenge from a remote service is auto-settled by the treasury
 * walletClient.
 *
 * Flow:
 *   1. fire the request as-is
 *   2. on 200, return as-is
 *   3. on 402, parse the EigenCloud x402 challenge body, build an
 *      EIP-3009 `TransferWithAuthorization` payload, sign it via the
 *      treasury walletClient (the signer here is the *payer*, not the
 *      relayer — the remote's relayer settles on chain), base64-encode
 *      into `X-PAYMENT`, and retry the request.
 *   4. return the second response (200 with `X-PAYMENT-RESPONSE`).
 *
 * On a successful settlement, the optional `onSettled` callback is
 * invoked so the runtime can emit a signed `treasury.outflow` +
 * sibling `reasoning.trace` event. Settlement gas is paid by the
 * remote's relayer (the relayer broadcasts `transferWithAuthorization`
 * against USDC on chain and pays the gas) — this client only signs the
 * EIP-712 payload.
 */

import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";

import type { Address, Hex, WalletClient } from "viem";

import { EIP3009_TYPES } from "./x402.js";

/** A single `accepts` entry from the 402 challenge. */
interface X402Accept {
  readonly scheme: string;
  readonly network: string;
  readonly maxAmountRequired: string; // USDC wei (6 decimals)
  readonly resource?: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly payTo: Address;
  readonly maxTimeoutSeconds?: number;
  readonly asset: Address;
  readonly extra?: {
    readonly name?: string;
    readonly version?: string;
  };
}

interface X402Challenge {
  readonly x402Version: number;
  readonly error?: string;
  readonly accepts: readonly X402Accept[];
}

export interface X402ClientOpts {
  /** The treasury walletClient — signs the EIP-712 payload. */
  readonly walletClient: WalletClient;
  /**
   * The default chain id for the EIP-712 domain. The challenge SHOULD
   * specify a network (e.g. "base-sepolia"); we fall back to this when
   * it doesn't, since some servers omit the network field.
   */
  readonly defaultChainId: number;
  /**
   * Tighten the challenge match — refuse to settle if the asset doesn't
   * match this address (cap-style defense against an attacker-controlled
   * server pointing at a different ERC-20).
   */
  readonly allowedAsset?: Address;
  /**
   * Reject the challenge if `maxAmountRequired` exceeds this USDC6 cap.
   * Defends against a vendor returning a bogus 402 for a 1000-USDC
   * charge per call. Default: 100_000 = 0.1 USDC. Per-call hosting
   * surfaces should be far below this.
   */
  readonly maxPerCallUsdc6?: bigint;
  /** Optional fetch impl — for tests / custom transports. */
  readonly fetchImpl?: typeof fetch;
  /**
   * Hook fired after a 402 → 200 settlement returns successfully.
   * Used by main.ts / inference path to emit the
   * `treasury.outflow` + sibling `reasoning.trace` events.
   */
  readonly onSettled?: (info: SettlementReceipt) => Promise<void> | void;
}

export interface SettlementReceipt {
  readonly amountUsdc6: bigint;
  readonly payTo: Address;
  readonly asset: Address;
  readonly resource: string;
  readonly nonce: Hex;
  readonly chainId: number;
  /** Decoded settlement receipt from the server's X-PAYMENT-RESPONSE. */
  readonly serverReceipt: {
    readonly success: boolean;
    readonly transaction?: string;
    readonly blockNumber?: number;
  } | null;
}

const DEFAULT_MAX_PER_CALL_USDC6 = 100_000n; // 0.1 USDC
const DEFAULT_VALIDITY_SECS = 60;
const CLOCK_SKEW_SECS = 30;

function decodeBase64Json<T>(b64: string): T | null {
  try {
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as T;
  } catch {
    return null;
  }
}

function encodeBase64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function readNonceHex(): Hex {
  return `0x${randomBytes(32).toString("hex")}` as Hex;
}

function pickAccept(
  challenge: X402Challenge,
  opts: X402ClientOpts,
): X402Accept | { error: string } {
  if (!Array.isArray(challenge.accepts) || challenge.accepts.length === 0) {
    return { error: "challenge_missing_accepts" };
  }
  // Take the first `exact` scheme entry — matches the inbound plugin's
  // choice and the spec's reference implementation.
  const accept = challenge.accepts.find((a) => a.scheme === "exact");
  if (!accept) return { error: "no_exact_scheme" };

  if (opts.allowedAsset && accept.asset.toLowerCase() !== opts.allowedAsset.toLowerCase()) {
    return { error: `asset_mismatch:expected=${opts.allowedAsset},got=${accept.asset}` };
  }
  let amt: bigint;
  try {
    amt = BigInt(accept.maxAmountRequired);
  } catch {
    return { error: "amount_parse_failed" };
  }
  const cap = opts.maxPerCallUsdc6 ?? DEFAULT_MAX_PER_CALL_USDC6;
  if (amt > cap) {
    return { error: `amount_above_cap:${amt.toString()}>${cap.toString()}` };
  }
  return accept;
}

async function buildPaymentHeader(
  accept: X402Accept,
  opts: X402ClientOpts,
): Promise<{ header: string; nonce: Hex; chainId: number; amount: bigint }> {
  const account = opts.walletClient.account;
  if (!account) throw new Error("x402-client: walletClient has no bound account");
  const from = account.address as Address;

  const value = BigInt(accept.maxAmountRequired);
  const now = Math.floor(Date.now() / 1000);
  const validAfter = BigInt(Math.max(0, now - CLOCK_SKEW_SECS));
  const validBefore = BigInt(now + (accept.maxTimeoutSeconds ?? DEFAULT_VALIDITY_SECS));
  const nonce = readNonceHex();

  // Resolve EIP-712 domain. USDC v2: name="USDC", version="2".
  const tokenName = accept.extra?.name ?? "USDC";
  const tokenVersion = accept.extra?.version ?? "2";
  // Chain id: prefer the one in the challenge (mapped from network),
  // else default to opts.defaultChainId.
  const chainId =
    accept.network === "base-sepolia"
      ? 84532
      : accept.network === "base"
        ? 8453
        : opts.defaultChainId;

  const signature = await opts.walletClient.signTypedData({
    account,
    domain: {
      name: tokenName,
      version: tokenVersion,
      chainId,
      verifyingContract: accept.asset,
    },
    types: EIP3009_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from,
      to: accept.payTo,
      value,
      validAfter,
      validBefore,
      nonce,
    },
  });

  const envelope = {
    x402Version: 1,
    scheme: "exact",
    network: accept.network,
    payload: {
      signature,
      authorization: {
        from,
        to: accept.payTo,
        value: value.toString(),
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
    },
  };
  return {
    header: encodeBase64Json(envelope),
    nonce,
    chainId,
    amount: value,
  };
}

/**
 * Wrap a single fetch call with x402 auto-settlement. If the first
 * response is 402, sign + retry. Otherwise return the response as-is.
 *
 * Throws only on transport / signature errors — application-level
 * errors (5xx, repeated 402, etc.) are returned to the caller as a
 * Response object so the inference layer can decide whether to retry.
 */
export async function fetchWithX402(
  url: string,
  init: RequestInit | undefined,
  opts: X402ClientOpts,
): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const first = await fetchImpl(url, init);
  if (first.status !== 402) return first;

  // Read the challenge body. Preserve the response if parsing fails so
  // the caller sees the original 402 instead of a synthesized error.
  let challenge: X402Challenge | null = null;
  try {
    challenge = (await first.clone().json()) as X402Challenge;
  } catch {
    return first;
  }
  if (!challenge || challenge.x402Version !== 1) return first;

  const picked = pickAccept(challenge, opts);
  if ("error" in picked) {
    // Surface the rejection by returning the original 402 — caller can
    // log + decide. We don't synthesize a body here because the inbound
    // plugin's challengeBody is well-formed and informative.
    return first;
  }

  const built = await buildPaymentHeader(picked, opts);

  // Retry with X-PAYMENT.
  const retryHeaders = new Headers(init?.headers ?? {});
  retryHeaders.set("X-PAYMENT", built.header);
  const retryInit: RequestInit = {
    ...(init ?? {}),
    headers: retryHeaders,
  };
  const second = await fetchImpl(url, retryInit);

  if (second.ok && opts.onSettled) {
    // Decode the settlement receipt header if present.
    const respHeader = second.headers.get("X-PAYMENT-RESPONSE");
    const serverReceipt = respHeader
      ? decodeBase64Json<{
          success: boolean;
          transaction?: string;
          blockNumber?: number;
        }>(respHeader)
      : null;
    try {
      await opts.onSettled({
        amountUsdc6: built.amount,
        payTo: picked.payTo,
        asset: picked.asset,
        resource: picked.resource ?? url,
        nonce: built.nonce,
        chainId: built.chainId,
        serverReceipt,
      });
    } catch {
      // onSettled is best-effort — never break the response on a
      // logging failure.
    }
  }

  return second;
}

/** Convenience: a fetch-shaped function bound to a single set of opts. */
export function createX402Fetch(opts: X402ClientOpts): typeof fetch {
  return ((url: string | URL, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    return fetchWithX402(u, init, opts);
  }) as typeof fetch;
}
