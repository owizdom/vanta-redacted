/**
 * Pledge-path Safe meta-tx builder + broadcaster.
 *
 * `buildPledgeExecTransaction` composes a `SafeTx` for the specific
 * calldata our pledge path submits: `CTF.safeTransferFrom(proxy, vault,
 * positionId, amount, "0x")` with `operation=0` (CALL). Every Safe gas
 * field is zeroed (canonical-reference §2 replay-proofing checklist).
 *
 * `signAndBroadcast` computes the SafeTx digest, calls the injected
 * `signDigest` to get `(r, s, v)`, packs the 65-byte signature via
 * venue-poly's `packThresholdOneSignature`, builds the
 * `proxy.execTransaction(...)` calldata, and broadcasts via the
 * injected `sendTransaction` function. The broadcaster contract is
 * narrow — we never pass a `WalletClient`, because the pledge module
 * should be callable from a TEE where a Node-native signer sends the
 * tx through an externally-operated wallet shim.
 */

import type { Hex, PublicClient } from "viem";
import { encodeFunctionData } from "viem";

import type { EthAddressHex, Sha256Hex } from "@vanta/tee";
import {
  AMOY_CHAIN_ID,
  CTF_ABI,
  CTF_ADDRESS,
  assertReadyToSign,
  buildExecTransactionPayload,
  computeSafeTxHash,
  type PositionId,
  type SafeTx,
  type SignDigestFn,
  signSafeTx,
} from "@vanta/venue-poly";

import { PledgeError } from "./errors.js";

/**
 * Narrow contract for the injected broadcaster. We deliberately avoid
 * viem's `WalletClient` type here so the pledge module stays agnostic
 * to the signer-side shim. Implementations commonly wrap
 * `walletClient.sendTransaction`, or a tee-held HKDF-derived wallet, or
 * a relayer pattern.
 */
export type SendExecTransactionFn = (args: {
  readonly to: EthAddressHex;
  readonly data: Hex;
  readonly value: bigint;
}) => Promise<Sha256Hex>;

export interface BuildPledgeExecTransactionArgs {
  readonly client: PublicClient;
  readonly borrowerProxy: EthAddressHex;
  readonly vaultAddress: EthAddressHex;
  readonly positionId: PositionId;
  readonly amount: bigint;
  readonly expectedNonce: bigint;
  readonly ownerEOA: EthAddressHex;
}

export interface BuildPledgeExecTransactionResult {
  readonly safeTx: SafeTx;
  readonly digest: Sha256Hex;
}

const ZERO_ADDRESS =
  "0x0000000000000000000000000000000000000000" as const satisfies EthAddressHex;

/**
 * Build the SafeTx that wraps `CTF.safeTransferFrom(proxy, vault, id,
 * amount, "0x")`. All Safe gas fields are zeroed. `operation: 0` is
 * pinned at the type level.
 *
 * Returns both the SafeTx and the EIP-712 digest so callers can log the
 * digest alongside the tx for audit trail.
 */
export async function buildPledgeExecTransaction(
  args: BuildPledgeExecTransactionArgs,
): Promise<BuildPledgeExecTransactionResult> {
  // Readiness gate — nonce and ownership consistency at finality depth.
  // `assertReadyToSign` throws a VenuePolyError on mismatch; we let it
  // propagate to keep typed signals distinct.
  await assertReadyToSign(
    args.client,
    args.borrowerProxy,
    args.expectedNonce,
    args.ownerEOA,
  );

  const calldata = encodeFunctionData({
    abi: CTF_ABI,
    functionName: "safeTransferFrom",
    args: [
      args.borrowerProxy,
      args.vaultAddress,
      args.positionId,
      args.amount,
      "0x" as Hex,
    ],
  });

  const safeTx: SafeTx = {
    to: CTF_ADDRESS,
    value: 0n,
    data: calldata,
    operation: 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: ZERO_ADDRESS,
    refundReceiver: ZERO_ADDRESS,
    nonce: args.expectedNonce,
  };

  const digest = computeSafeTxHash(args.borrowerProxy, safeTx);
  return { safeTx, digest };
}

export interface SignAndBroadcastArgs {
  readonly client: PublicClient;
  readonly borrowerProxy: EthAddressHex;
  readonly safeTx: SafeTx;
  readonly signDigest: SignDigestFn;
  readonly send: SendExecTransactionFn;
}

export interface SignAndBroadcastResult {
  readonly txHash: Sha256Hex;
  readonly safeTxHash: Sha256Hex;
}

/**
 * Sign the SafeTx, pack the 65-byte signature, build the
 * `execTransaction` calldata, and broadcast via the injected sender.
 * The broadcaster returns the raw tx hash which we normalise into an
 * unprefixed lowercase `Sha256Hex`.
 */
export async function signAndBroadcast(
  args: SignAndBroadcastArgs,
): Promise<SignAndBroadcastResult> {
  const { digest, signatures } = await signSafeTx({
    proxyAddress: args.borrowerProxy,
    tx: args.safeTx,
    signDigest: args.signDigest,
    chainId: AMOY_CHAIN_ID,
  });

  const execCalldata = buildExecTransactionPayload(args.safeTx, signatures);

  let txHash: Sha256Hex;
  try {
    txHash = await args.send({
      to: args.borrowerProxy,
      data: execCalldata,
      value: 0n,
    });
  } catch (cause: unknown) {
    throw new PledgeError(
      "safe_broadcast_failed",
      "execTransaction broadcast failed",
      { borrowerProxy: args.borrowerProxy },
      cause,
    );
  }

  return { txHash, safeTxHash: digest };
}
