/**
 * Minimal USDC ABI surface used by the treasury module.
 *
 * We only need three things on-chain:
 *   - `Transfer(from, to, value)` event for inflow detection (spec §1.4, §6)
 *   - `balanceOf(owner) → uint256` for reconciliation (spec §2 I-TR-3)
 *   - `transfer(to, amount) → bool` calldata for the dry-run outflow plan (spec §1.5)
 *
 * The ABI is typed `as const` so viem's type inference narrows
 * event args + decode return types without widening to `unknown`.
 */

export const usdcAbi = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export type UsdcAbi = typeof usdcAbi;
