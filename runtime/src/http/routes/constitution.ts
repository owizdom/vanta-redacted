/**
 * `/api/constitution` — return `{hash, body, genesis}` so an external
 * verifier can re-derive `constitution_hash` from the body.
 *
 * Shape matches `@vanta/verify`'s `constitutionResponseSchema`:
 * `{hash: 64-hex, body: any}`. We additionally include the full
 * signed genesis event under `genesis` for callers that want to
 * inspect lineage.
 */

import type { FastifyInstance } from "fastify";

export async function registerConstitutionRoute(app: FastifyInstance): Promise<void> {
  app.get("/api/constitution", async (_req, reply) => {
    const genesis = app.bootstrap.genesis;
    if (genesis.type !== "constitutional.genesis") {
      reply.status(500);
      return { error: "genesis_event_missing" };
    }
    return {
      hash: genesis.body.constitutionHash,
      body: genesis.body,
      genesis,
    };
  });
}
