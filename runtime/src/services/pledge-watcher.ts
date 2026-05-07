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

  return {
    start() {
      if (unwatch !== null || stopped) return;
      subscribe();
    },
    async stop() {
      stopped = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (unwatch !== null) {
        unwatch();
        unwatch = null;
      }
    },
  };
}
