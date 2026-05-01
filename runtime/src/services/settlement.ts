/**
 * Settlement service.
 *
 * Given a `loanId` and outcome (`repaid` | `liquidated`), broadcast
 * the appropriate `LoanBook.markRepaid` / `markLiquidated` tx, await
 * confirmation depth ≥ 2, then sign + persist a `loan.settlement`
 * (or `loan.liquidation`) event whose parents are
 * `[origination_event_id, last_mark_event_id_for_loan]` (I-RT-7).
 *
 * The settlement event's body shape is the events-package
 * `LoanSettlementBody` — `{loanId, amount, borrowerAddr}`. For a
 * liquidation we emit `loan.liquidation` instead, which carries
 * `{loanId, amount, borrowerAddr, reason}`.
 */

import {
  buildAndSign,
  type LoanLiquidationBody,
  type LoanSettlementBody,
  type Sha256Hex,
  type VantaEventOfType,
} from "@vanta/events";
import { asSha256Hex, sign as teeSign } from "@vanta/tee";
import type { Address, Hex, TransactionReceipt } from "viem";

import type { Bootstrap } from "../bootstrap.js";

const LOAN_BOOK_SETTLE_ABI = [
  {
    type: "function",
    name: "markRepaid",
    stateMutability: "nonpayable",
    inputs: [{ name: "loanId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "markLiquidated",
    stateMutability: "nonpayable",
    inputs: [
      { name: "loanId", type: "bytes32" },
      { name: "auctionEscrow", type: "address" },
      { name: "proceeds", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "loans",
    stateMutability: "view",
    inputs: [{ name: "loanId", type: "bytes32" }],
    outputs: [
      { name: "borrower", type: "address" },
      { name: "principal", type: "uint256" },
      { name: "maturityTs", type: "uint64" },
      { name: "haircutBps", type: "uint32" },
      { name: "paramsHash", type: "bytes32" },
      { name: "attestationHash", type: "bytes32" },
      { name: "status", type: "uint8" },
    ],
  },
] as const;

/**
 * 0=None, 1=Active, 2=Repaid, 3=Liquidated. Mirrors `LoanBook.Status`.
 */
const STATUS_ACTIVE = 1;

export interface SettleArgs {
  readonly bootstrap: Bootstrap;
  readonly loanBookAddress: Address;
  readonly loanId: Sha256Hex;
  readonly outcome: "repaid" | "liquidated";
  readonly auctionEscrow?: Address;
  readonly proceedsUsdc6?: bigint;
  readonly liquidationReason?: string;
  readonly finalityDepth?: number;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface SettleResult {
  readonly txHash: Hex;
  readonly blockNumber: number;
  readonly eventId: Sha256Hex;
}

export class SettleError extends Error {
  public readonly code:
    | "loan_not_found"
    | "loan_not_active"
    | "rpc_unreachable"
    | "broadcast_failed"
    | "finality_timeout"
    | "missing_origination_event"
    | "event_sign_failed"
    | "missing_liquidation_inputs";
  public constructor(code: SettleError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "SettleError";
  }
}

const FINALITY_DEPTH_DEFAULT = 2;
const POLL_DEFAULT = 1500;
const TIMEOUT_DEFAULT = 120_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((res) => {
    setTimeout(res, ms);
  });
}

async function findOriginationEvent(
  boot: Bootstrap,
  loanId: Sha256Hex,
): Promise<VantaEventOfType<"loan.origination"> | null> {
  for await (const ev of boot.log.walkFromTip()) {
    if (ev.type === "loan.origination" && ev.body.loan_id === loanId) {
      return ev;
    }
  }
  return null;
}

async function findLastMarkEvent(
  boot: Bootstrap,
  loanId: Sha256Hex,
): Promise<VantaEventOfType<"loan.mark"> | null> {
  for await (const ev of boot.log.walkFromTip()) {
    if (ev.type === "loan.mark" && ev.body.loan_id === loanId) {
      return ev;
    }
  }
  return null;
}

export async function settle(args: SettleArgs): Promise<SettleResult> {
  const finalityDepth = args.finalityDepth ?? FINALITY_DEPTH_DEFAULT;
  const pollMs = args.pollIntervalMs ?? POLL_DEFAULT;
  const timeoutMs = args.timeoutMs ?? TIMEOUT_DEFAULT;
  const nowFn = args.now ?? Date.now;
  const sleepFn = args.sleep ?? defaultSleep;

  // 1. Read on-chain status to fail-fast on already-settled.
  let onchainStatus: number;
  let principalOnchain: bigint;
  let borrowerOnchain: Address;
  try {
    const tuple = await args.bootstrap.publicClient.readContract({
      address: args.loanBookAddress,
      abi: LOAN_BOOK_SETTLE_ABI,
      functionName: "loans",
      args: [`0x${args.loanId}` as Hex],
    });
    borrowerOnchain = tuple[0];
    principalOnchain = tuple[1];
    onchainStatus = Number(tuple[6]);
  } catch (cause: unknown) {
    throw new SettleError(
      "rpc_unreachable",
      `LoanBook.loans read failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  if (principalOnchain === 0n && onchainStatus === 0) {
    throw new SettleError("loan_not_found", "LoanBook has no record of this loanId");
  }
  if (onchainStatus !== STATUS_ACTIVE) {
    throw new SettleError(
      "loan_not_active",
      `loan is not Active (status=${String(onchainStatus)})`,
    );
  }

  // 2. Locate the origination event (parent for I-RT-7).
  const originationEvent = await findOriginationEvent(args.bootstrap, args.loanId);
  if (originationEvent === null) {
    throw new SettleError(
      "missing_origination_event",
      "no loan.origination event in the on-disk log for this loanId",
    );
  }

  // 3. Locate the most recent mark event (best-effort; missing is fine).
  const lastMark = await findLastMarkEvent(args.bootstrap, args.loanId);

  // 4. Broadcast the settle tx.
  let txHash: Hex;
  try {
    if (args.outcome === "repaid") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      txHash = await (args.bootstrap.walletClient as unknown as {
        writeContract: (req: unknown) => Promise<Hex>;
      }).writeContract({
        address: args.loanBookAddress,
        abi: LOAN_BOOK_SETTLE_ABI,
        functionName: "markRepaid",
        args: [`0x${args.loanId}` as Hex],
      });
    } else {
      if (args.auctionEscrow === undefined || args.proceedsUsdc6 === undefined) {
        throw new SettleError(
          "missing_liquidation_inputs",
          "outcome=liquidated requires auctionEscrow + proceedsUsdc6",
        );
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      txHash = await (args.bootstrap.walletClient as unknown as {
        writeContract: (req: unknown) => Promise<Hex>;
      }).writeContract({
        address: args.loanBookAddress,
        abi: LOAN_BOOK_SETTLE_ABI,
        functionName: "markLiquidated",
        args: [
          `0x${args.loanId}` as Hex,
          args.auctionEscrow,
          args.proceedsUsdc6,
        ],
      });
    }
  } catch (cause: unknown) {
    if (cause instanceof SettleError) throw cause;
    throw new SettleError(
      "broadcast_failed",
      `markRepaid/markLiquidated tx failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  // 5. Wait for finality depth ≥ 2.
  let receipt: TransactionReceipt | null = null;
  const startedAt = nowFn();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let r: TransactionReceipt | null = null;
    try {
      // eslint-disable-next-line no-await-in-loop
      r = await args.bootstrap.publicClient.getTransactionReceipt({ hash: txHash });
    } catch {
      r = null;
    }
    if (r !== null && r.status === "success") {
      let head: bigint;
      try {
        // eslint-disable-next-line no-await-in-loop
        head = await args.bootstrap.publicClient.getBlockNumber();
      } catch (cause: unknown) {
        throw new SettleError(
          "rpc_unreachable",
          `getBlockNumber failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
      const depth = head - r.blockNumber + 1n;
      if (depth >= BigInt(finalityDepth)) {
        receipt = r;
        break;
      }
    }
    if (nowFn() - startedAt >= timeoutMs) {
      throw new SettleError(
        "finality_timeout",
        `settle tx ${txHash} did not reach depth ${String(finalityDepth)} within ${String(timeoutMs)}ms`,
      );
    }
    // eslint-disable-next-line no-await-in-loop
    await sleepFn(pollMs);
  }

  // 6. Sign + persist the settlement / liquidation event.
  const parentIds: readonly Sha256Hex[] = lastMark === null
    ? [originationEvent.id]
    : [originationEvent.id, lastMark.id];

  const teeBlock = {
    signingPubKey: args.bootstrap.tee.signingPubKey,
    kmsKeyHash: asSha256Hex("0".repeat(64)),
    tdxQuoteHash: null as null,
    attestationJwtHash: asSha256Hex("0".repeat(64)),
  };
  const instance = args.bootstrap.tee.identityAnchor?.kind === "kms-jwt"
    ? args.bootstrap.tee.identityAnchor.audience
    : "vanta-runtime-local";

  let event: VantaEventOfType<"loan.settlement"> | VantaEventOfType<"loan.liquidation">;
  try {
    if (args.outcome === "repaid") {
      const body: LoanSettlementBody = {
        loanId: args.loanId,
        amount: principalOnchain.toString(),
        borrowerAddr: borrowerOnchain,
      };
      event = buildAndSign({
        type: "loan.settlement",
        parent_ids: parentIds,
        lineage: "vanta-runtime",
        timestamp: Math.floor((args.now?.() ?? Date.now()) / 1000),
        epoch: Math.floor(args.bootstrap.tee.bootedAt / 1000),
        tee: teeBlock,
        instance,
        body,
        sign: teeSign,
      });
    } else {
      const proceeds = args.proceedsUsdc6 ?? 0n;
      const body: LoanLiquidationBody = {
        loanId: args.loanId,
        amount: proceeds.toString(),
        borrowerAddr: borrowerOnchain,
        reason: args.liquidationReason ?? "manual_resolve",
      };
      event = buildAndSign({
        type: "loan.liquidation",
        parent_ids: parentIds,
        lineage: "vanta-runtime",
        timestamp: Math.floor((args.now?.() ?? Date.now()) / 1000),
        epoch: Math.floor(args.bootstrap.tee.bootedAt / 1000),
        tee: teeBlock,
        instance,
        body,
        sign: teeSign,
      });
    }
  } catch (cause: unknown) {
    throw new SettleError(
      "event_sign_failed",
      `buildAndSign failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  await args.bootstrap.log.append(event);

  // Drop from the active registry — the mark loop should stop polling.
  args.bootstrap.loanRegistry.remove(args.loanId);

  return {
    txHash,
    blockNumber: Number(receipt.blockNumber),
    eventId: event.id,
  };
}
