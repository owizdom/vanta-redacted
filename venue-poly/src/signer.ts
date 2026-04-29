/**
 * Readiness + signing orchestrator for Safe meta-transactions.
 *
 * This module NEVER touches a private key. It receives a
 * caller-supplied `signDigest` function which takes a precomputed
 * EIP-712 digest and returns `(r, s, v)`. Typical implementations wrap
 * an EOA wallet's `personal_sign`-style method, or (when VANTA
 * operates sovereignly) the HKDF-derived secp256k1 wallet in
 * `@vanta/treasury`.
 *
 * Before signing, `assertReadyToSign` performs the two checks
 * canonical-reference §2 demands:
 *   1. Re-read `proxy.nonce()` at finality depth (head − 5 blocks) and
 *      assert it matches the `expectedNonce` baked into the SafeTx.
 *      Prevents the "same-nonce mempool clash" replay surface.
 *   2. Read `proxy.isOwner(ownerEOA)` and assert it is `true`. Prevents
 *      signing with an EOA that was removed from the proxy between
 *      SafeTx assembly and broadcast.
 *
 * Both checks fail loudly with typed errors; the pledge path gates on
 * them before a single byte of signature material enters existence.
 */

import type { PublicClient } from "viem";

import type { EthAddressHex, Sha256Hex } from "@vanta/tee";

import { SAFE_ABI } from "./abi/safe.js";
import { AMOY_CHAIN_ID, PLEDGE_CONFIRMATION_DEPTH } from "./constants.js";
import { VenuePolyError } from "./errors.js";
import {
  computeSafeTxHash,
  packThresholdOneSignature,
  type SafeSignature,
  type SafeTx,
} from "./safe.js";

/**
 * Injected-dependency contract for producing an ECDSA signature over a
 * precomputed digest. Intentionally narrow: we pass the digest, the
 * implementation returns `(r, s, v)`. No raw SafeTx leaves this module
 * to an untrusted signer implementation.
 */
export type SignDigestFn = (digest: Sha256Hex) => Promise<SafeSignature>;

export interface SignSafeTxArgs {
  readonly proxyAddress: EthAddressHex;
  readonly tx: SafeTx;
  readonly signDigest: SignDigestFn;
  readonly chainId: typeof AMOY_CHAIN_ID;
}

export interface SignSafeTxResult {
  readonly digest: Sha256Hex;
  readonly signatures: `0x${string}`;
}

function assertAmoyChain(client: PublicClient): void {
  const actual = client.chain?.id;
  if (actual !== AMOY_CHAIN_ID) {
    throw new VenuePolyError(
      "chain_id_mismatch",
      "venue-poly safe signer requires a PublicClient pinned to Polygon Amoy",
      {
        expectedChainId: String(AMOY_CHAIN_ID),
        actualChainId: actual === undefined ? "undefined" : String(actual),
      },
    );
  }
}

/**
 * Compute the SafeTx digest, call the injected `signDigest`, validate
 * `v`, and pack the 65-byte signature blob. Returns both the digest
 * and the packed signatures so the caller can audit what was signed.
 */
export async function signSafeTx(
  args: SignSafeTxArgs,
): Promise<SignSafeTxResult> {
  if (args.chainId !== AMOY_CHAIN_ID) {
    throw new VenuePolyError(
      "chain_id_mismatch",
      "signSafeTx requires chainId === 80002 (Polygon Amoy)",
      {
        expectedChainId: String(AMOY_CHAIN_ID),
        actualChainId: String(args.chainId),
      },
    );
  }
  const digest = computeSafeTxHash(args.proxyAddress, args.tx);
  const sig = await args.signDigest(digest);
  // `packThresholdOneSignature` re-validates `v`; this path funnels
  // every error through the same typed surface the direct caller sees.
  const signatures = packThresholdOneSignature(sig);
  return { digest, signatures };
}

/**
 * Pre-flight the two on-chain conditions required before signing:
 *
 *   1. `proxy.nonce()` at finality-depth (head − 5) equals
 *      `expectedNonce`.
 *   2. `proxy.isOwner(ownerEOA) === true`.
 *
 * Reads are performed through the supplied `PublicClient`, which the
 * caller is responsible for pinning to Polygon Amoy. We re-assert that
 * pin as a second gate.
 */
export async function assertReadyToSign(
  client: PublicClient,
  proxyAddress: EthAddressHex,
  expectedNonce: bigint,
  ownerEOA: EthAddressHex,
): Promise<void> {
  assertAmoyChain(client);

  // Read at finality depth (head − PLEDGE_CONFIRMATION_DEPTH). Use the
  // head block number first; if reorgs strike before our call, viem
  // will surface it as an RPC error which we wrap.
  let headBlockNumber: bigint;
  try {
    const head = await client.getBlock({ blockTag: "latest" });
    headBlockNumber = head.number;
  } catch (cause: unknown) {
    const msg = cause instanceof Error ? cause.message : "unknown";
    throw new VenuePolyError(
      "safe_read_failed",
      `safe readiness head-block read failed: ${msg}`,
      { op: "getBlock" },
    );
  }

  const finalityBlockNumber =
    headBlockNumber >= BigInt(PLEDGE_CONFIRMATION_DEPTH)
      ? headBlockNumber - BigInt(PLEDGE_CONFIRMATION_DEPTH)
      : 0n;

  let observedNonce: bigint;
  try {
    observedNonce = await client.readContract({
      address: proxyAddress,
      abi: SAFE_ABI,
      functionName: "nonce",
      blockNumber: finalityBlockNumber,
    });
  } catch (cause: unknown) {
    const msg = cause instanceof Error ? cause.message : "unknown";
    throw new VenuePolyError(
      "safe_read_failed",
      `safe readiness nonce read failed: ${msg}`,
      { op: "nonce" },
    );
  }

  if (observedNonce !== expectedNonce) {
    throw new VenuePolyError(
      "nonce_mismatch",
      "safe readiness: on-chain nonce at finality depth differs from expectedNonce",
      {
        expectedNonce: expectedNonce.toString(),
        observedNonce: observedNonce.toString(),
        finalityBlockNumber: finalityBlockNumber.toString(),
      },
    );
  }

  let isOwner: boolean;
  try {
    isOwner = await client.readContract({
      address: proxyAddress,
      abi: SAFE_ABI,
      functionName: "isOwner",
      args: [ownerEOA],
      blockNumber: finalityBlockNumber,
    });
  } catch (cause: unknown) {
    const msg = cause instanceof Error ? cause.message : "unknown";
    throw new VenuePolyError(
      "safe_read_failed",
      `safe readiness isOwner read failed: ${msg}`,
      { op: "isOwner" },
    );
  }

  if (!isOwner) {
    throw new VenuePolyError(
      "owner_not_on_proxy",
      "safe readiness: supplied ownerEOA is not an owner of the proxy",
      {
        proxyAddress,
        ownerEOA,
      },
    );
  }
}
