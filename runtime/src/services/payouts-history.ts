/**
 * Payouts history walker — joins `treasury.outflow` events to their
 * sibling `reasoning.trace` via `subject_event_id` so the bucket label
 * (gas_topup / hosting / inference) and dry-run flag survive the
 * round-trip through the signed log.
 *
 * Used by:
 *   - `payouts.ts` itself for weekly-cap accounting (sum of last-7d
 *     outflows per bucket, blocking new disbursements once the rolling
 *     cap is reached).
 *   - `/api/state` to surface the last 30 disbursements + weekly totals
 *     in the AgentBand UI.
 *
 * One pass over the log: O(events).
 */

import type { FileEventLog } from "../events-store.js";

export type PayoutBucket = "gas_topup" | "hosting" | "inference";

export interface PayoutRecord {
  readonly ts: number;
  /** Outflow event id; useful as a stable cursor / dedupe key. */
  readonly outflowEventId: string;
  readonly bucket: PayoutBucket;
  /** USDC wei (6 decimals). Stored as string to match event body type. */
  readonly amountUsdc6: string;
  /** Recipient address from the outflow body. */
  readonly recipient: string;
  /** Asset string from the outflow body — usually USDC contract or "ETH". */
  readonly asset: string;
  /** On-chain tx hash. "0x000…000" indicates a dry-run record. */
  readonly txHash: string;
  /**
   * Whether this was a dry-run (calldata logged, not broadcast). True
   * when the trace's `dry_run` field is "true". Excluded from weekly
   * cap accounting.
   */
  readonly dryRun: boolean;
}

/**
 * Walk recent log events, collecting `treasury.outflow` rows and
 * joining each to the matching `reasoning.trace`. The walker reads
 * tip→genesis (newest first) until `sinceUnix` is crossed.
 *
 * Returns records ordered newest-first. Outflows that lack a sibling
 * trace are skipped — they aren't ours; the bucket can't be determined
 * without the trace context.
 */
export async function walkPayouts(
  log: FileEventLog,
  sinceUnix: number,
): Promise<readonly PayoutRecord[]> {
  // Index traces by subject_event_id so we can join in O(1) per outflow.
  const tracesBySubject = new Map<
    string,
    { bucket: PayoutBucket; dryRun: boolean }
  >();
  const outflows: Array<{
    id: string;
    ts: number;
    body: Record<string, unknown>;
  }> = [];

  for await (const ev of log.walkFromTip()) {
    if (ev.timestamp < sinceUnix) break;
    if (ev.type === "reasoning.trace") {
      const body = ev.body as unknown as Record<string, unknown>;
      const subjectId = body["subject_event_id"];
      const subjectType = body["subject_event_type"];
      if (
        typeof subjectId !== "string" ||
        subjectType !== "treasury.outflow"
      ) {
        continue;
      }
      const inputs = body["inputs_summary"] as Record<string, unknown> | undefined;
      const bucketRaw = inputs?.["bucket"];
      const dryRunRaw = inputs?.["dry_run"];
      if (
        bucketRaw !== "gas_topup" &&
        bucketRaw !== "hosting" &&
        bucketRaw !== "inference"
      ) {
        continue;
      }
      tracesBySubject.set(subjectId, {
        bucket: bucketRaw,
        dryRun: dryRunRaw === "true" || dryRunRaw === true,
      });
    } else if (ev.type === "treasury.outflow") {
      outflows.push({
        id: ev.id,
        ts: ev.timestamp,
        body: ev.body as unknown as Record<string, unknown>,
      });
    }
  }

  const records: PayoutRecord[] = [];
  for (const o of outflows) {
    const trace = tracesBySubject.get(o.id);
    if (!trace) continue;
    const amountRaw = o.body["amount"];
    const txHashRaw = o.body["txHash"];
    const toRaw = o.body["toAddr"];
    const assetRaw = o.body["asset"];
    if (
      typeof amountRaw !== "string" ||
      typeof txHashRaw !== "string" ||
      typeof toRaw !== "string" ||
      typeof assetRaw !== "string"
    ) {
      continue;
    }
    records.push({
      ts: o.ts,
      outflowEventId: o.id,
      bucket: trace.bucket,
      amountUsdc6: amountRaw,
      recipient: toRaw,
      asset: assetRaw,
      txHash: txHashRaw,
      dryRun: trace.dryRun,
    });
  }
  return records;
}

/**
 * Sum non-dry-run outflows by bucket. Used by the Payouts service to
 * decide whether a new disbursement would exceed the rolling cap, and
 * by /api/state to surface weekly burn.
 */
export function sumByBucket(
  records: readonly PayoutRecord[],
): Record<PayoutBucket, bigint> {
  const totals: Record<PayoutBucket, bigint> = {
    gas_topup: 0n,
    hosting: 0n,
    inference: 0n,
  };
  for (const r of records) {
    if (r.dryRun) continue;
    try {
      totals[r.bucket] += BigInt(r.amountUsdc6);
    } catch {
      // skip malformed amounts — never crash on a stray non-numeric body.
    }
  }
  return totals;
}
