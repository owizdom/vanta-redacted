/**
 * Admin route used by the 10-min demo runner.
 *
 * `POST /admin/demo/append-event` — accepts a fully-signed VantaEvent
 * envelope (canonical JSON) in the request body, validates it via
 * `decodeEvent` (strict zod parse + signature verify), and appends it
 * to the runtime's FileEventLog. The append fires SSE listeners, so
 * the game frontend's chat panel renders the new activity instantly.
 *
 * The demo runner (`scripts/demo/demo-runner.ts`) is a separate Node
 * process that builds + signs origination chains with its OWN
 * ephemeral keypair and POSTs them here every minute. Each event
 * carries its own pubkey on `tee.signingPubKey`, so verifiers
 * cross-check the signature against the same public key the
 * runtime stamps into the event row — works identically to the
 * runtime's own events.
 *
 * Security: gated on env `VANTA_DEMO_ADMIN === "1"`. When unset
 * (production default) this route returns 404 even if registered.
 * Production HTTP infra should additionally block /admin/* via
 * upstream proxy ACLs.
 */

import type { FastifyInstance } from "fastify";

import { decodeEvent } from "@vanta/events";

import type { EventSink } from "../../loops/types.js";
import {
  emitDemoBorrow,
  type DemoBorrowMarket,
} from "../../services/demo-borrow.js";

const HEX64 = /^[0-9a-f]{64}$/;
const ETH_ADDR = /^0x[0-9a-fA-F]{40}$/;

export async function registerAdminDemoRoutes(
  app: FastifyInstance,
  events: EventSink,
): Promise<void> {
  const enabled = process.env["VANTA_DEMO_ADMIN"] === "1";

  app.post("/admin/demo/append-event", async (req, reply) => {
    if (!enabled) {
      reply.status(404);
      return { error: "not_found" };
    }

    let raw: string;
    if (typeof req.body === "string") {
      raw = req.body;
    } else if (req.body !== undefined && req.body !== null) {
      raw = JSON.stringify(req.body);
    } else {
      reply.status(400);
      return { error: "missing_body" };
    }

    const decoded = decodeEvent(raw);
    if (!decoded.ok) {
      reply.status(400);
      return {
        error: "decode_failed",
        code: decoded.error.code,
        message: decoded.error.message,
      };
    }

    await app.bootstrap.log.append(decoded.event);
    return {
      ok: true,
      id: decoded.event.id,
      type: decoded.event.type,
    };
  });

  /**
   * Demo borrow — the borrower modal in the game frontend POSTs here.
   * The route synthesizes the full TEE-signed origination chain
   * in-process (pledge → council → synthesis → trace → origination)
   * via the runtime's EventSink. SSE listeners broadcast each step
   * to the chat panel as it lands.
   *
   * Why not the real `/api/origination` route: that one calls
   * `LoanBook.originate(...)` on Base Sepolia, which requires
   * actual CTF tokens escrowed in `VantaVault` on Polygon Amoy. The
   * demo wallet doesn't hold real CTF positions. So this route
   * mints the same audit-chain shape without the on-chain mutation.
   */
  app.post("/admin/demo/borrow", async (req, reply) => {
    if (!enabled) {
      reply.status(404);
      return { error: "not_found" };
    }

    const body = req.body as Record<string, unknown> | null;
    if (body === null || typeof body !== "object") {
      reply.status(400);
      return { error: "missing_body" };
    }

    const agentId = Number(body["agentId"]);
    const principalUsdc6Str = String(body["principalUsdc6"] ?? "");
    const maturityTsUnix = Number(body["maturityTsUnix"]);
    const borrower = String(body["borrower"] ?? "");
    const market = body["market"] as DemoBorrowMarket | undefined;

    if (!Number.isInteger(agentId) || agentId < 0 || agentId > 2) {
      reply.status(400);
      return { error: "invalid_agent_id" };
    }
    if (!/^[0-9]+$/.test(principalUsdc6Str)) {
      reply.status(400);
      return { error: "invalid_principal" };
    }
    if (!Number.isInteger(maturityTsUnix) || maturityTsUnix <= 0) {
      reply.status(400);
      return { error: "invalid_maturity" };
    }
    if (!ETH_ADDR.test(borrower)) {
      reply.status(400);
      return { error: "invalid_borrower" };
    }
    if (
      market === undefined ||
      typeof market !== "object" ||
      !HEX64.test(market.conditionIdHex ?? "") ||
      typeof market.tokenId !== "string" ||
      typeof market.question !== "string"
    ) {
      reply.status(400);
      return { error: "invalid_market" };
    }

    try {
      const result = await emitDemoBorrow(events, {
        agentId,
        market,
        principalUsdc6: BigInt(principalUsdc6Str),
        maturityTsUnix,
        borrower: borrower as `0x${string}`,
      });
      return {
        ok: true,
        loanId: result.loanId,
        originationId: result.originationId,
        synthesisId: result.synthesisId,
        thoughtIds: result.thoughtIds,
        traceId: result.traceId,
        principalUsdc6: result.principalUsdc6,
        haircutBps: result.haircutBps,
      };
    } catch (err) {
      app.log.error({ err }, "demo_borrow_failed");
      reply.status(500);
      return {
        error: "demo_borrow_failed",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  });
}
