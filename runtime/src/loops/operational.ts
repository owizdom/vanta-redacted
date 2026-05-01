/**
 * Operational loop — paper §7 "Operational loop".
 *
 * The agent pays its own bills (Invariant 6). This loop reasons over:
 *   - Treasury runway (USDC balance / projected weekly spend)
 *   - Gas-price evolution on Base + Polygon Amoy (95th percentile of
 *     trailing 30 days as the anomaly trigger)
 *   - LLM inference cost step-changes (model price increases, provider
 *     rate-limit downgrades)
 *   - Oracle-read failures (UMA polling errors, RPC timeouts)
 *
 * Emits:
 *   - `op.treasury_alert` when projected runway < threshold
 *   - `op.operational_anomaly` when gas / inference / oracle
 *      observations breach the baseline band
 *
 * Neither event triggers a contract action. They are inputs to the
 * 4-of-7 lender multisig (paper §6 Fail-safes Global onboarding pause)
 * and to the verifier audit. The loop's authority is to *flag*, never
 * to *act*.
 */

import { asSha256Hex, type Sha256Hex } from "@vanta/tee";

import type {
  EventSink,
  LoopContext,
  OperationalAnomalyBody,
  ReasoningLoop,
  ReasoningTraceBody,
  TreasuryAlertBody,
} from "./types.js";

/**
 * The set of things this loop measures every tick. Wired by the runtime
 * from @vanta/treasury + @vanta/mark + a gas-tracker; tests inject fakes.
 */
export interface OperationalSnapshot {
  /** Treasury balance in USDC wei. uint256 decimal as string. */
  readonly treasury_balance_usdc: string;
  /** Projected USDC outflow per week (oracle reads + gas + inference). */
  readonly weekly_spend_usdc: string;
  /** Gas price observed this tick on Base, in gwei. */
  readonly base_gas_gwei: number;
  /** Gas price observed this tick on Polygon Amoy, in gwei. */
  readonly amoy_gas_gwei: number;
  /** Trailing-30d 95th percentile gas, Base. */
  readonly base_gas_p95_gwei: number;
  /** Trailing-30d 95th percentile gas, Polygon Amoy. */
  readonly amoy_gas_p95_gwei: number;
  /** Cost per 1k tokens, USDC, observed this tick. */
  readonly inference_cost_per_1k_usdc: number;
  /** Trailing-30d baseline cost per 1k tokens, USDC. */
  readonly inference_cost_baseline_usdc: number;
  /** Failed oracle reads this tick (UMA / RPC timeouts). */
  readonly oracle_read_failures: number;
  /** RPC health: percentage of healthy RPC requests this tick. */
  readonly rpc_healthy_pct: number;
}

export type FetchOperationalSnapshotFn = () => Promise<OperationalSnapshot>;

/** Runway thresholds. */
const RUNWAY_WARNING_DAYS = 60;
const RUNWAY_CRITICAL_DAYS = 30;

/** Anomaly thresholds. */
const INFERENCE_COST_SPIKE_RATIO = 2.0;
const RPC_UNHEALTHY_PCT_FLOOR = 95;

export interface OperationalLoopArgs {
  readonly ctx: LoopContext;
  readonly observe: FetchOperationalSnapshotFn;
  /** Tick cadence in seconds. Default 1 hour. */
  readonly tickSeconds?: number;
  readonly sleepMs?: (ms: number) => Promise<void>;
}

function computeRunway(snap: OperationalSnapshot): {
  readonly runwayDays: number;
  readonly weeklySpend: bigint;
  readonly balance: bigint;
} {
  const balance = BigInt(snap.treasury_balance_usdc);
  const weeklySpend = BigInt(snap.weekly_spend_usdc);
  if (weeklySpend <= 0n) {
    return { runwayDays: Number.POSITIVE_INFINITY, weeklySpend, balance };
  }
  const runwayWeeks = Number(balance) / Number(weeklySpend);
  return { runwayDays: runwayWeeks * 7, weeklySpend, balance };
}

function buildTreasuryTrace(args: {
  readonly snap: OperationalSnapshot;
  readonly runwayDays: number;
  readonly severity: "warning" | "critical";
}): ReasoningTraceBody {
  const { snap, runwayDays, severity } = args;
  const balanceUsdc = (Number(BigInt(snap.treasury_balance_usdc)) / 1e6).toFixed(2);
  const weeklySpendUsdc = (Number(BigInt(snap.weekly_spend_usdc)) / 1e6).toFixed(2);

  const rationale =
    severity === "critical"
      ? `Treasury runway ${runwayDays.toFixed(1)} days < ${String(RUNWAY_CRITICAL_DAYS)} days critical floor. Multisig should consider raising oracle/origination fees or pausing onboarding to slow burn.`
      : `Treasury runway ${runwayDays.toFixed(1)} days < ${String(RUNWAY_WARNING_DAYS)} days warning band. Surface to lender governance.`;

  return {
    subject_event_id: asSha256Hex("0".repeat(64)),
    subject_event_type: "op.treasury_alert",
    inputs_summary: {
      treasury_balance_usdc: balanceUsdc,
      weekly_spend_usdc: weeklySpendUsdc,
      runway_days: runwayDays.toFixed(2),
    },
    intermediate_scores: {
      runway_days: runwayDays,
      warning_threshold_days: RUNWAY_WARNING_DAYS,
      critical_threshold_days: RUNWAY_CRITICAL_DAYS,
    },
    decision_rationale: rationale,
    dissenting_considerations: "",
    model_id: "",
    prompt_hash: "",
  };
}

async function maybeEmitTreasuryAlert(args: {
  readonly events: EventSink;
  readonly genesisId: Sha256Hex;
  readonly snap: OperationalSnapshot;
}): Promise<void> {
  const { events, genesisId, snap } = args;
  const { runwayDays } = computeRunway(snap);

  if (runwayDays >= RUNWAY_WARNING_DAYS) return;

  const severity: "warning" | "critical" =
    runwayDays < RUNWAY_CRITICAL_DAYS ? "critical" : "warning";
  const traceBody = buildTreasuryTrace({ snap, runwayDays, severity });

  const traceId = await events.emit({
    type: "reasoning.trace",
    body: traceBody,
    parentIds: [genesisId],
  });

  const body: TreasuryAlertBody = {
    alert_id: traceId,
    treasury_balance_usdc: snap.treasury_balance_usdc,
    runway_days: Math.floor(runwayDays),
    threshold_runway_days:
      severity === "critical" ? RUNWAY_CRITICAL_DAYS : RUNWAY_WARNING_DAYS,
    severity,
    trace_hash: traceId,
  };

  await events.emit({
    type: "op.treasury_alert",
    body,
    parentIds: [genesisId, traceId],
  });
}

function detectAnomalies(snap: OperationalSnapshot): ReadonlyArray<{
  readonly kind: OperationalAnomalyBody["kind"];
  readonly value: string;
  readonly baseline: string;
  readonly detail: string;
}> {
  const out: Array<{
    kind: OperationalAnomalyBody["kind"];
    value: string;
    baseline: string;
    detail: string;
  }> = [];

  if (snap.base_gas_gwei > snap.base_gas_p95_gwei) {
    out.push({
      kind: "gas_spike",
      value: snap.base_gas_gwei.toFixed(2),
      baseline: snap.base_gas_p95_gwei.toFixed(2),
      detail: `Base gas ${snap.base_gas_gwei.toFixed(2)} gwei > 95th-pct ${snap.base_gas_p95_gwei.toFixed(2)} gwei`,
    });
  }
  if (snap.amoy_gas_gwei > snap.amoy_gas_p95_gwei) {
    out.push({
      kind: "gas_spike",
      value: snap.amoy_gas_gwei.toFixed(2),
      baseline: snap.amoy_gas_p95_gwei.toFixed(2),
      detail: `Amoy gas ${snap.amoy_gas_gwei.toFixed(2)} gwei > 95th-pct ${snap.amoy_gas_p95_gwei.toFixed(2)} gwei`,
    });
  }
  if (
    snap.inference_cost_baseline_usdc > 0 &&
    snap.inference_cost_per_1k_usdc >= snap.inference_cost_baseline_usdc * INFERENCE_COST_SPIKE_RATIO
  ) {
    out.push({
      kind: "inference_cost_spike",
      value: snap.inference_cost_per_1k_usdc.toFixed(6),
      baseline: snap.inference_cost_baseline_usdc.toFixed(6),
      detail: `Inference cost ${snap.inference_cost_per_1k_usdc.toFixed(6)} >= ${INFERENCE_COST_SPIKE_RATIO}× baseline`,
    });
  }
  if (snap.oracle_read_failures > 0) {
    out.push({
      kind: "oracle_read_failure",
      value: String(snap.oracle_read_failures),
      baseline: "0",
      detail: `${String(snap.oracle_read_failures)} oracle read failure(s) this tick`,
    });
  }
  if (snap.rpc_healthy_pct < RPC_UNHEALTHY_PCT_FLOOR) {
    out.push({
      kind: "rpc_unhealthy",
      value: snap.rpc_healthy_pct.toFixed(2),
      baseline: String(RPC_UNHEALTHY_PCT_FLOOR),
      detail: `RPC healthy ${snap.rpc_healthy_pct.toFixed(2)}% < ${String(RPC_UNHEALTHY_PCT_FLOOR)}% floor`,
    });
  }
  return out;
}

async function emitAnomalies(args: {
  readonly events: EventSink;
  readonly genesisId: Sha256Hex;
  readonly snap: OperationalSnapshot;
  readonly nowMs: number;
}): Promise<void> {
  const { events, genesisId, snap, nowMs } = args;
  const anomalies = detectAnomalies(snap);
  if (anomalies.length === 0) return;

  const traceBody: ReasoningTraceBody = {
    subject_event_id: asSha256Hex("0".repeat(64)),
    subject_event_type: "op.operational_anomaly",
    inputs_summary: {
      base_gas_gwei: snap.base_gas_gwei,
      base_gas_p95: snap.base_gas_p95_gwei,
      amoy_gas_gwei: snap.amoy_gas_gwei,
      amoy_gas_p95: snap.amoy_gas_p95_gwei,
      inference_cost_per_1k: snap.inference_cost_per_1k_usdc,
      inference_baseline: snap.inference_cost_baseline_usdc,
      oracle_read_failures: snap.oracle_read_failures,
      rpc_healthy_pct: snap.rpc_healthy_pct,
    },
    intermediate_scores: {
      anomaly_count: anomalies.length,
      tick_ms: nowMs,
    },
    decision_rationale: `${String(anomalies.length)} anomaly/anomalies detected this tick: ${anomalies.map((a) => a.kind).join(", ")}.`,
    dissenting_considerations: "",
    model_id: "",
    prompt_hash: "",
  };

  const traceId = await events.emit({
    type: "reasoning.trace",
    body: traceBody,
    parentIds: [genesisId],
  });

  for (const a of anomalies) {
    const body: OperationalAnomalyBody = {
      anomaly_id: traceId,
      kind: a.kind,
      value: a.value,
      baseline: a.baseline,
      detail: a.detail,
      trace_hash: traceId,
    };
    await events.emit({
      type: "op.operational_anomaly",
      body,
      parentIds: [genesisId, traceId],
    });
  }
}

const DEFAULT_TICK_SECONDS = 60 * 60;
const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function createOperationalLoop(args: OperationalLoopArgs): ReasoningLoop {
  const tickMs = (args.tickSeconds ?? DEFAULT_TICK_SECONDS) * 1_000;
  const sleep = args.sleepMs ?? realSleep;
  let stopping = false;
  let inFlight: Promise<void> = Promise.resolve();

  const runTick = async (): Promise<void> => {
    try {
      const snap = await args.observe();
      await maybeEmitTreasuryAlert({
        events: args.ctx.events,
        genesisId: args.ctx.genesisId,
        snap,
      });
      await emitAnomalies({
        events: args.ctx.events,
        genesisId: args.ctx.genesisId,
        snap,
        nowMs: args.ctx.clock.nowMs(),
      });
    } catch (err: unknown) {
      // eslint-disable-next-line no-console
      console.warn(
        `vanta/operational-loop: tick failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };

  const start = (): void => {
    void (async () => {
      while (!stopping) {
        inFlight = runTick();
        await inFlight;
        if (stopping) return;
        await sleep(tickMs);
      }
    })();
  };

  const stop = async (): Promise<void> => {
    stopping = true;
    await inFlight;
  };

  return {
    name: "operational",
    start,
    stop,
    runTick,
  };
}
