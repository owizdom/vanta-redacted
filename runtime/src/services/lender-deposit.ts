/**
 * Real on-chain LP-vault deposit path (paper §7.4 — Cynthia/Daniel).
 *
 * The bots' Cynthia and Daniel cycles narrate USDC deposits in chat.
 * In demo mode (current default) those deposits are tracked locally
 * by `agent-state.addDemoDepositUsdc6` and the chest renderer fills
 * the 9-chest grid from that synthetic balance. In *real* mode this
 * module signs and broadcasts an actual `LpVault.deposit(amount,
 * receiver)` call on Base Sepolia using a configured lender wallet —
 * the on-chain `LpVault.totalAssets()` then moves, agent-state's
 * 15s poll catches it, and the chest renderer reflects the real
 * deposit on its next 30s tick.
 *
 * Env vars required to enable real mode (all four; if any are missing
 * the module returns mode='demo' and the caller stays on the synthetic
 * accumulator):
 *
 *   VANTA_LENDER_PRIVATE_KEY   — 0x-prefixed 32-byte hex; pre-funded
 *                                with both USDC and ETH on Base Sepolia
 *   VANTA_USDC_ADDRESS         — USDC token on Base Sepolia
 *   VANTA_BASE_SEPOLIA_RPC_URL — public Base Sepolia RPC (NOT the
 *                                local anvil-base, which doesn't host
 *                                the deployed LpVault at 0xD9AFC3…)
 *   LP_VAULT_ADDRESS           — already in the runtime config
 *
 * On first call the module checks USDC allowance and runs an
 * `approve(LpVault, MAX_UINT256)` if needed; subsequent calls skip it.
 *
 * All network failures are *non-fatal* — they fall through to demo
 * mode so the visible-layer demo never stalls on transient RPC errors.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const ERC20_ABI = [
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
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const LP_VAULT_DEPOSIT_ABI = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "assets", type: "uint256" },
      { name: "receiver", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

const MAX_UINT256 =
  0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffn;

export interface LenderDepositResult {
  readonly mode: "real" | "demo";
  readonly txHash?: string;
  readonly error?: string;
}

export interface LenderDepositOpts {
  /** USD whole-dollar amount (positive = deposit). 6-dec wei conversion is handled here. */
  readonly amountUsd: number;
  /** LpVault address from runtime config; injected so we don't re-read env. */
  readonly lpVaultAddress: Address;
}

let approved = false;

export async function tryRealLenderDeposit(
  opts: LenderDepositOpts,
): Promise<LenderDepositResult> {
  const pk = process.env["VANTA_LENDER_PRIVATE_KEY"];
  const usdc = process.env["VANTA_USDC_ADDRESS"];
  const rpc = process.env["VANTA_BASE_SEPOLIA_RPC_URL"];
  if (!pk || !usdc || !rpc) {
    return { mode: "demo" };
  }
  if (opts.amountUsd <= 0) {
    return { mode: "demo" }; // redemptions/zero stay demo-only for now
  }

  try {
    const account = privateKeyToAccount(pk as Hex);
    const wallet = createWalletClient({
      account,
      chain: baseSepolia,
      transport: http(rpc),
    });
    const pub = createPublicClient({
      chain: baseSepolia,
      transport: http(rpc),
    });

    const amountRaw = BigInt(opts.amountUsd) * 1_000_000n;
    const usdcAddr = usdc as Address;

    if (!approved) {
      const allowance = (await pub.readContract({
        address: usdcAddr,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [account.address, opts.lpVaultAddress],
      })) as bigint;
      if (allowance < amountRaw) {
        const approveTx = await wallet.writeContract({
          address: usdcAddr,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [opts.lpVaultAddress, MAX_UINT256],
        });
        await pub.waitForTransactionReceipt({ hash: approveTx });
      }
      approved = true;
    }

    const txHash = await wallet.writeContract({
      address: opts.lpVaultAddress,
      abi: LP_VAULT_DEPOSIT_ABI,
      functionName: "deposit",
      args: [amountRaw, account.address],
    });
    await pub.waitForTransactionReceipt({ hash: txHash });
    return { mode: "real", txHash };
  } catch (err: unknown) {
    return {
      mode: "demo",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
