/**
 * Public types for the @vanta/treasury module.
 *
 * Every shape here is part of the Week-1-close frozen surface. Fields
 * are `readonly` throughout; all bigint-risky values are serialized
 * as decimal strings so wire JSON can round-trip amounts and block
 * numbers larger than 2^53 without precision loss (spec §1.7, §1.8).
 */

import type { EthAddressHex } from "@vanta/tee";

import type {
  CHAIN_ID,
  CHAIN_LABEL,
  CONFIRMATION_BLOCKS,
  USDC_BASE_SEPOLIA,
} from "./constants.js";

/** Alias: a raw uint256 USDC amount rendered as a decimal digit string. */
export type UsdcAmountWei = string & { readonly __brand: "usdc-amount-wei" };

/**
 * `TreasuryState` — spec §1.6. Snapshot of the treasury's accounting +
 * chain tip at the moment `getTreasuryState` returned.
 */
export interface TreasuryState {
  readonly address: EthAddressHex;
  readonly chainId: typeof CHAIN_ID;
  readonly usdcContract: typeof USDC_BASE_SEPOLIA;
  readonly balanceUsdc: string;
  readonly balanceWei: string;
  readonly lastInflowBlock: bigint | null;
  readonly lastInflowTxHash: `0x${string}` | null;
  readonly totalInflowsCount: number;
  readonly totalInflowsUsdc: string;
  readonly confirmationDepth: typeof CONFIRMATION_BLOCKS;
  readonly updatedAtBlock: bigint;
}

/**
 * `ScheduleEntry` — spec §1.6 (minimal Week 1 shape). Constitutional
 * binding lands with the constitution module in the same week; for
 * Week 1 we accept the shape as input to `buildOutflowTx` and validate
 * the entries' invariants locally.
 */
export type SchedulePeriod = "daily" | "monthly" | "yearly";

export interface ScheduleEntry {
  readonly id: string;
  readonly vendor: string;
  readonly periodKind: SchedulePeriod;
  readonly capUsdcWei: string;
  readonly destination: EthAddressHex;
  readonly constitutionalRef: string;
}

/**
 * `OutflowPlan` — spec §1.6. Week 1 dry-run shape; Week 3 will add an
 * execution path that signs and broadcasts.
 */
export interface OutflowPlan {
  readonly chainId: typeof CHAIN_ID;
  readonly to: typeof USDC_BASE_SEPOLIA;
  readonly data: `0x${string}`;
  readonly amountWei: string;
  readonly scheduleId: string;
  readonly plannedAt: number;
  readonly dryRun: true;
}

/**
 * `treasury.inflow` event body (spec §1.7). Fed to `buildAndSign` in
 * `@vanta/events`. `amountWei` and `blockNumber` are decimal strings so
 * canonical-JSON + external JSON parsers round-trip without losing
 * precision past 2^53.
 */
export type InflowSource = "stake-deposit" | "protocol-fee" | "unknown";

export interface TreasuryInflowBody {
  readonly chain: typeof CHAIN_LABEL;
  readonly usdcContract: typeof USDC_BASE_SEPOLIA;
  readonly txHash: `0x${string}`;
  readonly logIndex: number;
  readonly blockNumber: string;
  readonly blockHash: `0x${string}`;
  readonly fromAddress: EthAddressHex;
  readonly toAddress: EthAddressHex;
  readonly amountWei: string;
  readonly amountUsdc: string;
  readonly observedAt: number;
  readonly confirmationBlocks: typeof CONFIRMATION_BLOCKS;
  readonly source: InflowSource;
}

/**
 * Init options (spec §1.1). Reserved for Week 3 outflow config.
 */
export interface InitTreasuryOpts {
  readonly rpcUrl?: string;
}
