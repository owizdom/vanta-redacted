/**
 * `initTreasury` — HKDF → secp256k1 scalar → viem Account → chain clients.
 *
 * Boot-time, once per process. Idempotent at the hard-fail boundary:
 * second call throws `treasury_already_initialized` (spec §1.1).
 *
 * Position in boot sequence (spec §8): called by `initTEE` between step 5
 * (construct TeeState) and step 6 (post-boot MNEMONIC cleanup), while the
 * IKM cache is still populated. `initTreasury` is the ONLY HKDF-touching
 * file in this module.
 *
 * Scalar derivation contract (spec §5):
 *   step 1: deriveKey({salt: AGENT_TREASURY, info: AGENT_TREASURY}) → Buffer
 *   step 2: scalar = BigInt(0x + hex); reject 0 or >= n; zero buffer before throw
 *   step 3: pkHex = hex(buffer); account = privateKeyToAccount(pkHex)
 *   step 4: buf.fill(0) — viem has its own copy; our Buffer is now zero
 *   step 5: address = account.address (public, deterministic, loggable)
 *
 * HKDF label misnomer (spec §5 "Label misnomer" + D-TR-5):
 *   `HKDF_INFO.AGENT_TREASURY === "vanta/agent-treasury/v1/ed25519-seed"`
 *   yet we consume the bytes as a secp256k1 scalar. The @vanta/tee
 *   surface is frozen. We do
 *   NOT change the label here.
 */

import { Buffer } from "node:buffer";

import {
  deriveKey,
  HKDF_INFO,
  HKDF_SALT,
  type EthAddressHex,
} from "@vanta/tee";
import { privateKeyToAccount } from "viem/accounts";
import type { Account } from "viem";

import {
  CHAIN_ID,
  CONFIRMATION_BLOCKS,
  USDC_BASE_SEPOLIA,
} from "./constants.js";
import { TreasuryError } from "./errors.js";
import {
  buildChainClients,
  resolveRpcUrl,
  type ChainClients,
} from "./client.js";
import {
  createInflowLedger,
  formatUsdc,
  type InflowLedger,
} from "./ledger.js";
import { usdcAbi } from "./usdc.js";
import type {
  InitTreasuryOpts,
  TreasuryState,
} from "./types.js";

/**
 * secp256k1 group order. Any HKDF output interpreted as uint256 must
 * be in the open interval (0, n). Probability of hit outside this range
 * is ~2^-128; a real observation is a config bug (spec §5).
 */
const SECP256K1_N: bigint =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/**
 * Module-scope singleton. `initTreasury` sets it once. Downstream
 * accessors (`getTreasuryAddress`, `getTreasuryState`,
 * `buildOutflowTx` via its `planWithState` helper) read from it.
 *
 * We deliberately hold only the viem `Account` + its address + chain
 * clients + ledger. The raw 32-byte scalar Buffer is zeroed and dropped
 * inside `initTreasury` before return.
 */
export interface TreasuryBindings {
  readonly address: EthAddressHex;
  readonly account: Account;
  readonly clients: ChainClients;
  readonly ledger: InflowLedger;
}

let bindings: TreasuryBindings | null = null;

/**
 * Public entry point. Returns the viem-typed `TreasuryState` snapshot
 * via `getTreasuryState()` — `initTreasury` itself does not perform
 * RPC reads. That keeps the boot-critical path dependency-free of
 * network latency and isolates the "address is deterministic" invariant
 * (I-TR-5).
 */
export async function initTreasury(
  opts: InitTreasuryOpts = {},
): Promise<TreasuryBindings> {
  if (bindings !== null) {
    throw new TreasuryError(
      "treasury_already_initialized",
      "initTreasury has already run this process",
    );
  }

  const account = deriveTreasuryAccount();

  const rpcUrl = resolveRpcUrl(opts.rpcUrl);
  const clients = buildChainClients(account, rpcUrl);

  const ledger = createInflowLedger();

  bindings = Object.freeze({
    address: account.address,
    account,
    clients,
    ledger,
  });

  return bindings;
}

/**
 * HKDF → secp256k1 scalar → viem Account. Buffer is zeroed synchronously
 * after viem has its own copy (spec §5 step 4). No code path holds a
 * post-return reference to the raw buffer.
 */
function deriveTreasuryAccount(): Account {
  // Note: `HKDF_INFO.AGENT_TREASURY` is labeled "ed25519-seed" in the
  // frozen @vanta/tee surface but consumed here as a secp256k1 scalar.
  // See spec §5 "Label misnomer" and deferred item D-TR-5. Do not
  // refactor the tee label in Week 1.
  const buf: Buffer = deriveKey({
    salt: HKDF_SALT.AGENT_TREASURY,
    info: HKDF_INFO.AGENT_TREASURY,
  });

  // Defensive: the kdf contract guarantees `buf.length === 32` (kdf.ts
  // `length: 32`). If a future refactor breaks that, fail closed before
  // we interpret garbage as a key.
  if (buf.length !== 32) {
    buf.fill(0);
    throw new TreasuryError(
      "hkdf_scalar_invalid",
      "HKDF output was not 32 bytes",
      { actualLength: String(buf.length) },
    );
  }

  const hex = buf.toString("hex");
  const scalar = BigInt(`0x${hex}`);

  if (scalar === 0n || scalar >= SECP256K1_N) {
    // Never retry with a counter (spec §5). This is a config bug.
    buf.fill(0);
    throw new TreasuryError(
      "hkdf_scalar_invalid",
      "HKDF output interpreted as uint256 fell outside the secp256k1 order",
    );
  }

  const pkHex: `0x${string}` = `0x${hex}`;
  const account: Account = privateKeyToAccount(pkHex);

  // viem copied the hex into its own internal representation. Zero our
  // Buffer. The viem Account continues to function from its own copy.
  buf.fill(0);

  return account;
}

/** Accessor used by sibling modules. Throws if init has not run. */
export function getBindings(): TreasuryBindings {
  if (bindings === null) {
    throw new TreasuryError(
      "treasury_not_initialized",
      "treasury module has not been initialized",
    );
  }
  return bindings;
}

/**
 * Public accessor per spec §1.2. Cheap, re-entrant, pure after init.
 * Returns the 0x-prefixed checksummed address.
 */
export function getTreasuryAddress(): EthAddressHex {
  return getBindings().address;
}

/**
 * Pinned constants surfaced for wire formatters / `/api/treasury`
 * handlers that do not hold a `TreasuryBindings` reference directly.
 */
export function getChainId(): typeof CHAIN_ID {
  return CHAIN_ID;
}

export function getUsdcContract(): typeof USDC_BASE_SEPOLIA {
  return USDC_BASE_SEPOLIA;
}

/**
 * `getTreasuryState` — spec §1.3. Returns a snapshot combining the
 * live USDC balance, the in-memory inflow ledger, and the current
 * block number. Performs two RPC reads: `balanceOf` and
 * `getBlockNumber`. Throws `rpc_unreachable` on transport failure.
 *
 * Pure w.r.t. the ledger — no mutation of inflow totals.
 */
export async function getTreasuryState(): Promise<TreasuryState> {
  const b = getBindings();
  const client = b.clients.publicClient;

  let balanceWei: bigint;
  let blockNumber: bigint;
  try {
    const [bal, blk] = await Promise.all([
      client.readContract({
        address: USDC_BASE_SEPOLIA,
        abi: usdcAbi,
        functionName: "balanceOf",
        args: [b.address],
      }),
      client.getBlockNumber(),
    ]);
    if (typeof bal !== "bigint") {
      throw new TreasuryError(
        "rpc_response_inconsistent",
        "balanceOf did not return a bigint",
      );
    }
    balanceWei = bal;
    blockNumber = blk;
  } catch (err: unknown) {
    if (err instanceof TreasuryError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new TreasuryError(
      "rpc_unreachable",
      `getTreasuryState RPC read failed: ${msg}`,
    );
  }

  const snap = b.ledger.snapshot();

  return Object.freeze({
    address: b.address,
    chainId: CHAIN_ID,
    usdcContract: USDC_BASE_SEPOLIA,
    balanceUsdc: formatUsdc(balanceWei),
    balanceWei: balanceWei.toString(),
    lastInflowBlock: snap.lastInflowBlock,
    lastInflowTxHash: snap.lastInflowTxHash,
    totalInflowsCount: snap.totalInflowsCount,
    totalInflowsUsdc: snap.totalInflowsUsdc,
    confirmationDepth: CONFIRMATION_BLOCKS,
    updatedAtBlock: blockNumber,
  });
}

/**
 * Test-only state reset. Gated on NODE_ENV / VITEST. Not re-exported
 * from the package barrel. Mirrors the pattern in `packages/tee/src/kdf.ts`.
 */
export function __resetForTesting(): void {
  if (process.env["NODE_ENV"] !== "test" && process.env["VITEST"] === undefined) {
    throw new TreasuryError(
      "treasury_already_initialized",
      "__resetForTesting is disabled outside tests",
    );
  }
  bindings = null;
}
