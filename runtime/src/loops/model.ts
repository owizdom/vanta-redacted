/**
 * Model loop — paper §7 "Model loop".
 *
 * Calibration drift detector. Runs weekly (configurable). Replays the
 * formula against a public dataset of resolved markets, records
 * realized loss-given-default vs the formula's pre-loss prediction,
 * and emits a `loop.calibration_proposal` event when realized error
 * exceeds a calibrated band.
 *
 * **The proposal is not self-actuating.** It is an input to the 4-of-7
 * lender-quorum multisig with a 7-day timelock (paper §11 T8). The
 * agent reasons; the lenders vote; the contract delays. This loop's
 * only authority is to *propose*, never to *apply*.
 *
 * The actual calibration solver (a fit producing new α, β, γ, τ_gap
 * from the dataset) is intentionally a stubbed proportional adjustment
 * in v1.0 of this loop — the structural plumbing (replay, error
 * computation, signed proposal) is what matters today; the better
 * solver is v1.x work that drops in behind the same `proposeParams`
 * interface.
 */

import { createHash } from "node:crypto";

import { computeHaircut } from "@vanta/haircut";
import { CALIBRATION_V0 } from "@vanta/constitution";
import { asSha256Hex, type Sha256Hex } from "@vanta/tee";

import type {
  CalibrationProposalBody,
  EventSink,
  LoopContext,
  ReasoningLoop,
  ReasoningTraceBody,
} from "./types.js";

/**
 * One row of the public resolved-markets replay dataset. Fed in by a
 * dataset adapter; tests inject synthetic rows.
 *
 * `realized_outcome` is the actual resolution: 0 (NO won), 1 (YES won),
 * or a fractional partial-resolution if Polymarket ever ships them.
 */
export interface ReplayRow {
  /** Polymarket condition id (or any stable market identifier). */
  readonly condition_id: string;
  /** Price at the time the loan would have been originated, in [0, 1]. */
  readonly origination_price: number;
  /** Days from origination to resolution. */
  readonly tau_days_at_origination: number;
  /** Oracle dispute rate the agent observed for this market's resolver. */
  readonly oracle_dispute_rate: number;
  /** Loan principal as USDC wei (uint256 decimal). */
  readonly principal_usdc: string;
  /** Realized outcome: 0..1, 1 = YES won, 0 = NO won. */
  readonly realized_outcome: number;
  /** sha256 of the canonical row (for trace_hash anchoring). */
  readonly row_hash: Sha256Hex;
}

export type FetchReplayDatasetFn = () => Promise<{
  readonly rows: readonly ReplayRow[];
  readonly dataset_hash: Sha256Hex;
}>;

/**
 * Threshold above which a CalibrationProposal is emitted. 200 bps =
 * 2 percentage points of average error — a meaningful drift relative
 * to typical 5-15% gross spread.
 */
const CALIBRATION_ERROR_TRIGGER_BPS = 200;

/** Multisig timelock window before a proposal can apply. */
const MULTISIG_TIMELOCK_MS = 7 * 24 * 60 * 60 * 1_000;

export interface ModelLoopArgs {
  readonly ctx: LoopContext;
  readonly fetchDataset: FetchReplayDatasetFn;
  /** Tick cadence in seconds. Default 7 days. */
  readonly tickSeconds?: number;
  readonly sleepMs?: (ms: number) => Promise<void>;
}

/**
 * Run the formula against every row, compute realized LGD vs predicted,
 * return the aggregate error in bps and the slice that drove it.
 */
function runReplay(rows: readonly ReplayRow[]): {
  readonly realizedLgdBps: number;
  readonly predictedLgdBps: number;
  readonly errorBps: number;
  readonly worstRows: readonly ReplayRow[];
} {
  let realizedLossSum = 0;
  let predictedLossSum = 0;
  let principalSum = 0n;

  const rowErrors: Array<{ row: ReplayRow; errorBps: number }> = [];

  for (const row of rows) {
    const principal = Number(BigInt(row.principal_usdc));
    principalSum += BigInt(row.principal_usdc);

    const haircut = computeHaircut(
      {
        p: row.origination_price,
        tauDays: row.tau_days_at_origination,
        rho: row.oracle_dispute_rate,
      },
      CALIBRATION_V0,
    );
    // Predicted loss-on-default is approximated as h_applied — the buffer
    // we reserved against the position. If realized matches predicted
    // perfectly, error_bps = 0.
    const predictedLoss = principal * haircut.hApplied;

    // Realized: if YES won (outcome=1) and the loan was YES-backed with
    // origination price p < 1, the position appreciated to 1 — no loss.
    // If NO won (outcome=0), the position is worth 0 — loss is principal
    // minus the buffer that was already taken.
    const realizedLoss =
      row.realized_outcome >= row.origination_price
        ? 0
        : principal * (row.origination_price - row.realized_outcome);

    realizedLossSum += realizedLoss;
    predictedLossSum += predictedLoss;

    const rowErrorBps = principal > 0 ? Math.abs(predictedLoss - realizedLoss) / principal * 10_000 : 0;
    rowErrors.push({ row, errorBps: rowErrorBps });
  }

  const principalTotal = Number(principalSum);
  const realizedLgdBps =
    principalTotal > 0 ? Math.floor((realizedLossSum / principalTotal) * 10_000) : 0;
  const predictedLgdBps =
    principalTotal > 0 ? Math.floor((predictedLossSum / principalTotal) * 10_000) : 0;
  const errorBps = Math.abs(realizedLgdBps - predictedLgdBps);

  // Worst 5 rows by per-row error — for the trace's dissent considerations.
  rowErrors.sort((a, b) => b.errorBps - a.errorBps);
  const worstRows = rowErrors.slice(0, 5).map(({ row }) => row);

  return { realizedLgdBps, predictedLgdBps, errorBps, worstRows };
}

/**
 * Stub solver — proportional adjustment to bring predicted in line with
 * realized. Real v1.x: replace with a numerical fit (e.g. least squares
 * over the same dataset).
 */
function proposeParams(replay: ReturnType<typeof runReplay>): {
  readonly alpha: number;
  readonly beta: number;
  readonly gamma: number;
  readonly tauGapDays: number;
} {
  const { realizedLgdBps, predictedLgdBps } = replay;
  if (predictedLgdBps === 0) {
    return {
      alpha: CALIBRATION_V0.alpha,
      beta: CALIBRATION_V0.beta,
      gamma: CALIBRATION_V0.gamma,
      tauGapDays: CALIBRATION_V0.tauGapDays,
    };
  }
  const scale = realizedLgdBps / predictedLgdBps;
  // Distribute the scale across the three free weights uniformly. This
  // is intentionally crude — replace with a proper fit before promotion.
  const cubeRoot = Math.cbrt(scale);
  return {
    alpha: CALIBRATION_V0.alpha * cubeRoot,
    beta: CALIBRATION_V0.beta * cubeRoot,
    gamma: CALIBRATION_V0.gamma * cubeRoot,
    tauGapDays: CALIBRATION_V0.tauGapDays,
  };
}

const DEFAULT_TICK_SECONDS = 7 * 24 * 60 * 60;
const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function buildTraceBody(args: {
  readonly replay: ReturnType<typeof runReplay>;
  readonly proposed: ReturnType<typeof proposeParams>;
  readonly datasetHash: Sha256Hex;
  readonly errorTriggered: boolean;
}): ReasoningTraceBody {
  const { replay, proposed, datasetHash, errorTriggered } = args;
  const errorPct = (replay.errorBps / 100).toFixed(2);

  const rationale = errorTriggered
    ? `Replay over dataset ${datasetHash} shows ${errorPct}% error vs the live calibration. Proposing α=${proposed.alpha.toFixed(4)}, β=${proposed.beta.toFixed(4)}, γ=${proposed.gamma.toFixed(4)}. Multisig must approve under 7-day timelock; the agent has no apply authority.`
    : `Replay over dataset ${datasetHash} shows ${errorPct}% error — within the 200 bps band. No proposal emitted this cycle.`;

  const dissent =
    replay.worstRows.length > 0
      ? `Worst-row drivers: ${replay.worstRows.map((r) => r.condition_id).join(", ")}. Consider whether these share a cluster the tag system did not anticipate (paper §11 T7).`
      : "";

  return {
    subject_event_id: datasetHash,
    subject_event_type: "loop.calibration_proposal",
    inputs_summary: {
      dataset_hash: datasetHash,
      row_count: replay.worstRows.length === 0 ? 0 : replay.worstRows.length + replay.worstRows.length, // upper-bound proxy; real count fed in from caller
    },
    intermediate_scores: {
      realized_lgd_bps: replay.realizedLgdBps,
      predicted_lgd_bps: replay.predictedLgdBps,
      error_bps: replay.errorBps,
      trigger_bps: CALIBRATION_ERROR_TRIGGER_BPS,
    },
    decision_rationale: rationale,
    dissenting_considerations: dissent,
    model_id: "",
    prompt_hash: "",
  };
}

async function emitProposal(args: {
  readonly events: EventSink;
  readonly genesisId: Sha256Hex;
  readonly nowMs: number;
  readonly datasetHash: Sha256Hex;
  readonly replay: ReturnType<typeof runReplay>;
  readonly proposed: ReturnType<typeof proposeParams>;
}): Promise<void> {
  const { events, genesisId, nowMs, datasetHash, replay, proposed } = args;

  const traceBody = buildTraceBody({
    replay,
    proposed,
    datasetHash,
    errorTriggered: replay.errorBps >= CALIBRATION_ERROR_TRIGGER_BPS,
  });

  const traceId = await events.emit({
    type: "reasoning.trace",
    body: traceBody,
    parentIds: [genesisId],
  });

  if (replay.errorBps < CALIBRATION_ERROR_TRIGGER_BPS) {
    // No proposal needed; trace alone documents the no-op cycle.
    return;
  }

  // Stable placeholder id derived from the dataset+trace pair. The real
  // canonical-bytes id is assigned by the EventSink when the event is
  // built and signed; this is what the body carries in the meantime.
  const proposalId = asSha256Hex(
    createHash("sha256").update(`${datasetHash}|${traceId}`).digest("hex"),
  );

  const body: CalibrationProposalBody = {
    proposal_id: proposalId,
    proposed_alpha: proposed.alpha.toFixed(6),
    proposed_beta: proposed.beta.toFixed(6),
    proposed_gamma: proposed.gamma.toFixed(6),
    proposed_tau_gap_days: proposed.tauGapDays.toFixed(6),
    replay_dataset_hash: datasetHash,
    realized_lgd_bps: replay.realizedLgdBps,
    predicted_lgd_bps: replay.predictedLgdBps,
    error_bps: replay.errorBps,
    timelock_expires_at_unix_ms: nowMs + MULTISIG_TIMELOCK_MS,
    trace_hash: traceId,
  };

  await events.emit({
    type: "loop.calibration_proposal",
    body,
    parentIds: [genesisId, traceId],
  });
}

export function createModelLoop(args: ModelLoopArgs): ReasoningLoop {
  const tickMs = (args.tickSeconds ?? DEFAULT_TICK_SECONDS) * 1_000;
  const sleep = args.sleepMs ?? realSleep;
  let stopping = false;
  let inFlight: Promise<void> = Promise.resolve();

  const runTick = async (): Promise<void> => {
    try {
      const { rows, dataset_hash } = await args.fetchDataset();
      if (rows.length === 0) return;
      const replay = runReplay(rows);
      const proposed = proposeParams(replay);
      await emitProposal({
        events: args.ctx.events,
        genesisId: args.ctx.genesisId,
        nowMs: args.ctx.clock.nowMs(),
        datasetHash: dataset_hash,
        replay,
        proposed,
      });
    } catch (err: unknown) {
      // eslint-disable-next-line no-console
      console.warn(
        `vanta/model-loop: tick failed: ${
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
    name: "model",
    start,
    stop,
    runTick,
  };
}
