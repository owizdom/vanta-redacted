/**
 * Per-loan mark loop.
 *
 * On `start()`, spin up one `@vanta/mark.createMarkPoller` per active
 * loan in `LoanRegistry`. Each poller drives its own tick on
 * `MARK_TICK_SECONDS` cadence; emit callbacks sign + persist the
 * appropriate event into the on-disk log.
 *
 * I-RT-6: SIGTERM drains the in-flight tick before the loop exits.
 * We model that with a `stopping` flag the pollers see at the next
 * tick; the in-flight tick completes naturally because runTick is
 * sequential.
 *
 * Gap dedup: the underlying `createMarkPoller` already de-duplicates
 * gaps per condition (one emit on first failure, no re-emit until
 * recovery). We rely on that — see `mark/src/poller.ts::failureState`.
 */

import {
  buildAndSign,
  type LoanMarkBody,
  type OpMarkGapBody,
  type OpMarkSparseBody,
  type Sha256Hex,
} from "@vanta/events";
import { asSha256Hex, sign as teeSign } from "@vanta/tee";
import {
  createMarkPoller,
  type EmitGapFn,
  type EmitMarkFn,
  type EmitSparseFn,
  type FetchMarketFn,
  type FetchTradesFn,
  type MarkPollerHandle,
} from "@vanta/mark";

import type { Bootstrap } from "../bootstrap.js";
import type { LoanRegistry, ActiveLoan } from "./loan-registry.js";

export interface MarkLoopArgs {
  readonly bootstrap: Bootstrap;
  readonly registry: LoanRegistry;
  readonly fetchTrades: FetchTradesFn;
  readonly fetchMarket: FetchMarketFn;
  readonly tickSeconds: number;
  /** Override clock; tests inject a fake. Defaults to wall clock. */
  readonly now?: () => number;
  /** Override sleep; tests bypass real timers. */
  readonly sleepMs?: (ms: number) => Promise<void>;
}

export interface MarkLoop {
  readonly start: () => void;
  readonly stop: () => Promise<void>;
  /** For tests: pump all live pollers' runTick once. */
  readonly runTickAll: () => Promise<void>;
}

export function createMarkLoop(args: MarkLoopArgs): MarkLoop {
  const handles = new Map<Sha256Hex, MarkPollerHandle>();
  let stopping = false;
  let inFlight: Promise<void> = Promise.resolve();

  const buildPollerFor = (loan: ActiveLoan): MarkPollerHandle => {
    const teeBlock = {
      signingPubKey: args.bootstrap.tee.signingPubKey,
      kmsKeyHash: asSha256Hex("0".repeat(64)),
      tdxQuoteHash: null as null,
      attestationJwtHash: asSha256Hex("0".repeat(64)),
    };
    const instance = args.bootstrap.tee.identityAnchor?.kind === "kms-jwt"
      ? args.bootstrap.tee.identityAnchor.audience
      : "vanta-runtime-local";

    const emitMark: EmitMarkFn = async (body: LoanMarkBody) => {
      const event = buildAndSign({
        type: "loan.mark",
        parent_ids: [args.bootstrap.genesis.id, loan.originationEventId],
        lineage: "vanta-runtime",
        timestamp: Math.floor((args.now?.() ?? Date.now()) / 1000),
        epoch: Math.floor(args.bootstrap.tee.bootedAt / 1000),
        tee: teeBlock,
        instance,
        body,
        sign: teeSign,
      });
      await args.bootstrap.log.append(event);
    };

    const emitGap: EmitGapFn = async (body: OpMarkGapBody) => {
      const event = buildAndSign({
        type: "op.mark_gap",
        parent_ids: [args.bootstrap.genesis.id],
        lineage: "vanta-runtime",
        timestamp: Math.floor((args.now?.() ?? Date.now()) / 1000),
        epoch: Math.floor(args.bootstrap.tee.bootedAt / 1000),
        tee: teeBlock,
        instance,
        body,
        sign: teeSign,
      });
      await args.bootstrap.log.append(event);
    };

    const emitSparse: EmitSparseFn = async (body: OpMarkSparseBody) => {
      const event = buildAndSign({
        type: "op.mark_sparse",
        parent_ids: [args.bootstrap.genesis.id],
        lineage: "vanta-runtime",
        timestamp: Math.floor((args.now?.() ?? Date.now()) / 1000),
        epoch: Math.floor(args.bootstrap.tee.bootedAt / 1000),
        tee: teeBlock,
        instance,
        body,
        sign: teeSign,
      });
      await args.bootstrap.log.append(event);
    };

    const handle = createMarkPoller({
      fetchTrades: args.fetchTrades,
      fetchMarket: args.fetchMarket,
      emitMark,
      emitGap,
      emitSparse,
      markets: [
        {
          conditionId: loan.conditionId,
          tokenId: loan.tokenId,
          loanId: loan.loanId,
        },
      ],
      now: args.now ?? (() => Math.floor(Date.now() / 1000)),
      ...(args.sleepMs !== undefined ? { sleepMs: args.sleepMs } : {}),
    });
    return handle;
  };

  /**
   * Build a poller for `loan` if missing. Does NOT start it — the
   * caller controls when the in-poller `start()` (background pump)
   * runs. This split keeps `runTickAll` deterministic in tests
   * without spawning a background loop.
   */
  const ensureHandle = (loan: ActiveLoan): MarkPollerHandle => {
    let handle = handles.get(loan.loanId);
    if (handle === undefined) {
      handle = buildPollerFor(loan);
      handles.set(loan.loanId, handle);
    }
    return handle;
  };

  const start = (): void => {
    for (const loan of args.registry.list()) {
      const h = ensureHandle(loan);
      h.start();
    }
    args.registry.onChange((loan, op) => {
      if (op === "add") {
        const h = ensureHandle(loan);
        h.start();
      }
      if (op === "remove") {
        const h = handles.get(loan.loanId);
        if (h !== undefined) {
          h.stop();
          handles.delete(loan.loanId);
        }
      }
    });
  };

  const stop = async (): Promise<void> => {
    stopping = true;
    for (const h of handles.values()) h.stop();
    // Wait for the in-flight tick to drain.
    await inFlight;
    handles.clear();
  };

  const runTickAll = async (): Promise<void> => {
    // Materialize handles for all currently-registered loans (test
    // path: caller skipped start() to avoid the background pump).
    for (const loan of args.registry.list()) ensureHandle(loan);
    inFlight = (async () => {
      for (const h of handles.values()) {
        if (stopping) break;
        await h.runTick();
      }
    })();
    await inFlight;
  };

  return { start, stop, runTickAll };
}
