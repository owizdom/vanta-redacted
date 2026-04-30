/**
 * Top-level pledge orchestrator.
 *
 * The flow is:
 *
 *   1. I-PL-3 registry gate        — borrower_proxy must be in the closed set.
 *   2. I-PL-3 fallback-handler gate — assertFallbackHandler reads the Safe's
 *                                     fallback slot and asserts
 *                                     CompatibilityFallbackHandler v1.3.0.
 *   3. I-PL-4 + I-PL-7 eligibility  — checkEligibility rolls up all four
 *                                     on-chain + CLOB resolution reads.
 *   4. I-PL-1 pre-check             — readBalance(borrower, positionId) >=
 *                                     amount. Telemetry, not authority.
 *   5. Safe meta-tx                 — buildPledgeExecTransaction → signAndBroadcast.
 *   6. I-PL-2 finality              — awaitFinality at depth >= 5.
 *   7. I-PL-1 post-check            — reReadVaultBalance at the confirmed block.
 *   8. Emit loan.pledge             — buildAndSign wraps the body per
 *                                     events/bodies.ts LoanPledgeBody schema.
 *
 * Every step throws a typed `PledgeError` with a specific code; the
 * orchestrator itself never returns a partial success.
 */

import type { PublicClient } from "viem";

import {
  buildAndSign,
  type BuildArgs,
  type LoanPledgeBody,
  type Sha256Hex,
  type SignFn,
  type SigningPubKeyHex,
  type VantaEventOfType,
} from "@vanta/events";
import { asSha256Hex } from "@vanta/tee";
import {
  PLEDGE_CONFIRMATION_DEPTH,
  asConditionId,
  asPositionId,
  asQuestionId,
  type SignDigestFn,
} from "@vanta/venue-poly";

import { checkEligibility, type ReadQuestionFn } from "./eligibility.js";
import { PledgeError } from "./errors.js";
import { assertFallbackHandler } from "./fallback.js";
import { awaitFinality, readBalance, reReadVaultBalance } from "./finality.js";
import {
  buildPledgeExecTransaction,
  signAndBroadcast,
  type SendExecTransactionFn,
} from "./signer.js";
import type {
  BorrowerRegistry,
  ClobResolutionSnapshot,
  PledgeReceipt,
  PledgeRequest,
  SignedLoanPledgeEvent,
} from "./types.js";

/**
 * TEE inner envelope fields the pledge event's `tee` sub-envelope needs.
 * Matches the @vanta/events `BuildArgs.tee` shape exactly; callers pass
 * the values from their runtime's `getAttestation` result.
 */
export interface PledgeTeeEnvelope {
  readonly signingPubKey: SigningPubKeyHex;
  readonly kmsKeyHash: Sha256Hex;
  readonly attestationJwtHash: Sha256Hex;
}

export interface PledgeArgs extends PledgeRequest {
  readonly client: PublicClient;
  readonly sign: SignFn;
  readonly signingPubKey: SigningPubKeyHex;
  readonly signDigest: SignDigestFn;
  readonly send: SendExecTransactionFn;
  readonly readQuestion: ReadQuestionFn;
  readonly marketResolutionFromClob: ClobResolutionSnapshot;
  readonly borrowerRegistry: BorrowerRegistry;
  readonly tee: PledgeTeeEnvelope;
  readonly instance: string;
  readonly lineage: string;
  readonly parentIds: readonly Sha256Hex[];
  readonly expectedNonce: bigint;
  readonly nowUnix: () => number;
  /** Optional epoch override; defaults to nowUnix(). */
  readonly epoch?: number;
  /** Optional override for the finality await cap (ms); defaults match finality.ts. */
  readonly finalityTimeoutMs?: number;
  readonly finalityPollIntervalMs?: number;
  readonly finalityNow?: () => number;
  readonly finalitySleep?: (ms: number) => Promise<void>;
}

function parseBigIntAmount(
  label: "amount" | "position_id",
  value: string,
): bigint {
  if (!/^[0-9]+$/.test(value)) {
    throw new PledgeError(
      "ineligible",
      `${label} must be a decimal-digit string`,
      { [label]: value },
    );
  }
  return BigInt(value);
}

function isRegistered(
  registry: BorrowerRegistry,
  proxy: string,
  ownerEOA: string,
): boolean {
  const proxyLower = proxy.toLowerCase();
  const ownerLower = ownerEOA.toLowerCase();
  return registry.some(
    (entry) =>
      entry.proxyAddress.toLowerCase() === proxyLower &&
      entry.ownerEOA.toLowerCase() === ownerLower,
  );
}

/**
 * Execute the full pledge pipeline, returning a `PledgeReceipt` on
 * success. Throws a typed `PledgeError` on every gate failure.
 */
export async function pledge(args: PledgeArgs): Promise<PledgeReceipt> {
  // ---- Parse numeric inputs once, up front ------------------------------
  const amount = parseBigIntAmount("amount", args.amount);
  const positionIdBig = parseBigIntAmount("position_id", args.position_id);
  const positionId = asPositionId(positionIdBig);
  const conditionId = asConditionId(args.condition_id);
  const questionId = asQuestionId(args.question_id);

  if (amount === 0n) {
    throw new PledgeError(
      "transfer_value_zero",
      "pledge amount cannot be 0 (value>0 refusal at the app boundary)",
      { amount: args.amount },
    );
  }

  // ---- I-PL-3 (registry) ------------------------------------------------
  if (!isRegistered(args.borrowerRegistry, args.borrower_proxy, args.expected_owner_eoa)) {
    throw new PledgeError(
      "proxy_not_in_registry",
      "borrower_proxy + expected_owner_eoa tuple is not in the borrower registry",
      {
        borrower_proxy: args.borrower_proxy,
        expected_owner_eoa: args.expected_owner_eoa,
      },
    );
  }

  // ---- I-PL-3 (fallback handler) ---------------------------------------
  await assertFallbackHandler(args.client, args.borrower_proxy);

  // ---- I-PL-4 + I-PL-7 (eligibility) -----------------------------------
  const eligibility = await checkEligibility({
    client: args.client,
    readQuestion: args.readQuestion,
    conditionId,
    questionId,
    outcomeSlotCount: args.outcome_slot_count,
    marketResolutionFromClob: args.marketResolutionFromClob,
  });
  if (!eligibility.ok) {
    throw new PledgeError(
      "ineligible",
      `pledge rejected: ${eligibility.reason}`,
      {
        reason: eligibility.reason,
        condition_id: args.condition_id,
        question_id: args.question_id,
      },
    );
  }

  // ---- I-PL-1 (pre-check) ----------------------------------------------
  const borrowerBalance = await readBalance(
    args.client,
    args.borrower_proxy,
    positionId,
  );
  if (borrowerBalance < amount) {
    throw new PledgeError(
      "insufficient_balance",
      "borrower proxy holds less CTF than the pledge amount",
      {
        borrower_proxy: args.borrower_proxy,
        position_id: args.position_id,
        expected: args.amount,
        observed: borrowerBalance.toString(),
      },
    );
  }

  // ---- Safe meta-tx build + broadcast ----------------------------------
  const { safeTx, digest } = await buildPledgeExecTransaction({
    client: args.client,
    borrowerProxy: args.borrower_proxy,
    vaultAddress: args.vault_address,
    positionId,
    amount,
    expectedNonce: args.expectedNonce,
    ownerEOA: args.expected_owner_eoa,
  });

  const { txHash, safeTxHash } = await signAndBroadcast({
    client: args.client,
    borrowerProxy: args.borrower_proxy,
    safeTx,
    signDigest: args.signDigest,
    send: args.send,
  });

  // Defense in depth — ensure the digest returned by signAndBroadcast
  // matches the digest we computed in buildPledgeExecTransaction.
  if (safeTxHash !== digest) {
    throw new PledgeError(
      "safe_broadcast_failed",
      "SafeTx digest returned by signAndBroadcast differs from the locally computed digest",
      { safeTxHash, digest },
    );
  }

  // ---- I-PL-2 (finality) -----------------------------------------------
  const finality = await awaitFinality({
    client: args.client,
    txHash,
    minDepth: PLEDGE_CONFIRMATION_DEPTH,
    expectedOperator: args.borrower_proxy,
    expectedFrom: args.borrower_proxy,
    expectedTo: args.vault_address,
    expectedId: positionIdBig,
    expectedAmount: amount,
    ...(args.finalityPollIntervalMs !== undefined
      ? { pollIntervalMs: args.finalityPollIntervalMs }
      : {}),
    ...(args.finalityTimeoutMs !== undefined
      ? { timeoutMs: args.finalityTimeoutMs }
      : {}),
    ...(args.finalityNow !== undefined ? { now: args.finalityNow } : {}),
    ...(args.finalitySleep !== undefined ? { sleep: args.finalitySleep } : {}),
  });

  // ---- I-PL-1 (post-check) ---------------------------------------------
  await reReadVaultBalance(
    args.client,
    args.vault_address,
    positionId,
    finality.blockNumber,
    amount,
  );

  // ---- Emit loan.pledge ------------------------------------------------
  const body: LoanPledgeBody = {
    loan_id: args.loan_id,
    borrower_proxy: args.borrower_proxy,
    position_id: args.position_id,
    amount: args.amount,
    vault_address: args.vault_address,
    tx_hash: asSha256Hex(
      txHash.startsWith("0x") ? txHash.slice(2) : txHash,
    ),
    block_number: finality.blockNumber,
    block_hash: finality.blockHash,
    log_index: finality.logIndex,
    confirmation_depth: PLEDGE_CONFIRMATION_DEPTH,
    condition_id: args.condition_id,
  };

  const now = args.nowUnix();
  const buildArgs: BuildArgs<"loan.pledge"> = {
    type: "loan.pledge",
    parent_ids: args.parentIds,
    lineage: args.lineage,
    timestamp: now,
    epoch: args.epoch ?? now,
    tee: {
      signingPubKey: args.signingPubKey,
      kmsKeyHash: args.tee.kmsKeyHash,
      tdxQuoteHash: null,
      attestationJwtHash: args.tee.attestationJwtHash,
    },
    instance: args.instance,
    body,
    sign: args.sign,
  };

  const event: SignedLoanPledgeEvent = buildAndSign(buildArgs);

  return {
    event,
    safe_tx_hash: safeTxHash,
    tx_hash: body.tx_hash,
    block_number: finality.blockNumber,
    block_hash: finality.blockHash,
    log_index: finality.logIndex,
    confirmation_depth: PLEDGE_CONFIRMATION_DEPTH,
  };
}

export type { SignedLoanPledgeEvent, VantaEventOfType };
