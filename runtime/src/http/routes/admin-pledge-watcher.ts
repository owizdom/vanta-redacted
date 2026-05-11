/**
 * /api/admin/pledge-watcher/snapshot — GET
 *   Returns the watcher's internal diagnostics. Authoritative debugging
 *   surface when `ecloud compute app logs` is unreliable.
 *
 * /api/admin/pledge-watcher/replay — POST { txHash }
 *   Force re-evaluation of every TransferSingle in `txHash` that lands
 *   in the vault. Result distinguishes "watcher never saw it" from
 *   "watcher saw it but downstream blocked".
 *
 * Both gated by `x-admin-token` header. Same token as /api/admin/send-tx.
 */

import { timingSafeEqual } from "node:crypto";

import type { FastifyInstance } from "fastify";

import type { PledgeWatcher } from "../../services/pledge-watcher.js";

export interface RegisterAdminPledgeWatcherOpts {
  readonly enabled: boolean;
  readonly token: string;
  readonly watcher: PledgeWatcher;
}

function constTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export async function registerAdminPledgeWatcherRoute(
  app: FastifyInstance,
  opts: RegisterAdminPledgeWatcherOpts,
): Promise<void> {
  const guard = (
    req: { headers: Record<string, string | string[] | undefined> },
    reply: { code: (c: number) => unknown },
  ): { error: string } | null => {
    if (!opts.enabled) {
      void reply.code(404);
      return { error: "not_found" };
    }
    if (opts.token.length < 32) {
      void reply.code(503);
      return { error: "admin_token_unset_or_weak" };
    }
    const header = req.headers["x-admin-token"];
    const supplied = typeof header === "string" ? header : "";
    if (!constTimeEq(supplied, opts.token)) {
      void reply.code(401);
      return { error: "unauthorized" };
    }
    return null;
  };

  app.get("/api/admin/pledge-watcher/snapshot", async (req, reply) => {
    const denied = guard(req, reply);
    if (denied !== null) return denied;
    return opts.watcher.snapshot();
  });

  app.post("/api/admin/pledge-watcher/replay", async (req, reply) => {
    const denied = guard(req, reply);
    if (denied !== null) return denied;
    const body = req.body as { txHash?: unknown };
    const tx =
      typeof body?.txHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(body.txHash)
        ? (body.txHash as `0x${string}`)
        : null;
    if (tx === null) {
      void reply.code(400);
      return { error: "txHash must be 0x-prefixed 32-byte hex" };
    }
    try {
      const result = await opts.watcher.replay(tx);
      return result;
    } catch (err: unknown) {
      void reply.code(500);
      return {
        error: "replay_failed",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  });
}
