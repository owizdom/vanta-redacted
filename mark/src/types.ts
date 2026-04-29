/**
 * Public types for the @vanta/mark module.
 *
 * `Trade`, `Book`, and `Market` match the fields canonical-reference.md §4.2
 * captured live on Polymarket's mainnet CLOB and Data-API.
 *
 * `SourceAttestation` matches the shape required by the event-schema
 * `loan.mark.source_attestation` nested object (events/src/bodies.ts
 * `LoanMarkBody.source_attestation`). Same field names; `@vanta/events`
 * enforces the HTTP-200 + hex64 SPKI refinements at the schema layer.
 */

import type { Sha256Hex } from "@vanta/tee";

/**
 * Single taker-side trade from `data-api.polymarket.com/trades`.
 *
 * Fields captured verbatim from canonical-reference.md §4.2 per Phase 1
 * recon probes. `size`, `price`, and `timestamp` are the load-bearing
 * fields for the TWAP; the remainder are retained for attestation
 * provenance and cross-check against the on-chain CTF state (I-PL-7).
 */
export interface Trade {
  readonly proxyWallet: string;
  readonly side: "BUY" | "SELL";
  readonly asset: string;
  readonly conditionId: Sha256Hex;
  readonly size: string;
  readonly price: string;
  readonly timestamp: number;
  readonly outcome: string;
  readonly outcomeIndex: number;
  readonly transactionHash: string;
}

/**
 * A single price level from `clob.polymarket.com/book`. Price and size
 * are decimal strings (binary-prediction-market prices are bounded
 * [0, 1]). Retained for future liquidation-eligibility reads; the TWAP
 * pipeline itself does not need this structure.
 */
export interface BookLevel {
  readonly price: string;
  readonly size: string;
}

/**
 * Book snapshot from `clob.polymarket.com/book?token_id=...`. `bids` are
 * sorted descending by price; `asks` ascending. Ordering is only
 * guaranteed at the server; callers who need invariant ordering should
 * re-sort.
 */
export interface Book {
  readonly market: string;
  readonly asset_id: string;
  readonly bids: readonly BookLevel[];
  readonly asks: readonly BookLevel[];
  readonly hash?: string;
  readonly timestamp?: string;
}

/**
 * Token-outcome descriptor inside `Market.tokens`. `winner === true`
 * after resolution for exactly one entry (canonical-reference.md §4.4).
 */
export interface MarketToken {
  readonly token_id: string;
  readonly outcome: string;
  readonly price?: string;
  readonly winner: boolean;
}

/**
 * Market record from `clob.polymarket.com/markets/{conditionId}`.
 * `closed`, `accepting_orders`, and `tokens[].winner` are the only fields
 * the resolution / halt cross-check reads against the on-chain CTF state
 * (I-PL-7).
 */
export interface Market {
  readonly condition_id: Sha256Hex;
  readonly question: string;
  readonly closed: boolean;
  readonly accepting_orders: boolean;
  readonly tokens: readonly MarketToken[];
}

/**
 * Source-attestation bundle (I-MK-4). Every `loan.mark` body embeds
 * this so an external verifier can re-hash the response and re-check
 * the SPKI pin. Field names match `events/src/bodies.ts`
 * `LoanMarkBody.source_attestation` so the two can interoperate without
 * translation glue.
 */
export interface SourceAttestation {
  readonly clob_hostname: string;
  readonly tls_spki_sha256: string;
  readonly http_status: number;
  readonly response_etag_or_digest: string;
}
