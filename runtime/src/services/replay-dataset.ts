/**
 * Real ReplayRow adapter — wires the model loop's weekly calibration
 * replay to the agent's own signed event log.
 *
 * Replaces the stub at main.ts that returned an empty dataset every
 * week. With this module, every terminal loan event (settlement or
 * liquidation) becomes a row the model loop replays to compute realized
 * loss-given-default vs the formula's pre-loss prediction. If the
 * aggregate error breaches 200 bps the loop emits a
 * `loop.calibration_proposal` for the multisig — the agent's
 * pricing parameters drift detector.
 *
 * Pipeline:
 *   1. walkFromHead the event log once.
 *   2. Build three maps: pledges (cid + notional), originations (by
 *      loan_id), and the first `loan.mark` per loan_id (gives us the
 *      TWAP near origination — the closest signal to origination_price
 *      the log carries today).
 *   3. For every `loan.settlement` and `loan.liquidation`, join back to
 *      its origination via `body.loanId`, derive a ReplayRow, hash it.
 *
 * Cold-start fine: if no terminal events exist (fresh deploy, no loans
 * resolved yet), we return `{ rows: [], dataset_hash: 0…0 }` and the
 * model loop's `runReplay` no-ops on empty rows. The loop becomes
 * substantively useful the moment the first loan resolves.
 *
 * Approximations (Phase-6 candidates):
 *   - origination_price: from the first sibling `loan.mark` event. If
 *     no mark exists for the loan (a settlement that happened before
 *     the mark loop started), fall back to 0.5 (neutral midpoint) so
 *     the row still contributes a non-NaN haircut prediction.
 *   - oracle_dispute_rate: hardcoded to 0. Real UMA dispute lookup
 *     needs `@vanta/venue-poly` integration — Phase 6.
 *   - realized_outcome: derived from terminal event type. settlement
 *     → 1 (the borrower repaid because their position was winning),
 *     liquidation → 0 (the agent had to liquidate because the position
 *     went against them). Coarse but directionally correct; Phase 6
 *     reads the actual on-chain market resolution.
 */

import { createHash } from "node:crypto";

import { canonicalJsonBytes } from "@vanta/events";
import { asSha256Hex, type Sha256Hex } from "@vanta/tee";

import type { FileEventLog } from "../events-store.js";
import type { ReplayRow } from "../loops/model.js";

interface PledgeInfo {
  readonly conditionId: Sha256Hex;
  readonly amount: bigint;
}

interface OriginationInfo {
  readonly loanId: Sha256Hex;
  readonly conditionId: Sha256Hex;
  readonly principalUsdc: string;
  readonly originationTsUnix: number;
  readonly maturityTsUnix: number;
  readonly notional: bigint;
}

export interface ReplayDatasetArgs {
  readonly eventsStore: FileEventLog;
}

export function createReplayDataset(
  args: ReplayDatasetArgs,
): () => Promise<{
  readonly rows: readonly ReplayRow[];
  readonly dataset_hash: Sha256Hex;
}> {
  return async () => {
    const pledges = new Map<Sha256Hex, PledgeInfo>();
    const originations = new Map<Sha256Hex, OriginationInfo>();
    const firstMarkPriceByLoan = new Map<Sha256Hex, number>();
    const firstMarkTsByLoan = new Map<Sha256Hex, number>();
    const settledLoans: Array<{ loanId: Sha256Hex; outcome: number }> = [];

    for await (const ev of args.eventsStore.walkFromHead()) {
      if (ev.type === "loan.pledge") {
        pledges.set(ev.id, {
          conditionId: ev.body.condition_id,
          amount: BigInt(ev.body.amount),
        });
      } else if (ev.type === "loan.origination") {
        const pledgeId = ev.parent_ids[0];
        const pledge = pledgeId !== undefined ? pledges.get(pledgeId) : undefined;
        if (pledge === undefined) continue;
        originations.set(ev.body.loan_id, {
          loanId: ev.body.loan_id,
          conditionId: pledge.conditionId,
          principalUsdc: ev.body.principal,
          originationTsUnix: ev.timestamp,
          maturityTsUnix: ev.body.maturity_ts_unix,
          notional: pledge.amount,
        });
      } else if (ev.type === "loan.mark") {
        const prior = firstMarkTsByLoan.get(ev.body.loan_id);
        if (prior === undefined || ev.timestamp < prior) {
          firstMarkPriceByLoan.set(ev.body.loan_id, Number(ev.body.twap));
          firstMarkTsByLoan.set(ev.body.loan_id, ev.timestamp);
        }
      } else if (ev.type === "loan.settlement") {
        settledLoans.push({ loanId: ev.body.loanId, outcome: 1 });
      } else if (ev.type === "loan.liquidation") {
        settledLoans.push({ loanId: ev.body.loanId, outcome: 0 });
      }
    }

    const rows: ReplayRow[] = [];
    for (const settled of settledLoans) {
      const origination = originations.get(settled.loanId);
      if (origination === undefined) continue;

      const originationPrice =
        firstMarkPriceByLoan.get(settled.loanId) ?? 0.5;

      const tauSeconds =
        origination.maturityTsUnix - origination.originationTsUnix;
      const tauDays = Math.max(tauSeconds / 86_400, 1 / 86_400);

      const row: Omit<ReplayRow, "row_hash"> = {
        condition_id: origination.conditionId,
        origination_price: originationPrice,
        tau_days_at_origination: tauDays,
        // TODO(phase-6): wire UMA dispute count via @vanta/venue-poly.
        oracle_dispute_rate: 0,
        principal_usdc: origination.principalUsdc,
        // TODO(phase-6): replace with on-chain market-resolution lookup.
        // settlement→1 / liquidation→0 is directionally correct but coarse.
        realized_outcome: settled.outcome,
      };
      const rowHash = asSha256Hex(
        createHash("sha256")
          .update(canonicalJsonBytes(row))
          .digest("hex"),
      );
      rows.push({ ...row, row_hash: rowHash });
    }

    const datasetHash =
      rows.length === 0
        ? asSha256Hex("0".repeat(64))
        : asSha256Hex(
            createHash("sha256")
              .update(canonicalJsonBytes({ rows }))
              .digest("hex"),
          );

    return { rows, dataset_hash: datasetHash };
  };
}
