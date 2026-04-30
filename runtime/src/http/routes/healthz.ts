/**
 * `/healthz` — flat liveness probe. 200 always when the process is up.
 *
 * We do NOT report degraded TEE state here on purpose: a degraded
 * runtime is still "live" for traffic-routing decisions; a separate
 * `/api/tee` endpoint surfaces the structured state.
 */

import type { FastifyInstance } from "fastify";

export async function registerHealthzRoute(app: FastifyInstance): Promise<void> {
  app.get("/healthz", async () => {
    return { ok: true, ts: Date.now() };
  });
}
