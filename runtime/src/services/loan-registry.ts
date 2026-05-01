/**
 * In-memory registry of active loans.
 *
 * Hydrated from the on-disk event log on boot: scan every
 * `loan.origination` event, and skip those that already have a
 * matching `loan.settlement` or `loan.liquidation` event downstream.
 *
 * The registry is the source of truth for the mark loop: one poller
 * per registry entry, draining tickless on `unregister`.
 */

import type { Sha256Hex } from "@vanta/tee";

import type { FileEventLog } from "../events-store.js";

export interface ActiveLoan {
  readonly loanId: Sha256Hex;
  readonly conditionId: Sha256Hex;
  readonly tokenId: string;
  readonly originationBlock: number;
  readonly originationEventId: Sha256Hex;
  /** USDC wei (6 decimals) — origination body's `principal` field. */
  readonly principal: bigint;
  /** Maturity unix seconds — origination body's `maturity_ts_unix`. */
  readonly maturityTsUnix: number;
  /** Haircut applied at origination, basis points. */
  readonly haircutBps: number;
  /**
   * Notional in CTF token base units. The origination body does not
   * carry notional in v1.0 — we approximate it as the sibling pledge
   * `amount` when available, falling back to 0n. Phase 11 wires the
   * accurate value once the origination schema is bumped.
   */
  readonly notional: bigint;
}

export class LoanRegistry {
  private readonly active = new Map<Sha256Hex, ActiveLoan>();
  private readonly listeners: Array<(loan: ActiveLoan, op: "add" | "remove") => void> = [];

  public size(): number {
    return this.active.size;
  }

  public list(): readonly ActiveLoan[] {
    return Array.from(this.active.values());
  }

  public get(loanId: Sha256Hex): ActiveLoan | undefined {
    return this.active.get(loanId);
  }

  public add(loan: ActiveLoan): void {
    if (this.active.has(loan.loanId)) return; // idempotent
    this.active.set(loan.loanId, loan);
    for (const fn of this.listeners) fn(loan, "add");
  }

  public remove(loanId: Sha256Hex): void {
    const loan = this.active.get(loanId);
    if (loan === undefined) return;
    this.active.delete(loanId);
    for (const fn of this.listeners) fn(loan, "remove");
  }

  public onChange(fn: (loan: ActiveLoan, op: "add" | "remove") => void): void {
    this.listeners.push(fn);
  }

  /**
   * Scan the on-disk log and rebuild the active set. O(N) on boot;
   * cheap because origination events are sparse.
   */
  public async hydrateFromLog(
    log: FileEventLog,
    pledgeIndex: Map<Sha256Hex, {
      conditionId: Sha256Hex;
      tokenId: string;
      amount: bigint;
    }>,
  ): Promise<void> {
    const settled = new Set<Sha256Hex>();
    const originations = new Map<Sha256Hex, ActiveLoan>();

    for await (const ev of log.walkFromHead()) {
      if (ev.type === "loan.origination") {
        const body = ev.body;
        const pledgeId = ev.parent_ids[0];
        const pledge = pledgeId !== undefined ? pledgeIndex.get(pledgeId) : undefined;
        const conditionId = pledge?.conditionId ?? body.loan_id;
        const tokenId = pledge?.tokenId ?? body.loan_id;
        const notional = pledge?.amount ?? 0n;
        originations.set(body.loan_id, {
          loanId: body.loan_id,
          conditionId,
          tokenId,
          originationBlock: body.block_number,
          originationEventId: ev.id,
          principal: BigInt(body.principal),
          maturityTsUnix: body.maturity_ts_unix,
          haircutBps: body.haircut_bps,
          notional,
        });
      } else if (ev.type === "loan.settlement") {
        settled.add(ev.body.loanId);
      } else if (ev.type === "loan.liquidation") {
        settled.add(ev.body.loanId);
      }
    }

    for (const [loanId, loan] of originations.entries()) {
      if (settled.has(loanId)) continue;
      this.add(loan);
    }
  }

  /**
   * Build a pledge-id → {conditionId, tokenId, amount} map by scanning
   * the log for `loan.pledge` events. Used during hydrate so origination
   * events can resolve their cited pledge's market metadata + notional.
   */
  public static async buildPledgeIndex(
    log: FileEventLog,
  ): Promise<Map<Sha256Hex, {
    conditionId: Sha256Hex;
    tokenId: string;
    amount: bigint;
  }>> {
    const out = new Map<Sha256Hex, {
      conditionId: Sha256Hex;
      tokenId: string;
      amount: bigint;
    }>();
    for await (const ev of log.walkFromHead()) {
      if (ev.type === "loan.pledge") {
        out.set(ev.id, {
          conditionId: ev.body.condition_id,
          tokenId: ev.body.position_id,
          amount: BigInt(ev.body.amount),
        });
      }
    }
    return out;
  }
}
