/**
 * Frozen constants for @vanta/mark.
 *
 * Citations:
 *   - canonical-reference.md §4 ("Mark feed"): endpoint hosts, the TWAP
 *     window, TLS SPKI pin value (captured 2026-04-24), the
 *     insufficient-trades / coverage-gap / cross-check thresholds.
 *   - week-2-plan.md §Invariants I-MK-1…I-MK-5: invariant-level
 *     thresholds (min trades = 3, coverage-gap max = 5 min,
 *     cross-check max deviation = 2%).
 */

/** CLOB host. Book, midpoint, prices-history, and `/markets/{id}` live here. */
export const CLOB_HOST = "clob.polymarket.com" as const;

/** Data API host. `/trades?market=...&takerOnly=true` is L0 here (not on CLOB). */
export const DATA_API_HOST = "data-api.polymarket.com" as const;

/** TWAP window = 30 minutes (expressed in seconds). */
export const TWAP_WINDOW_SECONDS = 1800 as const;

/** Minimum number of trades in a window; below this the window is sparse. */
export const MIN_TRADES_IN_WINDOW = 3 as const;

/**
 * Aggregate-notional floor, in USDC base units (6 decimals). Windows whose
 * summed size*price notional falls below this are not usable for liquidation
 * decisions. $500 × 10^6 = 500_000_000.
 */
export const MIN_AGGREGATE_NOTIONAL_USDC_6DEC = 500_000_000n as const;

/** No single trade may hold more than 50% of the window's segment time. */
export const MAX_SINGLE_TRADE_SHARE = 0.5 as const;

/** Max coverage gap (seconds of unfilled time weighted into the TWAP). */
export const COVERAGE_GAP_MAX_SECONDS = 300 as const;

/** Max absolute deviation between our TWAP and server-side /prices-history. */
export const CROSS_CHECK_MAX_DEVIATION = 0.02 as const;

/** Poller tick period, in seconds. */
export const POLL_INTERVAL_SECONDS = 30 as const;

/**
 * SPKI SHA-256 pin, 64-char lowercase hex, captured 2026-05-05 off the
 * wildcard Google Trust Services leaf that serves `*.polymarket.com`
 * (clob.polymarket.com + data-api.polymarket.com both hash to this pin).
 * Google rotates leaves every 60-90 days; SPKI pins survive leaf rotation
 * as long as the keypair is stable. Pin-set (see `http.ts`) is recommended
 * so rotation doesn't break us mid-epoch.
 */
export const TLS_SPKI_SHA256_PIN =
  "435db2cbbbd932a737558e08b2e9b56b767be33d95d7d139a4793c73796376e9" as const;
