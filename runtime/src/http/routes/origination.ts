/**
 * `POST /api/origination` — server-computed haircut + principal.
 *
 * I-RT-4: the request body MUST NOT carry `haircutBps` or
 * `principalUsdc6`. If it does, return 400 with code
 * `client_supplied_haircut_forbidden` BEFORE the zod parse runs — we
 * want a precise error that points at the violating key, not a generic
 * "extra field".
 *
 * Pipeline:
 *   1. Pre-parse: reject `haircutBps` / `principalUsdc6` keys.
 *   2. zod.strict() validation on the remaining fields.
 *   3. Look up the cited pledge event in the on-disk log; pull the
 *      `tokenId` + `conditionId` from its body (a real Phase-1 caller
 *      would re-fetch them; for v0 the pledge event already carries
 *      both).
 *   4. `quote(...)` → `{haircutBps, principalUsdc6, ...}`.
 *   5. Forward to `@vanta/origination.originate(...)`.
 *   6. Return `{loanId, txHash, blockNumber, eventId, haircutBps, principalUsdc6}`.
 */

import { randomBytes } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  asSha256Hex,
  type EthAddressHex,
  type Sha256Hex,
} from "@vanta/tee";
import { sign as teeSign } from "@vanta/tee";
import { originate } from "@vanta/origination";

import { quote, QuoteError } from "../../services/quote.js";

const HEX64 = /^[0-9a-f]{64}$/;
const ETH_ADDR = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL_DIGITS = /^[0-9]+$/;

const OriginationBodySchema = z
  .object({
    positionId: z.string().min(1),
    requestedPrincipalCapUsdc6: z
      .string()
      .regex(DECIMAL_DIGITS, "must be a decimal-digit string (USDC 6-dec wei)"),
    maturityTs: z
      .number()
      .int()
      .positive(),
    pledgeEventId: z.string().regex(HEX64, "must be 64-char lowercase hex"),
    /**
     * Optional disbursement recipient. The pledge event identifies
     * the *collateral source* (`borrower_proxy`) — for Polymarket
     * users that's a Safe-style contract on Polygon. But the same
     * address on Base has no contract code and the user can't
     * control it, so USDC drawn into `borrower_proxy` on Base is
     * dead funds. Frontend supplies the user's EOA here; LoanBook's
     * `drawFor` sends USDC to that address instead.
     *
     * Falls back to `pledge.borrower_proxy` when omitted to preserve
     * the original behaviour for callers that already deploy
     * contracts at the proxy address on Base.
     */
    recipient: z
      .string()
      .regex(ETH_ADDR, "must be a 0x-prefixed 20-byte hex address")
      .optional(),
  })
  .strict();

/**
 * Keys the route REJECTS pre-parse with a precise error code so the
 * caller's error doesn't read as a generic "extra field".
 *
 * `haircutBps` / `principalUsdc6` are I-RT-4: server computes both;
 * client must not bypass the haircut model.
 *
 * `midpoint_override` / `midpointOverride` are W5 c5a: the env-gated
 * override is gone. Callers used to pass a midpoint to keep the
 * fork-anvil hermetic; the demo now uses a fixture-backed mark feed
 * (see W5 c5b) so this knob is no longer needed.
 */
const FORBIDDEN_KEYS = [
  "haircutBps",
  "haircut_bps",
  "principalUsdc6",
  "principal_usdc6",
  "midpointOverride",
  "midpoint_override",
] as const;

interface ForbiddenRejection {
  readonly code:
    | "client_supplied_haircut_forbidden"
    | "midpoint_override_unsupported";
  readonly key: string;
}

function rejectionFor(key: string): ForbiddenRejection {
  if (key === "midpointOverride" || key === "midpoint_override") {
    return { code: "midpoint_override_unsupported", key };
  }
  return { code: "client_supplied_haircut_forbidden", key };
}

interface OriginationReply {
  loanId: string;
  txHash: string;
  blockNumber: number;
  eventId: string;
  haircutBps: number;
  principalUsdc6: string;
  paramsHash: string;
  /** TEE-derived EOA that signed the on-chain LoanBook.originate tx. */
  teeAddress: string;
  /** Borrower wallet (== pledge event's borrower_proxy). */
  borrower: string;
}

export async function registerOriginationRoute(
  app: FastifyInstance,
): Promise<void> {
  app.post(
    "/api/origination",
    async (req: FastifyRequest, reply): Promise<OriginationReply | { error: string }> => {
      // Step 1: I-RT-4 + W5 c5a pre-parse rejection.
      const raw = req.body as Record<string, unknown> | undefined;
      if (raw !== null && typeof raw === "object") {
        for (const k of FORBIDDEN_KEYS) {
          if (Object.prototype.hasOwnProperty.call(raw, k)) {
            reply.status(400);
            return { error: rejectionFor(k).code };
          }
        }
      }

      // Step 2: strict zod parse.
      const parse = OriginationBodySchema.safeParse(raw ?? {});
      if (!parse.success) {
        reply.status(400);
        return { error: `body_invalid: ${parse.error.issues[0]?.message ?? "unknown"}` };
      }
      const body = parse.data;

      // Step 3: pledge lookup. The cited event must be a loan.pledge
      // already in the log (origination depends on it for I-OR-1 +
      // I-OR-5 anyway).
      const pledgeId = asSha256Hex(body.pledgeEventId);
      const pledgeEvent = app.bootstrap.log.getById(pledgeId);
      if (pledgeEvent === undefined) {
        reply.status(404);
        return { error: "pledge_event_not_found" };
      }
      if (pledgeEvent.type !== "loan.pledge") {
        reply.status(400);
        return { error: "cited_event_not_a_pledge" };
      }
      const pledgeBody = pledgeEvent.body;
      // The pledge captures the *proxy* (collateral source). The
      // LoanBook "borrower" — recipient of `drawFor` USDC + the
      // address whose repayment the contract expects at maturity —
      // is whichever the caller passes as `recipient`, defaulting
      // back to the proxy. For Polymarket Safe wallets the proxy
      // lives on Polygon, so an EOA recipient on Base is the only
      // way the user can actually access the disbursed USDC.
      const borrower = (body.recipient ?? pledgeBody.borrower_proxy) as string;
      const conditionId = pledgeBody.condition_id;
      // tokenId is not on the pledge body in the v0 event schema; the
      // caller passes it in as positionId. Document and trust.
      const tokenId = body.positionId;

      // Step 4: quote. The midpoint fetcher comes from the bootstrap
      // layer when the runtime is configured with one (W5 c5b
      // fixture loader); otherwise the quote module falls through to
      // the live `@vanta/mark.fetchMidpoint`.
      let q;
      try {
        q = await quote({
          positionId: body.positionId,
          tokenId,
          conditionId,
          requestedPrincipalCapUsdc6: BigInt(body.requestedPrincipalCapUsdc6),
          maturityTsUnix: body.maturityTs,
          nowUnix: () => Math.floor(Date.now() / 1000),
          ...(app.bootstrap.fetchMidpoint !== undefined
            ? { fetchMidpoint: app.bootstrap.fetchMidpoint }
            : {}),
        });
      } catch (err: unknown) {
        if (err instanceof QuoteError) {
          reply.status(400);
          return { error: err.code };
        }
        reply.status(500);
        return { error: "quote_failed" };
      }

      // Step 5: forward to @vanta/origination.originate(...).
      const loanIdHex = randomBytes(32).toString("hex");
      const loanId = asSha256Hex(loanIdHex);

      try {
        const receipt = await originate({
          loan_id: loanId,
          pledge_event_id: pledgeId,
          borrower: borrower as EthAddressHex,
          principal_usdc: q.principalUsdc6.toString(),
          haircut_bps: q.haircutBps,
          maturity_ts_unix: body.maturityTs,
          risk_model_attestation_body: JSON.stringify({
            kind: "vanta-quote-v0",
            p: q.p,
            tauDays: q.tauDays,
            rho: q.rho,
            sigmaTau: q.sigmaTau,
            pledgeEventId: body.pledgeEventId,
          }),
          walletClient: app.bootstrap.walletClient,
          publicClient: app.bootstrap.publicClient,
          loanBookAddress: app.config.loanBookAddress,
          sign: teeSign,
          signingPubKey: app.bootstrap.tee.signingPubKey,
          tee: {
            signingPubKey: app.bootstrap.tee.signingPubKey,
            kmsKeyHash: asSha256Hex("0".repeat(64)),
            attestationJwtHash: asSha256Hex("0".repeat(64)),
          },
          instance: app.bootstrap.tee.identityAnchor?.kind === "kms-jwt"
            ? app.bootstrap.tee.identityAnchor.audience
            : "vanta-runtime-local",
          lineage: "vanta-runtime",
          loadEvent: (id: Sha256Hex) => app.bootstrap.log.getById(id),
          appendEvent: (event) => {
            void app.bootstrap.log.append(event);
          },
          nowUnix: () => Math.floor(Date.now() / 1000),
        });

        // Register the new loan with the mark-loop registry so it
        // gets a poller starting on the next tick.
        app.bootstrap.loanRegistry.add({
          loanId: receipt.event.body.loan_id,
          conditionId,
          tokenId,
          originationBlock: receipt.block_number,
          originationEventId: receipt.event.id,
          principal: q.principalUsdc6,
          maturityTsUnix: body.maturityTs,
          haircutBps: q.haircutBps,
          notional: BigInt(pledgeBody.amount),
        });

        return {
          loanId: receipt.event.body.loan_id,
          txHash: receipt.tx_hash,
          blockNumber: receipt.block_number,
          eventId: receipt.event.id,
          haircutBps: q.haircutBps,
          principalUsdc6: q.principalUsdc6.toString(),
          paramsHash: receipt.params_hash,
          // Receipt-card fields. `teeAddress` is the EOA that signed the
          // on-chain LoanBook.originate tx (== HKDF-derived origination
          // EOA). `borrower` is the pledge event's `borrower_proxy`,
          // which the frontend renders on the approval card.
          teeAddress: app.bootstrap.origination.address,
          borrower,
        };
      } catch (err: unknown) {
        reply.status(500);
        const message = err instanceof Error ? err.message : String(err);
        return { error: `origination_failed: ${message}` };
      }
    },
  );
}
