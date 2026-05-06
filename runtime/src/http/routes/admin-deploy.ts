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
import type { Hex, WalletClient, PublicClient } from "viem";

const DeployBody = z
  .object({
    bytecode: z.string().regex(/^0x[0-9a-fA-F]+$/, "must be 0x-prefixed hex"),
    value: z.string().regex(/^\d+$/).optional(),
    gasLimit: z.string().regex(/^\d+$/).optional(),
  })
  .strict();

const SendTxBody = z
  .object({
    to: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20-byte hex address"),
    data: z.string().regex(/^0x[0-9a-fA-F]*$/, "must be 0x-prefixed hex"),
    value: z.string().regex(/^\d+$/).optional(),
    gasLimit: z.string().regex(/^\d+$/).optional(),
  })
  .strict();

export interface AdminDeployOpts {
  readonly enabled: boolean;
  /** Required when enabled. Constant-time-compared against `X-Admin-Token`
   *  header on every request. Set via VANTA_DEPLOY_ADMIN_TOKEN env. */
  readonly token: string;
  readonly walletClient: WalletClient;
  readonly publicClient: PublicClient;
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

    const { bytecode, value, gasLimit } = parsed.data;
    const { walletClient, publicClient } = opts;
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

    const { to, data, value, gasLimit } = parsed.data;
    const { walletClient, publicClient } = opts;
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
