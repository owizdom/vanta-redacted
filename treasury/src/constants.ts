/**
 * Frozen chain + policy constants for @vanta/treasury.
 *
 * All constants cite either the synthesis spec (§1.5, §1.7, §1.8, §6)
 * or EXPLAINERV7 §4 / §13 verifiable artifact #5.
 *
 * `CONFIRMATION_BLOCKS = 5` is a literal type so it flows through the
 * public `TreasuryState.confirmationDepth: 5` and `InflowBody.confirmationBlocks: 5`.
 */

import type { EthAddressHex } from "@vanta/tee";

/** Base Sepolia chain id — the treasury is pinned to this L2 testnet. */
export const CHAIN_ID = 84532 as const;
export type ChainId = typeof CHAIN_ID;

/**
 * Base Sepolia USDC (Circle). Sourced from Circle's testnet USDC list.
 * Frozen — changing this rotates the treasury's accounting universe.
 */
export const USDC_BASE_SEPOLIA: EthAddressHex =
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

/** Confirmation depth for inflow events (spec §1.7, §6.3). */
export const CONFIRMATION_BLOCKS = 5 as const;
export type ConfirmationDepth = typeof CONFIRMATION_BLOCKS;

/** USDC on Base Sepolia has six decimals. */
export const USDC_DECIMALS = 6 as const;

/** Default Base Sepolia RPC endpoint (public). Overridden by env. */
export const DEFAULT_BASE_SEPOLIA_RPC = "https://sepolia.base.org";

/** Polling interval for `watchContractEvent` (spec §1.4, §6.2): 12s. */
export const POLLING_INTERVAL_MS = 12_000 as const;

/**
 * Reconciliation cadence (spec §2 I-TR-3 + §6.5). Every 10 blocks,
 * run the balance-invariant check.
 */
export const RECONCILE_BLOCK_CADENCE = 10n;

/**
 * Cold-boot `lastProcessedBlock` default (spec §9 OQ-4). Conservative
 * fallback of `currentBlock - COLD_BOOT_LOOKBACK_BLOCKS` until a pinned
 * deployment-era block is stamped post first-funding.
 */
export const COLD_BOOT_LOOKBACK_BLOCKS = 10_000n;

/**
 * Canonical chain label for `treasury.inflow` body `chain` field (spec §1.7).
 */
export const CHAIN_LABEL = "base-sepolia" as const;
export type ChainLabel = typeof CHAIN_LABEL;
