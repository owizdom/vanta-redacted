/**
 * Credit loop — paper §7 "Credit loop".
 *
 * Per-loan health monitor. For each active loan, on each tick:
 *   1. Read best-bid + 30-min TWAP from the Polymarket CLOB (via @vanta/mark).
 *   2. Read UMA dispute history since origination (via @vanta/venue-poly).
 *   3. Read depth at 5% impact for the underlying market.
 *   4. Compute the current haircut (via @vanta/haircut) and current LTV.
 *   5. Reason about flag — ok / watch / freeze_request — using the
 *      loan-side invariants from @vanta/constitution (77% liquidation
 *      threshold, with watch band starting at 60%).
 *   6. Emit a sibling `reasoning.trace` event with the rationale.
 *   7. Emit the primary `loop.credit_tick` event with `trace_hash` set.
 *
 * The loop CANNOT execute a freeze. It can only request one — the
 * depositor-bond mechanism in OnboardingRegistry is what actually
 * freezes a market on three independent flags within 24h. The agent's
 * watch flags are inputs to that, not actions on top of it.
 */

import { computeHaircut } from "@vanta/haircut";
import { LOAN_INVARIANTS_V0, CALIBRATION_V0 } from "@vanta/constitution";
import { asSha256Hex, type Sha256Hex } from "@vanta/tee";

import type {
  CreditFlag,
  CreditTickBody,
  EventSink,
  LoopClock,
  LoopContext,
  ReasoningLoop,
  ReasoningTraceBody,
} from "./types.js";

/**
 * Minimal active-loan view the credit loop needs. The runtime's
 * LoanRegistry produces this; tests inject a static array.
 */
export interface ActiveLoanView {
  readonly loan_id: Sha256Hex;
  /** uint256 decimal: principal in USDC wei (6 decimals). */
  readonly principal_usdc: string;
  /**
   * Notional in CTF token units (uint256 decimal). For Polymarket binary
   * markets, 1 token redeems to 1 USDC at the winning outcome — so
   * notional_tokens × 1e6 is the max-payout USDC value. The credit loop
   * uses `V = p × (1 − h_applied) × N` with N = notional_tokens.
   */
  readonly notional_tokens: string;
  /** Maturity unix-ms. */
  readonly maturity_ts_ms: number;
  /** Polymarket condition id. */
  readonly condition_id: string;
  /** Token id (YES = 0, NO = 1, but Polymarket uses uint256). */
  readonly token_id: string;
  /** Origination event id — used as a parent for tick events. */
  readonly origination_event_id: Sha256Hex;
  /** Originated haircut bps — for delta tracking. */
  readonly originated_haircut_bps: number;
}

/**
 * Per-tick observation set. The credit loop reads these from
 * @vanta/mark and @vanta/venue-poly. Wired by the runtime; tests
 * inject fakes.
 */
export interface CreditObservation {
  /** Best-bid as decimal-string in [0, 1]. */
  readonly best_bid: string;
  /** 30-minute TWAP as decimal-string in [0, 1]. */
  readonly twap_30min: string;
  /** USDC notional needed to move best-bid by 5%. */
  readonly depth_5pct_usdc: string;
  /** Number of UMA disputes against this resolver in last 30d. */
  readonly dispute_30d_count: number;
  /** Seconds remaining until resolution. */
  readonly time_to_resolution_seconds: number;
}

export type FetchObservationFn = (loan: ActiveLoanView) => Promise<CreditObservation>;

/**
 * The agent's flag thresholds. Constants live here, not in
 * @vanta/constitution, because the watch band is an *agent heuristic*
 * (above the 77% contract floor), not a contract-enforced bound.
 *
 * Watch  : LTV ≥ 60% — the agent surfaces the loan to lenders
 * Freeze : LTV ≥ 70% — the agent posts a freeze flag (one of three needed)
 *
 * The contract's own liquidation threshold is 77% (paper §3, §5).
 */
const CREDIT_WATCH_LTV_BPS = 6_000;
const CREDIT_FREEZE_LTV_BPS = 7_000;

export interface CreditLoopArgs {
  readonly ctx: LoopContext;
  readonly listActiveLoans: () => Promise<readonly ActiveLoanView[]>;
  readonly observe: FetchObservationFn;
  /** Tick cadence in seconds. Default 60. */
  readonly tickSeconds?: number;
  /** Override sleep; tests bypass timers. */
  readonly sleepMs?: (ms: number) => Promise<void>;
}

/**
 * Compute the current LTV in bps from the observation and the loan's
 * principal/notional. Uses min(best-bid, TWAP) per paper §8 collateral
 * pricing. Returns ltvBps capped at 9999 and the current collateral
 * value in USDC wei (6 decimals).
 *
 * Math:
 *   p   = min(best_bid, twap_30min)               // current price in [0, 1]
 *   τ   = time_to_resolution_seconds / 86400      // days
 *   ρ   = min(dispute_30d_count / 200, 1)         // dispute-rate proxy
 *   h   = computeHaircut(p, τ, ρ).hApplied
 *   V   = p × (1 − h) × notional_tokens × 1e6     // USDC wei
 *   LTV = principal / V                           // → bps
 */
function computeLtvBps(loan: ActiveLoanView, obs: CreditObservation): {
  readonly ltvBps: number;
  readonly collateralValueUsdc: bigint;
} {
  const bestBid = Number(obs.best_bid);
  const twap = Number(obs.twap_30min);
  const p = Math.min(bestBid, twap);

  const tauSeconds = obs.time_to_resolution_seconds;
  const tauDays = Math.max(tauSeconds / 86_400, 1 / 86_400);

  const rho = Math.min(obs.dispute_30d_count / 200, 1.0);

  const haircut = computeHaircut({ p, tauDays, rho }, CALIBRATION_V0);

  const principal = BigInt(loan.principal_usdc);
  const notionalTokens = BigInt(loan.notional_tokens);

  // V = p × (1 − h) × N × 1_000_000 (USDC wei). Compute in fixed-point
  // by scaling p × (1 − h) to 1e9 then multiplying notional × 1e6.
  const valueScale = Math.max(p * (1 - haircut.hApplied), 0);
  const valueScaledMicros = BigInt(Math.floor(valueScale * 1_000_000_000));
  const collateralValueUsdc =
    (notionalTokens * 1_000_000n * valueScaledMicros) / 1_000_000_000n;

  const ltvBps =
    collateralValueUsdc <= 0n
      ? 9_999
      : Math.min(
          Math.floor(
            (Number(principal) / Number(collateralValueUsdc)) * 10_000,
          ),
          9_999,
        );

  return { ltvBps, collateralValueUsdc };
}

function flagFromLtv(ltvBps: number): CreditFlag {
  if (ltvBps >= CREDIT_FREEZE_LTV_BPS) return "freeze_request";
  if (ltvBps >= CREDIT_WATCH_LTV_BPS) return "watch";
  return "ok";
}

function buildTraceBody(args: {
  readonly subjectEventId: Sha256Hex;
  readonly loan: ActiveLoanView;
  readonly obs: CreditObservation;
  readonly ltvBps: number;
  readonly flag: CreditFlag;
}): ReasoningTraceBody {
  const { subjectEventId, loan, obs, ltvBps, flag } = args;
  const minPrice = Math.min(Number(obs.best_bid), Number(obs.twap_30min));
  const ltvPct = (ltvBps / 100).toFixed(2);

  const rationale =
    flag === "freeze_request"
      ? `LTV ${ltvPct}% breached the 70% freeze threshold (contract liquidation at ${
          LOAN_INVARIANTS_V0.liquidationThresholdBps / 100
        }%). Surface freeze-request to depositor-bond mechanism.`
      : flag === "watch"
        ? `LTV ${ltvPct}% in watch band [60%, 70%). Notify lenders; voluntary repayment preferred over auction.`
        : `LTV ${ltvPct}% below watch band. No action.`;

  const dissent =
    obs.dispute_30d_count > 0
      ? `Resolver has ${String(obs.dispute_30d_count)} disputes in trailing 30 days; consider tightening γρ if pattern persists.`
      : "";

  return {
    subject_event_id: subjectEventId,
    subject_event_type: "loop.credit_tick",
    inputs_summary: {
      loan_id: loan.loan_id,
      best_bid: obs.best_bid,
      twap_30min: obs.twap_30min,
      min_price: minPrice.toFixed(6),
      depth_5pct_usdc: obs.depth_5pct_usdc,
      time_to_resolution_seconds: obs.time_to_resolution_seconds,
      dispute_30d_count: obs.dispute_30d_count,
      principal_usdc: loan.principal_usdc,
    },
    intermediate_scores: {
      ltv_bps: ltvBps,
      watch_threshold_bps: CREDIT_WATCH_LTV_BPS,
      freeze_threshold_bps: CREDIT_FREEZE_LTV_BPS,
      liquidation_threshold_bps: LOAN_INVARIANTS_V0.liquidationThresholdBps,
    },
    decision_rationale: rationale,
    dissenting_considerations: dissent,
    model_id: "",
    prompt_hash: "",
  };
}

async function emitTraceAndTick(args: {
  readonly events: EventSink;
  readonly loan: ActiveLoanView;
  readonly obs: CreditObservation;
  readonly ltvBps: number;
  readonly collateralValueUsdc: bigint;
  readonly flag: CreditFlag;
  readonly genesisId: Sha256Hex;
}): Promise<void> {
  const { events, loan, obs, ltvBps, collateralValueUsdc, flag, genesisId } = args;

  // Provisional event id placeholder — real id is computed inside the
  // EventSink (canonical-bytes hash). The trace's `subject_event_id`
  // only needs to be stable; we use the loan_id as a proxy here and
  // let EventSink rewrite if the strict canonical id is required by
  // the schema. (Phase 11 wires the real id.)
  const traceBody = buildTraceBody({
    subjectEventId: loan.loan_id,
    loan,
    obs,
    ltvBps,
    flag,
  });

  const traceId = await events.emit({
    type: "reasoning.trace",
    body: traceBody,
    parentIds: [genesisId, loan.origination_event_id],
  });

  const tickBody: CreditTickBody = {
    loan_id: loan.loan_id,
    collateral_value_usdc: collateralValueUsdc.toString(),
    ltv_current_bps: ltvBps,
    trace_hash: traceId,
    flag,
    best_bid: obs.best_bid,
    twap_30min: obs.twap_30min,
    depth_5pct_usdc: obs.depth_5pct_usdc,
    time_to_resolution_seconds: obs.time_to_resolution_seconds,
    dispute_30d_count: obs.dispute_30d_count,
  };

  await events.emit({
    type: "loop.credit_tick",
    body: tickBody,
    parentIds: [genesisId, loan.origination_event_id, traceId],
  });
}

const DEFAULT_TICK_SECONDS = 60;
const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function createCreditLoop(args: CreditLoopArgs): ReasoningLoop {
  const tickMs = (args.tickSeconds ?? DEFAULT_TICK_SECONDS) * 1_000;
  const sleep = args.sleepMs ?? realSleep;
  let stopping = false;
  let inFlight: Promise<void> = Promise.resolve();

  const runTick = async (): Promise<void> => {
    const loans = await args.listActiveLoans();
    for (const loan of loans) {
      if (stopping) return;
      try {
        const obs = await args.observe(loan);
        const { ltvBps, collateralValueUsdc } = computeLtvBps(loan, obs);
        const flag = flagFromLtv(ltvBps);
        await emitTraceAndTick({
          events: args.ctx.events,
          loan,
          obs,
          ltvBps,
          collateralValueUsdc,
          flag,
          genesisId: args.ctx.genesisId,
        });
      } catch (err: unknown) {
        // Don't let one bad loan tank the whole tick. The operational
        // loop will pick up an `oracle_read_failure` anomaly if this
        // becomes a pattern.
        // eslint-disable-next-line no-console
        console.warn(
          `vanta/credit-loop: tick for loan ${loan.loan_id} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
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
    name: "credit",
    start,
    stop,
    runTick,
  };
}

// Expose the asSha256Hex re-import so tests can stamp deterministic ids.
export { asSha256Hex };
export type { LoopClock };
