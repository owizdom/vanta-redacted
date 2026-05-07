/**
 * `/api/borrower/register` — register a connected wallet as a permitted
 * borrower on the VantaVault contract (Polygon).
 *
 * Why this exists: VantaVault.onERC1155Received gates pledges by
 * `borrowerRegistry[from]` (I-VV-1). A new wallet cannot push CTF tokens
 * into the vault until the admin (the TEE-derived EOA) has called
 * `registerBorrower(wallet)`. This route lets a connected user trigger
 * that registration on demand without going through an off-chain
 * operator.
 *
 * Open route (no admin token). Anti-griefing:
 *   - Refuses unless the wallet actually holds CTF in at least one of
 *     the runtime's watched markets, so we don't burn gas on random
 *     addresses.
 *   - Idempotent: if `borrowerRegistry[wallet]` is already true, we
 *     return early without sending a tx.
 *
 *   POST /api/borrower/register
 *   body: { borrower: "0x..." }
 *   200:  { ok, registered: true,  txHash?, alreadyRegistered: false }
 *         { ok, registered: true,  alreadyRegistered: true }
 *   400:  { error: "no_eligible_balance" | "invalid_borrower" }
 *   503:  { error: "polygon_unavailable" }
 *
 * Once `loan.pledge` events land via the pledge-watcher, the borrower
 * can cite them to /api/origination for a real LoanBook entry on Base.
 */

import type { FastifyInstance } from "fastify";
import {
  createWalletClient,
  defineChain,
  http,
  type Hex,
  type Address,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { MarketsCache } from "../../services/markets-cache.js";

const ETH_ADDR = /^0x[0-9a-fA-F]{40}$/;

const VANTA_VAULT_ABI = [
  {
    type: "function",
    name: "borrowerRegistry",
    stateMutability: "view",
    inputs: [{ name: "proxy", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "registerBorrower",
    stateMutability: "nonpayable",
    inputs: [{ name: "proxy", type: "address" }],
    outputs: [],
  },
] as const;

const ERC1155_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "id", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

export interface BorrowerRouteOpts {
  readonly polygonClient: PublicClient;
  readonly polygonChainId: number;
  readonly polygonRpcUrl: string;
  readonly vantaVaultAddress: Address;
  readonly polymarketCtfAddress: Address;
  readonly adminPrivateKey: Hex;
  readonly marketsCache: MarketsCache;
}

export async function registerBorrowerRoute(
  app: FastifyInstance,
  opts: BorrowerRouteOpts,
): Promise<void> {
  const polygonChain = defineChain({
    id: opts.polygonChainId,
    name: opts.polygonChainId === 137 ? "polygon-mainnet" : "polygon-amoy",
    nativeCurrency: { name: "MATIC", symbol: "MATIC", decimals: 18 },
    rpcUrls: { default: { http: [opts.polygonRpcUrl] } },
  });
  const adminAccount = privateKeyToAccount(opts.adminPrivateKey);
  const walletClient = createWalletClient({
    account: adminAccount,
    chain: polygonChain,
    transport: http(opts.polygonRpcUrl),
  });

  app.post("/api/borrower/register", async (req, reply) => {
    const body = req.body as Record<string, unknown> | null;
    if (body === null || typeof body !== "object") {
      reply.status(400);
      return { error: "missing_body" };
    }
    const borrower = String(body["borrower"] ?? "");
    if (!ETH_ADDR.test(borrower)) {
      reply.status(400);
      return { error: "invalid_borrower" };
    }
    const borrowerAddr = borrower as Address;

    // 1. Already registered? Idempotent fast path — no tx needed.
    let already = false;
    try {
      already = (await opts.polygonClient.readContract({
        address: opts.vantaVaultAddress,
        abi: VANTA_VAULT_ABI,
        functionName: "borrowerRegistry",
        args: [borrowerAddr],
      })) as boolean;
    } catch (err) {
      reply.status(503);
      return {
        error: "polygon_unavailable",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    if (already) {
      return { ok: true, registered: true, alreadyRegistered: true };
    }

    // 2. Anti-griefing: require the borrower to actually hold CTF in
    //    at least one watched market. Multi-call in parallel; the first
    //    non-zero balance wins.
    const watched = opts.marketsCache.snapshotAll();
    const tokenIds: bigint[] = [];
    for (const m of watched) {
      for (const t of m.tokens) {
        try {
          tokenIds.push(BigInt(t.tokenId));
        } catch {
          /* skip malformed */
        }
      }
    }
    if (tokenIds.length === 0) {
      reply.status(503);
      return { error: "no_watched_markets" };
    }

    const balances = await Promise.all(
      tokenIds.map((id) =>
        opts.polygonClient
          .readContract({
            address: opts.polymarketCtfAddress,
            abi: ERC1155_ABI,
            functionName: "balanceOf",
            args: [borrowerAddr, id],
          })
          .catch(() => 0n),
      ),
    );
    const hasBalance = balances.some((b) => (b as bigint) > 0n);
    if (!hasBalance) {
      reply.status(400);
      return {
        error: "no_eligible_balance",
        detail:
          "Borrower wallet does not hold any Polymarket CTF tokens in the runtime's watched markets.",
      };
    }

    // 3. Send registerBorrower(borrower) on Polygon from TEE admin EOA.
    let txHash: `0x${string}`;
    try {
      txHash = await walletClient.writeContract({
        address: opts.vantaVaultAddress,
        abi: VANTA_VAULT_ABI,
        functionName: "registerBorrower",
        args: [borrowerAddr],
        account: adminAccount,
        chain: polygonChain,
      });
    } catch (err) {
      app.log.error(
        { err: err instanceof Error ? err.message : String(err), borrower },
        "register_borrower_failed",
      );
      reply.status(502);
      return {
        error: "register_tx_failed",
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    app.log.info(
      { borrower, txHash, vault: opts.vantaVaultAddress },
      "borrower_registered",
    );
    return {
      ok: true,
      registered: true,
      alreadyRegistered: false,
      txHash,
    };
  });

  // GET helper so the frontend can query status without sending a tx.
  app.get<{ Querystring: { borrower?: string } }>(
    "/api/borrower/status",
    async (req, reply) => {
      const borrower = String(req.query.borrower ?? "");
      if (!ETH_ADDR.test(borrower)) {
        reply.status(400);
        return { error: "invalid_borrower" };
      }
      try {
        const registered = (await opts.polygonClient.readContract({
          address: opts.vantaVaultAddress,
          abi: VANTA_VAULT_ABI,
          functionName: "borrowerRegistry",
          args: [borrower as Address],
        })) as boolean;
        return { ok: true, borrower, registered };
      } catch (err) {
        reply.status(503);
        return {
          error: "polygon_unavailable",
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );
}
