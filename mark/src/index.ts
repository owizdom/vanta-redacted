/**
 * Package barrel for @vanta/mark.
 *
 * Public surface: constants, types, error classes, HTTP + CLOB client,
 * TWAP computation, body builders, poller factory.
 *
 * Nothing not re-exported here is considered public. Tests reach into
 * the modules directly; downstream packages MUST go through this barrel.
 */

// Constants
export {
  CLOB_HOST,
  COVERAGE_GAP_MAX_SECONDS,
  CROSS_CHECK_MAX_DEVIATION,
  DATA_API_HOST,
  MAX_SINGLE_TRADE_SHARE,
  MIN_AGGREGATE_NOTIONAL_USDC_6DEC,
  MIN_TRADES_IN_WINDOW,
  POLL_INTERVAL_SECONDS,
  TLS_SPKI_SHA256_PIN,
  TWAP_WINDOW_SECONDS,
} from "./constants.js";

// Types
export type {
  Book,
  BookLevel,
  Market,
  MarketToken,
  SourceAttestation,
  Trade,
} from "./types.js";

// Errors
export { MarkError, MarkSparseSignal } from "./errors.js";
export type { MarkErrorCode, SparseReason } from "./errors.js";

// HTTP client
export { httpGetWithAttestation } from "./http.js";
export type {
  HttpGetResult,
  HttpGetWithAttestationOpts,
} from "./http.js";

// CLOB calls
export {
  fetchBook,
  fetchMarket,
  fetchMidpoint,
  fetchPricesHistory,
  fetchTrades,
} from "./clob.js";
export type {
  ClobCallOpts,
  FetchBookResult,
  FetchMarketResult,
  FetchMidpointResult,
  FetchPricesHistoryResult,
  FetchTradesResult,
} from "./clob.js";

// TWAP
export { computeTwap } from "./twap.js";
export type {
  TwapInvalid,
  TwapResult,
  TwapValid,
  TwapWindow,
} from "./twap.js";

// Builders
export {
  buildLoanMarkBody,
  buildMarkGapBody,
  buildMarkSparseBody,
} from "./builder.js";
export type {
  BuildLoanMarkBodyArgs,
  BuildMarkGapBodyArgs,
  BuildMarkSparseBodyArgs,
} from "./builder.js";

// Poller
export { createMarkPoller, computeAggregateNotional6dec } from "./poller.js";
export type {
  EmitGapFn,
  EmitMarkFn,
  EmitSparseFn,
  FetchMarketFn,
  FetchTradesFn,
  MarkPollerArgs,
  MarkPollerHandle,
  MarkTarget,
} from "./poller.js";
