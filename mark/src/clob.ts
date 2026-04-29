/**
 * Polymarket CLOB / Data-API reader.
 *
 * Five calls:
 *   fetchTrades         — data-api.polymarket.com/trades (L0 taker feed)
 *   fetchBook           — clob.polymarket.com/book
 *   fetchMidpoint       — clob.polymarket.com/midpoint
 *   fetchPricesHistory  — clob.polymarket.com/prices-history (server TWAP)
 *   fetchMarket         — clob.polymarket.com/markets/{conditionId}
 *
 * Every call goes through `httpGetWithAttestation`, so the TLS SPKI pin
 * and the HTTP-200 gate fire uniformly.
 *
 * Zod schemas at module scope capture the field shape canonical-reference.md
 * §4.2 recorded live (names: proxyWallet, side, asset, conditionId, size,
 * price, timestamp, outcome, outcomeIndex, transactionHash). Extra fields
 * on the server's response are allowed (no `.strict()` here) so a new
 * Polymarket field doesn't break us; we only strip to the fields we
 * consume.
 */

import { z } from "zod";

import { CLOB_HOST, DATA_API_HOST } from "./constants.js";
import {
  httpGetWithAttestation,
  type HttpGetWithAttestationOpts,
} from "./http.js";
import type {
  Book,
  BookLevel,
  Market,
  MarketToken,
  SourceAttestation,
  Trade,
} from "./types.js";
import { asSha256Hex, type Sha256Hex } from "@vanta/tee";

/** 64-char lowercase hex, optional 0x prefix — clob.polymarket.com
 *  /markets/{cid} returns the condition_id WITH 0x prefix; older
 *  endpoints sometimes drop it. We accept both at the schema layer
 *  and strip the prefix in `asSha256Hex` callers. */
const HEX64_RE = /^(?:0x)?[0-9a-f]{64}$/;

const conditionIdSchema = z
  .string()
  .regex(HEX64_RE, "conditionId must be 64-char lowercase hex (optional 0x prefix)");

const decimalStringSchema = z.string().regex(/^[0-9]+(\.[0-9]+)?$/, {
  message: "must be a non-negative decimal string",
});

const tradeSideSchema = z.enum(["BUY", "SELL"]);

const tradeSchema = z
  .object({
    proxyWallet: z.string(),
    side: tradeSideSchema,
    asset: z.string(),
    conditionId: conditionIdSchema,
    size: decimalStringSchema,
    price: decimalStringSchema,
    timestamp: z
      .number()
      .refine((n) => Number.isInteger(n) && n >= 0, "must be unix seconds"),
    outcome: z.string(),
    outcomeIndex: z
      .number()
      .refine((n) => Number.isInteger(n) && n >= 0, "must be a non-negative integer"),
    transactionHash: z.string(),
  })
  .passthrough();

const tradesListSchema = z.array(tradeSchema);

const bookLevelSchema = z
  .object({ price: decimalStringSchema, size: decimalStringSchema })
  .passthrough();

const bookSchema = z
  .object({
    market: z.string(),
    asset_id: z.string(),
    bids: z.array(bookLevelSchema),
    asks: z.array(bookLevelSchema),
    hash: z.string().optional(),
    timestamp: z.string().optional(),
  })
  .passthrough();

const midpointSchema = z
  .object({ mid: decimalStringSchema })
  .passthrough();

const pricesHistoryPointSchema = z
  .object({
    t: z.number().refine((n) => Number.isInteger(n) && n >= 0, "must be unix seconds"),
    p: decimalStringSchema,
  })
  .passthrough();

const pricesHistoryResponseSchema = z
  .object({ history: z.array(pricesHistoryPointSchema) })
  .passthrough();

const marketTokenSchema = z
  .object({
    token_id: z.string(),
    outcome: z.string(),
    // Polymarket has shipped both `"0.4200"` and `0.42` for token price
    // depending on the deployment slice. Accept either at parse time and
    // canonicalize to a decimal string in fetchMarket.
    price: z.union([decimalStringSchema, z.number()]).optional(),
    winner: z.boolean(),
  })
  .passthrough();

const marketSchema = z
  .object({
    condition_id: conditionIdSchema,
    question: z.string(),
    closed: z.boolean(),
    accepting_orders: z.boolean(),
    tokens: z.array(marketTokenSchema),
  })
  .passthrough();

/**
 * Common HTTP dispatcher knobs — agent, pin set, timeout. Injected at
 * the clob-call level so the poller can plumb a test-only stub all the
 * way down without each call redeclaring the shape.
 */
export type ClobCallOpts = Pick<
  HttpGetWithAttestationOpts<unknown>,
  "agent" | "pinSet" | "timeoutMs"
>;

export interface FetchTradesResult {
  readonly trades: readonly Trade[];
  readonly attestation: SourceAttestation;
}

export async function fetchTrades(
  conditionId: Sha256Hex,
  afterTsUnix: number,
  callOpts: ClobCallOpts = {},
): Promise<FetchTradesResult> {
  const path =
    `/trades?market=${encodeURIComponent(conditionId)}` +
    `&takerOnly=true` +
    `&after=${String(afterTsUnix)}`;
  const { body, attestation } = await httpGetWithAttestation({
    host: DATA_API_HOST,
    path,
    schema: tradesListSchema,
    ...callOpts,
  });

  const trades: Trade[] = body.map((t) => ({
    proxyWallet: t.proxyWallet,
    side: t.side,
    asset: t.asset,
    conditionId: asSha256Hex(t.conditionId),
    size: t.size,
    price: t.price,
    timestamp: t.timestamp,
    outcome: t.outcome,
    outcomeIndex: t.outcomeIndex,
    transactionHash: t.transactionHash,
  }));

  return { trades, attestation };
}

export interface FetchBookResult {
  readonly book: Book;
  readonly attestation: SourceAttestation;
}

export async function fetchBook(
  tokenId: string,
  callOpts: ClobCallOpts = {},
): Promise<FetchBookResult> {
  const path = `/book?token_id=${encodeURIComponent(tokenId)}`;
  const { body, attestation } = await httpGetWithAttestation({
    host: CLOB_HOST,
    path,
    schema: bookSchema,
    ...callOpts,
  });

  const bids: readonly BookLevel[] = body.bids.map(
    (b): BookLevel => ({ price: b.price, size: b.size }),
  );
  const asks: readonly BookLevel[] = body.asks.map(
    (a): BookLevel => ({ price: a.price, size: a.size }),
  );
  const book: Book = {
    market: body.market,
    asset_id: body.asset_id,
    bids,
    asks,
    ...(typeof body.hash === "string" ? { hash: body.hash } : {}),
    ...(typeof body.timestamp === "string" ? { timestamp: body.timestamp } : {}),
  };

  return { book, attestation };
}

export interface FetchMidpointResult {
  readonly mid: string;
  readonly attestation: SourceAttestation;
}

export async function fetchMidpoint(
  tokenId: string,
  callOpts: ClobCallOpts = {},
): Promise<FetchMidpointResult> {
  const path = `/midpoint?token_id=${encodeURIComponent(tokenId)}`;
  const { body, attestation } = await httpGetWithAttestation({
    host: CLOB_HOST,
    path,
    schema: midpointSchema,
    ...callOpts,
  });
  return { mid: body.mid, attestation };
}

export interface FetchPricesHistoryResult {
  readonly history: readonly { readonly t: number; readonly p: string }[];
  readonly attestation: SourceAttestation;
}

export async function fetchPricesHistory(
  tokenId: string,
  startTs: number,
  endTs: number,
  callOpts: ClobCallOpts = {},
): Promise<FetchPricesHistoryResult> {
  const path =
    `/prices-history?market=${encodeURIComponent(tokenId)}` +
    `&startTs=${String(startTs)}` +
    `&endTs=${String(endTs)}` +
    `&fidelity=1`;
  const { body, attestation } = await httpGetWithAttestation({
    host: CLOB_HOST,
    path,
    schema: pricesHistoryResponseSchema,
    ...callOpts,
  });
  const history = body.history.map((h) => ({ t: h.t, p: h.p }));
  return { history, attestation };
}

export interface FetchMarketResult {
  readonly market: Market;
  readonly attestation: SourceAttestation;
}

export async function fetchMarket(
  conditionId: Sha256Hex,
  callOpts: ClobCallOpts = {},
): Promise<FetchMarketResult> {
  // CLOB requires the 0x-prefixed conditionId on /markets/{cid}; the
  // Sha256Hex brand we accept is stored without the prefix everywhere
  // else, so we prepend here at the boundary.
  const path = `/markets/0x${encodeURIComponent(conditionId)}`;
  const { body, attestation } = await httpGetWithAttestation({
    host: CLOB_HOST,
    path,
    schema: marketSchema,
    ...callOpts,
  });
  const tokens: readonly MarketToken[] = body.tokens.map(
    (t): MarketToken => {
      const priceStr =
        typeof t.price === "string"
          ? t.price
          : typeof t.price === "number"
            ? t.price.toString()
            : undefined;
      return {
        token_id: t.token_id,
        outcome: t.outcome,
        ...(priceStr !== undefined ? { price: priceStr } : {}),
        winner: t.winner,
      };
    },
  );
  const market: Market = {
    condition_id: asSha256Hex(body.condition_id.replace(/^0x/, "")),
    question: body.question,
    closed: body.closed,
    accepting_orders: body.accepting_orders,
    tokens,
  };
  return { market, attestation };
}
