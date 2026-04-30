/**
 * Finality gate + `TransferSingle` log extraction (I-PL-2 + I-PL-1 post-check).
 *
 * `awaitFinality` polls `getBlockNumber` until the tx receipt's block is
 * confirmed at depth >= `minDepth`. Once confirmed, it:
 *
 *   1. Asserts the receipt exists (a reorg between mining and the depth
 *      check surfaces as `receipt_not_available`).
 *   2. Locates the `TransferSingle` log emitted from the CTF with
 *      `(operator, from, to, id, value)` matching the pledge's
 *      `(borrower_proxy, borrower_proxy → vault, positionId, amount)`.
 *      The ERC-1155 `safeTransferFrom` emits `TransferSingle` with
 *      `from == borrower_proxy` and `to == vault_address`.
 *   3. Rejects `value == 0` (I-PL-2 extension: a zero-value pledge is
 *      meaningless and the event-schema refinement would strip it; we
 *      fail loudly here so the orchestrator never hits a schema reject
 *      for an on-chain-observed condition).
 *
 * `reReadVaultBalance` is the I-PL-1 step: re-read the vault's ERC-1155
 * balance at the confirmed block to catch the pathological case where
 * the `TransferSingle` log is present but a subsequent in-block `revert`
 * undid it (practically impossible — the log would not be emitted — but
 * the re-read is a cheap paranoia check the canonical reference
 * explicitly demands).
 */

import type { Hex, PublicClient, TransactionReceipt } from "viem";
import {
  decodeEventLog,
  getAddress,
  keccak256,
  toBytes,
} from "viem";

import type { EthAddressHex, Sha256Hex } from "@vanta/tee";
import { asSha256Hex } from "@vanta/tee";
import {
  AMOY_CHAIN_ID,
  CTF_ABI,
  CTF_ADDRESS,
  readBalance,
  type PositionId,
} from "@vanta/venue-poly";

import { PledgeError } from "./errors.js";
import type { TransferSingleLog } from "./types.js";

const TRANSFER_SINGLE_TOPIC: Hex = keccak256(
  toBytes("TransferSingle(address,address,address,uint256,uint256)"),
);

/**
 * Poll interval for finality tracking (ms). 1s is a safe default for
 * Amoy's ~2s block time; keeps the test suite fast.
 */
const POLL_INTERVAL_MS_DEFAULT = 1000;

/**
 * Overall finality-await timeout (ms). Amoy Heimdall v2 nominally hits
 * 5-block depth in ~10s; the cap is 120s to absorb RPC jitter. Tests
 * inject a shorter cap to keep them fast and to exercise the
 * `finality_timeout` branch.
 */
const FINALITY_TIMEOUT_MS_DEFAULT = 120_000;

export interface AwaitFinalityArgs {
  readonly client: PublicClient;
  readonly txHash: Sha256Hex;
  readonly minDepth: number;
  readonly expectedOperator: EthAddressHex;
  readonly expectedFrom: EthAddressHex;
  readonly expectedTo: EthAddressHex;
  readonly expectedId: bigint;
  readonly expectedAmount: bigint;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface AwaitFinalityResult {
  readonly blockNumber: number;
  readonly blockHash: Sha256Hex;
  readonly logIndex: number;
  readonly log: TransferSingleLog;
}

function assertAmoyChain(client: PublicClient): void {
  const actual = client.chain?.id;
  if (actual !== AMOY_CHAIN_ID) {
    throw new PledgeError(
      "chain_id_mismatch",
      "pledge finality helper requires a PublicClient pinned to Polygon Amoy",
      {
        expectedChainId: String(AMOY_CHAIN_ID),
        actualChainId: actual === undefined ? "undefined" : String(actual),
      },
    );
  }
}

function bytes32FromSha256Hex(h: Sha256Hex): Hex {
  return `0x${h}` as Hex;
}

function normaliseHash(raw: string): Sha256Hex {
  const stripped = raw.startsWith("0x") ? raw.slice(2) : raw;
  return asSha256Hex(stripped.toLowerCase());
}

function normaliseAddress(raw: string): EthAddressHex {
  const lower = raw.toLowerCase();
  const prefixed = (lower.startsWith("0x") ? lower : `0x${lower}`) as EthAddressHex;
  // Runtime hex-length sanity.
  getAddress(prefixed);
  return prefixed;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Poll the chain head until the tx-receipt's block is at depth >=
 * `minDepth`, then extract the matching `TransferSingle` log and
 * validate its args against the pledge inputs.
 */
export async function awaitFinality(
  args: AwaitFinalityArgs,
): Promise<AwaitFinalityResult> {
  assertAmoyChain(args.client);

  const pollIntervalMs = args.pollIntervalMs ?? POLL_INTERVAL_MS_DEFAULT;
  const timeoutMs = args.timeoutMs ?? FINALITY_TIMEOUT_MS_DEFAULT;
  const nowFn = args.now ?? Date.now;
  const sleepFn = args.sleep ?? defaultSleep;
  const startedAt = nowFn();
  const minDepthBig = BigInt(args.minDepth);
  const txHashHex = bytes32FromSha256Hex(args.txHash);

  let receipt: TransactionReceipt | null = null;
  // Poll for a mined receipt + finality depth simultaneously.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      // eslint-disable-next-line no-await-in-loop
      receipt = await args.client.getTransactionReceipt({ hash: txHashHex });
    } catch (cause: unknown) {
      // viem throws `TransactionReceiptNotFoundError` when the tx has
      // not been mined yet. Treat any exception here as "not yet" and
      // retry until we hit the finality timeout.
      receipt = null;
    }

    if (receipt !== null) {
      let head: bigint;
      try {
        // eslint-disable-next-line no-await-in-loop
        head = await args.client.getBlockNumber();
      } catch (cause: unknown) {
        throw new PledgeError(
          "rpc_unreachable",
          "getBlockNumber failed while tracking finality",
          { txHash: args.txHash },
          cause,
        );
      }
      const depth = head - receipt.blockNumber + 1n;
      if (depth >= minDepthBig) {
        break;
      }
    }

    if (nowFn() - startedAt >= timeoutMs) {
      throw new PledgeError(
        "finality_timeout",
        "pledge tx did not reach the required confirmation depth within the timeout",
        {
          txHash: args.txHash,
          minDepth: String(args.minDepth),
          timeoutMs: String(timeoutMs),
        },
      );
    }

    // eslint-disable-next-line no-await-in-loop
    await sleepFn(pollIntervalMs);
  }

  // Defense in depth — the while-loop guarantees this.
  if (receipt === null) {
    throw new PledgeError(
      "receipt_not_available",
      "finality gate exited without a receipt (unexpected)",
      { txHash: args.txHash },
    );
  }

  // A reorg between the finality check and log extraction surfaces as
  // a receipt with `status !== "success"` — reject.
  if (receipt.status !== "success") {
    throw new PledgeError(
      "receipt_not_available",
      "pledge tx receipt reports non-success status",
      { txHash: args.txHash, status: String(receipt.status) },
    );
  }

  // Locate the `TransferSingle` log emitted from the CTF contract with
  // arg tuple matching the pledge inputs. Decode via viem to avoid
  // hand-rolled topic parsing.
  const ctfAddressLower = CTF_ADDRESS.toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== ctfAddressLower) {
      continue;
    }
    if (log.topics[0]?.toLowerCase() !== TRANSFER_SINGLE_TOPIC.toLowerCase()) {
      continue;
    }
    let decoded;
    try {
      decoded = decodeEventLog({
        abi: CTF_ABI,
        data: log.data,
        topics: log.topics,
        eventName: "TransferSingle",
      });
    } catch (cause: unknown) {
      // Malformed log topics — the CTF emitted something we can't decode.
      // Skip and keep searching.
      continue;
    }
    if (decoded.eventName !== "TransferSingle") {
      continue;
    }
    const { operator, from, to, id, value } = decoded.args;
    if (operator.toLowerCase() !== args.expectedOperator.toLowerCase()) {
      continue;
    }
    if (from.toLowerCase() !== args.expectedFrom.toLowerCase()) {
      continue;
    }
    if (to.toLowerCase() !== args.expectedTo.toLowerCase()) {
      continue;
    }
    if (id !== args.expectedId) {
      continue;
    }
    if (value !== args.expectedAmount) {
      continue;
    }

    if (value === 0n) {
      throw new PledgeError(
        "transfer_value_zero",
        "matching TransferSingle log has value=0; zero-value pledges are rejected",
        {
          txHash: args.txHash,
          expectedId: args.expectedId.toString(),
        },
      );
    }

    const logIndex = log.logIndex;
    if (logIndex === null) {
      continue;
    }
    const extracted: TransferSingleLog = {
      operator: normaliseAddress(operator),
      from: normaliseAddress(from),
      to: normaliseAddress(to),
      id,
      value,
      logIndex,
    };

    return {
      blockNumber: Number(receipt.blockNumber),
      blockHash: normaliseHash(receipt.blockHash),
      logIndex,
      log: extracted,
    };
  }

  throw new PledgeError(
    "transfer_log_not_found",
    "receipt confirmed but no matching TransferSingle log found",
    {
      txHash: args.txHash,
      expectedId: args.expectedId.toString(),
      expectedAmount: args.expectedAmount.toString(),
      logCount: String(receipt.logs.length),
    },
  );
}

/**
 * Re-read the vault's CTF balance at the confirmed block to catch the
 * pathological "log present, state reverted" race (I-PL-1 post-check).
 * Throws `post_transfer_balance_too_low` if the read returns less than
 * `expectedAmount`.
 */
export async function reReadVaultBalance(
  client: PublicClient,
  vault: EthAddressHex,
  positionId: PositionId,
  atBlock: number,
  expectedAmount: bigint,
): Promise<bigint> {
  // `readBalance` from venue-poly handles the chain-id guard + RPC
  // error wrapping. We need the balance at a specific block to rule out
  // races where a subsequent block moved the balance. We re-use
  // viem's `readContract` directly here with `blockNumber` set, matching
  // the pattern `assertReadyToSign` uses.
  //
  // For tests, `readBalance` is exercised at head; the
  // block-pinned path is a strict extension.
  let observed: bigint;
  try {
    observed = await client.readContract({
      address: CTF_ADDRESS,
      abi: CTF_ABI,
      functionName: "balanceOf",
      args: [vault, positionId],
      blockNumber: BigInt(atBlock),
    });
  } catch (cause: unknown) {
    throw new PledgeError(
      "rpc_unreachable",
      "eth_call balanceOf failed during post-transfer re-read",
      { vault, atBlock: String(atBlock) },
      cause,
    );
  }
  if (observed < expectedAmount) {
    throw new PledgeError(
      "post_transfer_balance_too_low",
      "vault's CTF balance after the confirmed transfer is below the pledged amount",
      {
        vault,
        atBlock: String(atBlock),
        expected: expectedAmount.toString(),
        observed: observed.toString(),
      },
    );
  }
  return observed;
}

/**
 * Re-export the head-path balance helper so the orchestrator can gate
 * on it without reaching into venue-poly directly; keeps the layering
 * crisp (pledge orchestrator only imports pledge + events + tee + the
 * venue-poly public API through finality helpers).
 */
export { readBalance };
