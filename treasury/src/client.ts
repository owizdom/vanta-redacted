/**
 * viem client builders for Base Sepolia.
 *
 * The treasury holds a single `publicClient` (reads) plus a single
 * `walletClient` (signs; Week 1 dry-run only — Week 3 unlocks broadcast
 * per spec §10 D-TR-1). Both are pinned to chain id 84532.
 *
 * The account is derived by `init.ts` from the HKDF scalar; this module
 * only consumes the resulting `Account` object and never re-materializes
 * the private key.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type Chain,
  type PublicClient,
  type WalletClient,
} from "viem";
import { baseSepolia } from "viem/chains";

import {
  CHAIN_ID,
  DEFAULT_BASE_SEPOLIA_RPC,
  POLLING_INTERVAL_MS,
} from "./constants.js";
import { TreasuryError } from "./errors.js";

const EXPECTED_CHAIN_ID: number = CHAIN_ID;

/**
 * Verify viem's exported `baseSepolia` chain matches our pinned id.
 * viem is a direct dependency, so any drift is a build-time fault we
 * want to catch loudly rather than silently rebind to the wrong chain.
 */
function assertBaseSepoliaChain(chain: Chain): Chain {
  if (chain.id !== EXPECTED_CHAIN_ID) {
    throw new TreasuryError(
      "rpc_unreachable",
      "viem baseSepolia chain id diverged from pinned constant",
      {
        expectedChainId: String(EXPECTED_CHAIN_ID),
        actualChainId: String(chain.id),
      },
    );
  }
  return chain;
}

export interface ChainClients {
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
}

/**
 * Build `publicClient` + `walletClient` pinned to Base Sepolia.
 *
 * `rpcUrl` follows spec §1.1: `InitTreasuryOpts.rpcUrl ?? BASE_SEPOLIA_RPC_URL ?? DEFAULT`.
 * The HTTP transport's `retryCount: 3` covers transient RPC flakiness;
 * persistent failure surfaces as `rpc_unreachable` from the caller.
 */
export function buildChainClients(account: Account, rpcUrl: string): ChainClients {
  const chain = assertBaseSepoliaChain(baseSepolia);
  const transport = http(rpcUrl, {
    retryCount: 3,
    retryDelay: 250,
  });

  const publicClient = createPublicClient({
    chain,
    transport,
    pollingInterval: POLLING_INTERVAL_MS,
  });

  const walletClient = createWalletClient({
    chain,
    transport,
    account,
  });

  return { publicClient, walletClient };
}

/**
 * Resolve the RPC URL in the precedence order declared by the spec.
 * Split out so tests can cover resolution independently of viem.
 */
export function resolveRpcUrl(optRpcUrl: string | undefined): string {
  if (typeof optRpcUrl === "string" && optRpcUrl.length > 0) {
    return optRpcUrl;
  }
  const envUrl = process.env["BASE_SEPOLIA_RPC_URL"];
  if (typeof envUrl === "string" && envUrl.length > 0) {
    return envUrl;
  }
  return DEFAULT_BASE_SEPOLIA_RPC;
}
