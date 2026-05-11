/**
 * Polymarket Relayer client — moves CTF tokens out of the user's
 * Polymarket-managed wallet via Polymarket's gasless relayer
 * (`relayer-v2.polymarket.com`).
 *
 * Polymarket has two distinct wallet generations on Polygon:
 *   - Old "Proxy" wallets (PolyProxyFactory CREATE2) — personal_sign
 *     of a `keccak256("rlx:" || ...)` struct hash, type="PROXY".
 *   - New "DepositWallet" wallets (used since pUSD migration) —
 *     EIP-712 signed Batch struct, type="WALLET". Implementation
 *     master copy is `0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB`.
 *
 * This file implements the **DepositWallet** path because that's the
 * wallet type the current Polymarket UI provisions (verified
 * empirically against user EOA 0xE3F2…29B → wallet 0x38d6…3783b).
 * If we later need to support legacy Proxy wallets we'd branch on
 * which factory derives to the user's actual wallet address.
 *
 * CORS: relayer-v2.polymarket.com replies with
 * `access-control-allow-origin: https://vanta-app.vercel.app` for our
 * origin so direct browser calls work — no serverless proxy.
 */

import {
  encodeFunctionData,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import {
  deriveDepositWallet,
  TransactionType,
  type NoncePayload,
} from "@polymarket/builder-relayer-client";

import { builderHeaders, type ApiCreds } from "./polymarket-auth";

const RELAYER_BASE = "https://relayer-v2.polymarket.com";

// Polygon mainnet (chain 137) Polymarket DepositWallet contracts.
// Mirrored from `@polymarket/builder-relayer-client` config so we can
// derive + sign without instantiating the SDK's RelayClient.
const DEPOSIT_WALLET_FACTORY: Address =
  "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07";
const DEPOSIT_WALLET_IMPLEMENTATION: Address =
  "0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB";

const DEPOSIT_WALLET_DOMAIN = {
  name: "DepositWallet",
  version: "1",
} as const;

// EIP-712 typed-data structure used by the DepositWallet contract.
// Domain has {chainId, verifyingContract} filled in per-request.
const DEPOSIT_WALLET_TYPES = {
  Call: [
    { name: "target", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
  ],
  Batch: [
    { name: "wallet", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "calls", type: "Call[]" },
  ],
} as const;

/**
 * Compute the Polymarket DepositWallet address for an EOA. Matches
 * the SDK's `deriveDepositWallet` (Solady-style ERC-1967 minimal
 * proxy with deterministic CREATE2 salt). No on-chain call needed.
 */
export function deriveUserWallet(eoa: Address): Address {
  return deriveDepositWallet(
    eoa,
    DEPOSIT_WALLET_FACTORY,
    DEPOSIT_WALLET_IMPLEMENTATION,
  ) as Address;
}

/**
 * Auth strategy — either the user pasted a long-lived Polymarket
 * Relayer API Key (simpler, `RELAYER_API_KEY` headers), OR they
 * signed an L1 auth message that gave us short-lived CLOB-style
 * credentials we HMAC per request (`POLY_BUILDER_*`). The relayer
 * accepts both; we pick whichever's available.
 */
export type RelayerAuth =
  | { readonly mode: "relayer-key"; readonly apiKey: string; readonly eoa: Address }
  | { readonly mode: "builder"; readonly creds: ApiCreds; readonly eoa: Address };

async function authForRequest(
  auth: RelayerAuth,
  method: "GET" | "POST",
  path: string,
  body?: string,
): Promise<Record<string, string>> {
  if (auth.mode === "relayer-key") {
    return {
      "Content-Type": "application/json",
      RELAYER_API_KEY: auth.apiKey,
      RELAYER_API_KEY_ADDRESS: auth.eoa,
    };
  }
  const bh = await builderHeaders({ creds: auth.creds, method, path, body });
  return {
    "Content-Type": "application/json",
    ...bh,
  };
}

/**
 * Fetch the next nonce for this EOA's DepositWallet. The relayer
 * tracks nonces server-side because Polymarket's wallet contracts
 * gate by-signature with replay protection.
 */
async function getWalletNonce(auth: RelayerAuth): Promise<NoncePayload> {
  const path = `/nonce?address=${auth.eoa}&type=${TransactionType.WALLET}`;
  const headers = await authForRequest(auth, "GET", path);
  const res = await fetch(`${RELAYER_BASE}${path}`, { headers });
  if (!res.ok) {
    throw new Error(
      `nonce ${String(res.status)}: ${(await res.text()).slice(0, 200)}`,
    );
  }
  return (await res.json()) as NoncePayload;
}

interface DepositWalletCall {
  readonly target: string;
  readonly value: string;
  readonly data: string;
}

interface SubmitRequest {
  readonly type: "WALLET";
  readonly from: Address;
  readonly to: Address;
  readonly nonce: string;
  readonly signature: Hex;
  readonly depositWalletParams: {
    readonly depositWallet: Address;
    readonly deadline: string;
    readonly calls: readonly DepositWalletCall[];
  };
}

interface SubmitResponse {
  readonly transactionID: string;
  readonly state: string;
}

interface TransactionDetail {
  readonly transactionID: string;
  readonly transactionHash?: string;
  readonly state: string;
}

const CTF_TRANSFER_ABI = parseAbi([
  "function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes data)",
]);

export interface RelayedTransferArgs {
  readonly auth: RelayerAuth;
  /** User's connected EOA — owns the DepositWallet, signs the EIP-712 Batch. */
  readonly eoa: Address;
  /** Polymarket DepositWallet holding the CTF tokens. */
  readonly wallet: Address;
  readonly ctfAddress: Address;
  readonly tokenId: bigint;
  readonly amount: bigint;
  readonly recipient: Address;
  readonly chainId: number;
  /**
   * EIP-712 typed-data signer. Browser callers wire wagmi's
   * `signTypedDataAsync` here; the SDK uses ethers-style
   * `signTypedData(domain, types, message, primaryType)`.
   */
  readonly signTypedData: (args: {
    readonly domain: {
      readonly name: string;
      readonly version: string;
      readonly chainId: number;
      readonly verifyingContract: Address;
    };
    readonly types: typeof DEPOSIT_WALLET_TYPES;
    readonly primaryType: "Batch";
    readonly message: {
      readonly wallet: Address;
      readonly nonce: bigint;
      readonly deadline: bigint;
      readonly calls: ReadonlyArray<{
        readonly target: Address;
        readonly value: bigint;
        readonly data: Hex;
      }>;
    };
  }) => Promise<Hex>;
  /** Seconds the relayer has to submit this batch before the
   *  on-chain signature check rejects it. Default 30 min. */
  readonly deadlineSeconds?: number;
}

/**
 * Sign + submit a CTF.safeTransferFrom from the user's DepositWallet
 * through Polymarket's relayer. Returns the relayer's
 * `transactionID`; caller polls {@link pollRelayerTx} for the
 * eventual on-chain transactionHash.
 *
 * The DepositWallet flow is:
 *   1. GET /nonce → server-side nonce for this wallet
 *   2. Build calls = [{target: CTF, value: 0, data: safeTransferFrom(...)}]
 *   3. Build EIP-712 Batch{wallet, nonce, deadline, calls}
 *   4. User signs the typed data with their EOA
 *   5. POST /submit type=WALLET with depositWalletParams
 *   6. DepositWallet contract verifies sig + executes calls
 */
export async function submitWalletCtfTransfer(
  args: RelayedTransferArgs,
): Promise<string> {
  const inner = encodeFunctionData({
    abi: CTF_TRANSFER_ABI,
    functionName: "safeTransferFrom",
    args: [args.wallet, args.recipient, args.tokenId, args.amount, "0x"],
  });

  const calls = [
    {
      target: args.ctfAddress,
      value: 0n,
      data: inner,
    },
  ];

  const noncePayload = await getWalletNonce(args.auth);
  const deadline =
    BigInt(Math.floor(Date.now() / 1000)) +
    BigInt(args.deadlineSeconds ?? 1_800);

  const signature = await args.signTypedData({
    domain: {
      name: DEPOSIT_WALLET_DOMAIN.name,
      version: DEPOSIT_WALLET_DOMAIN.version,
      chainId: args.chainId,
      verifyingContract: args.wallet,
    },
    types: DEPOSIT_WALLET_TYPES,
    primaryType: "Batch",
    message: {
      wallet: args.wallet,
      nonce: BigInt(noncePayload.nonce),
      deadline,
      calls,
    },
  });

  const body: SubmitRequest = {
    type: "WALLET",
    from: args.eoa,
    to: DEPOSIT_WALLET_FACTORY,
    nonce: noncePayload.nonce,
    signature,
    depositWalletParams: {
      depositWallet: args.wallet,
      deadline: deadline.toString(),
      calls: calls.map((c) => ({
        target: c.target,
        value: c.value.toString(),
        data: c.data,
      })),
    },
  };

  const bodyJson = JSON.stringify(body);
  const submitHeaders = await authForRequest(args.auth, "POST", "/submit", bodyJson);
  const res = await fetch(`${RELAYER_BASE}/submit`, {
    method: "POST",
    headers: submitHeaders,
    body: bodyJson,
  });
  if (!res.ok) {
    throw new Error(
      `relayer submit ${String(res.status)}: ${(await res.text()).slice(0, 300)}`,
    );
  }
  const out = (await res.json()) as SubmitResponse;
  return out.transactionID;
}

/**
 * Poll the relayer until the queued tx hits a terminal state. Returns
 * the on-chain transactionHash on success, throws on failure / timeout.
 */
export async function pollRelayerTx(args: {
  readonly auth: RelayerAuth;
  readonly transactionId: string;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
}): Promise<Hex> {
  const timeoutMs = args.timeoutMs ?? 120_000;
  const intervalMs = args.intervalMs ?? 2_500;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const path = `/transaction?id=${args.transactionId}`;
    const headers = await authForRequest(args.auth, "GET", path);
    const res = await fetch(`${RELAYER_BASE}${path}`, { headers });
    if (res.ok) {
      const body = (await res.json()) as TransactionDetail | TransactionDetail[];
      const detail = Array.isArray(body) ? body[0] : body;
      if (detail !== undefined) {
        if (detail.state === "STATE_FAILED" || detail.state === "STATE_INVALID") {
          throw new Error(`relayer tx ${detail.state} (${args.transactionId})`);
        }
        if (
          (detail.state === "STATE_MINED" || detail.state === "STATE_CONFIRMED") &&
          detail.transactionHash !== undefined &&
          detail.transactionHash.length > 2
        ) {
          return detail.transactionHash as Hex;
        }
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `relayer tx ${args.transactionId} timed out after ${String(timeoutMs)}ms`,
  );
}
