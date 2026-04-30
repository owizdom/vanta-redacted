/**
 * Broadcast `LoanBook.originate(...)` and wait for a confirmed receipt.
 *
 * The two-phase shape is load-bearing for I-OR-3' (post-image):
 *
 *   1. `writeContract({...})` returns a tx hash; the tx is in the
 *      mempool but unconfirmed.
 *   2. We poll `getTransactionReceipt(hash)` until a receipt exists AND
 *      `currentHead - receipt.blockNumber + 1 >= finalityDepth`.
 *   3. At that point we re-read the receipt one more time and confirm
 *      `receipt.blockHash` matches the value we observed at first
 *      confirmation. A different blockHash signals a reorg between the
 *      two reads — we surface it as `params_hash_mismatch` so the
 *      orchestrator can refuse to sign the post-image event.
 *
 * Throws `OriginationError` with one of:
 *   - `loanbook_call_failed` — wallet client refused or revert-on-broadcast.
 *   - `finality_timeout`     — receipt did not arrive at the configured
 *                              depth within the polling budget.
 *   - `params_hash_mismatch` — block hash drift between first and final
 *                              confirmation reads.
 *   - `rpc_unreachable`      — `getBlockNumber` / receipt read failed.
 */

import type {
  Address,
  Hex,
  PublicClient,
  TransactionReceipt,
  WalletClient,
} from "viem";

import { LOAN_BOOK_ABI } from "./abi.js";
import { OriginationError } from "./errors.js";

/** Default finality depth for I-OR-3' (post-image). Base Sepolia is fast. */
export const ORIGINATION_FINALITY_DEPTH = 2;

/** Default poll cadence (ms). 1.5s pairs with Base's ~2s block time. */
const POLL_INTERVAL_MS_DEFAULT = 1500;

/** Default overall timeout (ms). 120s absorbs RPC jitter on a healthy net. */
const FINALITY_TIMEOUT_MS_DEFAULT = 120_000;

export interface BroadcastOriginateArgs {
  readonly walletClient: WalletClient;
  /**
   * Public client pinned to the same chain as the wallet client; we
   * read receipts and block heads via this client so a separate RPC URL
   * (e.g. for archive reads) can be plumbed without forking the writer.
   */
  readonly publicClient: PublicClient;
  readonly loanBookAddress: Address;
  readonly originateArgs: {
    readonly loanId: Hex;
    readonly borrower: Address;
    readonly principal: bigint;
    readonly haircutBps: number;
    readonly maturityTs: bigint;
    readonly attestationHash: Hex;
  };
  readonly finalityDepth?: number;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface BroadcastOriginateResult {
  readonly txHash: Hex;
  readonly blockNumber: number;
  readonly blockHash: Hex;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Submit `LoanBook.originate(...)` and wait until the receipt is
 * `finalityDepth` blocks deep.
 */
export async function broadcastOriginate(
  args: BroadcastOriginateArgs,
): Promise<BroadcastOriginateResult> {
  const finalityDepth = args.finalityDepth ?? ORIGINATION_FINALITY_DEPTH;
  const pollIntervalMs = args.pollIntervalMs ?? POLL_INTERVAL_MS_DEFAULT;
  const timeoutMs = args.timeoutMs ?? FINALITY_TIMEOUT_MS_DEFAULT;
  const nowFn = args.now ?? Date.now;
  const sleepFn = args.sleep ?? defaultSleep;
  const startedAt = nowFn();

  // ---- Step 1: submit the tx ------------------------------------------------
  let txHash: Hex;
  try {
    // viem's writeContract requires `chain` + `account` to be set on the
    // wallet client. We delegate that to the caller; here we only need
    // the hash back.
    const writeReq = {
      address: args.loanBookAddress,
      abi: LOAN_BOOK_ABI,
      functionName: "originate",
      args: [
        args.originateArgs.loanId,
        args.originateArgs.borrower,
        args.originateArgs.principal,
        args.originateArgs.haircutBps,
        args.originateArgs.maturityTs,
        args.originateArgs.attestationHash,
      ],
    } as const;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    txHash = await (args.walletClient as unknown as {
      writeContract: (req: unknown) => Promise<Hex>;
    }).writeContract(writeReq);
  } catch (cause: unknown) {
    throw new OriginationError(
      "loanbook_call_failed",
      "writeContract(LoanBook.originate) failed at submission",
      {
        loanBookAddress: args.loanBookAddress,
        loanId: args.originateArgs.loanId,
      },
      cause,
    );
  }

  // ---- Step 2: poll for first-confirmation receipt -------------------------
  const minDepthBig = BigInt(finalityDepth);
  let firstConfirm: TransactionReceipt | null = null;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let receipt: TransactionReceipt | null = null;
    try {
      // eslint-disable-next-line no-await-in-loop
      receipt = await args.publicClient.getTransactionReceipt({ hash: txHash });
    } catch {
      // viem throws TransactionReceiptNotFoundError until mined; retry.
      receipt = null;
    }

    if (receipt !== null) {
      let head: bigint;
      try {
        // eslint-disable-next-line no-await-in-loop
        head = await args.publicClient.getBlockNumber();
      } catch (cause: unknown) {
        throw new OriginationError(
          "rpc_unreachable",
          "getBlockNumber failed while tracking finality",
          { txHash },
          cause,
        );
      }
      const depth = head - receipt.blockNumber + 1n;
      if (depth >= minDepthBig) {
        firstConfirm = receipt;
        break;
      }
    }

    if (nowFn() - startedAt >= timeoutMs) {
      throw new OriginationError(
        "finality_timeout",
        "LoanBook.originate did not reach the required confirmation depth within the timeout",
        {
          txHash,
          finalityDepth: String(finalityDepth),
          timeoutMs: String(timeoutMs),
        },
      );
    }

    // eslint-disable-next-line no-await-in-loop
    await sleepFn(pollIntervalMs);
  }

  if (firstConfirm.status !== "success") {
    throw new OriginationError(
      "loanbook_call_failed",
      "LoanBook.originate tx receipt reports non-success status",
      { txHash, status: String(firstConfirm.status) },
    );
  }

  // ---- Step 3: re-read receipt at finality, detect block-hash drift -------
  let finalReceipt: TransactionReceipt | null = null;
  try {
    finalReceipt = await args.publicClient.getTransactionReceipt({
      hash: txHash,
    });
  } catch (cause: unknown) {
    throw new OriginationError(
      "rpc_unreachable",
      "getTransactionReceipt failed during finality re-read",
      { txHash },
      cause,
    );
  }

  if (finalReceipt === null) {
    // Receipt vanished between first-confirm and finality — definite reorg.
    throw new OriginationError(
      "params_hash_mismatch",
      "tx receipt vanished between first confirmation and finality re-read (reorg)",
      { txHash },
    );
  }

  if (finalReceipt.blockHash !== firstConfirm.blockHash) {
    throw new OriginationError(
      "params_hash_mismatch",
      "block hash differs between first-confirm and finality re-read (reorg)",
      {
        txHash,
        firstConfirmBlockHash: firstConfirm.blockHash,
        finalBlockHash: finalReceipt.blockHash,
      },
    );
  }

  return {
    txHash,
    blockNumber: Number(finalReceipt.blockNumber),
    blockHash: finalReceipt.blockHash,
  };
}
