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
 *
 * Observability: every state transition updates a `diag` snapshot
 * accessible via `watcher.snapshot()` and an admin HTTP route. The
 * snapshot is the authoritative debugging surface — `ecloud compute
 * app logs` is not reliable enough to depend on. `watcher.replay(tx)`
 * lets an operator force re-evaluation of a specific transaction,
 * bypassing the live subscription's bookkeeping.
 */

import {
  decodeEventLog,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from "viem";

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
const BACKFILL_INTERVAL_MS = 20_000;
const BACKFILL_LOOKBACK_BLOCKS = 9_500n;

export type ExitReason =
  | "already_seen"
  | "args_undefined"
  | "args_partial"
  | "unknown_token"
  | "confirmation_failed"
  | "emit_failed"
  | "emit_success";

export interface PledgeWatcherDiagnostics {
  readonly nowMs: number;
  readonly subscribedAt: number | null;
  readonly lastSubscribeError: string | null;
  readonly reconnectCount: number;
  readonly liveOnLogsCount: number; // total times the live onLogs callback fired
  readonly liveOnLogsLastAt: number | null;
  readonly liveOnLogsLastSize: number;
  readonly lastBackfillStartedAt: number | null;
  readonly lastBackfillFinishedAt: number | null;
  readonly lastBackfillFromBlock: string | null;
  readonly lastBackfillToBlock: string | null;
  readonly lastBackfillCount: number | null;
  readonly lastBackfillError: string | null;
  readonly backfillIterations: number;
  readonly handleLogTotal: number;
  readonly lastHandleLogAt: number | null;
  readonly exitCounters: Record<ExitReason, number>;
  readonly seenSize: number;
  readonly seenSample: readonly string[];
  readonly lastEmittedAt: number | null;
  readonly lastEmittedTxHash: string | null;
  readonly lastEmittedLoanId: string | null;
  readonly marketsCacheSize: number;
  readonly marketsCacheSampleTokenIds: readonly string[];
  readonly config: {
    readonly ctfAddress: string;
    readonly vantaVaultAddress: string;
    readonly chainId: number | null;
    readonly backfillIntervalMs: number;
    readonly backfillLookbackBlocks: string;
    readonly confirmations: number;
  };
}

export interface ReplayResult {
  readonly txHash: string;
  readonly logsScanned: number;
  readonly matchingTransfers: number;
  readonly results: ReadonlyArray<{
    readonly logIndex: number;
    readonly outcome: ExitReason | "no_match";
    readonly eventId?: string;
    readonly error?: string;
    readonly tokenId?: string;
    readonly from?: string;
    readonly to?: string;
  }>;
}

export interface PledgeWatcher {
  readonly start: () => void;
  readonly stop: () => Promise<void>;
  readonly snapshot: () => PledgeWatcherDiagnostics;
  readonly replay: (txHash: Hex) => Promise<ReplayResult>;
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

interface DecodedTransfer {
  readonly from: Address;
  readonly id: bigint;
  readonly value: bigint;
}

/**
 * Decode args off a log, robust to two shapes: viem `watchContractEvent`
 * onLogs decorates each log with `.args` (the easy case), but `getLogs`
 * with `event:` sometimes returns logs without the decoration — re-decode
 * from `topics + data` when args is missing. This shim made the watcher's
 * silent-failure surface go from invisible to never-hit.
 */
function decodeTransfer(log: Log): DecodedTransfer | null {
  const baseArgs = (log as Log & { args?: Record<string, unknown> }).args;
  if (baseArgs !== undefined) {
    const from = baseArgs["from"] as Address | undefined;
    const id = baseArgs["id"] as bigint | undefined;
    const value = baseArgs["value"] as bigint | undefined;
    if (from !== undefined && id !== undefined && value !== undefined) {
      return { from, id, value };
    }
  }
  try {
    const decoded = decodeEventLog({
      abi: CTF_ABI,
      data: log.data,
      topics: log.topics,
    });
    if (decoded.eventName !== "TransferSingle") return null;
    const a = decoded.args as unknown as Record<string, unknown>;
    const from = a["from"] as Address;
    const id = a["id"] as bigint;
    const value = a["value"] as bigint;
    if (from === undefined || id === undefined || value === undefined) {
      return null;
    }
    return { from, id, value };
  } catch {
    return null;
  }
}

export function createPledgeWatcher(
  opts: CreatePledgeWatcherOpts,
): PledgeWatcher {
  let unwatch: (() => void) | null = null;
  let stopped = false;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let backfillTimer: NodeJS.Timeout | null = null;
  const seen = new Set<string>();

  // Diagnostics state — every code path updates these so an external
  // snapshot can pinpoint exactly where the watcher is wedged.
  const diag: {
    subscribedAt: number | null;
    lastSubscribeError: string | null;
    reconnectCount: number;
    liveOnLogsCount: number;
    liveOnLogsLastAt: number | null;
    liveOnLogsLastSize: number;
    lastBackfillStartedAt: number | null;
    lastBackfillFinishedAt: number | null;
    lastBackfillFromBlock: string | null;
    lastBackfillToBlock: string | null;
    lastBackfillCount: number | null;
    lastBackfillError: string | null;
    backfillIterations: number;
    handleLogTotal: number;
    lastHandleLogAt: number | null;
    exitCounters: Record<ExitReason, number>;
    lastEmittedAt: number | null;
    lastEmittedTxHash: string | null;
    lastEmittedLoanId: string | null;
  } = {
    subscribedAt: null,
    lastSubscribeError: null,
    reconnectCount: 0,
    liveOnLogsCount: 0,
    liveOnLogsLastAt: null,
    liveOnLogsLastSize: 0,
    lastBackfillStartedAt: null,
    lastBackfillFinishedAt: null,
    lastBackfillFromBlock: null,
    lastBackfillToBlock: null,
    lastBackfillCount: null,
    lastBackfillError: null,
    backfillIterations: 0,
    handleLogTotal: 0,
    lastHandleLogAt: null,
    exitCounters: {
      already_seen: 0,
      args_undefined: 0,
      args_partial: 0,
      unknown_token: 0,
      confirmation_failed: 0,
      emit_failed: 0,
      emit_success: 0,
    },
    lastEmittedAt: null,
    lastEmittedTxHash: null,
    lastEmittedLoanId: null,
  };

  // Mirror critical state transitions to stdout via `console.log` so they
  // appear in `ecloud compute app logs` (which streams stdout, not the
  // fastify pino sink). The `opts.log` path is kept for parity with the
  // rest of the runtime.
  const sayInfo = (msg: string, extra: Record<string, unknown> = {}): void => {
    const line = `[pledge-watcher] ${msg} ${JSON.stringify(extra)}`;
    console.log(line);
    opts.log?.info({ msg: `pledge_watcher_${msg}`, ...extra });
  };
  const sayWarn = (msg: string, extra: Record<string, unknown> = {}): void => {
    const line = `[pledge-watcher][warn] ${msg} ${JSON.stringify(extra)}`;
    console.warn(line);
    opts.log?.warn({ msg: `pledge_watcher_${msg}`, ...extra });
  };
  const sayError = (msg: string, extra: Record<string, unknown> = {}): void => {
    const line = `[pledge-watcher][error] ${msg} ${JSON.stringify(extra)}`;
    console.error(line);
    opts.log?.error({ msg: `pledge_watcher_${msg}`, ...extra });
  };

  const findConditionId = (tokenIdStr: string): string | null => {
    for (const m of opts.marketsCache.snapshotAll()) {
      for (const t of m.tokens) {
        if (t.tokenId === tokenIdStr) return m.conditionId;
      }
    }
    return null;
  };

  const waitForConfirmations = async (logBlock: bigint): Promise<boolean> => {
    const target = logBlock + BigInt(CONFIRMATIONS);
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const current = await opts.polygonClient.getBlockNumber();
        if (current >= target) return true;
      } catch (err) {
        sayWarn("block_read_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      await new Promise((r) => setTimeout(r, 4_000));
    }
    return false;
  };

  /**
   * Process one log and return the exit reason. Always updates `diag`
   * counters. Replay-safe — does not mutate `seen` on retryable
   * failures (cache-miss).
   */
  const handleLog = async (log: Log): Promise<{
    outcome: ExitReason | "no_match";
    eventId?: string;
    error?: string;
    tokenId?: string;
    from?: string;
    to?: string;
  }> => {
    diag.handleLogTotal += 1;
    diag.lastHandleLogAt = Date.now();

    const txHash = log.transactionHash ?? "0x0";
    const logIndex = log.logIndex ?? 0;
    const dedupeKey = `${txHash}:${logIndex}`;
    if (seen.has(dedupeKey)) {
      diag.exitCounters.already_seen += 1;
      return { outcome: "already_seen" };
    }

    const decoded = decodeTransfer(log);
    if (decoded === null) {
      diag.exitCounters.args_undefined += 1;
      sayWarn("args_undecodable", { tx: txHash, logIndex });
      return { outcome: "args_undefined" };
    }
    const { from, id, value } = decoded;

    const tokenIdStr = id.toString();
    const conditionId = findConditionId(tokenIdStr);
    if (conditionId === null) {
      diag.exitCounters.unknown_token += 1;
      sayInfo("unknown_token_retry_pending", {
        tokenId: tokenIdStr.slice(0, 24),
        from,
        cache_size: opts.marketsCache.snapshotAll().length,
        tx: txHash,
      });
      return {
        outcome: "unknown_token",
        tokenId: tokenIdStr,
        from,
        to: opts.vantaVaultAddress,
      };
    }

    seen.add(dedupeKey);
    if (seen.size > 4096) {
      const first = seen.values().next();
      if (!first.done) seen.delete(first.value);
    }

    const logBlock = log.blockNumber ?? 0n;
    if (logBlock > 0n) {
      const confirmed = await waitForConfirmations(logBlock);
      if (!confirmed) {
        diag.exitCounters.confirmation_failed += 1;
        sayWarn("confirmation_timeout", {
          tx_hash: txHash,
          block_number: Number(logBlock),
        });
        return { outcome: "confirmation_failed", tokenId: tokenIdStr, from };
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
      diag.exitCounters.emit_success += 1;
      diag.lastEmittedAt = Date.now();
      diag.lastEmittedTxHash = txHash;
      diag.lastEmittedLoanId = loanId;
      sayInfo("emit", {
        loan_id: loanId.slice(0, 12),
        event_id: eventId.slice(0, 12),
        borrower: from,
        condition_id: conditionId.slice(0, 12),
        tx_hash: txHash,
      });
      return {
        outcome: "emit_success",
        eventId,
        tokenId: tokenIdStr,
        from,
        to: opts.vantaVaultAddress,
      };
    } catch (err) {
      diag.exitCounters.emit_failed += 1;
      const error = err instanceof Error ? err.message : String(err);
      sayError("emit_failed", { error, tx_hash: txHash });
      return { outcome: "emit_failed", error };
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
          diag.liveOnLogsCount += 1;
          diag.liveOnLogsLastAt = Date.now();
          diag.liveOnLogsLastSize = logs.length;
          sayInfo("live_on_logs", { count: logs.length });
          for (const log of logs) {
            void handleLog(log as Log);
          }
        },
        onError: (err) => {
          diag.lastSubscribeError = err instanceof Error ? err.message : String(err);
          diag.reconnectCount += 1;
          sayWarn("subscription_error", { error: diag.lastSubscribeError });
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
      diag.subscribedAt = Date.now();
      diag.lastSubscribeError = null;
      sayInfo("subscribed", {
        ctf: opts.ctfAddress,
        vault: opts.vantaVaultAddress,
      });
    } catch (err) {
      diag.lastSubscribeError = err instanceof Error ? err.message : String(err);
      sayError("subscribe_failed", { error: diag.lastSubscribeError });
      if (!stopped) {
        reconnectTimer = setTimeout(subscribe, RECONNECT_BACKOFF_MS);
      }
    }
  };

  const runBackfill = async (): Promise<void> => {
    if (stopped) return;
    diag.lastBackfillStartedAt = Date.now();
    diag.backfillIterations += 1;
    try {
      const current = await opts.polygonClient.getBlockNumber();
      const fromBlock =
        current > BACKFILL_LOOKBACK_BLOCKS
          ? current - BACKFILL_LOOKBACK_BLOCKS
          : 0n;
      diag.lastBackfillFromBlock = `0x${fromBlock.toString(16)}`;
      diag.lastBackfillToBlock = `0x${current.toString(16)}`;
      const logs = await opts.polygonClient.getLogs({
        address: opts.ctfAddress,
        event: CTF_ABI[0],
        args: { to: opts.vantaVaultAddress },
        fromBlock,
        toBlock: current,
      });
      diag.lastBackfillCount = logs.length;
      diag.lastBackfillError = null;
      sayInfo("backfill_swept", {
        from_block: diag.lastBackfillFromBlock,
        to_block: diag.lastBackfillToBlock,
        count: logs.length,
      });
      for (const log of logs) {
        void handleLog(log as Log);
      }
    } catch (err) {
      diag.lastBackfillError = err instanceof Error ? err.message : String(err);
      diag.lastBackfillCount = null;
      sayWarn("backfill_failed", { error: diag.lastBackfillError });
    } finally {
      diag.lastBackfillFinishedAt = Date.now();
      if (!stopped) {
        backfillTimer = setTimeout(() => void runBackfill(), BACKFILL_INTERVAL_MS);
      }
    }
  };

  const snapshot = (): PledgeWatcherDiagnostics => {
    const mkts = opts.marketsCache.snapshotAll();
    const sampleTokenIds: string[] = [];
    for (const m of mkts) {
      for (const t of m.tokens) {
        sampleTokenIds.push(t.tokenId.slice(0, 16));
        if (sampleTokenIds.length >= 6) break;
      }
      if (sampleTokenIds.length >= 6) break;
    }
    return {
      nowMs: Date.now(),
      subscribedAt: diag.subscribedAt,
      lastSubscribeError: diag.lastSubscribeError,
      reconnectCount: diag.reconnectCount,
      liveOnLogsCount: diag.liveOnLogsCount,
      liveOnLogsLastAt: diag.liveOnLogsLastAt,
      liveOnLogsLastSize: diag.liveOnLogsLastSize,
      lastBackfillStartedAt: diag.lastBackfillStartedAt,
      lastBackfillFinishedAt: diag.lastBackfillFinishedAt,
      lastBackfillFromBlock: diag.lastBackfillFromBlock,
      lastBackfillToBlock: diag.lastBackfillToBlock,
      lastBackfillCount: diag.lastBackfillCount,
      lastBackfillError: diag.lastBackfillError,
      backfillIterations: diag.backfillIterations,
      handleLogTotal: diag.handleLogTotal,
      lastHandleLogAt: diag.lastHandleLogAt,
      exitCounters: { ...diag.exitCounters },
      seenSize: seen.size,
      seenSample: Array.from(seen).slice(-3),
      lastEmittedAt: diag.lastEmittedAt,
      lastEmittedTxHash: diag.lastEmittedTxHash,
      lastEmittedLoanId: diag.lastEmittedLoanId,
      marketsCacheSize: mkts.length,
      marketsCacheSampleTokenIds: sampleTokenIds,
      config: {
        ctfAddress: opts.ctfAddress,
        vantaVaultAddress: opts.vantaVaultAddress,
        chainId: opts.polygonClient.chain?.id ?? null,
        backfillIntervalMs: BACKFILL_INTERVAL_MS,
        backfillLookbackBlocks: BACKFILL_LOOKBACK_BLOCKS.toString(),
        confirmations: CONFIRMATIONS,
      },
    };
  };

  /**
   * Manually re-process every TransferSingle in a given tx that lands
   * in the vault. Operators reach for this when the live watcher
   * appears wedged — the result distinguishes "watcher never saw it"
   * (logs scan returns matches that re-emit cleanly here) from
   * "watcher saw it but emit-side fails" (replay also fails).
   */
  const replay = async (txHash: Hex): Promise<ReplayResult> => {
    const receipt = await opts.polygonClient.getTransactionReceipt({
      hash: txHash,
    });
    const ctfLower = opts.ctfAddress.toLowerCase();
    const vaultLower = opts.vantaVaultAddress.toLowerCase();
    const TS_TOPIC =
      "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";

    const results: ReplayResult["results"][number][] = [];
    let matching = 0;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== ctfLower) continue;
      if (log.topics[0] !== TS_TOPIC) continue;
      // topic[3] = padded `to` address
      const toPadded = log.topics[3] ?? "";
      const toAddr = "0x" + toPadded.slice(-40);
      if (toAddr.toLowerCase() !== vaultLower) continue;

      matching += 1;
      const outcome = await handleLog(log as unknown as Log);
      const row: ReplayResult["results"][number] = {
        logIndex: Number(log.logIndex ?? -1),
        outcome: outcome.outcome,
      };
      if (outcome.eventId !== undefined) {
        (row as { eventId: string }).eventId = outcome.eventId;
      }
      if (outcome.error !== undefined) {
        (row as { error: string }).error = outcome.error;
      }
      if (outcome.tokenId !== undefined) {
        (row as { tokenId: string }).tokenId = outcome.tokenId;
      }
      if (outcome.from !== undefined) {
        (row as { from: string }).from = outcome.from;
      }
      results.push(row);
    }

    return {
      txHash,
      logsScanned: receipt.logs.length,
      matchingTransfers: matching,
      results,
    };
  };

  return {
    start() {
      if (unwatch !== null || stopped) return;
      subscribe();
      backfillTimer = setTimeout(() => void runBackfill(), 2_000);
      sayInfo("start_called", {});
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
    snapshot,
    replay,
  };
}
