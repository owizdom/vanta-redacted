import { parseAbi, type Address } from "viem";
import { base, baseSepolia } from "wagmi/chains";

/**
 * Static contract addresses + minimal viable ABIs for the deposit /
 * withdraw flow. AgentPoolVault is per-agent (one deployment per
 * VANTA) so its address arrives via /api/agents/:id; only the ABI
 * is shared here.
 *
 * Chain selection: VITE_CHAIN_ENV=mainnet → Base mainnet (8453);
 * anything else → Base Sepolia (84532). Production Vercel build
 * sets VITE_CHAIN_ENV=mainnet.
 */

const IS_MAINNET = import.meta.env.VITE_CHAIN_ENV === "mainnet";

export const CHAIN_ID = IS_MAINNET ? base.id : baseSepolia.id;

export const USDC_ADDRESS: Address = IS_MAINNET
  ? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
  : "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

/** Standard ERC-20 subset used by approve/balanceOf/allowance flows. */
export const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 value) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

/**
 * AgentPoolVault — ERC-4626 share token over USDC. Subset matching
 * the contract at contracts/src/AgentPoolVault.sol. We don't write
 * agent-only methods here (open/closePosition); those are runtime-
 * only.
 */
export const AGENT_POOL_VAULT_ABI = parseAbi([
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function maxDeposit(address) view returns (uint256)",
  "function maxWithdraw(address owner) view returns (uint256)",
  "function previewDeposit(uint256 assets) view returns (uint256)",
  "function previewWithdraw(uint256 assets) view returns (uint256)",
  "function convertToShares(uint256 assets) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function withdraw(uint256 assets, address receiver, address owner) returns (uint256)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
]);

/** Block explorer URL for a tx hash on the configured chain. */
export function explorerTxUrl(txHash: string): string {
  const host = IS_MAINNET ? "basescan.org" : "sepolia.basescan.org";
  return `https://${host}/tx/${txHash}`;
}

/** Convert a string like "5.0" → 5_000_000n (6-decimal USDC wei). */
export function parseUsdcInput(input: string): bigint | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  if (!/^\d+(\.\d{0,6})?$/.test(trimmed)) return null;
  const [whole = "0", frac = ""] = trimmed.split(".");
  const padded = (frac + "000000").slice(0, 6);
  try {
    return BigInt(whole) * 1_000_000n + BigInt(padded);
  } catch {
    return null;
  }
}

/** Pretty-print 6-decimal USDC wei into a "$1.234" / "$0.50" string. */
export function formatUsdcRaw(raw: bigint, decimals = 2): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const whole = abs / 1_000_000n;
  const frac = Number(abs % 1_000_000n) / 1_000_000;
  const display = (Number(whole) + frac).toFixed(decimals);
  return negative ? `-$${display}` : `$${display}`;
}
