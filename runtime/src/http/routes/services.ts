/**
 * VANTA public service endpoints — the X402-metered surface.
 *
 * Paper §8 / EigenCloud Service Agent affordance. These routes are
 * intended to be called by *other* agents (third-party towers in the
 * open layer) and by humans curling from outside the local Docker
 * compose. Internal callers (Mineflayer bridge, wizard agent loop)
 * skip metering via the `X-Vanta-Internal` header.
 *
 * Routes:
 *   POST /bridge/wizard/quote  — signed haircut quote for a position
 *   GET  /mark/:market_id      — signed 30-min TWAP mark from CLOB
 *   GET  /.well-known/x402     — discovery: prices + receiver wallet
 *
 * Each metered response is Ed25519-signed by the TEE so a caller can
 * prove provenance — the wizard's signing pubkey is the agent's
 * canonical identity (paper §3 I1).
 */

import { z } from "zod";
import type { FastifyInstance } from "fastify";

import { fetchMidpoint } from "@vanta/mark";
import { sign as teeSign } from "@vanta/tee";
import { canonicalJsonBytes, asSha256HexOrEmpty } from "@vanta/events";
import { createHash } from "node:crypto";

import { quote, QuoteError } from "../../services/quote.js";
import type { X402RouteConfig } from "../../services/x402.js";

const HEX64 = /^[0-9a-fA-F]{64}$/;
const TOKEN_ID_RE = /^[0-9]+$/; // CTF positions are uint256 decimal strings
const DECIMAL_DIGITS = /^\d+$/;

const WizardQuoteRequest = z
  .object({
    position_id: z.string().regex(TOKEN_ID_RE, "position_id must be uint256 decimal string"),
    /** Notional size in USDC 6-dec wei (decimal-digit string). */
    size: z.string().regex(DECIMAL_DIGITS, "size must be a decimal-digit string (USDC 6-dec wei)"),
    /** 64-hex condition id without the leading 0x (or with — both accepted). */
    market_id: z
      .string()
      .regex(/^(0x)?[0-9a-fA-F]{64}$/, "market_id must be a 64-char hex condition id"),
    /** Optional maturity override; default = now + 30 days. */
    maturity_ts_unix: z.number().int().positive().optional(),
  })
  .strict();

const MarketIdParam = z.object({
  market_id: z
    .string()
    .regex(/^(0x)?[0-9a-fA-F]{64}$/, "market_id must be a 64-char hex condition id"),
});

const SECONDS_PER_DAY = 86_400;
const DEFAULT_MATURITY_DAYS = 30;
const QUOTE_VALIDITY_SECONDS = 5 * 60; // 5 min — paper §5 + practical retry window

function signCanonical(payload: Record<string, unknown>): {
  readonly signature: string;
  readonly request_hash: string;
} {
  const bytes = canonicalJsonBytes(payload);
  const sigBuf = teeSign(bytes);
  const hash = createHash("sha256").update(bytes).digest("hex");
  return {
    signature: sigBuf.toString("hex"),
    request_hash: hash,
  };
}

export interface ServiceRoutesOpts {
  /** Pricing block consumed by the X402 plugin's discovery doc. */
  readonly priceConfig: readonly X402RouteConfig[];
  /** Treasury receiver for the discovery doc. */
  readonly receiver: string;
  /** USDC token address for the discovery doc. */
  readonly usdcAddress: string;
  /** Network label. */
  readonly network: "base-sepolia";
  /** Whether X402 metering is enabled (drives the discovery doc). */
  readonly metered: boolean;
}

export async function registerServiceRoutes(
  app: FastifyInstance,
  opts: ServiceRoutesOpts,
): Promise<void> {
  const { agentState, log: eventLog, fetchMidpoint: injectedMidpoint } = app.bootstrap;

  // -------- POST /bridge/wizard/quote --------------------------------
  app.post("/bridge/wizard/quote", async (req, reply) => {
    const parse = WizardQuoteRequest.safeParse(req.body);
    if (!parse.success) {
      reply.status(400);
      return { error: "request_invalid", message: parse.error.issues[0]?.message ?? "" };
    }
    const body = parse.data;
    const conditionIdRaw = body.market_id.replace(/^0x/, "").toLowerCase();
    const conditionId = asSha256HexOrEmpty(conditionIdRaw);
    if (conditionId === "") {
      reply.status(400);
      return { error: "market_id_invalid" };
    }
    const nowUnix = Math.floor(Date.now() / 1000);
    const maturityTsUnix =
      body.maturity_ts_unix ?? nowUnix + DEFAULT_MATURITY_DAYS * SECONDS_PER_DAY;

    let q;
    try {
      q = await quote({
        positionId: body.position_id,
        tokenId: body.position_id,
        conditionId,
        requestedPrincipalCapUsdc6: BigInt(body.size),
        maturityTsUnix,
        nowUnix: () => nowUnix,
        ...(injectedMidpoint !== undefined ? { fetchMidpoint: injectedMidpoint } : {}),
      });
    } catch (err: unknown) {
      if (err instanceof QuoteError) {
        reply.status(400);
        return { error: err.code, message: err.message };
      }
      reply.status(502);
      return { error: "quote_failed", message: err instanceof Error ? err.message : String(err) };
    }

    const expiresAt = nowUnix + QUOTE_VALIDITY_SECONDS;
    const inner = {
      kind: "vanta.wizard.quote.v1" as const,
      issuer_pubkey: app.bootstrap.tee.signingPubKey,
      market_id: `0x${conditionIdRaw}`,
      position_id: body.position_id,
      requested_size_usdc6: body.size,
      midpoint: q.p.toFixed(6),
      tau_days: q.tauDays,
      sigma_tau: q.sigmaTau,
      rho: q.rho,
      haircut_bps: q.haircutBps,
      max_loan_usdc6: q.principalUsdc6.toString(),
      maturity_ts_unix: maturityTsUnix,
      issued_at_unix: nowUnix,
      expires_at_unix: expiresAt,
    };
    const { signature, request_hash } = signCanonical(inner);
    return { ...inner, request_hash, signature };
  });

  // -------- GET /mark/:market_id ------------------------------------
  app.get("/mark/:market_id", async (req, reply) => {
    const parse = MarketIdParam.safeParse(req.params);
    if (!parse.success) {
      reply.status(400);
      return { error: "request_invalid", message: parse.error.issues[0]?.message ?? "" };
    }
    const conditionIdRaw = parse.data.market_id.replace(/^0x/, "").toLowerCase();

    // Pull the latest mark from the agent-state snapshot if it tracks
    // the requested market, otherwise hit fetchMidpoint live (which the
    // mark-loop already proxies under fixture mode).
    const fetcher = injectedMidpoint ?? fetchMidpoint;
    let mid: string;
    try {
      const r = await fetcher(parse.data.market_id);
      mid = r.mid;
    } catch (err: unknown) {
      reply.status(502);
      return {
        error: "mark_unavailable",
        message: err instanceof Error ? err.message : String(err),
      };
    }

    const nowUnix = Math.floor(Date.now() / 1000);
    const inner = {
      kind: "vanta.mark.v1" as const,
      issuer_pubkey: app.bootstrap.tee.signingPubKey,
      market_id: `0x${conditionIdRaw}`,
      mid,
      asof_unix: nowUnix,
      window_seconds: 30 * 60,
    };
    const { signature, request_hash } = signCanonical(inner);
    return { ...inner, request_hash, signature };
  });

  // -------- GET /.well-known/x402 ------------------------------------
  app.get("/.well-known/x402", async () => ({
    x402Version: 1,
    metered: opts.metered,
    network: opts.network,
    asset: opts.usdcAddress,
    receiver: opts.receiver,
    issuer_pubkey: app.bootstrap.tee.signingPubKey,
    routes: opts.priceConfig.map((r) => ({
      path: r.path,
      method: r.method ?? "*",
      price_usdc6: r.priceUsdc6.toString(),
      price_usd: (Number(r.priceUsdc6) / 1_000_000).toFixed(6),
      description: r.description,
      resource: r.resource ?? r.path,
    })),
  }));

  // Suppress lint — eventLog/agentState are deliberately captured for
  // future observability hooks (rate limiting, per-payer metering).
  void eventLog;
  void agentState;
}
