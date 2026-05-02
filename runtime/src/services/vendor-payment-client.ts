/**
 * VendorPayment client — thin wrapper around the VendorPayment ABI
 * exposed for the Payouts service. Two writes (`approve` + `pay`),
 * three reads (`paidThisWeek`, `weeklyCapUsdc6`, `constitutionalRef`).
 *
 * Constitutional-ref pattern:
 *   - Each VendorPayment deploy carries an immutable bytes32 ref.
 *   - The runtime pins the same ref in env (`PAYOUTS_HOSTING_CONSTITUTIONAL_REF`).
 *   - At boot, the runtime reads the on-chain ref and asserts equality.
 *     Any mismatch fails closed — the runtime refuses to call `pay`.
 *   - Means a misconfigured `PAYOUTS_HOSTING_CONTRACT_ADDRESS` (pointed
 *     at a different VendorPayment, or an attacker-deployed clone)
 *     can't quietly route disbursements to a different payee.
 */

import {
  encodeFunctionData,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";

import { ERC20_APPROVE_ABI, MAX_UINT256 } from "./uniswap-v3.js";

export const VENDOR_PAYMENT_ABI = [
  {
    type: "function",
    name: "pay",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "paidThisWeek",
    stateMutability: "view",
    inputs: [{ name: "weekId", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "weeklyCapUsdc6",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "vendorPayee",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "constitutionalRef",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "currentWeekId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const;

export interface VendorPaymentDeployment {
  readonly address: Address;
  readonly bucket: "hosting" | "inference";
  readonly expectedConstitutionalRef: Hex;
  readonly expectedWeeklyCapUsdc6: bigint;
}

export interface VendorPaymentChainState {
  readonly address: Address;
  readonly bucket: "hosting" | "inference";
  readonly weeklyCap: bigint;
  readonly vendorPayee: Address;
  readonly constitutionalRef: Hex;
  readonly currentWeekId: bigint;
  readonly paidThisWeek: bigint;
  readonly owner: Address;
}

/**
 * Read everything we care about for a single VendorPayment deploy in
 * one batch — used at boot to assert refs and at every operational
 * tick to compute remaining-headroom for the cap.
 */
export async function readVendorPaymentState(
  client: PublicClient,
  deployment: VendorPaymentDeployment,
): Promise<VendorPaymentChainState> {
  const [weeklyCap, vendorPayee, constitutionalRef, currentWeekId, owner] = await Promise.all([
    client.readContract({
      address: deployment.address,
      abi: VENDOR_PAYMENT_ABI,
      functionName: "weeklyCapUsdc6",
    }) as Promise<bigint>,
    client.readContract({
      address: deployment.address,
      abi: VENDOR_PAYMENT_ABI,
      functionName: "vendorPayee",
    }) as Promise<Address>,
    client.readContract({
      address: deployment.address,
      abi: VENDOR_PAYMENT_ABI,
      functionName: "constitutionalRef",
    }) as Promise<Hex>,
    client.readContract({
      address: deployment.address,
      abi: VENDOR_PAYMENT_ABI,
      functionName: "currentWeekId",
    }) as Promise<bigint>,
    client.readContract({
      address: deployment.address,
      abi: VENDOR_PAYMENT_ABI,
      functionName: "owner",
    }) as Promise<Address>,
  ]);
  const paidThisWeek = (await client.readContract({
    address: deployment.address,
    abi: VENDOR_PAYMENT_ABI,
    functionName: "paidThisWeek",
    args: [currentWeekId],
  })) as bigint;
  return {
    address: deployment.address,
    bucket: deployment.bucket,
    weeklyCap,
    vendorPayee,
    constitutionalRef,
    currentWeekId,
    paidThisWeek,
    owner,
  };
}

export class ConstitutionalRefMismatch extends Error {
  constructor(
    readonly bucket: "hosting" | "inference",
    readonly contractAddress: Address,
    readonly onChain: Hex,
    readonly expected: Hex,
  ) {
    super(
      `VendorPayment(${bucket}) at ${contractAddress}: constitutional_ref mismatch — on-chain=${onChain}, expected=${expected}`,
    );
    this.name = "ConstitutionalRefMismatch";
  }
}

export class WeeklyCapMismatch extends Error {
  constructor(
    readonly bucket: "hosting" | "inference",
    readonly contractAddress: Address,
    readonly onChain: bigint,
    readonly expected: bigint,
  ) {
    super(
      `VendorPayment(${bucket}) at ${contractAddress}: weekly_cap mismatch — on-chain=${onChain.toString()}, expected=${expected.toString()}`,
    );
    this.name = "WeeklyCapMismatch";
  }
}

/**
 * Boot-time assertion: the on-chain VendorPayment's constitutional ref
 * AND immutable weekly cap MUST match what the runtime config pins.
 * Runs before any pay() call to avoid silently routing capital
 * through a misconfigured deployment.
 */
export async function assertVendorPaymentMatches(
  client: PublicClient,
  deployment: VendorPaymentDeployment,
): Promise<VendorPaymentChainState> {
  const state = await readVendorPaymentState(client, deployment);
  if (
    state.constitutionalRef.toLowerCase() !==
    deployment.expectedConstitutionalRef.toLowerCase()
  ) {
    throw new ConstitutionalRefMismatch(
      deployment.bucket,
      deployment.address,
      state.constitutionalRef,
      deployment.expectedConstitutionalRef,
    );
  }
  if (state.weeklyCap !== deployment.expectedWeeklyCapUsdc6) {
    throw new WeeklyCapMismatch(
      deployment.bucket,
      deployment.address,
      state.weeklyCap,
      deployment.expectedWeeklyCapUsdc6,
    );
  }
  return state;
}

export interface PayArgs {
  readonly walletClient: WalletClient;
  readonly publicClient: PublicClient;
  readonly contract: Address;
  readonly amount: bigint;
  /**
   * USDC token address — needed to grant the contract an allowance the
   * first time pay() is called. Allowance is set to MAX_UINT256 so we
   * pay the approve gas exactly once.
   */
  readonly usdc: Address;
}

export interface PayResult {
  readonly approveTx: Hex | null;
  readonly payTx: Hex;
}

/**
 * Execute a VendorPayment.pay(amount) call. If the treasury's allowance
 * to the contract is below `amount`, first sends a one-shot approve(MAX)
 * tx. Returns both tx hashes (approveTx is null when allowance was
 * already sufficient).
 */
export async function payVendorPayment(args: PayArgs): Promise<PayResult> {
  const account = args.walletClient.account;
  if (!account) throw new Error("vendor-payment-client: walletClient has no bound account");
  const owner = account.address as Address;

  const allowance = (await args.publicClient.readContract({
    address: args.usdc,
    abi: ERC20_APPROVE_ABI,
    functionName: "allowance",
    args: [owner, args.contract],
  })) as bigint;

  let approveTx: Hex | null = null;
  if (allowance < args.amount) {
    approveTx = await args.walletClient.writeContract({
      account,
      chain: args.walletClient.chain ?? null,
      address: args.usdc,
      abi: ERC20_APPROVE_ABI,
      functionName: "approve",
      args: [args.contract, MAX_UINT256],
    });
    await args.publicClient.waitForTransactionReceipt({ hash: approveTx });
  }

  const payTx = await args.walletClient.writeContract({
    account,
    chain: args.walletClient.chain ?? null,
    address: args.contract,
    abi: VENDOR_PAYMENT_ABI,
    functionName: "pay",
    args: [args.amount],
  });
  await args.publicClient.waitForTransactionReceipt({ hash: payTx });
  return { approveTx, payTx };
}

/**
 * Pre-encode pay() calldata — used by the dry-run path so the runtime
 * can log exactly what it would have broadcast without sending any tx.
 */
export function encodePayCalldata(amount: bigint): Hex {
  return encodeFunctionData({
    abi: VENDOR_PAYMENT_ABI,
    functionName: "pay",
    args: [amount],
  });
}
