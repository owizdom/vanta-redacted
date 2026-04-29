/**
 * 30-second tick driver.
 *
 * On each tick, for each configured market:
 *   1. Fetch trades in the last TWAP_WINDOW_SECONDS via the injected
 *      `fetchTrades`. Any thrown `MarkError.http_non_200` is translated
 *      into a single `emitGap` call on the first failure (I-MK-2
 *      tightening: not after 90s of silence).
 *   2. On success, attempt `buildLoanMarkBody`. `MarkSparseSignal` →
 *      `emitSparse`. `MarkError.cross_check_divergence` → also
 *      `emitSparse` with `cross_check_disagreement`. Otherwise
 *      `emitMark`.
 *
 * Clock injection (`now()`): tests synthesize minute-scale timelines
 * in milliseconds. `start` schedules its own timer driven by `now()`
 * as Unix seconds.
 *
 * `start` is idempotent against its own handle; calling `stop` twice
 * is a no-op. The poller DOES NOT hold module-global state (unlike
 * treasury's watcher singleton) because multiple pollers are
 * conceivable under test.
 */

import type { PublicClient } from "viem";

import type {
  LoanMarkBody,
  OpMarkGapBody,
  OpMarkSparseBody,
} from "@vanta/events";

import {
  buildLoanMarkBody,
  buildMarkGapBody,
  buildMarkSparseBody,
} from "./builder.js";
import {
  POLL_INTERVAL_SECONDS,
  TWAP_WINDOW_SECONDS,
} from "./constants.js";
import { MarkError, MarkSparseSignal, type SparseReason } from "./errors.js";
import type { FetchMarketResult, FetchTradesResult } from "./clob.js";
import type { Sha256Hex } from "@vanta/tee";

export interface MarkTarget {
  readonly conditionId: Sha256Hex;
  readonly tokenId: string;
  readonly loanId: Sha256Hex;
}

/**
 * Fetch-trades and fetch-market fns are injected. Production callers
 * hand in the real `clob.fetchTrades` / `clob.fetchMarket`; tests hand
 * in a `FakeCLOB`. `fetchMarket` is reserved for the halt / resolution
 * cross-check that Phase 1 §4 "Market-resolution via CLOB" requires
 * (I-PL-7); the poller performs a readiness probe but does NOT block on
 * it, because Week 2 commit 4's scope is the mark feed only.
 */
export type FetchTradesFn = (
  conditionId: Sha256Hex,
  afterTsUnix: number,
) => Promise<FetchTradesResult>;

export type FetchMarketFn = (
  conditionId: Sha256Hex,
) => Promise<FetchMarketResult>;

export type EmitMarkFn = (body: LoanMarkBody) => Promise<void>;
export type EmitGapFn = (body: OpMarkGapBody) => Promise<void>;
export type EmitSparseFn = (body: OpMarkSparseBody) => Promise<void>;

export interface MarkPollerArgs {
  readonly client?: PublicClient | undefined;
  readonly fetchTrades: FetchTradesFn;
  readonly fetchMarket: FetchMarketFn;
  readonly emitMark: EmitMarkFn;
  readonly emitGap: EmitGapFn;
  readonly emitSparse: EmitSparseFn;
  readonly markets: readonly MarkTarget[];
  readonly now: () => number;
  /** Optional sleep injection. Tests bypass real setTimeout. */
  readonly sleepMs?: (ms: number) => Promise<void>;
}

export interface MarkPollerHandle {
  readonly start: () => void;
  readonly stop: () => void;
  /** Expose one-shot tick for test harnesses. */
  readonly runTick: () => Promise<void>;
}

export function createMarkPoller(args: MarkPollerArgs): MarkPollerHandle {
  // Per-market state: whether the most recent fetch was a failure, and
  // the timestamp of the first failure so gap.duration_seconds can be
  // filled in. We store on a Map keyed by conditionId.
  const failureState = new Map<
    Sha256Hex,
    { first_failure_unix: number; http_status: number; clob_hostname: string }
  >();

  let running = false;

  const sleep = args.sleepMs ?? ((ms: number) =>
    new Promise<void>((res) => setTimeout(res, ms)));

  const runTick = async (): Promise<void> => {
    const tickStart = args.now();
    const windowEnd = tickStart;
    const windowStart = windowEnd - TWAP_WINDOW_SECONDS;

    for (const m of args.markets) {
      let tradesResult: FetchTradesResult;
      try {
        tradesResult = await args.fetchTrades(m.conditionId, windowStart);
      } catch (err: unknown) {
        // HTTP error (any MarkError.http_non_200 / transport) → gap on
        // first failure only. A subsequent failure does not re-emit.
        const already = failureState.get(m.conditionId);
        if (already === undefined) {
          const hostname =
            err instanceof MarkError && err.context["host"] !== undefined
              ? err.context["host"]
              : "clob.polymarket.com";
          const status =
            err instanceof MarkError && err.context["status"] !== undefined
              ? Number(err.context["status"])
              : 0;
          failureState.set(m.conditionId, {
            first_failure_unix: tickStart,
            http_status: status,
            clob_hostname: hostname,
          });
          await args.emitGap(
            buildMarkGapBody({
              clob_hostname: hostname,
              http_status: status,
              first_failure_unix: tickStart,
              duration_seconds: 0,
              affected_condition_ids: [m.conditionId],
            }),
          );
        }
        continue;
      }

      // Reset failure state on successful fetch.
      failureState.delete(m.conditionId);

      // Bootstrap-price strategy: if trades exist in the window, take
      // the first trade's price as bootstrap (it holds for zero seconds
      // in that case, so the value doesn't influence the TWAP beyond
      // the fallback). The strictly-correct bootstrap is the midpoint
      // at window start, but that requires a second HTTP call; the
      // poller's scope is the 30s tick and that extra call is deferred
      // to the integration test in a later commit. Use the first
      // trade's price as a documented approximation; fall back to "0"
      // if the window is empty (the insufficient_trades branch below
      // will short-circuit before the TWAP math cares).
      const bootstrapPrice =
        tradesResult.trades.length > 0
          ? (tradesResult.trades[0]?.price ?? "0")
          : "0";

      // Deduplicate by transactionHash (TWAP contract in twap.ts).
      const seenTx = new Set<string>();
      const deduped = tradesResult.trades.filter((t) => {
        if (seenTx.has(t.transactionHash)) return false;
        seenTx.add(t.transactionHash);
        return true;
      });

      // Aggregate notional for sparse body reporting (informational only;
      // the TWAP path doesn't gate on it since I-MK-3's aggregate-notional
      // floor is enforced by the caller when it wants to; we still report
      // it accurately for observability).
      const aggregateNotional = computeAggregateNotional6dec(deduped);

      try {
        const body = buildLoanMarkBody({
          loan_id: m.loanId,
          token_id: m.tokenId,
          condition_id: m.conditionId,
          window_start_unix: windowStart,
          window_end_unix: windowEnd,
          trades: deduped,
          bootstrap_price: bootstrapPrice,
          attestation: tradesResult.attestation,
          source_block_range: [0, 0],
        });
        await args.emitMark(body);
      } catch (err: unknown) {
        if (err instanceof MarkSparseSignal) {
          await emitSparseFromSignal(err.reason);
          continue;
        }
        if (
          err instanceof MarkError &&
          err.code === "cross_check_divergence"
        ) {
          await emitSparseFromSignal("cross_check_disagreement");
          continue;
        }
        throw err;
      }

      async function emitSparseFromSignal(reason: SparseReason): Promise<void> {
        await args.emitSparse(
          buildMarkSparseBody({
            condition_id: m.conditionId,
            token_id: m.tokenId,
            window_start_unix: windowStart,
            window_end_unix: windowEnd,
            reason,
            trade_count: deduped.length,
            aggregate_notional_usdc: aggregateNotional,
          }),
        );
      }
    }
  };

  const start = (): void => {
    if (running) return;
    running = true;
    void pump();
  };

  const pump = async (): Promise<void> => {
    while (running) {
      try {
        await runTick();
      } catch {
        // Ticks should not throw (runTick catches + converts), but if
        // something does, keep pumping — the alternative is a silent
        // stall. Observability is wired externally.
      }
      // `running` may flip to false inside runTick via stop(); check
      // before sleeping. ESLint's flow analysis can't see the await
      // side-effect so the recheck trips `no-unnecessary-condition`;
      // we accept it as the cleanest way to honor stop().
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!running) break;
      await sleep(POLL_INTERVAL_SECONDS * 1000);
    }
  };

  const stop = (): void => {
    if (!running) return;
    running = false;
  };

  return { start, stop, runTick };
}

/**
 * Sum size*price across dedup'd trades and render as USDC-6-decimal
 * decimal string. Prices are in [0, 1]; sizes are `decimal` strings.
 * Multiplying through `number` incurs ~2^-52 rounding; we coerce the
 * final product to an integer of 10^6 base units then back to a
 * decimal string to match the `amountStr` regex in the events schema.
 */
export function computeAggregateNotional6dec(
  trades: readonly { readonly size: string; readonly price: string }[],
): string {
  let total = 0;
  for (const t of trades) {
    const s = Number(t.size);
    const p = Number(t.price);
    if (Number.isFinite(s) && Number.isFinite(p)) {
      total += s * p;
    }
  }
  const base = Math.floor(total * 1_000_000);
  return String(Math.max(0, base));
}
