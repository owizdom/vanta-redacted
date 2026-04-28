/**
 * `buildOutflowTx` — Week 1 pure planner (spec §1.5).
 *
 * Validates a `ScheduleEntry`, encodes ERC-20 `transfer(to, amountWei)`
 * calldata, returns a read-only `OutflowPlan` with `dryRun: true`. No
 * signing, no RPC, no broadcast. Live execution lands Week 3 behind a
 * separate entry point (spec §10 D-TR-1).
 *
 * Invariants enforced (spec §2 I-TR-2):
 *   - `scheduleEntry` is the ONLY way to produce an outflow plan
 *   - `amount <= capUsdcWei` per period
 *   - `constitutionalRef` resolver is injected so the constitution
 *      module's genesis SCO is the source of truth; Week 1 callers
 *      supply a stub resolver, Week 3 binds the real one.
 */

import { encodeFunctionData, type Hex } from "viem";

import { CHAIN_ID, USDC_BASE_SEPOLIA } from "./constants.js";
import { TreasuryError } from "./errors.js";
import { parseUintString } from "./ledger.js";
import { usdcAbi } from "./usdc.js";
import type { OutflowPlan, ScheduleEntry } from "./types.js";

/**
 * Resolver for `constitutionalRef`. Returns `true` iff the ref resolves
 * to a published entry in the genesis SCO. Injected so this module
 * does not depend on `@vanta/constitution` directly (spec §9 OQ-1).
 */
export type ConstitutionalRefResolver = (ref: string) => boolean;

/**
 * Reservation-remainder lookup for per-period schedule cap. Returns the
 * remaining capacity (uint256 decimal string) for `entry.id` in the
 * current period. Week 1 tests stub this (spec §1.5
 * `schedule_period_exhausted` reserved).
 */
export type SchedulePeriodRemainder = (entry: ScheduleEntry) => string;

export interface BuildOutflowDeps {
  readonly resolveRef: ConstitutionalRefResolver;
  readonly remainder?: SchedulePeriodRemainder;
}

/**
 * Pure planner. `amountWei` must be a decimal digit string. Returns a
 * frozen `OutflowPlan` on success.
 *
 * Error mapping (spec §4):
 *   - `null` scheduleEntry → `schedule_entry_missing`
 *   - amount > cap            → `schedule_amount_mismatch`
 *   - amount > remainder      → `schedule_period_exhausted`
 *   - ref not resolved        → `schedule_constitutional_ref_unresolved`
 */
export function buildOutflowTx(
  scheduleEntry: ScheduleEntry | null,
  amountWei: string,
  deps: BuildOutflowDeps,
): OutflowPlan {
  if (scheduleEntry === null) {
    throw new TreasuryError(
      "schedule_entry_missing",
      "outflow plan requires a non-null ScheduleEntry",
    );
  }

  const amount = parseUintString(amountWei, "amountWei");
  const cap = parseUintString(scheduleEntry.capUsdcWei, "capUsdcWei");

  if (amount > cap) {
    throw new TreasuryError(
      "schedule_amount_mismatch",
      "outflow amount exceeds schedule entry cap",
      {
        scheduleId: scheduleEntry.id,
      },
    );
  }

  if (deps.remainder !== undefined) {
    const remainderStr = deps.remainder(scheduleEntry);
    const remainder = parseUintString(remainderStr, "remainder");
    if (amount > remainder) {
      throw new TreasuryError(
        "schedule_period_exhausted",
        "outflow amount exceeds remaining period allowance",
        { scheduleId: scheduleEntry.id },
      );
    }
  }

  if (!deps.resolveRef(scheduleEntry.constitutionalRef)) {
    throw new TreasuryError(
      "schedule_constitutional_ref_unresolved",
      "scheduleEntry.constitutionalRef did not resolve in the genesis SCO",
      { scheduleId: scheduleEntry.id },
    );
  }

  const data: Hex = encodeFunctionData({
    abi: usdcAbi,
    functionName: "transfer",
    args: [scheduleEntry.destination, amount],
  });

  const plan: OutflowPlan = Object.freeze({
    chainId: CHAIN_ID,
    to: USDC_BASE_SEPOLIA,
    data,
    amountWei: amount.toString(),
    scheduleId: scheduleEntry.id,
    plannedAt: Date.now(),
    dryRun: true,
  });

  return plan;
}
