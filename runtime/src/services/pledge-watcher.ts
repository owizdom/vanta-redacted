/**
 * Polygon pledge watcher — subscribes to ERC-1155 TransferSingle
 * events on the Polymarket CTF contract where `to == VantaVault`,
 * and signs a `loan.pledge` event for each transfer that lands.
 *
 * This is what makes a real borrow flow possible end-to-end: a
 * connected user calls `cTF.safeTransferFrom(user, vantaVault,
 * tokenId, amount, "")` from their wallet on Polygon; the vault's
 * `onERC1155Received` registry-gates the sender (I-VV-1); the
 * runtime sees the on-chain log, walks the cached markets to
 * recover the matching `conditionId`, and persists a signed
 * `loan.pledge` event the borrower can cite when calling
 * `/api/origination`.
 *
 * Self-healing: on subscription drop the watcher reconnects with
 * a 5s backoff. Block reorgs are handled by viem's confirmations
 * setting (we wait for 6 blocks before emitting).
 */

import type { Address, Log, PublicClient } from "viem";

import type { EventSink } from "../loops/types.js";
import type { MarketsCache } from "./markets-cache.js";
import type { Sha256Hex } from "@vanta/tee";
import { asSha256Hex } from "@vanta/tee";
import { randomBytes } from "node:crypto";

const CTF_ABI = [
  {
    type: "event",
    name: "TransferSingle",
    inputs: [
      { name: "operator", type: "address", indexed: true },
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "id", type: "uint256", indexed: false },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;

const RECONNECT_BACKOFF_MS = 5_000;
const CONFIRMATIONS = 6;

/** How often we sweep recent blocks looking for transfers the live
 *  subscription might have dropped (viem's `watchContractEvent` is
 *  not crash-proof — it pauses silently on certain RPC errors). */
const BACKFILL_INTERVAL_MS = 20_000;

/** How many blocks to scan on each backfill sweep. ~500 blocks ≈
 *  17 minutes on Polygon, well past `CONFIRMATIONS + 60s` of frontend
 *  patience, so even one sweep catches anything the live watcher
 *  missed since the last sweep. */
const BACKFILL_LOOKBACK_BLOCKS = 500n;

export interface PledgeWatcher {
  readonly start: () => void;
  readonly stop: () => Promise<void>;
}

export interface CreatePledgeWatcherOpts {
  readonly polygonClient: PublicClient;
  readonly ctfAddress: Address;
  readonly vantaVaultAddress: Address;
  readonly events: EventSink;
  readonly genesisId: Sha256Hex;
  readonly marketsCache: MarketsCache;
  readonly log?: {
    info: (msg: object) => void;
    warn: (msg: object) => void;
    error: (msg: object) => void;
  };
}

export function createPledgeWatcher(
  opts: CreatePledgeWatcherOpts,
): PledgeWatcher {
  let unwatch: (() => void) | null = null;
  let stopped = false;
  let reconnectTimer: NodeJS.Timeout | null = null;
  // Idempotency: dedupe on (txHash, logIndex) so a viem reconnect
  // that re-delivers a confirmed log doesn't double-emit.
  const seen = new Set<string>();

  const findConditionId = (tokenIdStr: string): string | null => {
    for (const m of opts.marketsCache.snapshotAll()) {
      for (const t of m.tokens) {
        if (t.tokenId === tokenIdStr) return m.conditionId;
      }
    }
    return null;
  };

  // Wait until the chain is N blocks past the log. Polls block height
  // every 4s; gives up after 4 minutes (60 polls). On timeout we drop
  // the pledge — better to lose a maybe-orphaned event than to sign a
  // pledge that never finalised.
  const waitForConfirmations = async (logBlock: bigint): Promise<boolean> => {
    const target = logBlock + BigInt(CONFIRMATIONS);
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const current = await opts.polygonClient.getBlockNumber();
        if (current >= target) return true;
      } catch (err) {
        opts.log?.warn({
          msg: "pledge_watcher_block_read_failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
      await new Promise((r) => setTimeout(r, 4_000));
    }
    return false;
  };

  const handleLog = async (log: Log): Promise<void> => {
    const txHash = log.transactionHash ?? "0x0";
    const logIndex = log.logIndex ?? 0;
    const dedupeKey = `${txHash}:${logIndex}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    // Best-effort cap on memory growth — 4096 most recent.
    if (seen.size > 4096) {
      const first = seen.values().next();
      if (!first.done) seen.delete(first.value);
    }

    const args = (log as Log & { args?: Record<string, unknown> }).args;
    if (args === undefined) return;
    const from = args["from"] as Address | undefined;
    const id = args["id"] as bigint | undefined;
    const value = args["value"] as bigint | undefined;
    if (from === undefined || id === undefined || value === undefined) return;

    const tokenIdStr = id.toString();
    const conditionId = findConditionId(tokenIdStr);
    if (conditionId === null) {
      opts.log?.info({
        msg: "pledge_watcher_unknown_token",
        tokenId: tokenIdStr.slice(0, 24),
        from,
      });
      return;
    }

    // Wait for confirmations on Polygon before signing the pledge so a
    // chain reorg can't orphan a loan.pledge event mid-flight. The
    // confirmation_depth field on the event body now reflects an
    // actual on-chain wait, not just metadata.
    const logBlock = log.blockNumber ?? 0n;
    if (logBlock > 0n) {
      const confirmed = await waitForConfirmations(logBlock);
      if (!confirmed) {
        opts.log?.warn({
          msg: "pledge_watcher_confirmation_timeout",
          tx_hash: txHash,
          block_number: Number(logBlock),
        });
        return;
      }
    }

    const loanId = asSha256Hex(randomBytes(32).toString("hex"));
    try {
      const eventId = await opts.events.emit({
        type: "loan.pledge",
        body: {
          loan_id: loanId,
          borrower_proxy: from,
          position_id: tokenIdStr,
          amount: value.toString(),
          vault_address: opts.vantaVaultAddress,
          tx_hash: txHash,
          block_number: Number(log.blockNumber ?? 0n),
          block_hash: log.blockHash ?? "0x0",
          log_index: logIndex,
          confirmation_depth: CONFIRMATIONS,
          condition_id: asSha256Hex(conditionId),
        },
        parentIds: [opts.genesisId],
      });
      opts.log?.info({
        msg: "pledge_watcher_emit",
        loan_id: loanId.slice(0, 12),
        event_id: eventId.slice(0, 12),
        borrower: from,
        condition_id: conditionId.slice(0, 12),
      });
    } catch (err) {
      opts.log?.error({
        msg: "pledge_watcher_emit_failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const subscribe = (): void => {
    if (stopped) return;
    try {
      unwatch = opts.polygonClient.watchContractEvent({
        address: opts.ctfAddress,
        abi: CTF_ABI,
        eventName: "TransferSingle",
        args: { to: opts.vantaVaultAddress },
        onLogs: (logs) => {
          for (const log of logs) {
            void handleLog(log as Log);
          }
        },
        onError: (err) => {
          opts.log?.warn({
            msg: "pledge_watcher_subscription_error",
            error: err instanceof Error ? err.message : String(err),
          });
          if (unwatch !== null) {
            unwatch();
            unwatch = null;
          }
          if (!stopped) {
            reconnectTimer = setTimeout(subscribe, RECONNECT_BACKOFF_MS);
          }
        },
        pollingInterval: 8_000,
      });
      opts.log?.info({
        msg: "pledge_watcher_subscribed",
        ctf: opts.ctfAddress,
        vault: opts.vantaVaultAddress,
      });
    } catch (err) {
      opts.log?.error({
        msg: "pledge_watcher_subscribe_failed",
        error: err instanceof Error ? err.message : String(err),
      });
      if (!stopped) {
        reconnectTimer = setTimeout(subscribe, RECONNECT_BACKOFF_MS);
      }
    }
  };

  // Backfill sweep — supplements the live subscription. viem's
  // `watchContractEvent` has a failure mode where it silently stops
  // polling after certain transient RPC errors (observed in
  // production with public-node Polygon RPCs that rate-limit
  // eth_getLogs). The sweep below queries the recent block window
  // every 20s and replays any TransferSingle the live watcher
  // missed. Dedup is the same `seen` set used by the live handler,
  // so a transfer the live path already emitted is a no-op here.
  let backfillTimer: NodeJS.Timeout | null = null;
  const runBackfill = async (): Promise<void> => {
    if (stopped) return;
    try {
      const current = await opts.polygonClient.getBlockNumber();
      const fromBlock =
        current > BACKFILL_LOOKBACK_BLOCKS
          ? current - BACKFILL_LOOKBACK_BLOCKS
          : 0n;
      const logs = await opts.polygonClient.getLogs({
        address: opts.ctfAddress,
        event: CTF_ABI[0],
        args: { to: opts.vantaVaultAddress },
        fromBlock,
        toBlock: current,
      });
      for (const log of logs) {
        // handleLog dedups via `seen`, so this is idempotent vs the
        // live subscription firing concurrently.
        void handleLog(log as Log);
      }
    } catch (err) {
      opts.log?.warn({
        msg: "pledge_watcher_backfill_failed",
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (!stopped) {
        backfillTimer = setTimeout(() => void runBackfill(), BACKFILL_INTERVAL_MS);
      }
    }
  };

  return {
    start() {
      if (unwatch !== null || stopped) return;
      subscribe();
      // Kick the backfill loop. First run is also a hot-start scan —
      // catches anything that happened between container restart and
      // subscription becoming live.
      backfillTimer = setTimeout(() => void runBackfill(), 2_000);
    },
    async stop() {
      stopped = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (backfillTimer !== null) {
        clearTimeout(backfillTimer);
        backfillTimer = null;
      }
      if (unwatch !== null) {
        unwatch();
        unwatch = null;
      }
    },
  };
}
