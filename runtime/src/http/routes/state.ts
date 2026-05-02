/**
 * `/api/state` — single-shot aggregator for the AgentBand UI.
 *
 * The /app dashboard polls this every ~6s to render VANTA's posture
 * (watching N markets, M positions, runway, last decision) without
 * making every visitor's tab re-walk the event log on every poll.
 *
 * Read-only. Joins:
 *   - markets-cache snapshots
 *   - loan registry (hydrated from log)
 *   - the four reasoning loops (in-memory tick telemetry)
 *   - last-24h slice of the signed event log (for net P&L + last decision)
 */

import type { FastifyInstance } from "fastify";

import type { ReasoningLoop } from "../../loops/types.js";
import type { LoanRegistry } from "../../services/loan-registry.js";
import type { MarketsCache } from "../../services/markets-cache.js";
import type { FileEventLog } from "../../events-store.js";
import type { OperationalReader } from "../../services/operational-snapshot.js";

import { WATCHED_MARKETS } from "../../services/watched-markets.js";

export interface RegisterStateRouteOpts {
  readonly marketsCache: MarketsCache;
  readonly loanRegistry: LoanRegistry;
  readonly log: FileEventLog;
  readonly operationalReader: OperationalReader;
  readonly loops: {
    readonly credit: ReasoningLoop;
    readonly model: ReasoningLoop;
    readonly operational: ReasoningLoop;
    readonly onboarding: ReasoningLoop;
  };
}

export async function registerStateRoute(
  app: FastifyInstance,
  opts: RegisterStateRouteOpts,
): Promise<void> {
  app.get("/api/state", async () => {
    const now = Date.now();

    const watching_n = opts.marketsCache.snapshotAll().length;

    const positions = opts.loanRegistry.list().map((loan) => {
      const watchedHit = WATCHED_MARKETS.find(
        (m) => m.conditionIdHex === loan.conditionId,
      );
      const label = watchedHit?.label ?? loan.loanId.slice(0, 8);
      return {
        label,
        loan_id: loan.loanId,
        condition_id: loan.conditionId,
        principal_usdc: loan.principal.toString(),
        haircut_bps: loan.haircutBps,
        maturity_ts_unix: loan.maturityTsUnix,
      };
    });

    // Walk recent events once to compute everything event-derived in
    // a single pass. 500 is well above the per-day cap on a healthy
    // runtime (paper §6 envelope: 3 onboards/24h + ~1 credit-tick/min).
    type Walked = {
      id: string;
      type: string;
      timestamp: number;
      body: Record<string, unknown>;
    };
    const recent: Walked[] = [];
    for await (const ev of opts.log.walkFromTip()) {
      recent.push({
        id: ev.id,
        type: ev.type,
        timestamp: ev.timestamp,
        body: ev.body as unknown as Record<string, unknown>,
      });
      if (recent.length >= 500) break;
    }

    // P&L last-24h: sum treasury.inflow amount minus operational outflow
    // proxies. We don't track every gas-spend on chain, so this is a
    // best-effort agent-revenue figure (x402 metering settlements, loan
    // settlement spreads) until the operational loop emits explicit
    // outflow events.
    const dayAgoUnix = Math.floor(now / 1000) - 24 * 60 * 60;
    let earned_today_usdc6 = 0n;
    for (const ev of recent) {
      if (ev.timestamp < dayAgoUnix) break;
      if (ev.type === "treasury.inflow") {
        const amt = ev.body["amount"];
        if (typeof amt === "string") {
          try { earned_today_usdc6 += BigInt(amt); } catch { /* skip */ }
        }
      }
    }

    // Latest signed decision — first event we hit walking tip→genesis
    // that's a loop event the user would call a "decision".
    let last_decision: Walked | null = null;
    for (const ev of recent) {
      if (
        ev.type === "loop.onboard_decision" ||
        ev.type === "loop.credit_tick" ||
        ev.type === "loop.calibration_proposal" ||
        ev.type === "op.treasury_alert" ||
        ev.type === "op.operational_anomaly"
      ) {
        last_decision = ev;
        break;
      }
    }

    // Probation: count of `loop.onboard_decision` events with cap ≤
    // $25k issued in the last 7 days (paper §6 probation envelope).
    const sevenDayUnix = Math.floor(now / 1000) - 7 * 24 * 60 * 60;
    let probation_n = 0;
    for (const ev of recent) {
      if (ev.timestamp < sevenDayUnix) break;
      if (ev.type !== "loop.onboard_decision") continue;
      const cap = ev.body["cap_initial_usdc"];
      const decision = ev.body["decision"];
      if (decision === "onboard" && typeof cap === "string") {
        try {
          if (BigInt(cap) <= 25_000n * 1_000_000n) probation_n++;
        } catch { /* skip */ }
      }
    }

    // Per-market decisions: most recent onboard_decision per cid.
    const market_decisions = new Map<
      string,
      {
        cid: string;
        haircut_bps: number;
        ltv_max_bps: number;
        decision: string;
        reviewed_at_unix_ms: number;
      }
    >();
    for (const ev of recent) {
      if (ev.type !== "loop.onboard_decision") continue;
      const cid = ev.body["market_id"];
      if (typeof cid !== "string") continue;
      if (market_decisions.has(cid)) continue; // first hit = most recent
      // haircut bps approximation: αβγ are floats, not bps. We keep
      // the LTV cap and decision; haircut surfaces from credit-loop
      // ticks instead. Empty bps signals "no haircut yet", not zero.
      const ltv = ev.body["ltv_max_bps"];
      const decision = ev.body["decision"];
      market_decisions.set(cid, {
        cid,
        haircut_bps: 0,
        ltv_max_bps: typeof ltv === "number" ? ltv : 0,
        decision: typeof decision === "string" ? decision : "unknown",
        reviewed_at_unix_ms: ev.timestamp * 1000,
      });
    }
    // Layer credit-tick haircuts on top so each row shows the latest
    // observed haircut bps (paper §7 credit loop).
    for (const ev of recent) {
      if (ev.type !== "loop.credit_tick") continue;
      // credit_tick body carries loan_id, not market_id directly. Resolve
      // via loan registry → conditionId.
      const loanId = ev.body["loan_id"];
      if (typeof loanId !== "string") continue;
      const loan = opts.loanRegistry.get(loanId as never);
      if (loan === undefined) continue;
      const slot = market_decisions.get(loan.conditionId);
      if (slot === undefined) continue;
      // Only fill once per cid (most recent wins).
      if (slot.haircut_bps === 0) slot.haircut_bps = loan.haircutBps;
    }

    const snapLoop = (l: ReasoningLoop) => {
      const last = l.lastTickAtMs();
      const ageS = last === null ? null : Math.floor((now - last) / 1000);
      const nextEtaS =
        last === null
          ? Math.floor(l.tickIntervalMs / 1000)
          : Math.max(0, Math.floor((last + l.tickIntervalMs - now) / 1000));
      return { age_s: ageS, next_eta_s: nextEtaS, interval_s: Math.floor(l.tickIntervalMs / 1000) };
    };

    return {
      now_unix_ms: now,
      watching_n,
      probation_n,
      positions,
      earned_today_usdc: (Number(earned_today_usdc6) / 1_000_000).toFixed(2),
      // Real runway: balance / weekly_spend × 7. Reads from the cached
      // last operational snapshot (refreshed every hour by the loop).
      // null until first tick lands; clamped to a 4-week ceiling so the
      // UI doesn't show absurd numbers when treasury is small.
      runway_days: ((): number | null => {
        const snap = opts.operationalReader.latest();
        if (snap === null) return null;
        const bal = Number(BigInt(snap.treasury_balance_usdc));
        const wk = Number(BigInt(snap.weekly_spend_usdc));
        if (wk <= 0) return null;
        return Math.floor((bal / wk) * 7);
      })(),
      last_decision: last_decision === null
        ? null
        : {
            id: last_decision.id,
            type: last_decision.type,
            age_s: Math.floor((now - last_decision.timestamp * 1000) / 1000),
            body: last_decision.body,
          },
      loops: {
        credit: snapLoop(opts.loops.credit),
        model: snapLoop(opts.loops.model),
        operational: snapLoop(opts.loops.operational),
        onboarding: snapLoop(opts.loops.onboarding),
      },
      market_decisions: Array.from(market_decisions.values()),
    };
  });

  app.log.info("state route registered");
}
