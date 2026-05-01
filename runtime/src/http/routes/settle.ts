/**
 * `POST /api/loans/:loanId/settle` — close out an active loan.
 *
 * Body: `{ outcome: "repaid"|"liquidated", auctionEscrow?: address,
 * proceedsUsdc6?: string }`. Forward to the settlement service.
 *
 * 409 if the loan is already settled (settlement service surfaces
 * `loan_not_active`).
 */

import type { Address } from "viem";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { asSha256Hex } from "@vanta/tee";

import { settle, SettleError } from "../../services/settlement.js";

const HEX64 = /^[0-9a-f]{64}$/;
const ETH_ADDR = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL_DIGITS = /^[0-9]+$/;

const ParamsSchema = z.object({
  loanId: z.string().regex(HEX64, "loanId must be 64-char lowercase hex"),
});

const BodySchema = z
  .object({
    outcome: z.enum(["repaid", "liquidated"]),
    auctionEscrow: z.string().regex(ETH_ADDR).optional(),
    proceedsUsdc6: z.string().regex(DECIMAL_DIGITS).optional(),
    liquidationReason: z.string().min(1).max(128).optional(),
  })
  .strict();

export async function registerSettleRoute(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/loans/:loanId/settle",
    {
      schema: {
        params: ParamsSchema,
        body: BodySchema,
      },
    },
    async (req, reply) => {
      const params = req.params as { loanId: string };
      const body = req.body as z.infer<typeof BodySchema>;

      try {
        const r = await settle({
          bootstrap: app.bootstrap,
          loanBookAddress: app.config.loanBookAddress,
          loanId: asSha256Hex(params.loanId),
          outcome: body.outcome,
          ...(body.auctionEscrow !== undefined
            ? { auctionEscrow: body.auctionEscrow as Address }
            : {}),
          ...(body.proceedsUsdc6 !== undefined
            ? { proceedsUsdc6: BigInt(body.proceedsUsdc6) }
            : {}),
          ...(body.liquidationReason !== undefined
            ? { liquidationReason: body.liquidationReason }
            : {}),
        });
        return {
          txHash: r.txHash,
          blockNumber: r.blockNumber,
          eventId: r.eventId,
        };
      } catch (err: unknown) {
        if (err instanceof SettleError) {
          if (err.code === "loan_not_active" || err.code === "loan_not_found") {
            reply.status(409);
          } else if (
            err.code === "missing_liquidation_inputs"
          ) {
            reply.status(400);
          } else {
            reply.status(500);
          }
          return { error: err.code, message: err.message };
        }
        reply.status(500);
        return {
          error: "settle_failed",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );
}
