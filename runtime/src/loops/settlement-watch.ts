/**
 * Settlement-watch loop — polls the in-memory loan registry every
 * `tickSeconds`, and for each active loan that has crossed its
 * maturity timestamp without being settled, emits a TEE-signed
 * `reasoning.trace` event flagging the maturity.
 *
 * Why not auto-settle on chain: deciding "repaid" vs "liquidated"
 * requires either borrower repayment evidence or an oracle/auction
 * outcome. V0 keeps the human-in-loop for that decision; this loop
 * makes the decision *visible* by publishing a signed observation
 * the operator can act on (or that auditors can use to confirm the
 * runtime is watching).
 *
 * Idempotency: an in-memory set of seen loanIds prevents republishing
 * the same maturity-reached event on every tick. The set is rebuilt
 * on restart from log replay (see hydrate hook).
 */

import { createHash } from "node:crypto";

import { asSha256Hex } from "@vanta/tee";

import type { LoanRegistry } from "../services/loan-registry.js";
import type { LoopClock, LoopContext, ReasoningLoop } from "./types.js";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export interface CreateSettlementWatchOpts {
  readonly ctx: LoopContext;
  readonly loanRegistry: LoanRegistry;
  readonly clock: LoopClock;
  readonly tickSeconds: number;
  readonly log?: {
    info: (msg: object) => void;
    warn: (msg: object) => void;
    error: (msg: object) => void;
  };
}

export function createSettlementWatchLoop(
  opts: CreateSettlementWatchOpts,
): ReasoningLoop {
  const seen = new Set<string>();
  let lastTickMs: number | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const nowSec = Math.floor(opts.clock.nowMs() / 1000);
      const active = opts.loanRegistry.list();
      let emitted = 0;

      for (const loan of active) {
        if (loan.maturityTsUnix > nowSec) continue;
        if (seen.has(loan.loanId)) continue;

        const summary = `loan ${loan.loanId.slice(0, 12)} crossed maturity at ${new Date(
          loan.maturityTsUnix * 1000,
        ).toISOString()} — awaiting settlement decision (repaid / liquidated).`;

        const inputsSummary: Record<string, string | number> = {
          loan_id: loan.loanId,
          condition_id: loan.conditionId,
          principal_usdc6: loan.principal.toString(),
          haircut_bps: loan.haircutBps,
          maturity_ts_unix: loan.maturityTsUnix,
          age_seconds: nowSec - loan.maturityTsUnix,
        };

        const promptHash = asSha256Hex(
          sha256Hex(`settlement-watch::${loan.loanId}::${String(loan.maturityTsUnix)}`),
        );

        try {
          await opts.ctx.events.emit({
            type: "reasoning.trace",
            body: {
              subject_event_id: loan.originationEventId,
              subject_event_type: "loan.maturity_reached",
              inputs_summary: inputsSummary,
              intermediate_scores: {},
              decision_rationale: summary,
              dissenting_considerations: "",
              model_id: "vanta-settlement-watch-v0",
              prompt_hash: promptHash,
            },
            parentIds: [opts.ctx.genesisId, loan.originationEventId],
          });
          seen.add(loan.loanId);
          emitted++;
        } catch (err) {
          opts.log?.error({
            msg: "settlement_watch_emit_failed",
            loan_id: loan.loanId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      lastTickMs = opts.clock.nowMs();
      if (emitted > 0) {
        opts.log?.info({
          msg: "settlement_watch_tick",
          active: active.length,
          emitted,
        });
      }
    } catch (err) {
      opts.log?.error({
        msg: "settlement_watch_tick_failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return {
    name: "settlement-watch",
    start() {
      if (timer !== null) return;
      void tick();
      timer = setInterval(() => void tick(), opts.tickSeconds * 1000);
    },
    async stop() {
      stopped = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    async runTick() {
      await tick();
    },
    lastTickAtMs() {
      return lastTickMs;
    },
    tickIntervalMs: opts.tickSeconds * 1000,
  };
}
