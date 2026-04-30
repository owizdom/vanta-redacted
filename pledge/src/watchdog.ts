/**
 * Pledge-event watchdog (I-PL-6).
 *
 * After a `loan.pledge` is emitted at confirmation depth 5, the caller
 * starts a watchdog that tracks the cited block until it crosses depth
 * `watchdogDepth` (canonical-reference pins this to 12). On the first
 * tick the cited block is at depth >= 12, the watchdog:
 *
 *   1. Re-reads the transaction receipt.
 *   2. Compares the observed receipt's `blockHash` against the pledge's
 *      `block_hash`. A mismatch means the cited block is no longer on
 *      canonical chain (reorg-drop) — sign and emit a
 *      `loan.pledge_revoked` with `reason: "block_hash_mismatch"`.
 *   3. If the receipt is absent entirely (`null` from viem), the tx
 *      itself disappeared — emit `reason: "log_missing"`.
 *   4. If the receipt is present AND the block_hash matches AND the log
 *      at `log_index` still carries the expected args, no revocation is
 *      needed; cancel the loop.
 *
 * USDC release and every downstream decision gate on watchdog depth,
 * not emit depth — so revocation here is the load-bearing gate the
 * caller consumes.
 */

import type { PublicClient, TransactionReceipt } from "viem";
import { decodeEventLog, keccak256, toBytes } from "viem";

import type { Sha256Hex } from "@vanta/tee";
import {
  CTF_ABI,
  CTF_ADDRESS,
} from "@vanta/venue-poly";
import {
  buildAndSign,
  type BuildArgs,
  type LoanPledgeBody,
  type LoanPledgeRevokedBody,
  type SignFn,
  type SigningPubKeyHex,
  type VantaEventOfType,
} from "@vanta/events";

import { PledgeError } from "./errors.js";

/** One tick per 10 seconds (matches Amoy block time budget). */
const DEFAULT_TICK_MS = 10_000;

/** Watchdog is considered satisfied when we've confirmed canonicality. */
type WatchdogOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "revoked"; readonly event: VantaEventOfType<"loan.pledge_revoked"> };

const TRANSFER_SINGLE_TOPIC = keccak256(
  toBytes("TransferSingle(address,address,address,uint256,uint256)"),
);

function bytes32FromSha256Hex(h: Sha256Hex): `0x${string}` {
  return `0x${h}` as `0x${string}`;
}

function addressesEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function normaliseHash(raw: string): string {
  return (raw.startsWith("0x") ? raw.slice(2) : raw).toLowerCase();
}

/**
 * TEE inner envelope needed by buildAndSign. Matches the shape
 * @vanta/events expects for the revocation event — the caller is
 * responsible for providing a tee sub-envelope already populated by the
 * runtime's `getAttestation` call.
 */
export interface TeeInnerEnvelope {
  readonly signingPubKey: SigningPubKeyHex;
  readonly kmsKeyHash: Sha256Hex;
  readonly attestationJwtHash: Sha256Hex;
}

export interface StartPledgeWatchdogArgs {
  readonly client: PublicClient;
  readonly pledgeEvent: VantaEventOfType<"loan.pledge">;
  readonly watchdogDepth: number;
  readonly sign: SignFn;
  readonly signingPubKey: SigningPubKeyHex;
  readonly tee: TeeInnerEnvelope;
  readonly instance: string;
  readonly lineage: string;
  readonly emit: (ev: VantaEventOfType<"loan.pledge_revoked">) => Promise<void>;
  readonly nowUnix: () => number;
  readonly tickIntervalMs?: number;
  /**
   * Optional override for test-injection. Real callers do not pass
   * this; it exists so unit tests can step the loop deterministically
   * without real timers.
   */
  readonly schedule?: (fn: () => void, ms: number) => { readonly cancel: () => void };
  /** Optional epoch for the synthesised loan.pledge_revoked event. Defaults to nowUnix(). */
  readonly epoch?: number;
}

export interface PledgeWatchdogHandle {
  readonly cancel: () => void;
  /**
   * Promise that resolves when the watchdog has reached a terminal
   * state: either the pledge was confirmed canonical (no revocation
   * needed) or a `loan.pledge_revoked` event was signed and emitted.
   */
  readonly done: Promise<WatchdogOutcome>;
}

/**
 * Inspect a receipt for the expected `TransferSingle` args at the
 * pledge's cited `log_index`. Returns `true` when the args match; any
 * mismatch or absence returns `false`.
 */
function logMatches(
  receipt: TransactionReceipt,
  body: LoanPledgeBody,
): boolean {
  const citedIndex = body.log_index;
  const ctfAddressLower = CTF_ADDRESS.toLowerCase();
  for (const log of receipt.logs) {
    if (log.logIndex !== citedIndex) {
      continue;
    }
    if (log.address.toLowerCase() !== ctfAddressLower) {
      return false;
    }
    if (
      log.topics[0]?.toLowerCase() !== TRANSFER_SINGLE_TOPIC.toLowerCase()
    ) {
      return false;
    }
    let decoded;
    try {
      decoded = decodeEventLog({
        abi: CTF_ABI,
        data: log.data,
        topics: log.topics,
        eventName: "TransferSingle",
      });
    } catch {
      return false;
    }
    if (decoded.eventName !== "TransferSingle") {
      return false;
    }
    const { from, to, id, value } = decoded.args;
    if (!addressesEqual(from, body.borrower_proxy)) return false;
    if (!addressesEqual(to, body.vault_address)) return false;
    if (id.toString() !== body.position_id) return false;
    if (value.toString() !== body.amount) return false;
    return true;
  }
  return false;
}

async function buildRevocationEvent(
  reason: LoanPledgeRevokedBody["reason"],
  observedAtBlock: number,
  watchdogDepth: number,
  pledgeEvent: VantaEventOfType<"loan.pledge">,
  args: StartPledgeWatchdogArgs,
): Promise<VantaEventOfType<"loan.pledge_revoked">> {
  const body: LoanPledgeRevokedBody = {
    original_pledge_id: pledgeEvent.id,
    reason,
    watchdog_depth: watchdogDepth,
    observed_at_block: observedAtBlock,
  };
  const now = args.nowUnix();
  const buildArgs: BuildArgs<"loan.pledge_revoked"> = {
    type: "loan.pledge_revoked",
    parent_ids: [pledgeEvent.id],
    lineage: args.lineage,
    timestamp: now,
    epoch: args.epoch ?? now,
    tee: {
      signingPubKey: args.signingPubKey,
      kmsKeyHash: args.tee.kmsKeyHash,
      tdxQuoteHash: null,
      attestationJwtHash: args.tee.attestationJwtHash,
    },
    instance: args.instance,
    body,
    sign: args.sign,
  };
  return buildAndSign(buildArgs);
}

/**
 * Start the watchdog loop. Returns a handle with `cancel()` (external
 * stop) and `done` (promise that resolves when the loop reaches a
 * terminal state).
 */
export function startPledgeWatchdog(
  args: StartPledgeWatchdogArgs,
): PledgeWatchdogHandle {
  const tickMs = args.tickIntervalMs ?? DEFAULT_TICK_MS;
  const body = args.pledgeEvent.body;
  let cancelled = false;
  let settled = false;
  let timer: { readonly cancel: () => void } | null = null;

  let resolveDone!: (outcome: WatchdogOutcome) => void;
  let rejectDone!: (err: unknown) => void;
  const done = new Promise<WatchdogOutcome>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const scheduleNext = (fn: () => void): void => {
    if (cancelled || settled) {
      return;
    }
    const s =
      args.schedule ??
      ((cb: () => void, ms: number) => {
        const t = setTimeout(cb, ms);
        return {
          cancel: () => {
            clearTimeout(t);
          },
        };
      });
    timer = s(fn, tickMs);
  };

  const settle = (outcome: WatchdogOutcome): void => {
    if (settled) return;
    settled = true;
    if (timer) timer.cancel();
    resolveDone(outcome);
  };

  const fail = (err: unknown): void => {
    if (settled) return;
    settled = true;
    if (timer) timer.cancel();
    rejectDone(err);
  };

  const tick = async (): Promise<void> => {
    if (cancelled || settled) return;
    let head: bigint;
    try {
      head = await args.client.getBlockNumber();
    } catch (cause: unknown) {
      fail(
        new PledgeError(
          "rpc_unreachable",
          "watchdog getBlockNumber failed",
          { txHash: body.tx_hash },
          cause,
        ),
      );
      return;
    }
    const depth = head - BigInt(body.block_number) + 1n;
    if (depth < BigInt(args.watchdogDepth)) {
      scheduleNext(() => {
        tick().catch(fail);
      });
      return;
    }

    let receipt: TransactionReceipt | null = null;
    try {
      receipt = await args.client.getTransactionReceipt({
        hash: bytes32FromSha256Hex(body.tx_hash),
      });
    } catch {
      receipt = null;
    }

    const observedAtBlock = Number(head);

    if (receipt === null) {
      try {
        const revoked = await buildRevocationEvent(
          "log_missing",
          observedAtBlock,
          args.watchdogDepth,
          args.pledgeEvent,
          args,
        );
        await args.emit(revoked);
        settle({ kind: "revoked", event: revoked });
      } catch (cause) {
        fail(cause);
      }
      return;
    }

    const receiptBlockHash = normaliseHash(receipt.blockHash);
    if (receiptBlockHash !== body.block_hash) {
      try {
        const revoked = await buildRevocationEvent(
          "block_hash_mismatch",
          observedAtBlock,
          args.watchdogDepth,
          args.pledgeEvent,
          args,
        );
        await args.emit(revoked);
        settle({ kind: "revoked", event: revoked });
      } catch (cause) {
        fail(cause);
      }
      return;
    }

    if (!logMatches(receipt, body)) {
      try {
        const revoked = await buildRevocationEvent(
          "log_missing",
          observedAtBlock,
          args.watchdogDepth,
          args.pledgeEvent,
          args,
        );
        await args.emit(revoked);
        settle({ kind: "revoked", event: revoked });
      } catch (cause) {
        fail(cause);
      }
      return;
    }

    // All checks passed — the pledge is canonical at watchdog depth.
    settle({ kind: "ok" });
  };

  // Kick off the first tick immediately so tests can drive progress
  // via a single awaited loop step.
  tick().catch(fail);

  return {
    cancel(): void {
      if (cancelled) return;
      cancelled = true;
      if (timer) timer.cancel();
      if (!settled) {
        settled = true;
        resolveDone({ kind: "ok" });
      }
    },
    done,
  };
}

export type { WatchdogOutcome };
