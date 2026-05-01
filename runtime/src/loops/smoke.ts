/**
 * Smoke test for the three reasoning loops.
 *
 * Run with: pnpm --filter @vanta/runtime smoke
 *
 * Stubs every external dependency with synthetic data, drives one tick
 * of each loop, and prints the emitted events. Exits non-zero if a loop
 * does not emit the events expected for its scenario.
 *
 * This is paper §7 made flesh: a chain of (reasoning.trace, primary)
 * event pairs the verifier could walk.
 */

import { createHash } from "node:crypto";

import { asSha256Hex, type Sha256Hex } from "@vanta/tee";

import { createCreditLoop, type ActiveLoanView, type CreditObservation } from "./credit.js";
import { createModelLoop, type ReplayRow } from "./model.js";
import { createOperationalLoop, type OperationalSnapshot } from "./operational.js";
import type { EventSink, LoopClock, LoopContext } from "./types.js";

interface CapturedEvent {
  readonly type: string;
  readonly body: object;
  readonly parentIds: readonly Sha256Hex[];
  readonly id: Sha256Hex;
}

function makeInMemorySink(): { sink: EventSink; events: CapturedEvent[] } {
  const events: CapturedEvent[] = [];
  let counter = 0;
  const sink: EventSink = {
    async emit({ type, body, parentIds }) {
      counter += 1;
      const seed = `${String(counter)}|${type}|${JSON.stringify(body)}|${parentIds.join(",")}`;
      const id = asSha256Hex(createHash("sha256").update(seed).digest("hex"));
      events.push({ type, body, parentIds, id });
      return id;
    },
  };
  return { sink, events };
}

function makeFakeClock(seedMs: number): LoopClock {
  return { nowMs: () => seedMs };
}

const NOW_MS = Date.UTC(2026, 4, 1);
const GENESIS_ID = asSha256Hex("0".repeat(64));

function makeCtx(sink: EventSink): LoopContext {
  // PublicClient is unused by the loops in their current form (chain
  // reads are abstracted behind the `observe` / `fetchDataset` callbacks),
  // so we cast a stub. Phase 11 wires real viem clients here.
  const stubClient = {} as unknown as LoopContext["base"];
  return {
    base: stubClient,
    amoy: stubClient,
    events: sink,
    clock: makeFakeClock(NOW_MS),
    genesisId: GENESIS_ID,
  };
}

async function smokeCredit(): Promise<void> {
  console.log("--- credit loop ---");
  const { sink, events } = makeInMemorySink();
  const ctx = makeCtx(sink);

  // Loan A: paper §4 worked example shape. p=0.60, τ=365, ρ=0.02 → h≈0.170,
  // V = 0.60 × 0.83 × 250,000 = 124,500 USDC, principal = 60,000 → LTV ≈ 48%.
  // Healthy. Expect flag=ok.
  //
  // Loan B: the position has fallen to p=0.30 against a 30-day market.
  // V = 0.30 × (1 − 0.05) × 200,000 ≈ 57,000 USDC against 100,000 principal
  // → LTV ≈ 175%, far above the 70% freeze threshold. Expect flag=freeze_request.
  const loans: readonly ActiveLoanView[] = [
    {
      loan_id: asSha256Hex("a".repeat(64)),
      principal_usdc: "60000000000", // 60,000 USDC (6 decimals)
      notional_tokens: "250000",
      maturity_ts_ms: NOW_MS + 365 * 86_400_000,
      condition_id: "0xabc",
      token_id: "1",
      origination_event_id: asSha256Hex("b".repeat(64)),
      originated_haircut_bps: 1_700,
    },
    {
      loan_id: asSha256Hex("c".repeat(64)),
      principal_usdc: "100000000000", // 100,000 USDC
      notional_tokens: "200000",
      maturity_ts_ms: NOW_MS + 30 * 86_400_000,
      condition_id: "0xdef",
      token_id: "1",
      origination_event_id: asSha256Hex("d".repeat(64)),
      originated_haircut_bps: 2_500,
    },
  ];

  // First loan: healthy, watch flag should be `ok`.
  // Second loan: price has fallen near liquidation — should freeze_request.
  const observations = new Map<Sha256Hex, CreditObservation>([
    [
      loans[0]!.loan_id,
      {
        best_bid: "0.60",
        twap_30min: "0.60",
        depth_5pct_usdc: "300000000000",
        dispute_30d_count: 0,
        time_to_resolution_seconds: 365 * 86_400,
      },
    ],
    [
      loans[1]!.loan_id,
      {
        best_bid: "0.30",
        twap_30min: "0.32",
        depth_5pct_usdc: "120000000000",
        dispute_30d_count: 1,
        time_to_resolution_seconds: 30 * 86_400,
      },
    ],
  ]);

  const loop = createCreditLoop({
    ctx,
    listActiveLoans: () => Promise.resolve(loans),
    observe: async (loan) => {
      const o = observations.get(loan.loan_id);
      if (!o) throw new Error(`no observation for ${loan.loan_id}`);
      return o;
    },
  });

  await loop.runTick();

  console.log(`emitted ${String(events.length)} events:`);
  for (const e of events) {
    const summary =
      e.type === "loop.credit_tick"
        ? ` flag=${(e.body as { flag: string }).flag} ltv_bps=${String((e.body as { ltv_current_bps: number }).ltv_current_bps)}`
        : "";
    console.log(`  ${e.type}${summary} (parents=${String(e.parentIds.length)})`);
  }

  const tickCount = events.filter((e) => e.type === "loop.credit_tick").length;
  const traceCount = events.filter((e) => e.type === "reasoning.trace").length;
  if (tickCount !== loans.length || traceCount !== loans.length) {
    throw new Error(
      `credit loop expected ${String(loans.length)} ticks + ${String(loans.length)} traces, got ${String(tickCount)} + ${String(traceCount)}`,
    );
  }
}

async function smokeModel(): Promise<void> {
  console.log("\n--- model loop ---");
  const { sink, events } = makeInMemorySink();
  const ctx = makeCtx(sink);

  // Synthetic dataset: predicted h matches realized for half the rows;
  // the other half realized worse than predicted (push error above 200 bps).
  const rows: readonly ReplayRow[] = [
    {
      condition_id: "0x2028-fl-senate",
      origination_price: 0.6,
      tau_days_at_origination: 365,
      oracle_dispute_rate: 0.02,
      principal_usdc: "1000000000",
      realized_outcome: 1,
      row_hash: asSha256Hex("1".repeat(64)),
    },
    {
      condition_id: "0x2028-presidential",
      origination_price: 0.55,
      tau_days_at_origination: 365,
      oracle_dispute_rate: 0.03,
      principal_usdc: "1000000000",
      realized_outcome: 0, // realized worse than predicted
      row_hash: asSha256Hex("2".repeat(64)),
    },
    {
      condition_id: "0xfomc-rate-cut",
      origination_price: 0.7,
      tau_days_at_origination: 90,
      oracle_dispute_rate: 0.01,
      principal_usdc: "500000000",
      realized_outcome: 0, // realized worse
      row_hash: asSha256Hex("3".repeat(64)),
    },
  ];

  const loop = createModelLoop({
    ctx,
    fetchDataset: () =>
      Promise.resolve({
        rows,
        dataset_hash: asSha256Hex("d".repeat(64)),
      }),
  });

  await loop.runTick();

  console.log(`emitted ${String(events.length)} events:`);
  for (const e of events) {
    if (e.type === "loop.calibration_proposal") {
      const b = e.body as {
        readonly error_bps: number;
        readonly proposed_alpha: string;
        readonly proposed_beta: string;
        readonly proposed_gamma: string;
      };
      console.log(
        `  ${e.type} error_bps=${String(b.error_bps)} proposed (α=${b.proposed_alpha}, β=${b.proposed_beta}, γ=${b.proposed_gamma})`,
      );
    } else {
      console.log(`  ${e.type} (parents=${String(e.parentIds.length)})`);
    }
  }

  // Whether a proposal fires depends on whether replay error exceeds 200 bps;
  // either way we must see at least one reasoning.trace.
  const traceCount = events.filter((e) => e.type === "reasoning.trace").length;
  if (traceCount !== 1) {
    throw new Error(`model loop expected 1 reasoning.trace, got ${String(traceCount)}`);
  }
}

async function smokeOperational(): Promise<void> {
  console.log("\n--- operational loop ---");
  const { sink, events } = makeInMemorySink();
  const ctx = makeCtx(sink);

  // Snapshot designed to fire (a) treasury alert and (b) gas spike.
  const snap: OperationalSnapshot = {
    treasury_balance_usdc: (3_000n * 10n ** 6n).toString(), // 3,000 USDC
    weekly_spend_usdc: (1_000n * 10n ** 6n).toString(), // 1,000 USDC/week → 21 days runway
    base_gas_gwei: 10,
    amoy_gas_gwei: 50,
    base_gas_p95_gwei: 5,
    amoy_gas_p95_gwei: 30,
    inference_cost_per_1k_usdc: 0.005,
    inference_cost_baseline_usdc: 0.004,
    oracle_read_failures: 0,
    rpc_healthy_pct: 99,
  };

  const loop = createOperationalLoop({
    ctx,
    observe: () => Promise.resolve(snap),
  });

  await loop.runTick();

  console.log(`emitted ${String(events.length)} events:`);
  for (const e of events) {
    const detail =
      e.type === "op.treasury_alert"
        ? ` severity=${(e.body as { severity: string }).severity} runway=${String((e.body as { runway_days: number }).runway_days)}d`
        : e.type === "op.operational_anomaly"
          ? ` kind=${(e.body as { kind: string }).kind}`
          : "";
    console.log(`  ${e.type}${detail}`);
  }

  const treasuryAlerts = events.filter((e) => e.type === "op.treasury_alert").length;
  const anomalies = events.filter((e) => e.type === "op.operational_anomaly").length;
  if (treasuryAlerts !== 1) {
    throw new Error(`operational loop expected 1 treasury_alert, got ${String(treasuryAlerts)}`);
  }
  // 2 gas-spike anomalies expected: Base + Amoy both above their p95.
  if (anomalies !== 2) {
    throw new Error(`operational loop expected 2 anomalies, got ${String(anomalies)}`);
  }
}

async function main(): Promise<void> {
  await smokeCredit();
  await smokeModel();
  await smokeOperational();
  console.log("\nall three loops emitted expected events.");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
