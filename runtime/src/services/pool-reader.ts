/**
 * Read-only adapter for AgentPoolVault + PositionBook.
 *
 * One reader instance per VANTA, since the (pool, positionBook) pair
 * is per-agent. Surface fields:
 *
 *   - `nav_usdc6`         AgentPoolVault.totalAssets()
 *   - `total_supply`      AgentPoolVault.totalSupply()
 *   - `share_price_e18`   nav × 1e18 / supply (or 1e18 if supply=0)
 *   - `max_aum_usdc6`     AgentPoolVault.maxAumUsdc6() (immutable cap)
 *   - `free_usdc6`        nav − openNotional  (USDC available to deploy)
 *   - `open_notional_usdc6` PositionBook.openNotionalUsdc6()
 *   - `lifetime_pnl_usdc6` lifetime_proceeds − lifetime_cost_basis (signed)
 *
 * Everything is read-only and idempotent. Mutations (deposit /
 * withdraw / open / close) live behind the relayer EOA and are not
 * exposed via this reader.
 *
 * As with `agent-registry-reader.ts`, two implementations: a fixture
 * for local-dev / tests, and a viem reader for production.
 */

import type { Address, PublicClient } from "viem";

export interface PoolState {
  readonly agent_id: number;
  readonly pool: Address;
  /**
   * Per-agent PositionBook address. Null in v1 (shared-pool runtime —
   * no per-agent position book deployed yet); a real Address in v2 when
   * AgentRegistry / AgentFactory.deploy() are wired up.
   */
  readonly position_book: Address | null;
  readonly nav_usdc6: bigint;
  readonly total_supply: bigint;
  readonly share_price_e18: bigint;
  readonly max_aum_usdc6: bigint;
  readonly free_usdc6: bigint;
  readonly open_notional_usdc6: bigint;
  readonly lifetime_cost_basis_usdc6: bigint;
  readonly lifetime_proceeds_usdc6: bigint;
}

export interface PoolReader {
  readonly read: () => Promise<PoolState>;
}

// ----------------------- fixture reader ----------------------------

export interface FixturePoolStateInputs {
  readonly agent_id: number;
  readonly pool: Address;
  readonly position_book: Address | null;
  readonly nav_usdc6: bigint;
  readonly total_supply: bigint;
  readonly max_aum_usdc6: bigint;
  readonly open_notional_usdc6: bigint;
  readonly lifetime_cost_basis_usdc6: bigint;
  readonly lifetime_proceeds_usdc6: bigint;
}

const ONE_E18 = 1_000_000_000_000_000_000n;

function computeSharePriceE18(navUsdc6: bigint, totalSupply: bigint): bigint {
  if (totalSupply === 0n) return ONE_E18;
  return (navUsdc6 * ONE_E18) / totalSupply;
}

function computeFreeUsdc6(navUsdc6: bigint, openNotional: bigint): bigint {
  if (openNotional > navUsdc6) return 0n;
  return navUsdc6 - openNotional;
}

export function createFixturePoolReader(
  inputs: FixturePoolStateInputs,
): PoolReader {
  const state: PoolState = {
    agent_id: inputs.agent_id,
    pool: inputs.pool,
    position_book: inputs.position_book,
    nav_usdc6: inputs.nav_usdc6,
    total_supply: inputs.total_supply,
    share_price_e18: computeSharePriceE18(inputs.nav_usdc6, inputs.total_supply),
    max_aum_usdc6: inputs.max_aum_usdc6,
    free_usdc6: computeFreeUsdc6(inputs.nav_usdc6, inputs.open_notional_usdc6),
    open_notional_usdc6: inputs.open_notional_usdc6,
    lifetime_cost_basis_usdc6: inputs.lifetime_cost_basis_usdc6,
    lifetime_proceeds_usdc6: inputs.lifetime_proceeds_usdc6,
  };
  return {
    read: () => Promise.resolve(state),
  };
}

// ----------------------- viem reader -------------------------------

const POOL_ABI = [
  { type: "function", name: "totalAssets", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxAumUsdc6", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "agentId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

const POSITION_BOOK_ABI = [
  { type: "function", name: "openNotionalUsdc6", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "lifetimeCostBasisUsdc6", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "lifetimeProceedsUsdc6", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export interface ViemPoolReaderArgs {
  readonly client: PublicClient;
  readonly agent_id: number;
  readonly pool: Address;
  readonly position_book: Address;
}

/**
 * Reader for a vanilla ERC-4626 LpVault that does NOT have the
 * `maxAumUsdc6` / position-book extensions. Reads `totalAssets()`
 * and `totalSupply()` live on every call; returns 0 for the
 * extension-only fields. Used by the prod runtime when the only
 * deployed contract is the shared LpVault on Base mainnet — the
 * full per-agent vault layout is V1 work.
 */
export interface MinimalLpVaultReaderArgs {
  readonly client: PublicClient;
  readonly agent_id: number;
  readonly pool: Address;
  /** Null in v1 (no per-agent position book); reader stamps null
   *  through into PoolState.position_book. */
  readonly position_book: Address | null;
  readonly maxAumUsdc6?: bigint;
}

export function createMinimalLpVaultReader(
  args: MinimalLpVaultReaderArgs,
): PoolReader {
  const maxAum = args.maxAumUsdc6 ?? 10_000_000_000_000n;
  const read = async (): Promise<PoolState> => {
    const [nav, supply] = (await Promise.all([
      args.client.readContract({
        address: args.pool,
        abi: POOL_ABI,
        functionName: "totalAssets",
      }),
      args.client.readContract({
        address: args.pool,
        abi: POOL_ABI,
        functionName: "totalSupply",
      }),
    ])) as [bigint, bigint];
    return {
      agent_id: args.agent_id,
      pool: args.pool,
      position_book: args.position_book,
      nav_usdc6: nav,
      total_supply: supply,
      share_price_e18: computeSharePriceE18(nav, supply),
      max_aum_usdc6: maxAum,
      free_usdc6: computeFreeUsdc6(nav, 0n),
      open_notional_usdc6: 0n,
      lifetime_cost_basis_usdc6: 0n,
      lifetime_proceeds_usdc6: 0n,
    };
  };
  return { read };
}

export function createViemPoolReader(args: ViemPoolReaderArgs): PoolReader {
  const read = async (): Promise<PoolState> => {
    const [nav, supply, maxAum, openNotional, lifeCost, lifeProceeds] = (await Promise.all([
      args.client.readContract({ address: args.pool, abi: POOL_ABI, functionName: "totalAssets" }),
      args.client.readContract({ address: args.pool, abi: POOL_ABI, functionName: "totalSupply" }),
      args.client.readContract({ address: args.pool, abi: POOL_ABI, functionName: "maxAumUsdc6" }),
      args.client.readContract({ address: args.position_book, abi: POSITION_BOOK_ABI, functionName: "openNotionalUsdc6" }),
      args.client.readContract({ address: args.position_book, abi: POSITION_BOOK_ABI, functionName: "lifetimeCostBasisUsdc6" }),
      args.client.readContract({ address: args.position_book, abi: POSITION_BOOK_ABI, functionName: "lifetimeProceedsUsdc6" }),
    ])) as [bigint, bigint, bigint, bigint, bigint, bigint];

    return {
      agent_id: args.agent_id,
      pool: args.pool,
      position_book: args.position_book,
      nav_usdc6: nav,
      total_supply: supply,
      share_price_e18: computeSharePriceE18(nav, supply),
      max_aum_usdc6: maxAum,
      free_usdc6: computeFreeUsdc6(nav, openNotional),
      open_notional_usdc6: openNotional,
      lifetime_cost_basis_usdc6: lifeCost,
      lifetime_proceeds_usdc6: lifeProceeds,
    };
  };
  return { read };
}
