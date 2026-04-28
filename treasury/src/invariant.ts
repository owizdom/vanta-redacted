/**
 * `I-TR-3` reconciler — observed vs expected balance, every 10 blocks.
 *
 * Week 1 scope (spec §2 I-TR-3 + §6.5): logs discrepancies. Week 3
 * wires the freeze-outflows effect on `balance_discrepancy_observed`.
 *
 * Decision recap:
 *   - observed == expected     → no event, no freeze
 *   - observed > expected      → likely in-flight Transfer pending
 *                                5-block confirm; not a violation
 *                                within a 20-block tolerance window
 *   - observed < expected      → invariant break; emit signed event
 *                                `treasury.balance_discrepancy` (Week 3
 *                                also freezes outflows). Week 1 returns
 *                                the discrepancy payload and lets
 *                                callers decide how to surface it.
 *
 * This file is PURE w.r.t. the event log: it reports discrepancies but
 * does not itself sign/append. The caller (Week 3 integration) routes
 * the payload to `buildAndSign`.
 */

import type { PublicClient } from "viem";

import {
  RECONCILE_BLOCK_CADENCE,
  USDC_BASE_SEPOLIA,
} from "./constants.js";
import { TreasuryError } from "./errors.js";
import { getBindings } from "./init.js";
import { usdcAbi } from "./usdc.js";
import type { EthAddressHex } from "@vanta/tee";

/** Outcome of a single reconciliation tick. */
export type ReconcileResult =
  | { readonly kind: "match"; readonly balanceWei: bigint }
  | { readonly kind: "observed_gt_expected_tolerable"; readonly excessWei: bigint }
  | { readonly kind: "observed_gt_expected_warning"; readonly excessWei: bigint }
  | { readonly kind: "observed_lt_expected_discrepancy"; readonly shortfallWei: bigint };

export interface ReconcileOpts {
  /** Override for tests; defaults to live publicClient.getBalance-of-token. */
  readonly readBalance?: (address: EthAddressHex) => Promise<bigint>;
}

/**
 * Run one reconciliation tick. Returns a discriminated outcome; callers
 * decide whether to emit a signed `treasury.balance_discrepancy` event.
 */
export async function reconcileOnce(opts: ReconcileOpts = {}): Promise<ReconcileResult> {
  const bindings = getBindings();
  const read = opts.readBalance ?? defaultReadBalance(bindings.clients.publicClient);

  let observed: bigint;
  try {
    observed = await read(bindings.address);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new TreasuryError(
      "rpc_unreachable",
      `balanceOf(treasury) failed: ${msg}`,
    );
  }

  const expected = bindings.ledger.snapshot().totalInflowsWei;

  if (observed === expected) {
    return { kind: "match", balanceWei: observed };
  }

  if (observed > expected) {
    const excess = observed - expected;
    // Spec §2 I-TR-3 "within 20-block window, do not emit". We do not
    // track block-level persistence here — that is the scheduler's job.
    // Report the excess as tolerable; the scheduler promotes to warning
    // after >20 blocks of persistence.
    return { kind: "observed_gt_expected_tolerable", excessWei: excess };
  }

  // observed < expected — serious invariant break.
  return {
    kind: "observed_lt_expected_discrepancy",
    shortfallWei: expected - observed,
  };
}

/** Default live-RPC balance reader. */
function defaultReadBalance(
  client: PublicClient,
): (address: EthAddressHex) => Promise<bigint> {
  return async (address: EthAddressHex): Promise<bigint> => {
    const raw = await client.readContract({
      address: USDC_BASE_SEPOLIA,
      abi: usdcAbi,
      functionName: "balanceOf",
      args: [address],
    });
    // viem's typed abi narrows balanceOf → bigint; assert defensively
    // in case a future ABI shape widens.
    if (typeof raw !== "bigint") {
      throw new TreasuryError(
        "rpc_response_inconsistent",
        "balanceOf did not return a bigint",
      );
    }
    return raw;
  };
}

export interface ReconcileSchedulerHandle {
  readonly stop: () => void;
}

export type ReconcileEmitFn = (result: ReconcileResult) => void | Promise<void>;

/**
 * Schedule reconciliation on every `RECONCILE_BLOCK_CADENCE` blocks.
 *
 * We do not subscribe to a block feed here; instead we tick on a timer
 * aligned to the 2s Base Sepolia blocktime × cadence = 20s. Precise
 * block-alignment is a Week 3 refinement (spec §10). `onResult`
 * receives every tick outcome; callers filter.
 */
export function startReconciler(
  onResult: ReconcileEmitFn,
  opts: ReconcileOpts = {},
): ReconcileSchedulerHandle {
  const intervalMs = Number(RECONCILE_BLOCK_CADENCE) * 2_000;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const result = await reconcileOnce(opts);
      await onResult(result);
    } catch {
      // Swallow reconciler errors so the timer continues. The outcome
      // for a failing tick is "no result for this window"; next window
      // re-tries. Callers wire observability externally (no console.log).
    }
  };

  const handle = setInterval(() => {
    void tick();
  }, intervalMs);
  // Allow the process to exit while the reconciler is running.
  handle.unref?.();

  return {
    stop: (): void => {
      if (stopped) return;
      stopped = true;
      clearInterval(handle);
    },
  };
}
