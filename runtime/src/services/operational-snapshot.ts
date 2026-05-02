/**
 * Real operational snapshot — replaces `stubOperationalSnapshot()`.
 *
 * Reads on-chain:
 *   - Treasury USDC balance on Base Sepolia
 *   - Treasury native (ETH) balance on Base Sepolia
 *   - Admin native (ETH) balance on Base Sepolia
 *   - Admin native (MATIC) balance on Polygon Amoy
 *   - Live gas price (gwei) on both chains
 *
 * Computes:
 *   - `treasury_balance_usdc` = on-chain USDC held by `vanta-agent-treasury-v1`
 *   - `weekly_spend_usdc` = a conservative floor based on EigenCompute
 *      hosting line items + estimated gas + inference. NOT yet sourced from
 *      tracked tx receipts; that's the cost-tracker work in a later patch.
 *      For now the floor is honest about what the agent costs to run, even
 *      if the actual money isn't flowing yet (since we're on credits).
 *   - `base_gas_p95_gwei` / `amoy_gas_p95_gwei` = static priors until we
 *      build a rolling-window tracker.
 *   - `inference_cost_*` = 0 until the AI gateway is live with USDC pricing.
 *   - `oracle_read_failures` / `rpc_healthy_pct` = derived from this tick's
 *      RPC calls (any throw → unhealthy).
 *
 * The honest framing: treasury balance is real, gas prices are real,
 * weekly_spend is a hand-calibrated floor, and the rest are placeholders
 * the operational loop already handles gracefully (the anomaly detector
 * skips inference if baseline = 0).
 */

import { createPublicClient, http, type Address } from "viem";
import { baseSepolia, polygonAmoy } from "viem/chains";

import type { OperationalSnapshot } from "../loops/operational.js";

// USDC on Base Sepolia (Circle-issued). Same as
// `contracts/script/01_LpVault.s.sol::USDC`; pinned here to keep this
// module independent of the deploy-script imports.
const BASE_SEPOLIA_USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

const ERC20_BALANCE_OF_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

// EigenCompute line items as published in `ecloud billing status`:
// $0.118/hr (shielded VM tier) + $0.329/hr (TDX tier). VANTA runs on
// g1-standard-4t (TDX), so $0.329/hr × 168 hr/wk = $55.27/wk.
// Plus a small buffer for gas + inference; bumped by callsite on real
// data when the cost-tracker lands.
const HOSTING_USD_PER_WEEK = 55.27;
const GAS_BUDGET_USD_PER_WEEK = 5;
const INFERENCE_BUDGET_USD_PER_WEEK = 10;
const WEEKLY_SPEND_USD_FLOOR =
  HOSTING_USD_PER_WEEK + GAS_BUDGET_USD_PER_WEEK + INFERENCE_BUDGET_USD_PER_WEEK;

// Gas-price priors. Replace with rolling-window tracker once we have
// tx-receipt history.
const BASE_GAS_P95_GWEI_PRIOR = 0.2;
const AMOY_GAS_P95_GWEI_PRIOR = 60;

export interface OperationalSnapshotArgs {
  readonly treasuryAddress: Address;
  readonly adminAddress: Address;
  readonly baseRpcUrl: string;
  readonly amoyRpcUrl: string;
}

export interface OperationalReader {
  /** Snapshot used by the operational loop. */
  readonly snapshot: () => Promise<OperationalSnapshot>;
  /** Latest read; cached so /api/state can surface without re-RPCing. */
  readonly latest: () => OperationalSnapshot | null;
}

export function createOperationalReader(
  args: OperationalSnapshotArgs,
): OperationalReader {
  // Note: not annotating these as `PublicClient` — Base (Optimism stack)
  // and Polygon Amoy define divergent transaction shapes in viem 2.22's
  // chain types, and a shared `PublicClient` annotation collapses them
  // to incompatible. Inferred types are precise per-call.
  const baseClient = createPublicClient({
    chain: baseSepolia,
    transport: http(args.baseRpcUrl),
  });
  const amoyClient = createPublicClient({
    chain: polygonAmoy,
    transport: http(args.amoyRpcUrl),
  });

  let cached: OperationalSnapshot | null = null;

  async function snapshot(): Promise<OperationalSnapshot> {
    let oracleFailures = 0;
    let rpcAttempts = 0;
    let rpcSuccesses = 0;

    async function tryRead<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
      rpcAttempts += 1;
      try {
        const v = await fn();
        rpcSuccesses += 1;
        return v;
      } catch {
        oracleFailures += 1;
        return fallback;
      }
    }

    const treasuryUsdc = await tryRead(
      () =>
        baseClient.readContract({
          address: BASE_SEPOLIA_USDC,
          abi: ERC20_BALANCE_OF_ABI,
          functionName: "balanceOf",
          args: [args.treasuryAddress],
        }),
      0n,
    );

    // Native balances on Base Sepolia (admin + treasury) drive the
    // gas-refill subroutine in payouts.ts. Amoy admin balance is read
    // for RPC-health accounting but not surfaced — the runtime never
    // signs Amoy txs today (paper §7 — VantaVault is read-only).
    const treasuryNative = await tryRead(
      () => baseClient.getBalance({ address: args.treasuryAddress }),
      0n,
    );
    const adminNative = await tryRead(
      () => baseClient.getBalance({ address: args.adminAddress }),
      0n,
    );
    await tryRead(() => amoyClient.getBalance({ address: args.adminAddress }), 0n);

    const baseGasWei = await tryRead(() => baseClient.getGasPrice(), 0n);
    const amoyGasWei = await tryRead(() => amoyClient.getGasPrice(), 0n);

    const baseGasGwei = Number(baseGasWei) / 1e9;
    const amoyGasGwei = Number(amoyGasWei) / 1e9;

    // weekly_spend in USDC wei (6 decimals). Convert USD floor → wei.
    const weeklySpendWei = BigInt(Math.round(WEEKLY_SPEND_USD_FLOOR * 1_000_000));

    const rpcHealthyPct =
      rpcAttempts === 0 ? 100 : (rpcSuccesses / rpcAttempts) * 100;

    const out: OperationalSnapshot = {
      treasury_balance_usdc: treasuryUsdc.toString(),
      weekly_spend_usdc: weeklySpendWei.toString(),
      base_gas_gwei: baseGasGwei,
      amoy_gas_gwei: amoyGasGwei,
      base_gas_p95_gwei: BASE_GAS_P95_GWEI_PRIOR,
      amoy_gas_p95_gwei: AMOY_GAS_P95_GWEI_PRIOR,
      inference_cost_per_1k_usdc: 0,
      inference_cost_baseline_usdc: 0,
      oracle_read_failures: oracleFailures,
      rpc_healthy_pct: rpcHealthyPct,
      admin_native_wei: adminNative.toString(),
      treasury_native_wei: treasuryNative.toString(),
    };
    cached = out;
    return out;
  }

  return {
    snapshot,
    latest: () => cached,
  };
}
