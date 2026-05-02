/**
 * Runtime bootstrap. Runs once before the HTTP server is listening.
 *
 * Order:
 *   1. Load + validate config (fail-closed on bad env).
 *   2. Read the origination-EOA seed (`.vanta/dev-seed` in dev, env
 *      `MNEMONIC` in production) and derive the admin EOA + private
 *      key via `@vanta/tee.deriveOriginationEOA`.
 *   3. Run `initTEE()` for the signing identity + attestation anchor.
 *      This clears `process.env.MNEMONIC` as a side effect.
 *   4. Open the on-disk event log.
 *   5. If no `constitutional.genesis` event exists yet, build, sign,
 *      and persist one.
 *   6. Read `LoanBook.owner()` via viem and assert it equals the
 *      derived EOA (I-RT-2). Hard-fail on mismatch — the runtime
 *      cannot drive originate/markRepaid/markLiquidated otherwise.
 *
 * Returns a struct of long-lived handles the rest of the runtime
 * needs (TEE state, event log, derived EOA + privateKey, viem
 * publicClient/walletClient binding).
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  buildAndSign,
  type VantaEvent,
} from "@vanta/events";
import {
  buildVantaGenesisBody,
  signGenesis,
  constitutionHash,
  type ConstitutionalGenesisPayload,
} from "@vanta/constitution";
import {
  asSha256Hex,
  deriveKey,
  deriveOriginationEOA,
  HKDF_SALT,
  HKDF_INFO,
  initTEE,
  TeeError,
  sign as teeSign,
  type EthAddressHex,
  type TeeState,
} from "@vanta/tee";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { RuntimeConfig } from "./config.js";
import { FileEventLog } from "./events-store.js";
import { createAgentState, type AgentState } from "./services/agent-state.js";
import { createInferenceClient, type InferenceClient } from "./services/inference.js";
import { LoanRegistry } from "./services/loan-registry.js";
import { createMarketsCache, type MarketsCache } from "./services/markets-cache.js";

const LOAN_BOOK_OWNER_ABI = [
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

const LP_VAULT_WIRING_ABI = [
  {
    type: "function",
    name: "loanBook",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "pendingLoanBook",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "proposeLoanBook",
    stateMutability: "nonpayable",
    inputs: [{ name: "next", type: "address" }],
    outputs: [],
  },
] as const;

const LOAN_BOOK_WIRING_ABI = [
  {
    type: "function",
    name: "acceptLpVaultWiring",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
] as const;

// LoanBook origination-fee admin surface. The fee path is off by default
// at deploy time (feeBps = 0, feeReceiver = address(0)) so the contract
// can be deployed before the runtime exposes its treasury address. The
// runtime configures both on first boot via the steps below.
const LOAN_BOOK_FEE_ABI = [
  {
    type: "function",
    name: "feeBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint16" }],
  },
  {
    type: "function",
    name: "feeReceiver",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "setOriginationFeeBps",
    stateMutability: "nonpayable",
    inputs: [{ name: "newBps", type: "uint16" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setFeeReceiver",
    stateMutability: "nonpayable",
    inputs: [{ name: "newReceiver", type: "address" }],
    outputs: [],
  },
] as const;

/** Default origination-fee target. 50 bps = 0.5%. Capped on-chain at 500. */
const DEFAULT_ORIGINATION_FEE_BPS = 50;

export interface Bootstrap {
  readonly tee: TeeState;
  readonly log: FileEventLog;
  readonly origination: {
    readonly address: EthAddressHex;
    readonly privateKey: Hex;
  };
  /**
   * vanta-agent-treasury-v1 — HKDF-derived secp256k1 account on Base
   * Sepolia. Receiver of X402 micropayments + origination fees;
   * spec-pinned distinct from `origination` so a metering breach can't
   * mint loans. The walletClient signs treasury-side outflows
   * (Uniswap gas refills, VendorPayment.pay) — the only EOA that may
   * push USDC out of the treasury on its own initiative.
   */
  readonly treasury: {
    readonly address: EthAddressHex;
    readonly walletClient: WalletClient;
  };
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly genesis: VantaEvent;
  readonly loanRegistry: LoanRegistry;
  readonly inference: InferenceClient;
  /**
   * Live read-only snapshot of the credit engine's on-chain + log
   * state. Polled in the background; bridge routes use the synchronous
   * `snapshot()` accessor to ground the wizard's mouth in real numbers
   * (and the future tower-chest renderer reads the same snapshot).
   */
  readonly agentState: AgentState;
  /**
   * Polymarket markets cache — live midpoints + metadata for the
   * markets vanta is watching. start()/stop() driven from main.ts.
   */
  readonly marketsCache: MarketsCache;
  /**
   * Optional injected midpoint fetcher. Set by `main.ts` when
   * `MARK_MODE=fixture`; left undefined in production so the quote
   * service falls through to live `@vanta/mark.fetchMidpoint`.
   */
  readonly fetchMidpoint?: (tokenId: string) => Promise<{ readonly mid: string }>;
}

/**
 * Read the dev-seed (32 bytes) used both by the Foundry deploy script
 * and the runtime to derive the origination EOA. Falls through to the
 * `MNEMONIC` env var when the dev-seed file is missing (production
 * EigenCloud path).
 */
function readDevSeedOrMnemonic(): Buffer {
  const repoRoot = process.cwd().endsWith("/runtime")
    ? resolve(process.cwd(), "..")
    : process.cwd();
  const devSeedPath = resolve(repoRoot, ".vanta", "dev-seed");
  if (existsSync(devSeedPath)) {
    return readFileSync(devSeedPath);
  }
  const mnem = process.env["MNEMONIC"];
  if (typeof mnem === "string" && mnem.length > 0) {
    return Buffer.from(mnem, "utf8").subarray(0, 32);
  }
  throw new TeeError(
    "mnemonic_missing",
    "no .vanta/dev-seed and no MNEMONIC env var; cannot derive origination EOA",
  );
}

/**
 * I-RT-3: if `versions.json` carries a `kms.publicKeySha256` pin, the
 * live identity-anchor's KMS public key (PEM) MUST hash to the same
 * value. Defends against a deploy that re-points at a different KMS
 * (e.g. via leaked `upgradeApp` posting a new image with a tampered
 * KMS_SERVER_URL).
 *
 * Also enforces the appId pin against the EigenCompute instance id when
 * the anchor is the eigencompute-instance fallback (degraded path).
 */
function loadKmsPin(): {
  appId: string | null;
  publicKeySha256: string | null;
} {
  const candidates = [
    resolve(process.cwd(), "versions.json"),
    resolve(process.cwd(), "..", "versions.json"),
  ];
  for (const p of candidates) {
    try {
      const raw = readFileSync(p, "utf8");
      const parsed = JSON.parse(raw) as {
        kms?: { appId?: unknown; publicKeySha256?: unknown };
      };
      const kms = parsed.kms;
      return {
        appId: typeof kms?.appId === "string" ? kms.appId : null,
        publicKeySha256:
          typeof kms?.publicKeySha256 === "string" ? kms.publicKeySha256 : null,
      };
    } catch {
      // continue
    }
  }
  return { appId: null, publicKeySha256: null };
}

function assertKmsPinMatches(tee: TeeState): void {
  const pin = loadKmsPin();
  if (pin.publicKeySha256 === null && pin.appId === null) return;

  const anchor = tee.identityAnchor;
  if (anchor === null) {
    throw new TeeError(
      "env_not_configured",
      "I-RT-3 violation: kms pin set in versions.json but identityAnchor is null",
    );
  }

  if (pin.publicKeySha256 !== null) {
    const livePem = anchor.kind === "kms-jwt"
      ? anchor.kmsPublicKeyPem
      : anchor.kmsPublicKeyPem;
    const liveHash = livePem === null
      ? null
      : createHash("sha256").update(livePem, "utf8").digest("hex");
    if (liveHash !== pin.publicKeySha256) {
      throw new TeeError(
        "env_not_configured",
        "I-RT-3 violation: KMS public key SHA-256 does not match versions.json pin",
        {
          expected: pin.publicKeySha256,
          observed: liveHash ?? "null",
        },
      );
    }
  }

  if (pin.appId !== null && anchor.kind === "eigencompute-instance") {
    if (anchor.instanceId !== pin.appId) {
      throw new TeeError(
        "env_not_configured",
        "I-RT-3 violation: EigenCompute instanceId does not match versions.json appId pin",
        {
          expected: pin.appId,
          observed: anchor.instanceId,
        },
      );
    }
  }
}

/**
 * Second-stage bootstrap: contracts are deployed but unwired. Foundry
 * script 03 can't run because both calls require admin authority and
 * admin's private key is in the TEE. So the runtime — which DOES have
 * the admin key — performs the propose/accept handshake itself on
 * first boot.
 *
 * Idempotent: bails as a no-op if `vault.loanBook()` is already the
 * configured LoanBook address. Logs to stderr so the operator sees
 * what happened in `ecloud compute app logs`.
 */
async function bootWireVaultIfNeeded(args: {
  readonly publicClient: PublicClient;
  // The wallet client must already be bound to a local PrivateKeyAccount
  // (so viem signs locally and submits via eth_sendRawTransaction). If
  // the account is just an address string the writeContract falls back
  // to wallet_sendTransaction, which public RPCs don't implement.
  readonly walletClient: WalletClient;
  readonly lpVaultAddress: Address;
  readonly loanBookAddress: Address;
}): Promise<void> {
  const current = (await args.publicClient.readContract({
    address: args.lpVaultAddress,
    abi: LP_VAULT_WIRING_ABI,
    functionName: "loanBook",
  })) as Address;
  if (current.toLowerCase() === args.loanBookAddress.toLowerCase()) {
    process.stderr.write(
      `[bootstrap] BOOT_AND_WIRE: vault.loanBook() already == ${args.loanBookAddress}; no-op\n`,
    );
    return;
  }
  if (current !== "0x0000000000000000000000000000000000000000") {
    // Refuse to silently overwrite a previously-wired LoanBook. Operator
    // must opt in by setting ALLOW_LOANBOOK_REWIRE=1 — this exists for
    // the legitimate case of re-pointing the vault at a redeployed
    // LoanBook (e.g. v1 → v2 with origination fees). The rewire still
    // goes through the propose+accept handshake; the gate is just a
    // safety against a misconfigured env silently rerouting capital.
    const allowRewire = process.env["ALLOW_LOANBOOK_REWIRE"] === "1";
    if (!allowRewire) {
      throw new TeeError(
        "env_not_configured",
        "BOOT_AND_WIRE: vault.loanBook() is non-zero AND does not match configured LoanBook — refusing to overwrite",
        { current, configured: args.loanBookAddress },
      );
    }
    process.stderr.write(
      `[bootstrap] BOOT_AND_WIRE: ALLOW_LOANBOOK_REWIRE=1 — proceeding to rewire ${current} → ${args.loanBookAddress}\n`,
    );
  }

  const account = args.walletClient.account;
  if (account === undefined) {
    throw new TeeError(
      "env_not_configured",
      "BOOT_AND_WIRE: walletClient has no bound account; cannot sign txs",
    );
  }
  const chain = args.walletClient.chain ?? null;

  // Step 1: admin proposes the LoanBook on the vault (idempotent).
  const pending = (await args.publicClient.readContract({
    address: args.lpVaultAddress,
    abi: LP_VAULT_WIRING_ABI,
    functionName: "pendingLoanBook",
  })) as Address;
  if (pending.toLowerCase() !== args.loanBookAddress.toLowerCase()) {
    process.stderr.write(`[bootstrap] BOOT_AND_WIRE: proposing LoanBook…\n`);
    const proposeHash = await args.walletClient.writeContract({
      address: args.lpVaultAddress,
      abi: LP_VAULT_WIRING_ABI,
      functionName: "proposeLoanBook",
      args: [args.loanBookAddress],
      account,
      chain,
    });
    await args.publicClient.waitForTransactionReceipt({ hash: proposeHash });
    process.stderr.write(`[bootstrap] BOOT_AND_WIRE: propose tx ${proposeHash}\n`);
  }

  // RPC eventual consistency: writeContract pre-flights via eth_call,
  // and public Base Sepolia RPCs sometimes serve a stale block on the
  // simulation node even after waitForTransactionReceipt returns. Poll
  // the proposed value until it's visible to a fresh read before we
  // submit the accept tx, otherwise simulation reverts with
  // PendingLoanBookUnset() against the stale view.
  for (let i = 0; i < 20; i++) {
    const seen = (await args.publicClient.readContract({
      address: args.lpVaultAddress,
      abi: LP_VAULT_WIRING_ABI,
      functionName: "pendingLoanBook",
    })) as Address;
    if (seen.toLowerCase() === args.loanBookAddress.toLowerCase()) break;
    if (i === 19) {
      throw new TeeError(
        "env_not_configured",
        "BOOT_AND_WIRE: pendingLoanBook never converged after propose tx",
        { observed: seen, expected: args.loanBookAddress },
      );
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  // Step 2: admin asks the LoanBook to accept the wiring.
  process.stderr.write(`[bootstrap] BOOT_AND_WIRE: accepting on LoanBook…\n`);
  const acceptHash = await args.walletClient.writeContract({
    address: args.loanBookAddress,
    abi: LOAN_BOOK_WIRING_ABI,
    functionName: "acceptLpVaultWiring",
    account,
    chain,
  });
  await args.publicClient.waitForTransactionReceipt({ hash: acceptHash });
  process.stderr.write(`[bootstrap] BOOT_AND_WIRE: accept tx ${acceptHash}\n`);

  // Same eventual-consistency story on the readback: poll until a fresh
  // read of loanBook() converges to the configured address.
  for (let i = 0; i < 20; i++) {
    const after = (await args.publicClient.readContract({
      address: args.lpVaultAddress,
      abi: LP_VAULT_WIRING_ABI,
      functionName: "loanBook",
    })) as Address;
    if (after.toLowerCase() === args.loanBookAddress.toLowerCase()) {
      process.stderr.write(`[bootstrap] BOOT_AND_WIRE: wired ✓\n`);
      return;
    }
    if (i === 19) {
      throw new TeeError(
        "env_not_configured",
        "BOOT_AND_WIRE: post-accept loanBook() never converged",
        { observed: after, expected: args.loanBookAddress },
      );
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/**
 * Configure LoanBook origination-fee parameters on first boot.
 *
 * Idempotent: reads current feeBps + feeReceiver, only broadcasts the
 * setters if a value differs from the configured target. This lets us
 * deploy LoanBook with fees off (because the deployer doesn't know the
 * treasury address — only the running enclave does), then have the
 * runtime configure them once it knows its own treasury.
 *
 * The receiver is always the HKDF-derived `vanta-agent-treasury-v1` EOA;
 * feeBps defaults to DEFAULT_ORIGINATION_FEE_BPS but can be overridden
 * via env (handy for governance recalibration without redeploy).
 */
async function bootConfigureLoanBookFees(args: {
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly loanBookAddress: Address;
  readonly treasuryAddress: Address;
  readonly desiredFeeBps: number;
}): Promise<void> {
  const account = args.walletClient.account;
  if (account === undefined) {
    throw new TeeError(
      "env_not_configured",
      "BOOT_FEE_CONFIG: walletClient has no bound account; cannot sign txs",
    );
  }
  const chain = args.walletClient.chain ?? null;

  const currentBps = (await args.publicClient.readContract({
    address: args.loanBookAddress,
    abi: LOAN_BOOK_FEE_ABI,
    functionName: "feeBps",
  })) as number;
  const currentReceiver = (await args.publicClient.readContract({
    address: args.loanBookAddress,
    abi: LOAN_BOOK_FEE_ABI,
    functionName: "feeReceiver",
  })) as Address;

  const wantBps = args.desiredFeeBps;
  const wantReceiver = args.treasuryAddress;

  // Receiver must be set before bps becomes non-zero — otherwise the
  // setOriginationFeeBps tx succeeds but originate() would still take
  // the no-fee path (bps != 0 && receiver == 0 short-circuits to no-fee
  // in LoanBook.sol). Set receiver first.
  if (currentReceiver.toLowerCase() !== wantReceiver.toLowerCase()) {
    process.stderr.write(
      `[bootstrap] BOOT_FEE_CONFIG: setFeeReceiver(${wantReceiver}) (was ${currentReceiver})\n`,
    );
    const hash = await args.walletClient.writeContract({
      address: args.loanBookAddress,
      abi: LOAN_BOOK_FEE_ABI,
      functionName: "setFeeReceiver",
      args: [wantReceiver],
      account,
      chain,
    });
    await args.publicClient.waitForTransactionReceipt({ hash });
    process.stderr.write(`[bootstrap] BOOT_FEE_CONFIG: receiver tx ${hash}\n`);
  } else {
    process.stderr.write(
      `[bootstrap] BOOT_FEE_CONFIG: feeReceiver already == ${wantReceiver}; no-op\n`,
    );
  }

  if (Number(currentBps) !== wantBps) {
    process.stderr.write(
      `[bootstrap] BOOT_FEE_CONFIG: setOriginationFeeBps(${String(wantBps)}) (was ${String(currentBps)})\n`,
    );
    const hash = await args.walletClient.writeContract({
      address: args.loanBookAddress,
      abi: LOAN_BOOK_FEE_ABI,
      functionName: "setOriginationFeeBps",
      args: [wantBps],
      account,
      chain,
    });
    await args.publicClient.waitForTransactionReceipt({ hash });
    process.stderr.write(`[bootstrap] BOOT_FEE_CONFIG: bps tx ${hash}\n`);
  } else {
    process.stderr.write(
      `[bootstrap] BOOT_FEE_CONFIG: feeBps already == ${String(wantBps)}; no-op\n`,
    );
  }
}

/**
 * I-RT-2: assert the LoanBook on-chain admin matches the derived EOA.
 */
async function assertOnchainOwnerMatches(
  publicClient: PublicClient,
  loanBookAddress: Address,
  expectedAdmin: EthAddressHex,
): Promise<void> {
  const onchain = await publicClient.readContract({
    address: loanBookAddress,
    abi: LOAN_BOOK_OWNER_ABI,
    functionName: "owner",
  });
  if ((onchain as string).toLowerCase() !== expectedAdmin.toLowerCase()) {
    throw new TeeError(
      "env_not_configured",
      "I-RT-2 violation: LoanBook.owner() does not match derived origination EOA — refusing to start",
      {
        loanBook: loanBookAddress,
        onchain: onchain as string,
        derived: expectedAdmin,
      },
    );
  }
}

/**
 * Find the existing constitutional.genesis event in the log, if any.
 * O(N) over the log on boot — cheap.
 */
async function findGenesis(log: FileEventLog): Promise<VantaEvent | null> {
  for await (const ev of log.walkFromHead()) {
    if (ev.type === "constitutional.genesis") return ev;
  }
  return null;
}

/**
 * Build, sign, and persist a `constitutional.genesis` event over the
 * v1 baseline body. Idempotent: callers should only invoke this if
 * `findGenesis` returned null.
 */
async function signAndPersistGenesis(args: {
  readonly tee: TeeState;
  readonly log: FileEventLog;
  readonly admin: EthAddressHex;
}): Promise<VantaEvent> {
  const stewardEntry = {
    handle: "wisdom",
    role: "agent",
    pubkey: args.tee.signingPubKey,
    contact: "okechukwuwisdom016@gmail.com",
  } as const;

  const body = buildVantaGenesisBody({
    agentPk: args.tee.signingPubKey,
    wisdomSteward: stewardEntry,
    genesisTimestampUnixMs: Date.now(),
  });

  const payload: ConstitutionalGenesisPayload = await signGenesis({
    body,
    sign: teeSign,
    signingPubKey: args.tee.signingPubKey,
  });

  // Project the payload into the on-the-wire `constitutional.genesis`
  // body shape. The events schema's body matches the cross-cutting
  // sketch in `@vanta/events.bodies::ConstitutionalGenesisBody`.
  const ch = constitutionHash(payload.body);
  const constitutionalBody = {
    constitutionHash: ch,
    constitutionUri: "vanta://constitution/v1",
    stewardAddrs: [args.admin] as readonly EthAddressHex[],
    quorum: 1,
  };

  const event = buildAndSign({
    type: "constitutional.genesis",
    parent_ids: [], // genesis has no parents (I-EV-4 special-case)
    lineage: "vanta-genesis",
    timestamp: Math.floor(Date.now() / 1000),
    epoch: Math.floor(args.tee.bootedAt / 1000),
    tee: {
      signingPubKey: args.tee.signingPubKey,
      kmsKeyHash: asSha256Hex(
        // KMS public key hash: the canonical form is the SHA-256 of
        // the PEM. In dev/degraded mode there may be no PEM; emit
        // 64 zero-hex as a placeholder bound by the genesis body.
        "0".repeat(64),
      ),
      tdxQuoteHash: null,
      attestationJwtHash: asSha256Hex("0".repeat(64)),
    },
    instance: args.tee.identityAnchor?.kind === "kms-jwt"
      ? args.tee.identityAnchor.audience
      : "vanta-runtime-local",
    body: constitutionalBody,
    sign: teeSign,
  });

  await args.log.append(event);
  return event;
}

export async function bootstrap(config: RuntimeConfig): Promise<Bootstrap> {
  // Step 2: derive admin EOA. Done before initTEE so we still have
  // the seed bytes; initTEE clears MNEMONIC as a side effect.
  const seed = readDevSeedOrMnemonic();
  const origination = deriveOriginationEOA(seed);
  seed.fill(0);

  // I-RT-2 sanity at the config layer too: when an `expectedAdmin` is
  // pinned in the deployment JSON, it MUST agree with the derivation.
  if (
    config.expectedAdmin !== null &&
    config.expectedAdmin.toLowerCase() !== origination.address.toLowerCase()
  ) {
    throw new TeeError(
      "env_not_configured",
      "expectedAdmin in deployment JSON disagrees with derived origination EOA",
      {
        expected: config.expectedAdmin,
        derived: origination.address,
      },
    );
  }

  // Step 3: TEE init. Synthesize a degraded env in dev (no real KMS).
  if (
    process.env["MNEMONIC"] === undefined ||
    process.env["MNEMONIC"].length === 0
  ) {
    // Local dev: feed initTEE a deterministic mnemonic so the signing
    // identity is also deterministic per-boot.
    process.env["MNEMONIC"] = "vanta-runtime-dev-mnemonic-0000000000000000";
  }
  if (process.env["EIGENCOMPUTE_INSTANCE_ID"] === undefined) {
    process.env["EIGENCOMPUTE_INSTANCE_ID"] = "vanta-local-runtime";
  }

  // Derive the treasury (vanta-agent-treasury-v1) BEFORE initTEE so we
  // share the cached HKDF IKM. initTEE clears the IKM at the end of its
  // boot phase; any HKDF derivation must happen first.
  const treasury = deriveTreasuryBindings();

  const tee = await initTEE();

  // I-RT-3: KMS pin check (no-op when versions.json carries no pin).
  assertKmsPinMatches(tee);

  // Step 4: open the log.
  const log = new FileEventLog(config.dataDir);

  // Step 5: ensure genesis.
  let genesis = await findGenesis(log);
  if (genesis === null) {
    genesis = await signAndPersistGenesis({
      tee,
      log,
      admin: origination.address,
    });
  }
  // Step 6: viem clients + on-chain owner check (I-RT-2).
  const baseSepoliaLocal = defineChain({
    id: 84532,
    name: "base-sepolia-local",
    nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
    rpcUrls: {
      default: { http: [config.loanBookRpcUrl] },
    },
  });
  const transport = http(config.loanBookRpcUrl);
  const account = privateKeyToAccount(origination.privateKey);
  const publicClient = createPublicClient({
    chain: baseSepoliaLocal,
    transport,
  });
  const walletClient = createWalletClient({
    account,
    chain: baseSepoliaLocal,
    transport,
  });
  // Treasury walletClient — same chain + transport as origination, but
  // bound to the HKDF-derived treasury account. Used by the Payouts
  // service to sign Uniswap swaps + VendorPayment.pay calls.
  const treasuryAccount = privateKeyToAccount(treasury.privateKey);
  const treasuryWalletClient = createWalletClient({
    account: treasuryAccount,
    chain: baseSepoliaLocal,
    transport,
  });

  if (config.skipContractChecks) {
    // Bootstrap-deploy mode. Contracts may not exist yet — the whole
    // point is to surface the derived admin EOA via /api/tee so the
    // operator can deploy contracts owned by it. Skip the on-chain
    // owner check; address-dependent routes will fail closed at
    // request time.
    process.stderr.write(
      `[bootstrap] SKIP_CONTRACT_CHECKS=1 — bypassing I-RT-2 LoanBook.owner() assertion. Derived admin: ${origination.address}\n`,
    );
  } else {
    await assertOnchainOwnerMatches(
      publicClient,
      config.loanBookAddress,
      origination.address,
    );
  }

  if (config.bootAndWire) {
    await bootWireVaultIfNeeded({
      publicClient,
      walletClient,
      lpVaultAddress: config.lpVaultAddress,
      loanBookAddress: config.loanBookAddress,
    });
    // Same boot phase: configure the LoanBook origination-fee parameters
    // to point at our HKDF-derived treasury. Idempotent — bails as no-op
    // when current state already matches the target. Skipped on chains
    // where the LoanBook address is the zero placeholder (bootstrap mode).
    if (
      config.loanBookAddress !== "0x0000000000000000000000000000000000000000"
    ) {
      await bootConfigureLoanBookFees({
        publicClient,
        walletClient,
        loanBookAddress: config.loanBookAddress,
        treasuryAddress: treasury.address as Address,
        desiredFeeBps: DEFAULT_ORIGINATION_FEE_BPS,
      });
    }
  }

  // Step 7: hydrate the in-memory loan registry from the on-disk log.
  const loanRegistry = new LoanRegistry();
  const pledgeIndex = await LoanRegistry.buildPledgeIndex(log);
  await loanRegistry.hydrateFromLog(log, pledgeIndex);

  // Step 8: build the inference client. Genesis event id is the default
  // causal parent for op.inference events; callers can override.
  const inference = createInferenceClient({
    config: config.inference,
    tee: {
      signingPubKey: tee.signingPubKey,
      kmsKeyHash: genesis.tee.kmsKeyHash,
      attestationJwtHash: genesis.tee.attestationJwtHash,
      bootedAt: tee.bootedAt,
    },
    instance: genesis.instance,
    sign: teeSign,
    appendEvent: (ev) => log.append(ev),
    defaultParentId: genesis.id,
    blobDir: resolve(config.dataDir, "inference-blobs"),
  });

  // Step 9: build the agent-state poller. This is the synchronous-read
  // snapshot the bridge surface uses to ground the wizard (and the
  // tower-chest renderer, eventually). Background polling is started
  // by main.ts after bootstrap returns so tests can construct the
  // Bootstrap struct without spinning a real timer.
  const agentState = createAgentState({
    publicClient,
    lpVaultAddress: config.lpVaultAddress,
    loanBookAddress: config.loanBookAddress,
    log,
    activeLoanCount: () => loanRegistry.size(),
    skipContractChecks: config.skipContractChecks,
  });

  // Polymarket markets cache. In-memory only; reseeds on boot.
  const marketsCache = createMarketsCache();

  return {
    tee,
    log,
    origination,
    treasury: {
      address: treasury.address,
      walletClient: treasuryWalletClient,
    },
    publicClient,
    walletClient,
    genesis,
    loanRegistry,
    inference,
    agentState,
    marketsCache,
  };
}

/**
 * HKDF → secp256k1 → viem-derived treasury address + private key.
 * Mirrors `@vanta/treasury.deriveTreasuryAccount` but stays in-runtime
 * so we don't pay the cost of building duplicate viem clients we never
 * use.
 *
 * The private key is returned (not zeroed in this helper) so the
 * caller can construct a walletClient against the chain config that's
 * defined later in `bootstrap()`. The key lives in process memory for
 * the runtime's lifetime — same posture as the origination key.
 */
function deriveTreasuryBindings(): {
  address: EthAddressHex;
  privateKey: Hex;
} {
  const buf: Buffer = deriveKey({
    salt: HKDF_SALT.AGENT_TREASURY,
    info: HKDF_INFO.AGENT_TREASURY,
  });
  if (buf.length !== 32) {
    buf.fill(0);
    throw new Error("AGENT_TREASURY HKDF output was not 32 bytes");
  }
  const pkHex: `0x${string}` = `0x${buf.toString("hex")}`;
  const account = privateKeyToAccount(pkHex);
  buf.fill(0);
  return { address: account.address, privateKey: pkHex };
}

