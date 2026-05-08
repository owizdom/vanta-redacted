/**
 * VANTA X402 metering — Fastify plugin.
 *
 * Implements the EigenCloud "Service Agent" affordance: arbitrary
 * agents/people can curl a metered VANTA endpoint, get a 402 with an
 * EIP-3009 challenge, sign a USDC `transferWithAuthorization` payload,
 * retry with `X-PAYMENT`, and receive the resource. Settlement happens
 * server-side on Base Sepolia using vanta-agent-treasury-v1 as the
 * receiver and the runtime's wallet (gas-payer) as the relayer.
 *
 * Spec: https://github.com/coinbase/x402 (`exact` scheme, EIP-3009 USDC).
 *
 * Internal callers (the Mineflayer bridge plugin, the wizard's own
 * agent loop, the population bots) skip metering by sending the
 * `X-Vanta-Internal` header with a value matching VANTA_INTERNAL_SECRET.
 * That keeps the existing dev/Docker-compose flow unchanged.
 *
 * On a successful settlement the plugin appends a signed
 * `treasury.inflow` event to the log so the "everything is signed"
 * invariant (paper §3 I2) holds.
 *
 * The plugin can be disabled wholesale with X402_ENABLED=false; routes
 * pass through unmetered, suitable for local development without a
 * funded payer wallet.
 */

import {
  decodeAbiParameters,
  parseAbiParameters,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";

const USDC_TRANSFER_WITH_AUTH_ABI = [
  {
    type: "function",
    name: "transferWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "authorizationState",
    stateMutability: "view",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

/** EIP-3009 TransferWithAuthorization typed-data type definition. */
const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface X402RouteConfig {
  /** Match the request's routerPath (e.g. "/bridge/wizard/quote"). */
  readonly path: string;
  /** Method to gate; "*" matches any. */
  readonly method?: "GET" | "POST" | "*";
  /** USDC 6-decimal price in wei (e.g. 50_000n = 0.05 USDC). */
  readonly priceUsdc6: bigint;
  /** Human-readable description for the discovery doc. */
  readonly description: string;
  /** Resource URI advertised in the 402 challenge. */
  readonly resource?: string;
}

export interface X402PluginOpts {
  /** When false, the preHandler is a no-op — local dev. */
  readonly enabled: boolean;
  readonly routes: readonly X402RouteConfig[];
  /** Treasury address — receiver of the payment. */
  readonly receiver: Address;
  /** USDC token on the configured chain (Base mainnet 0x8335…2913). */
  readonly usdcAddress: Address;
  /** Network label for the challenge body. Coinbase X402 spec strings:
   *  `"base"` for Base mainnet, `"base-sepolia"` for testnet. */
  readonly network: "base" | "base-sepolia";
  /** Chain id (8453 for base, 84532 for base-sepolia). */
  readonly chainId: number;
  /** USDC EIP-712 domain name + version (USDC v2 → "USDC", "2"). */
  readonly tokenName: string;
  readonly tokenVersion: string;
  /** Wallet client used to relay settlement (pays gas in ETH). */
  readonly walletClient: WalletClient;
  readonly publicClient: PublicClient;
  /** Internal-bypass header secret. Anything matching skips metering. */
  readonly internalSecret: string | null;
  /** How long a challenge stays valid (default 60s). */
  readonly maxTimeoutSeconds?: number;
  /** Hook called after a successful settlement. Used to emit signed events. */
  readonly onSettled?: (info: SettledPayment) => void | Promise<void>;
}

export interface SettledPayment {
  readonly route: X402RouteConfig;
  readonly payer: Address;
  readonly receiver: Address;
  readonly amountUsdc6: bigint;
  readonly txHash: string;
  readonly blockNumber: number;
  readonly nonce: string;
}

interface X402PaymentEnvelope {
  readonly x402Version: number;
  readonly scheme: "exact";
  readonly network: "base" | "base-sepolia";
  readonly payload: {
    readonly signature: Hex;
    readonly authorization: {
      readonly from: Address;
      readonly to: Address;
      readonly value: string;
      readonly validAfter: string;
      readonly validBefore: string;
      readonly nonce: Hex;
    };
  };
}

function challengeBody(opts: X402PluginOpts, cfg: X402RouteConfig, error?: string) {
  return {
    x402Version: 1,
    error: error ?? "X-PAYMENT header missing or invalid",
    accepts: [
      {
        scheme: "exact",
        network: opts.network,
        maxAmountRequired: cfg.priceUsdc6.toString(),
        resource: cfg.resource ?? cfg.path,
        description: cfg.description,
        mimeType: "application/json",
        payTo: opts.receiver,
        maxTimeoutSeconds: opts.maxTimeoutSeconds ?? 60,
        asset: opts.usdcAddress,
        extra: {
          name: opts.tokenName,
          version: opts.tokenVersion,
        },
      },
    ],
  };
}

function parsePaymentHeader(raw: string): X402PaymentEnvelope | null {
  try {
    const json = Buffer.from(raw, "base64").toString("utf8");
    const env = JSON.parse(json) as X402PaymentEnvelope;
    if (env.x402Version !== 1) return null;
    if (env.scheme !== "exact") return null;
    if (env.network !== "base" && env.network !== "base-sepolia") return null;
    const a = env.payload?.authorization;
    if (!a || !a.from || !a.to || !a.value || !a.validBefore || !a.nonce) return null;
    return env;
  } catch {
    return null;
  }
}

interface VerifyResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly recovered?: Address;
}

async function verifyAuthorization(
  env: X402PaymentEnvelope,
  cfg: X402RouteConfig,
  opts: X402PluginOpts,
): Promise<VerifyResult> {
  const a = env.payload.authorization;

  // Recipient must be us; amount must cover the price; auth must not
  // have expired.
  if (a.to.toLowerCase() !== opts.receiver.toLowerCase()) {
    return { ok: false, reason: "wrong_receiver" };
  }
  let valBig: bigint;
  try {
    valBig = BigInt(a.value);
  } catch {
    return { ok: false, reason: "invalid_value" };
  }
  if (valBig < cfg.priceUsdc6) {
    return { ok: false, reason: "insufficient_value" };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  let validBefore: number;
  let validAfter: number;
  try {
    validBefore = Number(BigInt(a.validBefore));
    validAfter = Number(BigInt(a.validAfter));
  } catch {
    return { ok: false, reason: "invalid_validity" };
  }
  if (nowSec >= validBefore) return { ok: false, reason: "expired" };
  if (nowSec < validAfter) return { ok: false, reason: "not_yet_valid" };

  // Recover the signer; must match the `from` field.
  let recovered: Address;
  try {
    recovered = await recoverTypedDataAddress({
      domain: {
        name: opts.tokenName,
        version: opts.tokenVersion,
        chainId: opts.chainId,
        verifyingContract: opts.usdcAddress,
      },
      types: EIP3009_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: a.from,
        to: a.to,
        value: BigInt(a.value),
        validAfter: BigInt(a.validAfter),
        validBefore: BigInt(a.validBefore),
        nonce: a.nonce,
      },
      signature: env.payload.signature,
    });
  } catch (err) {
    return {
      ok: false,
      reason: `signature_recover_failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (recovered.toLowerCase() !== a.from.toLowerCase()) {
    return { ok: false, reason: "signature_mismatch" };
  }

  // Optional: check the nonce hasn't already been used. USDC's
  // authorizationState(authorizer, nonce) returns true iff the nonce is
  // already consumed.
  try {
    const used = (await opts.publicClient.readContract({
      address: opts.usdcAddress,
      abi: USDC_TRANSFER_WITH_AUTH_ABI,
      functionName: "authorizationState",
      args: [a.from, a.nonce],
    })) as boolean;
    if (used) return { ok: false, reason: "nonce_already_used" };
  } catch {
    // Don't fail verification on RPC errors; settlement will catch a
    // duplicate nonce by reverting.
  }

  return { ok: true, recovered };
}

async function settleOnChain(
  env: X402PaymentEnvelope,
  opts: X402PluginOpts,
): Promise<{ txHash: string; blockNumber: number }> {
  const a = env.payload.authorization;
  const account = opts.walletClient.account;
  if (!account) throw new Error("walletClient has no bound account");

  const txHash = await opts.walletClient.writeContract({
    chain: opts.walletClient.chain ?? null,
    account,
    address: opts.usdcAddress,
    abi: USDC_TRANSFER_WITH_AUTH_ABI,
    functionName: "transferWithAuthorization",
    args: [
      a.from,
      a.to,
      BigInt(a.value),
      BigInt(a.validAfter),
      BigInt(a.validBefore),
      a.nonce,
      env.payload.signature,
    ],
  });
  const receipt = await opts.publicClient.waitForTransactionReceipt({ hash: txHash });
  return { txHash, blockNumber: Number(receipt.blockNumber) };
}

/** Encode a settlement-receipt header for the client. The `network`
 *  string follows Coinbase's X402 spec (`"base"` mainnet, `"base-sepolia"`
 *  testnet) and must match the network we settled the EIP-3009 transfer on. */
function encodeSettleResponse(
  info: { txHash: string; blockNumber: number },
  network: "base" | "base-sepolia",
): string {
  const body = {
    x402Version: 1,
    success: true,
    transaction: info.txHash,
    blockNumber: info.blockNumber,
    network,
  };
  return Buffer.from(JSON.stringify(body), "utf8").toString("base64");
}

function isInternalCall(req: FastifyRequest, secret: string | null): boolean {
  if (!secret) return false;
  const v = req.headers["x-vanta-internal"];
  if (Array.isArray(v)) return v.includes(secret);
  return v === secret;
}

function findRouteConfig(
  routes: readonly X402RouteConfig[],
  req: FastifyRequest,
): X402RouteConfig | null {
  const path = (req as unknown as { routeOptions?: { url?: string } }).routeOptions?.url
    ?? (req as unknown as { routerPath?: string }).routerPath;
  if (typeof path !== "string") return null;
  return (
    routes.find(
      (r) =>
        r.path === path && (r.method === undefined || r.method === "*" || r.method === req.method),
    ) ?? null
  );
}

/**
 * Install the X402 hook on the root Fastify instance. Must be called
 * BEFORE the metered routes are registered — Fastify hooks only apply
 * to routes registered after the hook is added at the same scope.
 */
export function installX402Hook(fastify: FastifyInstance, opts: X402PluginOpts): void {
  if (!opts.enabled) {
    fastify.log.info({ msg: "x402_disabled" });
    return;
  }
  fastify.log.info({
    msg: "x402_enabled",
    routes: opts.routes.map((r) => ({ path: r.path, price: r.priceUsdc6.toString() })),
    receiver: opts.receiver,
  });

  fastify.addHook("preHandler", async (req, reply) => {
    const cfg = findRouteConfig(opts.routes, req);
    if (!cfg) return;

    if (isInternalCall(req, opts.internalSecret)) return;

    const xpay = req.headers["x-payment"];
    if (typeof xpay !== "string" || xpay.length === 0) {
      reply.status(402);
      return reply.send(challengeBody(opts, cfg));
    }

    const env = parsePaymentHeader(xpay);
    if (!env) {
      reply.status(402);
      return reply.send(challengeBody(opts, cfg, "X-PAYMENT decode failed"));
    }

    const verify = await verifyAuthorization(env, cfg, opts);
    if (!verify.ok) {
      reply.status(402);
      return reply.send(challengeBody(opts, cfg, `verify_failed:${verify.reason}`));
    }

    let settled: { txHash: string; blockNumber: number };
    try {
      settled = await settleOnChain(env, opts);
    } catch (err: unknown) {
      reply.status(402);
      return reply.send(
        challengeBody(
          opts,
          cfg,
          `settlement_failed:${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }

    reply.header("X-PAYMENT-RESPONSE", encodeSettleResponse(settled, opts.network));
    if (opts.onSettled) {
      try {
        await opts.onSettled({
          route: cfg,
          payer: env.payload.authorization.from,
          receiver: opts.receiver,
          amountUsdc6: BigInt(env.payload.authorization.value),
          txHash: settled.txHash,
          blockNumber: settled.blockNumber,
          nonce: env.payload.authorization.nonce,
        });
      } catch (err) {
        fastify.log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "x402_onsettled_failed",
        );
      }
    }
    // fall through to the route handler
  });
}

/** Helper for the test client + the discovery doc. */
export function createNonceHex(): Hex {
  return `0x${randomBytes(32).toString("hex")}` as Hex;
}

/** Decode a settlement receipt the client receives back. */
export function decodeSettleResponse(b64: string): {
  readonly success: boolean;
  readonly transaction?: string;
  readonly blockNumber?: number;
} {
  try {
    const json = Buffer.from(b64, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return { success: false };
  }
}

// Re-export ABI fragment so the test client can encode/decode the same
// thing the server does without needing its own copy.
export { USDC_TRANSFER_WITH_AUTH_ABI, EIP3009_TYPES };

// Suppress unused-import lint warnings — both are exported above for
// downstream consumers that want to encode/decode bytes themselves.
void decodeAbiParameters;
void parseAbiParameters;
