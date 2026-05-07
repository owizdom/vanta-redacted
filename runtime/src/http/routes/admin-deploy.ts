/**
 * /api/admin/deploy        — POST hex bytecode, runtime signs+broadcasts a
 *                             contract creation tx using the in-TEE admin
 *                             wallet, returns { txHash, contractAddress }.
 * /api/admin/send-tx       — POST { to, data, value? }, runtime signs+broadcasts
 *                             a non-deploy tx (used for the LpVault.proposeLoanBook
 *                             + LoanBook.acceptLpVaultWiring handshake).
 *
 * Both gated behind `VANTA_DEPLOY_ADMIN_ENABLED=1`. **MUST** flip back to 0
 * after the initial deploy is complete — leaving these routes on lets anyone
 * with network access broadcast txs from the admin EOA on Base mainnet.
 *
 * Why this exists: the admin private key is HKDF-derived inside the TEE from
 * /vanta-data/.seed and never leaves the enclave. Foundry's `forge script
 * --broadcast` runs on an operator machine that doesn't have the key, so we
 * can't sign deploy txs externally. This route lets the runtime do the signing
 * itself for one-shot contract creation, preserving the "key never leaves TEE"
 * property.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Hex,
  type WalletClient,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Allowlist of supported chains for cross-chain deploys. Restricts the
// route from sending requests to arbitrary RPCs.
const SUPPORTED_CHAINS: Record<number, { name: string; defaultRpc: string }> = {
  8453: { name: "base-mainnet", defaultRpc: "https://mainnet.base.org" },
  84532: { name: "base-sepolia", defaultRpc: "https://sepolia.base.org" },
  137: { name: "polygon-mainnet", defaultRpc: "https://polygon-rpc.com" },
  80002: { name: "polygon-amoy", defaultRpc: "https://rpc-amoy.polygon.technology" },
};

const ChainOverride = z
  .object({
    chainId: z.number().int().refine((n) => n in SUPPORTED_CHAINS, {
      message: "unsupported chainId",
    }),
    rpcUrl: z.string().url().optional(),
  })
  .strict();

const DeployBody = z
  .object({
    bytecode: z.string().regex(/^0x[0-9a-fA-F]+$/, "must be 0x-prefixed hex"),
    value: z.string().regex(/^\d+$/).optional(),
    gasLimit: z.string().regex(/^\d+$/).optional(),
    chain: ChainOverride.optional(),
  })
  .strict();

const SendTxBody = z
  .object({
    to: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20-byte hex address"),
    data: z.string().regex(/^0x[0-9a-fA-F]*$/, "must be 0x-prefixed hex"),
    value: z.string().regex(/^\d+$/).optional(),
    gasLimit: z.string().regex(/^\d+$/).optional(),
    chain: ChainOverride.optional(),
  })
  .strict();

export interface AdminDeployOpts {
  readonly enabled: boolean;
  /** Required when enabled. Constant-time-compared against `X-Admin-Token`
   *  header on every request. Set via VANTA_DEPLOY_ADMIN_TOKEN env. */
  readonly token: string;
  /** Default wallet/public clients (bound to LOAN_BOOK_RPC_URL +
   *  LOAN_BOOK_CHAIN_ID). Used when the request body omits `chain`. */
  readonly walletClient: WalletClient;
  readonly publicClient: PublicClient;
  /** Admin private key. When request body supplies a `chain` override,
   *  we construct an ad-hoc wallet client on that chain using this key
   *  so the runtime can deploy on any supported chain (Polygon mainnet
   *  for VantaVault, etc) from the same TEE-derived admin EOA. */
  readonly adminPrivateKey: Hex;
}

interface ChainClients {
  readonly walletClient: WalletClient;
  readonly publicClient: PublicClient;
}

function buildClientsForChain(
  override: z.infer<typeof ChainOverride>,
  privateKey: Hex,
): ChainClients {
  const meta = SUPPORTED_CHAINS[override.chainId]!;
  const rpc = override.rpcUrl ?? meta.defaultRpc;
  const chain = defineChain({
    id: override.chainId,
    name: meta.name,
    nativeCurrency: { decimals: 18, name: "Native", symbol: override.chainId === 137 || override.chainId === 80002 ? "MATIC" : "ETH" },
    rpcUrls: { default: { http: [rpc] } },
  });
  const transport = http(rpc);
  const account = privateKeyToAccount(privateKey);
  const walletClient = createWalletClient({ account, chain, transport });
  const publicClient = createPublicClient({ chain, transport });
  return { walletClient, publicClient };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export async function registerAdminDeployRoutes(
  app: FastifyInstance,
  opts: AdminDeployOpts,
): Promise<void> {
  const guard = (
    req: { headers: Record<string, string | string[] | undefined> },
    reply: { code: (c: number) => unknown },
  ) => {
    if (!opts.enabled) {
      void reply.code(404);
      return { error: "not_found" };
    }
    if (opts.token.length < 32) {
      void reply.code(503);
      return { error: "admin_token_unset_or_weak" };
    }
    const header = req.headers["x-admin-token"];
    const supplied = typeof header === "string" ? header : "";
    if (!timingSafeEqual(supplied, opts.token)) {
      void reply.code(401);
      return { error: "unauthorized" };
    }
    return null;
  };

  app.post("/api/admin/deploy", async (req, reply) => {
    const denied = guard(req, reply);
    if (denied !== null) return denied;

    const parsed = DeployBody.safeParse(req.body);
    if (!parsed.success) {
      void reply.code(400);
      return { error: "invalid_body", issues: parsed.error.issues };
    }

    const { bytecode, value, gasLimit, chain: chainOverride } = parsed.data;
    const { walletClient, publicClient } =
      chainOverride === undefined
        ? { walletClient: opts.walletClient, publicClient: opts.publicClient }
        : buildClientsForChain(chainOverride, opts.adminPrivateKey);
    const account = walletClient.account;
    if (account === undefined) {
      void reply.code(500);
      return { error: "wallet_account_unset" };
    }

    try {
      const txHash = await walletClient.sendTransaction({
        account,
        chain: walletClient.chain ?? null,
        to: null,
        data: bytecode as Hex,
        value: value === undefined ? 0n : BigInt(value),
        gas: gasLimit === undefined ? undefined : BigInt(gasLimit),
      } as Parameters<WalletClient["sendTransaction"]>[0]);

      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") {
        void reply.code(500);
        return { error: "tx_reverted", txHash, receipt: { status: receipt.status } };
      }
      return {
        ok: true,
        txHash,
        contractAddress: receipt.contractAddress,
        gasUsed: receipt.gasUsed.toString(),
        blockNumber: receipt.blockNumber.toString(),
        chainId: walletClient.chain?.id,
      };
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      void reply.code(500);
      return { error: "broadcast_failed", detail: e.message };
    }
  });

  app.post("/api/admin/send-tx", async (req, reply) => {
    const denied = guard(req, reply);
    if (denied !== null) return denied;

    const parsed = SendTxBody.safeParse(req.body);
    if (!parsed.success) {
      void reply.code(400);
      return { error: "invalid_body", issues: parsed.error.issues };
    }

    const { to, data, value, gasLimit, chain: chainOverride } = parsed.data;
    const { walletClient, publicClient } =
      chainOverride === undefined
        ? { walletClient: opts.walletClient, publicClient: opts.publicClient }
        : buildClientsForChain(chainOverride, opts.adminPrivateKey);
    const account = walletClient.account;
    if (account === undefined) {
      void reply.code(500);
      return { error: "wallet_account_unset" };
    }

    try {
      const txHash = await walletClient.sendTransaction({
        account,
        chain: walletClient.chain ?? null,
        to: to as Hex,
        data: data as Hex,
        value: value === undefined ? 0n : BigInt(value),
        gas: gasLimit === undefined ? undefined : BigInt(gasLimit),
      } as Parameters<WalletClient["sendTransaction"]>[0]);

      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") {
        void reply.code(500);
        return { error: "tx_reverted", txHash };
      }
      return {
        ok: true,
        txHash,
        gasUsed: receipt.gasUsed.toString(),
        blockNumber: receipt.blockNumber.toString(),
      };
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      void reply.code(500);
      return { error: "broadcast_failed", detail: e.message };
    }
  });

  app.get("/api/admin/deploy/info", async (req, reply) => {
    const denied = guard(req, reply);
    if (denied !== null) return denied;
    const account = opts.walletClient.account;
    return {
      enabled: opts.enabled,
      adminAddress: account?.address ?? null,
      chainId: opts.walletClient.chain?.id ?? null,
    };
  });
}
