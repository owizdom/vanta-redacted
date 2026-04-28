/**
 * Pure in-memory inflow ledger.
 *
 * Rebuilt at boot from the signed `treasury.inflow` events already in
 * the event log (spec §1.4). Rebuild is idempotent: two rebuilds from
 * the same event list produce identical ledger state (property test
 * T-TR-ledger-rebuild-idempotent).
 *
 * The ledger holds ONLY data already committed as signed events — no
 * raw chain logs pass through here. Callers sign and append first, then
 * call `apply` with the committed body.
 *
 * Arithmetic is native bigint for totals; the public surface returns
 * decimal strings so big amounts survive wire JSON and canonical-JSON
 * round-trips (spec §1.7 "amountWei as uint256 decimal string").
 */

import { USDC_DECIMALS } from "./constants.js";
import { TreasuryError } from "./errors.js";
import type { TreasuryInflowBody } from "./types.js";

export interface InflowLedgerSnapshot {
  readonly totalInflowsCount: number;
  readonly totalInflowsWei: bigint;
  readonly totalInflowsUsdc: string;
  readonly lastInflowBlock: bigint | null;
  readonly lastInflowTxHash: `0x${string}` | null;
}

export interface InflowLedger {
  readonly apply: (body: TreasuryInflowBody) => void;
  readonly rebuildFrom: (bodies: readonly TreasuryInflowBody[]) => void;
  readonly snapshot: () => InflowLedgerSnapshot;
  readonly seenKey: (txHash: `0x${string}`, logIndex: number) => boolean;
  readonly trackKey: (txHash: `0x${string}`, logIndex: number) => void;
  readonly dedupSize: () => number;
}

/**
 * Format a raw uint256 USDC wei value as a 6-decimal-place USDC string.
 *
 * Pure-bigint math: no `Number`, no floats, no loss past 2^53. Invariant:
 * `formatUsdc(parseUsdcWei(s)) === s` for any s matching `^\d+$`.
 */
export function formatUsdc(wei: bigint): string {
  if (wei < 0n) {
    throw new TreasuryError(
      "balance_discrepancy_observed",
      "negative wei passed to formatUsdc",
    );
  }
  const base = 10n ** BigInt(USDC_DECIMALS);
  const whole = wei / base;
  const frac = wei % base;
  const fracStr = frac.toString().padStart(USDC_DECIMALS, "0");
  return `${whole.toString()}.${fracStr}`;
}

/** Strict decimal-digit parse; rejects signed, hex, whitespace, empty. */
export function parseUintString(s: string, field: string): bigint {
  if (s.length === 0 || !/^\d+$/.test(s)) {
    throw new TreasuryError(
      "balance_discrepancy_observed",
      `${field} is not a decimal digit string`,
      { field },
    );
  }
  return BigInt(s);
}

function dedupKey(txHash: `0x${string}`, logIndex: number): string {
  return `${txHash}:${logIndex.toString()}`;
}

/** Construct a fresh empty ledger. */
export function createInflowLedger(): InflowLedger {
  let totalInflowsCount = 0;
  let totalInflowsWei = 0n;
  let lastInflowBlock: bigint | null = null;
  let lastInflowTxHash: `0x${string}` | null = null;
  const dedup = new Set<string>();

  function apply(body: TreasuryInflowBody): void {
    const key = dedupKey(body.txHash, body.logIndex);
    if (dedup.has(key)) {
      // Defensive. Watcher is the gate; if it ever double-applies, fail
      // closed so the discrepancy surfaces instead of silently corrupting
      // totals. This is spec §4 `inflow_dedup_collision`.
      throw new TreasuryError(
        "inflow_dedup_collision",
        "inflow body already applied to ledger",
        { txHash: body.txHash, logIndex: String(body.logIndex) },
      );
    }

    const addWei = parseUintString(body.amountWei, "amountWei");
    const blockNumber = parseUintString(body.blockNumber, "blockNumber");

    totalInflowsCount += 1;
    totalInflowsWei += addWei;
    // Keep the highest block number observed so far as `lastInflowBlock`.
    // Ordering cannot be assumed: rebuild may replay in arbitrary order,
    // and multi-log txs can arrive with identical blocks.
    if (lastInflowBlock === null || blockNumber > lastInflowBlock) {
      lastInflowBlock = blockNumber;
      lastInflowTxHash = body.txHash;
    }
    dedup.add(key);
  }

  function rebuildFrom(bodies: readonly TreasuryInflowBody[]): void {
    totalInflowsCount = 0;
    totalInflowsWei = 0n;
    lastInflowBlock = null;
    lastInflowTxHash = null;
    dedup.clear();
    for (const b of bodies) {
      apply(b);
    }
  }

  function snapshot(): InflowLedgerSnapshot {
    return {
      totalInflowsCount,
      totalInflowsWei,
      totalInflowsUsdc: formatUsdc(totalInflowsWei),
      lastInflowBlock,
      lastInflowTxHash,
    };
  }

  function seenKey(txHash: `0x${string}`, logIndex: number): boolean {
    return dedup.has(dedupKey(txHash, logIndex));
  }

  function trackKey(txHash: `0x${string}`, logIndex: number): void {
    dedup.add(dedupKey(txHash, logIndex));
  }

  function dedupSize(): number {
    return dedup.size;
  }

  return { apply, rebuildFrom, snapshot, seenKey, trackKey, dedupSize };
}
