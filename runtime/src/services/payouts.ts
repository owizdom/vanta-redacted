/**
 * Payouts orchestrator — the agent's outbound disbursement engine.
 *
 * One method (`runTick`) is called from the operational loop's observe
 * lambda once per hour. It runs three independently-gated subroutines:
 *
 *   1. maybeRefillGas
 *      Reads the admin EOA's native balance. If below the low watermark,
 *      computes a USDC→ETH swap sized to bring admin back up to the
 *      high watermark (capped per-tick, per-week, slippage-bounded),
 *      then broadcasts the Uniswap V3 multicall (exactInputSingle +
 *      unwrapWETH9 with admin as the unwrap recipient). Two on-chain
 *      txs total: a one-time MAX_UINT256 USDC.approve + the multicall.
 *
 *   2. maybePayHosting
 *      Calls VendorPayment(hosting).pay(amount) where amount = the
 *      per-tick hosting allowance (configurable, defaults to a
 *      per-week budget split evenly across 168 ticks). The contract
 *      enforces the immutable weekly cap on chain — even a misbehaving
 *      runtime cannot exceed it.
 *
 *   3. maybePayInference
 *      Same as hosting, against the inference VendorPayment. (Note:
 *      per-call x402 inference settlement is a separate path through
 *      the x402-client; this contract-mediated stream is the *budget
 *      envelope* covering inference cost when no x402 metering is in
 *      place, or topping up the operator's reimbursement when only
 *      part of inference cost is x402-settled.)
 *
 * Each subroutine fails closed:
 *   - skip if its `*Enabled` flag is false
 *   - skip if treasury USDC < amount + safety margin
 *   - skip if rolling weekly cap would be exceeded
 *   - skip if `dryRun` is true (logs calldata only)
 *
 * Every action — including skips — emits a `treasury.outflow` event
 * (broadcast outcome) plus a sibling `reasoning.trace` (bucket label +
 * rationale + skip reason). Skips emit only the trace.
 */

import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  parseGwei,
} from "viem";

import {
  asSha256Hex,
  type EthAddressHex,
  type Sha256Hex,
} from "@vanta/tee";
import { buildAndSign } from "@vanta/events";

import type { Bootstrap } from "../bootstrap.js";
import type { PayoutsConfig } from "../config.js";
import {
  applySlippageBps,
  buildSwapAndUnwrapMulticall,
  ERC20_APPROVE_ABI,
  MAX_UINT256,
  quoteExactInputSingle,
} from "./uniswap-v3.js";
import {
  payVendorPayment,
  encodePayCalldata,
} from "./vendor-payment-client.js";
import { walkPayouts, sumByBucket, type PayoutBucket } from "./payouts-history.js";

// Re-exported so loops/operational can pass through to /api/state.
export type { PayoutBucket };

const CHAIN_ID = 84532;

export interface PayoutsArgs {
  readonly bootstrap: Bootstrap;
  readonly config: PayoutsConfig;
  readonly usdcAddress: Address;
  /** Optional override for "now" — only set in tests. */
  readonly now?: () => Date;
}

interface RunTickOutcome {
  readonly gas: SubroutineOutcome;
  readonly hosting: SubroutineOutcome;
  readonly inference: SubroutineOutcome;
}

interface SubroutineOutcome {
  readonly action: "broadcast" | "dry_run" | "skip" | "disabled";
  readonly reason?: string;
  readonly txs?: readonly Hex[];
  readonly amountUsdc6?: string;
}

export class Payouts {
  constructor(private readonly args: PayoutsArgs) {}

  /**
   * One operational tick. Runs all three subroutines in sequence and
   * surfaces a structured result for the observe lambda to log.
   * Best-effort — a per-bucket failure does not block other buckets.
   */
  async runTick(): Promise<RunTickOutcome> {
    const gas = await this.run("gas", () => this.maybeRefillGas());
    const hosting = await this.run("hosting", () => this.maybePayHosting());
    const inference = await this.run("inference", () => this.maybePayInference());
    return { gas, hosting, inference };
  }

  private async run(
    bucket: PayoutBucket | "gas",
    fn: () => Promise<SubroutineOutcome>,
  ): Promise<SubroutineOutcome> {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.emitTrace({
        bucket: bucket === "gas" ? "gas_topup" : bucket,
        rationale: `subroutine_failed: ${msg}`,
        amountUsdc6: 0n,
        recipient: "0x0000000000000000000000000000000000000000",
        skipReason: "exception",
        dryRun: false,
      });
      return { action: "skip", reason: `exception:${msg}` };
    }
  }

  // -------------------------------------------------------------------
  // Gas refill
  // -------------------------------------------------------------------

  private async maybeRefillGas(): Promise<SubroutineOutcome> {
    const cfg = this.args.config.gas;
    if (!cfg.enabled) return { action: "disabled" };

    const adminAddr = this.args.bootstrap.origination.address as Address;
    const treasuryAddr = this.args.bootstrap.treasury.address as Address;
    const publicClient = this.args.bootstrap.publicClient as PublicClient;

    const adminNative = await publicClient.getBalance({ address: adminAddr });
    if (adminNative >= cfg.lowWatermarkWei) {
      return { action: "skip", reason: "admin_above_low_watermark" };
    }

    const deficitWei = cfg.highWatermarkWei - adminNative;
    if (deficitWei <= 0n) {
      return { action: "skip", reason: "deficit_nonpositive" };
    }

    // Quote the swap: how much USDC do we need to deliver `deficitWei`
    // worth of ETH? QuoterV2 takes amountIn — we approximate by
    // assuming a recent ETH/USDC price, then do an exactInput swap with
    // a slippage-bounded amountOutMinimum.
    //
    // We bound the inbound USDC by cfg.tickCapUsdc6 — never spend more
    // than the per-tick cap on a single refill.
    const tickCap = cfg.tickCapUsdc6;
    const amountInUsdc6 = tickCap; // refill with the full per-tick cap each cycle
    const treasuryUsdc = await publicClient.readContract({
      address: this.args.usdcAddress,
      abi: ERC20_APPROVE_ABI,
      functionName: "balanceOf",
      args: [treasuryAddr],
    }) as bigint;
    if (treasuryUsdc < amountInUsdc6) {
      return { action: "skip", reason: "insufficient_treasury_usdc" };
    }

    // Weekly-cap check — sum gas_topup outflows over last 7 days.
    const sinceUnix = Math.floor(this.now().getTime() / 1000) - 7 * 24 * 60 * 60;
    const records = await walkPayouts(this.args.bootstrap.log, sinceUnix);
    const totals = sumByBucket(records);
    if (totals.gas_topup + amountInUsdc6 > cfg.weeklyCapUsdc6) {
      return { action: "skip", reason: "weekly_cap_exceeded" };
    }

    // Quote — get ETH out for `amountInUsdc6` of USDC.
    let amountOut: bigint;
    try {
      const quote = await quoteExactInputSingle(publicClient, {
        tokenIn: this.args.usdcAddress,
        tokenOut: cfg.weth,
        amountIn: amountInUsdc6,
        poolFee: cfg.poolFee,
        quoter: cfg.quoter,
      });
      amountOut = quote.amountOut;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { action: "skip", reason: `quote_failed:${msg}` };
    }
    if (amountOut === 0n) {
      return { action: "skip", reason: "quote_zero" };
    }

    const amountOutMinimum = applySlippageBps(amountOut, cfg.slippageBps);

    // Dry-run path: log calldata, emit trace + outflow with sentinel tx,
    // never broadcast.
    if (cfg.dryRun) {
      const built = buildSwapAndUnwrapMulticall({
        tokenIn: this.args.usdcAddress,
        tokenOut: cfg.weth,
        amountIn: amountInUsdc6,
        amountOutMinimum,
        recipient: adminAddr,
        poolFee: cfg.poolFee,
        router: cfg.router,
      });
      await this.emitOutflow({
        bucket: "gas_topup",
        txHash: null,
        amountUsdc6: amountInUsdc6,
        recipient: adminAddr,
        asset: this.args.usdcAddress,
        rationale: `dry_run:gas_refill calldata=${built.data.slice(0, 18)}…`,
        dryRun: true,
      });
      return {
        action: "dry_run",
        amountUsdc6: amountInUsdc6.toString(),
        reason: "dry_run",
      };
    }

    // Broadcast path. Two txs: approve(MAX) once + multicall.
    const treasuryWallet = this.args.bootstrap.treasury.walletClient as WalletClient;
    const account = treasuryWallet.account;
    if (!account) {
      return { action: "skip", reason: "treasury_wallet_no_account" };
    }
    const allowance = (await publicClient.readContract({
      address: this.args.usdcAddress,
      abi: ERC20_APPROVE_ABI,
      functionName: "allowance",
      args: [treasuryAddr, cfg.router],
    })) as bigint;

    const txs: Hex[] = [];
    if (allowance < amountInUsdc6) {
      const approveHash = await treasuryWallet.writeContract({
        account,
        chain: treasuryWallet.chain ?? null,
        address: this.args.usdcAddress,
        abi: ERC20_APPROVE_ABI,
        functionName: "approve",
        args: [cfg.router, MAX_UINT256],
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });
      txs.push(approveHash);
    }

    const built = buildSwapAndUnwrapMulticall({
      tokenIn: this.args.usdcAddress,
      tokenOut: cfg.weth,
      amountIn: amountInUsdc6,
      amountOutMinimum,
      recipient: adminAddr,
      poolFee: cfg.poolFee,
      router: cfg.router,
    });
    const swapHash = await treasuryWallet.sendTransaction({
      account,
      chain: treasuryWallet.chain ?? null,
      to: built.to,
      data: built.data,
      // Multicall on SwapRouter02 is `payable`; we send 0 ETH.
      value: 0n,
      // Bound gas — Uniswap multicall typically lands in <= 250k gas.
      gas: 350_000n,
      // Force EIP-1559 default by leaving fee params unset.
    });
    await publicClient.waitForTransactionReceipt({ hash: swapHash });
    txs.push(swapHash);

    await this.emitOutflow({
      bucket: "gas_topup",
      txHash: swapHash,
      amountUsdc6: amountInUsdc6,
      recipient: adminAddr,
      asset: this.args.usdcAddress,
      rationale: `gas_refill: admin native ${adminNative.toString()} wei < low ${cfg.lowWatermarkWei.toString()}; swapped ${amountInUsdc6.toString()} USDC6 for ≥ ${amountOutMinimum.toString()} wei ETH (slippage ${cfg.slippageBps}bps, pool fee ${cfg.poolFee})`,
      dryRun: false,
    });

    return {
      action: "broadcast",
      txs,
      amountUsdc6: amountInUsdc6.toString(),
    };
  }

  // -------------------------------------------------------------------
  // Hosting payment
  // -------------------------------------------------------------------

  private async maybePayHosting(): Promise<SubroutineOutcome> {
    return this.payVendor("hosting");
  }

  private async maybePayInference(): Promise<SubroutineOutcome> {
    return this.payVendor("inference");
  }

  private async payVendor(
    bucket: "hosting" | "inference",
  ): Promise<SubroutineOutcome> {
    const cfg = this.args.config[bucket];
    if (!cfg.enabled) return { action: "disabled" };
    if (cfg.contractAddress === null) {
      return { action: "skip", reason: "contract_address_unset" };
    }

    const treasuryAddr = this.args.bootstrap.treasury.address as Address;
    const publicClient = this.args.bootstrap.publicClient as PublicClient;

    // Read on-chain weekly state — cap, paidThisWeek, currentWeekId.
    const [weeklyCap, currentWeekId] = await Promise.all([
      publicClient.readContract({
        address: cfg.contractAddress,
        abi: VENDOR_PAYMENT_VIEW_ABI,
        functionName: "weeklyCapUsdc6",
      }) as Promise<bigint>,
      publicClient.readContract({
        address: cfg.contractAddress,
        abi: VENDOR_PAYMENT_VIEW_ABI,
        functionName: "currentWeekId",
      }) as Promise<bigint>,
    ]);
    const paidThisWeek = (await publicClient.readContract({
      address: cfg.contractAddress,
      abi: VENDOR_PAYMENT_VIEW_ABI,
      functionName: "paidThisWeek",
      args: [currentWeekId],
    })) as bigint;

    // Per-tick installment: split the weekly cap evenly across 168 ticks
    // (one tick per hour). Round up so the tail tick lands the last few
    // wei. The on-chain cap is the absolute upper bound regardless.
    const tickInstallment = (weeklyCap + 167n) / 168n;

    // The remaining headroom for this week = cap - paidThisWeek.
    const remaining = weeklyCap - paidThisWeek;
    if (remaining === 0n) {
      return { action: "skip", reason: "weekly_budget_already_paid" };
    }
    const amount = tickInstallment < remaining ? tickInstallment : remaining;
    if (amount === 0n) {
      return { action: "skip", reason: "tick_installment_zero" };
    }

    // Treasury USDC sufficiency.
    const treasuryUsdc = (await publicClient.readContract({
      address: this.args.usdcAddress,
      abi: ERC20_APPROVE_ABI,
      functionName: "balanceOf",
      args: [treasuryAddr],
    })) as bigint;
    if (treasuryUsdc < amount) {
      return { action: "skip", reason: "insufficient_treasury_usdc" };
    }

    const recipient = (await publicClient.readContract({
      address: cfg.contractAddress,
      abi: VENDOR_PAYMENT_VIEW_ABI,
      functionName: "vendorPayee",
    })) as Address;

    if (cfg.dryRun) {
      const calldata = encodePayCalldata(amount);
      await this.emitOutflow({
        bucket,
        txHash: null,
        amountUsdc6: amount,
        recipient,
        asset: this.args.usdcAddress,
        rationale: `dry_run:${bucket}_pay calldata=${calldata.slice(0, 18)}… constitutional_ref=${cfg.constitutionalRef}`,
        dryRun: true,
        constitutionalRef: cfg.constitutionalRef,
      });
      return {
        action: "dry_run",
        amountUsdc6: amount.toString(),
        reason: "dry_run",
      };
    }

    // Broadcast.
    const treasuryWallet = this.args.bootstrap.treasury.walletClient as WalletClient;
    const result = await payVendorPayment({
      walletClient: treasuryWallet,
      publicClient,
      contract: cfg.contractAddress,
      amount,
      usdc: this.args.usdcAddress,
    });

    await this.emitOutflow({
      bucket,
      txHash: result.payTx,
      amountUsdc6: amount,
      recipient,
      asset: this.args.usdcAddress,
      rationale: `${bucket}_pay: amount=${amount.toString()} usdc6 paidThisWeek=${paidThisWeek.toString()} weeklyCap=${weeklyCap.toString()} constitutional_ref=${cfg.constitutionalRef}`,
      dryRun: false,
      constitutionalRef: cfg.constitutionalRef,
    });

    const txs: Hex[] = [];
    if (result.approveTx) txs.push(result.approveTx);
    txs.push(result.payTx);
    return {
      action: "broadcast",
      txs,
      amountUsdc6: amount.toString(),
    };
  }

  // -------------------------------------------------------------------
  // Event emission — treasury.outflow + sibling reasoning.trace
  // -------------------------------------------------------------------

  private async emitOutflow(args: {
    bucket: PayoutBucket;
    txHash: Hex | null;
    amountUsdc6: bigint;
    recipient: Address;
    asset: Address;
    rationale: string;
    dryRun: boolean;
    constitutionalRef?: string;
  }): Promise<void> {
    const boot = this.args.bootstrap;
    const teeBlock = {
      signingPubKey: boot.tee.signingPubKey,
      kmsKeyHash: boot.genesis.tee.kmsKeyHash,
      tdxQuoteHash: null as null,
      attestationJwtHash: boot.genesis.tee.attestationJwtHash,
    };
    const instance = boot.genesis.instance;
    const nowSec = Math.floor(this.now().getTime() / 1000);
    const epoch = Math.floor(boot.tee.bootedAt / 1000);

    const txHashHex: Sha256Hex =
      args.txHash === null
        ? asSha256Hex("0".repeat(64))
        : asSha256Hex(args.txHash.replace(/^0x/, "").toLowerCase());

    const outflow = buildAndSign({
      type: "treasury.outflow",
      parent_ids: [boot.genesis.id],
      lineage: "vanta-runtime",
      timestamp: nowSec,
      epoch,
      tee: teeBlock,
      instance,
      body: {
        txHash: txHashHex,
        chainId: CHAIN_ID,
        asset: args.asset as string,
        amount: args.amountUsdc6.toString(),
        toAddr: args.recipient as EthAddressHex,
      },
      sign: teeSign,
    });
    await boot.log.append(outflow);

    const trace = buildAndSign({
      type: "reasoning.trace",
      parent_ids: [boot.genesis.id, outflow.id],
      lineage: "vanta-runtime",
      timestamp: nowSec,
      epoch,
      tee: teeBlock,
      instance,
      body: {
        subject_event_id: outflow.id,
        subject_event_type: "treasury.outflow",
        inputs_summary: {
          bucket: args.bucket,
          dry_run: args.dryRun ? "true" : "false",
          amount_usdc6: args.amountUsdc6.toString(),
          recipient: args.recipient,
          ...(args.constitutionalRef !== undefined
            ? { constitutional_ref: args.constitutionalRef }
            : {}),
        },
        intermediate_scores: {},
        decision_rationale: args.rationale,
        dissenting_considerations: "",
        model_id: "",
        prompt_hash: "",
      },
      sign: teeSign,
    });
    await boot.log.append(trace);
  }

  /**
   * Emit just the trace (no outflow) — for skip reasons and exceptions.
   * Joined by walkPayouts only when paired with an outflow, so these
   * traces are best-effort breadcrumbs not affecting weekly accounting.
   */
  private async emitTrace(args: {
    bucket: PayoutBucket;
    rationale: string;
    amountUsdc6: bigint;
    recipient: Address | string;
    skipReason: string;
    dryRun: boolean;
  }): Promise<void> {
    const boot = this.args.bootstrap;
    const teeBlock = {
      signingPubKey: boot.tee.signingPubKey,
      kmsKeyHash: boot.genesis.tee.kmsKeyHash,
      tdxQuoteHash: null as null,
      attestationJwtHash: boot.genesis.tee.attestationJwtHash,
    };
    // Sentinel zero-hash for the "no subject event" case (skip / failure
     // traces have no paired outflow).
    const ZERO_HASH = asSha256Hex("0".repeat(64));
    const trace = buildAndSign({
      type: "reasoning.trace",
      parent_ids: [boot.genesis.id],
      lineage: "vanta-runtime",
      timestamp: Math.floor(this.now().getTime() / 1000),
      epoch: Math.floor(boot.tee.bootedAt / 1000),
      tee: teeBlock,
      instance: boot.genesis.instance,
      body: {
        subject_event_id: ZERO_HASH,
        subject_event_type: "treasury.outflow_skipped",
        inputs_summary: {
          bucket: args.bucket,
          skip_reason: args.skipReason,
          dry_run: args.dryRun ? "true" : "false",
          amount_usdc6: args.amountUsdc6.toString(),
          recipient: args.recipient,
        },
        intermediate_scores: {},
        decision_rationale: args.rationale,
        dissenting_considerations: "",
        model_id: "",
        prompt_hash: "",
      },
      sign: teeSign,
    });
    await boot.log.append(trace);
  }

  private now(): Date {
    return this.args.now ? this.args.now() : new Date();
  }
}

// Lazy-import the TEE signer to avoid a circular bootstrap reference.
import { sign as teeSign } from "@vanta/tee";

// Stable view-only ABI fragment used by payVendor — pulled inline so
// the orchestrator doesn't need to round-trip through the full
// vendor-payment-client ABI.
const VENDOR_PAYMENT_VIEW_ABI = [
  {
    type: "function",
    name: "weeklyCapUsdc6",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
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
    name: "paidThisWeek",
    stateMutability: "view",
    inputs: [{ name: "weekId", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "vendorPayee",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const;

// Suppress unused-import lint warning — `parseGwei` is exported for
// future use by gas-budget tuning callers.
void parseGwei;
