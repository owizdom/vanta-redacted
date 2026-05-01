/**
 * `GET /api/health/components` — health/degraded chips data source.
 *
 * Returns a small object summarising the live state of the four
 * subsystems the launcher's health row cares about:
 *
 *   polymarket — last-fresh timestamp + error from the markets cache
 *   chain      — last-fresh timestamp from the agent-state poller
 *   inference  — last successful op.inference event (timestamp from log)
 *   log        — current event count + tip event id
 *
 * Each chip carries `{ status: "ok" | "degraded" | "unknown", since_ms,
 * detail }`. The launcher renders a small row of dots with tooltips so
 * when something is broken the visitor sees resilience, not silence.
 *
 * Read-only. Cheap — every read is from in-process caches or a single
 * walk over the event log tail.
 */

import type { FastifyInstance } from "fastify";

import type { Bootstrap } from "../../bootstrap.js";

interface RegisterHealthOpts {
  readonly bootstrap: Bootstrap;
}

export async function registerHealthRoute(
  app: FastifyInstance,
  opts: RegisterHealthOpts,
): Promise<void> {
  const { bootstrap } = opts;

  app.get("/api/health/components", async () => {
    const now = Date.now();
    const agentSnap = bootstrap.agentState.snapshot();

    // Polymarket — pick the freshest snapshot in the cache, treat
    // "fresh within last 90s" as ok, "fresh within 5min" as degraded,
    // older than that as broken.
    const markets = bootstrap.marketsCache.snapshotAll();
    let pmFreshest = 0;
    let pmAnyError: string | null = null;
    let pmStaleCount = 0;
    for (const m of markets) {
      if (m.fetchedAt > pmFreshest) pmFreshest = m.fetchedAt;
      if (m.stale) pmStaleCount += 1;
      if (m.lastError && pmAnyError === null) pmAnyError = m.lastError;
    }
    const pmAgeMs = pmFreshest === 0 ? Number.MAX_SAFE_INTEGER : now - pmFreshest;
    const polymarket = {
      status: classify(pmAgeMs, 90_000, 300_000, pmFreshest === 0 ? "unknown" : undefined),
      last_fresh_unix_ms: pmFreshest === 0 ? null : pmFreshest,
      age_ms: pmFreshest === 0 ? null : pmAgeMs,
      stale_count: pmStaleCount,
      total_count: markets.length,
      detail: pmAnyError === null ? null : pmAnyError.slice(0, 160),
    };

    // Chain — agent-state polls Base Sepolia every 15s. fetchedAt=0
    // means the poller hasn't run yet.
    const chainAgeMs = agentSnap.fetchedAt === 0 ? Number.MAX_SAFE_INTEGER : now - agentSnap.fetchedAt;
    const chain = {
      status: classify(chainAgeMs, 30_000, 90_000, agentSnap.fetchedAt === 0 ? "unknown" : undefined),
      last_fresh_unix_ms: agentSnap.fetchedAt === 0 ? null : agentSnap.fetchedAt,
      age_ms: agentSnap.fetchedAt === 0 ? null : chainAgeMs,
      detail: agentSnap.stale ? "agent-state poller marked stale" : null,
    };

    // Inference — last op.inference event in the log. Walk back from
    // the tip; cap at 200 events so we don't pay for a long scan.
    let lastInferenceAt: number | null = null;
    let lastInferenceProvider: string | null = null;
    {
      let scanned = 0;
      for await (const ev of bootstrap.log.walkFromTip()) {
        scanned += 1;
        if (ev.type === "op.inference") {
          lastInferenceAt = ev.timestamp * 1000;
          const body = ev.body as { provider?: string };
          lastInferenceProvider = typeof body.provider === "string" ? body.provider : null;
          break;
        }
        if (scanned >= 200) break;
      }
    }
    const inferenceAgeMs = lastInferenceAt === null ? Number.MAX_SAFE_INTEGER : now - lastInferenceAt;
    const inference = {
      status: classify(
        inferenceAgeMs,
        300_000,        // 5 min — wizard cycle should be inside this
        15 * 60_000,    // 15 min — degraded; LLM provider rotating?
        lastInferenceAt === null ? "unknown" : undefined,
      ),
      last_inference_unix_ms: lastInferenceAt,
      provider: lastInferenceProvider,
      age_ms: lastInferenceAt === null ? null : inferenceAgeMs,
    };

    // Log — count + tip. Cheap (the log already exposes count via
    // walkFromTip; we cap our scan at 1 record).
    let tipId: string | null = null;
    let tipType: string | null = null;
    let tipAt: number | null = null;
    let logCount = 0;
    for await (const ev of bootstrap.log.walkFromTip()) {
      if (tipId === null) {
        tipId = ev.id;
        tipType = ev.type;
        tipAt = ev.timestamp * 1000;
      }
      logCount += 1;
      // Don't count past 5000 — a full scan on a busy log would be
      // wasteful for a healthcheck. Approximate.
      if (logCount >= 5000) break;
    }
    const log = {
      status: tipId === null ? "unknown" : "ok",
      tip_event_id: tipId,
      tip_type: tipType,
      tip_unix_ms: tipAt,
      approx_count: logCount,
    };

    return {
      polymarket,
      chain,
      inference,
      log,
      checked_at_unix_ms: now,
    };
  });
}

function classify(
  ageMs: number,
  okBelow: number,
  degradedBelow: number,
  forced?: "ok" | "degraded" | "unknown",
): "ok" | "degraded" | "unknown" {
  if (forced !== undefined) return forced;
  if (ageMs < okBelow) return "ok";
  if (ageMs < degradedBelow) return "degraded";
  return "degraded";
}
