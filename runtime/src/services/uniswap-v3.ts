/**
 * Uniswap V3 helper — minimal SwapRouter02 + QuoterV2 surface used by
 * the Payouts service to convert treasury USDC into ETH for the
 * admin EOA's gas budget.
 *
 * Two on-chain actions per refill:
 *   1. USDC.approve(SwapRouter02, MAX_UINT256) — one-time, idempotent
 *      (caller decides whether to skip when allowance is already high)
 *   2. SwapRouter02.multicall([
 *        exactInputSingle(USDC → WETH, recipient = router itself),
 *        unwrapWETH9(amountMinimum, recipient = admin)
 *      ])
 *      — delivers ETH directly to the admin EOA at the end of the call.
 *
 * Addresses below are pinned for the chain VANTA's Payouts run on.
 * `BASE_MAINNET_UNISWAP_V3` is the production set (chainId 8453); the
 * `BASE_SEPOLIA_UNISWAP_V3` testnet set is preserved for dev/CI. The
 * config layer picks the right set per `loanBookChainId`.
 */

import {
  encodeAbiParameters,
  encodeFunctionData,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

/** Verified Base mainnet (chainId 8453) deployment addresses. */
export const BASE_MAINNET_UNISWAP_V3 = {
  SwapRouter02: "0x2626664c2603336E57B271c5C0b26F421741e481" as Address,
  QuoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a" as Address,
  WETH9: "0x4200000000000000000000000000000000000006" as Address,
  V3Factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD" as Address,
} as const;

/** Verified Base Sepolia (chainId 84532) deployment addresses — testnet only. */
export const BASE_SEPOLIA_UNISWAP_V3 = {
  SwapRouter02: "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4" as Address,
  QuoterV2: "0xC5290058841028F1614F3A6F0F5816cAd0df5E27" as Address,
  WETH9: "0x4200000000000000000000000000000000000006" as Address,
  V3Factory: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24" as Address,
} as const;

/** Pick the deployment set for the given Base chainId. */
export function uniswapV3ForChain(
  chainId: number,
): typeof BASE_MAINNET_UNISWAP_V3 {
  if (chainId === 8453) return BASE_MAINNET_UNISWAP_V3;
  if (chainId === 84532) return BASE_SEPOLIA_UNISWAP_V3;
  throw new Error(
    `uniswapV3ForChain: no Uniswap V3 deployment registered for chainId=${String(chainId)}`,
  );
}

/** Common Uniswap V3 fee tiers (basis points × 100). 500 = 0.05%. */
export const UNISWAP_V3_FEE_TIERS = {
  LOWEST: 100,
  LOW: 500,
  MEDIUM: 3000,
  HIGH: 10000,
} as const;

/** SwapRouter02 ABI subset — only what Payouts needs. */
export const SWAP_ROUTER_02_ABI = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "unwrapWETH9",
    stateMutability: "payable",
    inputs: [
      { name: "amountMinimum", type: "uint256" },
      { name: "recipient", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "multicall",
    stateMutability: "payable",
    inputs: [{ name: "data", type: "bytes[]" }],
    outputs: [{ name: "results", type: "bytes[]" }],
  },
] as const;

/** QuoterV2 ABI subset — `quoteExactInputSingle` only. */
export const QUOTER_V2_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    // QuoterV2's quote functions are not view (they revert internally to
    // unwind state), but the off-chain RPC simulates them via eth_call.
    // viem's readContract handles this transparently.
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

export interface BuildSwapAndUnwrapArgs {
  readonly tokenIn: Address;
  readonly tokenOut: Address; // typically WETH9 — must match unwrap below
  readonly amountIn: bigint;
  readonly amountOutMinimum: bigint;
  readonly recipient: Address; // final ETH recipient (the admin EOA)
  readonly poolFee: number; // 500 / 3000 / 10000
  readonly router: Address; // SwapRouter02
  /** sqrtPriceLimitX96 — 0 for "no price limit", recommended default. */
  readonly sqrtPriceLimitX96?: bigint;
}

/**
 * Build the calldata for a single tx that:
 *   1. swaps `amountIn` of `tokenIn` for at least `amountOutMinimum`
 *      `tokenOut` (WETH), held by the router contract itself, then
 *   2. unwraps the WETH and forwards the ETH to `recipient`.
 *
 * Returns `{ to, data }` — caller calls `walletClient.sendTransaction`
 * (or `walletClient.writeContract` against `multicall(bytes[])`) with
 * this payload.
 */
export function buildSwapAndUnwrapMulticall(
  args: BuildSwapAndUnwrapArgs,
): { to: Address; data: Hex } {
  const sqrtLimit = args.sqrtPriceLimitX96 ?? 0n;

  // Step 1: encode exactInputSingle. Recipient is the router itself
  // because we want WETH to land in the router so the next call
  // (unwrapWETH9) can withdraw the full balance for the user.
  const exactInputData = encodeFunctionData({
    abi: SWAP_ROUTER_02_ABI,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: args.tokenIn,
        tokenOut: args.tokenOut,
        fee: args.poolFee,
        recipient: args.router, // WETH lands here, then unwrapWETH9 sweeps it
        amountIn: args.amountIn,
        amountOutMinimum: args.amountOutMinimum,
        sqrtPriceLimitX96: sqrtLimit,
      },
    ],
  });

  // Step 2: encode unwrapWETH9 — sweep the router's full WETH balance
  // out as ETH to `recipient`. amountMinimum is the same minimum we
  // enforced on the swap (defense in depth — both must hold).
  const unwrapData = encodeFunctionData({
    abi: SWAP_ROUTER_02_ABI,
    functionName: "unwrapWETH9",
    args: [args.amountOutMinimum, args.recipient],
  });

  // Step 3: bundle into multicall(bytes[]).
  const multicallData = encodeFunctionData({
    abi: SWAP_ROUTER_02_ABI,
    functionName: "multicall",
    args: [[exactInputData, unwrapData]],
  });

  return { to: args.router, data: multicallData };
}

/**
 * Encode a swap + unwrap pair without the outer multicall wrapper —
 * useful when the caller wants to inject extra leg(s) (e.g. a refund
 * sweep). Returns the two inner calldata blobs in order.
 */
export function buildSwapAndUnwrapInner(
  args: BuildSwapAndUnwrapArgs,
): { exactInput: Hex; unwrap: Hex } {
  const sqrtLimit = args.sqrtPriceLimitX96 ?? 0n;
  const exactInput = encodeFunctionData({
    abi: SWAP_ROUTER_02_ABI,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: args.tokenIn,
        tokenOut: args.tokenOut,
        fee: args.poolFee,
        recipient: args.router,
        amountIn: args.amountIn,
        amountOutMinimum: args.amountOutMinimum,
        sqrtPriceLimitX96: sqrtLimit,
      },
    ],
  });
  const unwrap = encodeFunctionData({
    abi: SWAP_ROUTER_02_ABI,
    functionName: "unwrapWETH9",
    args: [args.amountOutMinimum, args.recipient],
  });
  return { exactInput, unwrap };
}

export interface QuoteExactInputSingleArgs {
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: bigint;
  readonly poolFee: number;
  readonly quoter: Address;
}

export interface QuoteResult {
  readonly amountOut: bigint;
  readonly sqrtPriceX96After: bigint;
  readonly initializedTicksCrossed: number;
  readonly gasEstimate: bigint;
}

/**
 * Off-chain quote of a swap via QuoterV2. Reverts internally on the
 * EVM but viem's readContract simulates via eth_call and returns the
 * unwound output. Use the result to size `amountIn` against a target
 * `amountOut` (e.g. "give me ETH worth $X of USDC").
 */
export async function quoteExactInputSingle(
  client: PublicClient,
  args: QuoteExactInputSingleArgs,
): Promise<QuoteResult> {
  const result = await client.readContract({
    address: args.quoter,
    abi: QUOTER_V2_ABI,
    functionName: "quoteExactInputSingle",
    args: [
      {
        tokenIn: args.tokenIn,
        tokenOut: args.tokenOut,
        amountIn: args.amountIn,
        fee: args.poolFee,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  // viem returns named-tuple outputs as a positional array.
  const [amountOut, sqrtPriceX96After, initializedTicksCrossed, gasEstimate] =
    result as readonly [bigint, bigint, number, bigint];
  return {
    amountOut,
    sqrtPriceX96After,
    initializedTicksCrossed,
    gasEstimate,
  };
}

/**
 * Apply a basis-point slippage tolerance to a quoted output, returning
 * the `amountOutMinimum` to enforce on the swap. 100 bps = 1%.
 */
export function applySlippageBps(amountOut: bigint, slippageBps: number): bigint {
  if (slippageBps < 0 || slippageBps > 10_000) {
    throw new Error(`slippageBps out of range: ${slippageBps}`);
  }
  const num = BigInt(10_000 - slippageBps);
  return (amountOut * num) / 10_000n;
}

/** Re-export for callers building ERC-20 approve calldata. */
export const ERC20_APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** MAX_UINT256 — the canonical "infinite approval" amount. */
export const MAX_UINT256 = (1n << 256n) - 1n;

// `encodeAbiParameters` is exported so callers writing custom multicall
// pipelines can splice extra legs without re-importing viem.
export { encodeAbiParameters };
