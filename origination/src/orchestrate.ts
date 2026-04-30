/**
 * Top-level origination orchestrator.
 *
 * Implements the post-image flow (I-OR-3'):
 *
 *   1. Validate request inputs (decimal strings, ranges, future maturity).
 *   2. Compute `attestation_hash = sha256(risk_model_attestation_body)`.
 *   3. Compute `params_hash = keccak256(abi.encode(borrower, principal,
 *      haircut_bps, maturity_ts))` — the hash LoanBook will stamp.
 *   4. Verify the cited pledge event exists in the injected event log,
 *      that its `confirmation_depth >= 5` (I-OR-1), and that its
 *      `borrower_proxy` matches the request's `borrower` (I-OR-5).
 *   5. Broadcast `LoanBook.originate(...)` and wait for confirmation
 *      depth >= 2.
 *   6. Build the `loan.origination` event body, sign via the injected
 *      `SignFn` (the enclave's `@vanta/tee.sign`).
 *   7. Persist via the injected `appendEvent`.
 *   8. Return `OriginationReceipt`.
 *
 * The signed event's `parent_ids` ALWAYS includes `pledge_event_id`; if
 * the caller passes additional parents, they are appended after the
 * pledge id.
 */

import { createHash } from "node:crypto";

import type { Address, Hex, PublicClient, WalletClient } from "viem";

import {
  buildAndSign,
  type BuildArgs,
  type LoanOriginationBody,
  type Sha256Hex,
  type SignFn,
  type SigningPubKeyHex,
  type VantaEvent,
} from "@vanta/events";
import { asSha256Hex } from "@vanta/tee";

import {
  broadcastOriginate,
  ORIGINATION_FINALITY_DEPTH,
} from "./broadcast.js";
import { OriginationError } from "./errors.js";
import { computeParamsHash } from "./paramsHash.js";
import type {
  OriginationReceipt,
  OriginationRequest,
  OriginationTeeEnvelope,
  SignedLoanOriginationEvent,
} from "./types.js";

/**
 * Function the orchestrator calls to fetch a previously-signed event by
 * its id. Used to verify the cited pledge event exists and is finalised
 * before we touch the chain.
 */
export type LoadEventFn = (id: Sha256Hex) => VantaEvent | undefined;

/**
 * Function the orchestrator calls to persist the freshly-signed event.
 * Returns void; failures are reported by `appendEvent` throwing — the
 * orchestrator catches and rewraps as `event_sign_failed`.
 */
export type AppendEventFn = (event: SignedLoanOriginationEvent) => void;

export interface OriginateArgs extends OriginationRequest {
  readonly walletClient: WalletClient;
  readonly publicClient: PublicClient;
  readonly loanBookAddress: Address;
  readonly sign: SignFn;
  readonly signingPubKey: SigningPubKeyHex;
  readonly tee: OriginationTeeEnvelope;
  readonly instance: string;
  readonly lineage: string;
  /**
   * Optional additional parents (beyond the cited pledge event). The
   * pledge event id is always prepended.
   */
  readonly extraParentIds?: readonly Sha256Hex[];
  readonly loadEvent: LoadEventFn;
  readonly appendEvent: AppendEventFn;
  readonly nowUnix: () => number;
  readonly nowMs?: () => number;
  readonly epoch?: number;
  readonly finalityDepth?: number;
  readonly finalityPollIntervalMs?: number;
  readonly finalityTimeoutMs?: number;
  readonly finalitySleep?: (ms: number) => Promise<void>;
}

const HEX64 = /^[0-9a-f]{64}$/;
const ETH_ADDR = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL_DIGITS = /^[0-9]+$/;

function sha256HexFromBytes(bytes: Uint8Array): Sha256Hex {
  const h = createHash("sha256");
  h.update(bytes);
  return asSha256Hex(h.digest("hex"));
}

function sha256HexFromString(s: string): Sha256Hex {
  return sha256HexFromBytes(Buffer.from(s, "utf8"));
}

function bytes32FromSha256Hex(h: Sha256Hex): Hex {
  return `0x${h}` as Hex;
}

function strToAddress(addr: string): Address {
  return addr as Address;
}

function validateRequest(
  req: OriginationRequest,
  nowSeconds: number,
): void {
  if (!HEX64.test(req.loan_id)) {
    throw new OriginationError(
      "params_invalid",
      "loan_id must be 64-char lowercase hex (no 0x prefix)",
      { loan_id: req.loan_id },
    );
  }
  if (!HEX64.test(req.pledge_event_id)) {
    throw new OriginationError(
      "params_invalid",
      "pledge_event_id must be 64-char lowercase hex (no 0x prefix)",
      { pledge_event_id: req.pledge_event_id },
    );
  }
  if (!ETH_ADDR.test(req.borrower)) {
    throw new OriginationError(
      "params_invalid",
      "borrower must be a 0x-prefixed 20-byte hex address",
      { borrower: req.borrower },
    );
  }
  if (!DECIMAL_DIGITS.test(req.principal_usdc)) {
    throw new OriginationError(
      "params_invalid",
      "principal_usdc must be a decimal-digit string (USDC wei)",
      { principal_usdc: req.principal_usdc },
    );
  }
  if (req.principal_usdc === "0") {
    throw new OriginationError(
      "params_invalid",
      "principal_usdc must be > 0 (LoanBook reverts on zero principal)",
      { principal_usdc: req.principal_usdc },
    );
  }
  if (
    !Number.isInteger(req.haircut_bps) ||
    req.haircut_bps < 0 ||
    req.haircut_bps > 10000
  ) {
    throw new OriginationError(
      "params_invalid",
      "haircut_bps must be an integer in [0, 10000]",
      { haircut_bps: String(req.haircut_bps) },
    );
  }
  if (
    !Number.isInteger(req.maturity_ts_unix) ||
    req.maturity_ts_unix <= 0 ||
    !Number.isSafeInteger(req.maturity_ts_unix)
  ) {
    throw new OriginationError(
      "params_invalid",
      "maturity_ts_unix must be a positive safe-integer unix-seconds value",
      { maturity_ts_unix: String(req.maturity_ts_unix) },
    );
  }
  if (req.maturity_ts_unix <= nowSeconds) {
    throw new OriginationError(
      "params_invalid",
      "maturity_ts_unix must be in the future relative to nowUnix()",
      {
        maturity_ts_unix: String(req.maturity_ts_unix),
        nowSeconds: String(nowSeconds),
      },
    );
  }
}

const PLEDGE_FINALITY_MIN_DEPTH = 5;

/**
 * Verify the cited pledge event exists, is finalised, and matches the
 * request's borrower (I-OR-1 + I-OR-5).
 */
function checkPledgeEvent(
  req: OriginationRequest,
  loadEvent: LoadEventFn,
): void {
  const ev = loadEvent(req.pledge_event_id);
  if (ev === undefined) {
    throw new OriginationError(
      "pledge_not_finalized",
      "cited pledge event not found in injected log",
      { pledge_event_id: req.pledge_event_id },
    );
  }
  if (ev.type !== "loan.pledge") {
    throw new OriginationError(
      "pledge_not_finalized",
      "cited event is not a loan.pledge",
      {
        pledge_event_id: req.pledge_event_id,
        observed_type: ev.type,
      },
    );
  }
  // Schema requires confirmation_depth >= 5 at sign time, but a stale
  // ev that was generated under an older schema (or a corrupted log)
  // could still flow in. Re-check defensively.
  if (ev.body.confirmation_depth < PLEDGE_FINALITY_MIN_DEPTH) {
    throw new OriginationError(
      "pledge_not_finalized",
      "cited pledge event confirmation_depth is below the I-OR-1 minimum",
      {
        pledge_event_id: req.pledge_event_id,
        observed_depth: String(ev.body.confirmation_depth),
        required_depth: String(PLEDGE_FINALITY_MIN_DEPTH),
      },
    );
  }
  if (ev.body.borrower_proxy.toLowerCase() !== req.borrower.toLowerCase()) {
    throw new OriginationError(
      "borrower_mismatch",
      "request.borrower does not match the cited pledge event's borrower_proxy",
      {
        pledge_event_id: req.pledge_event_id,
        request_borrower: req.borrower,
        pledge_borrower_proxy: ev.body.borrower_proxy,
      },
    );
  }
}

/**
 * Execute the full origination pipeline.
 *
 * Throws `OriginationError` with a typed code on any gate failure;
 * never returns a partial success.
 */
export async function originate(
  args: OriginateArgs,
): Promise<OriginationReceipt> {
  const nowSeconds = args.nowUnix();
  validateRequest(
    {
      loan_id: args.loan_id,
      pledge_event_id: args.pledge_event_id,
      borrower: args.borrower,
      principal_usdc: args.principal_usdc,
      haircut_bps: args.haircut_bps,
      maturity_ts_unix: args.maturity_ts_unix,
      risk_model_attestation_body: args.risk_model_attestation_body,
    },
    nowSeconds,
  );

  // ---- Step 4: pledge-event verification -----------------------------------
  checkPledgeEvent(args, args.loadEvent);

  // ---- Step 2 + 3: hashes that LoanBook will independently stamp -----------
  const attestationHash = sha256HexFromString(args.risk_model_attestation_body);
  const paramsHash = computeParamsHash(
    strToAddress(args.borrower),
    args.principal_usdc,
    args.haircut_bps,
    args.maturity_ts_unix,
  );

  // ---- Step 5: broadcast LoanBook.originate(...) ---------------------------
  const broadcast = await broadcastOriginate({
    walletClient: args.walletClient,
    publicClient: args.publicClient,
    loanBookAddress: args.loanBookAddress,
    originateArgs: {
      loanId: bytes32FromSha256Hex(args.loan_id),
      borrower: strToAddress(args.borrower),
      principal: BigInt(args.principal_usdc),
      haircutBps: args.haircut_bps,
      maturityTs: BigInt(args.maturity_ts_unix),
      attestationHash: bytes32FromSha256Hex(attestationHash),
    },
    ...(args.finalityDepth !== undefined
      ? { finalityDepth: args.finalityDepth }
      : {}),
    ...(args.finalityPollIntervalMs !== undefined
      ? { pollIntervalMs: args.finalityPollIntervalMs }
      : {}),
    ...(args.finalityTimeoutMs !== undefined
      ? { timeoutMs: args.finalityTimeoutMs }
      : {}),
    ...(args.nowMs !== undefined ? { now: args.nowMs } : {}),
    ...(args.finalitySleep !== undefined
      ? { sleep: args.finalitySleep }
      : {}),
  });

  // ---- Step 6: build + sign the loan.origination event ---------------------
  const txHashStripped = broadcast.txHash.startsWith("0x")
    ? broadcast.txHash.slice(2)
    : broadcast.txHash;
  const blockHashStripped = broadcast.blockHash.startsWith("0x")
    ? broadcast.blockHash.slice(2)
    : broadcast.blockHash;

  const body: LoanOriginationBody = {
    loan_id: args.loan_id,
    borrower: args.borrower,
    principal: args.principal_usdc,
    haircut_bps: args.haircut_bps,
    maturity_ts_unix: args.maturity_ts_unix,
    attestation_hash: attestationHash,
    tx_hash: asSha256Hex(txHashStripped.toLowerCase()),
    block_number: broadcast.blockNumber,
    block_hash: asSha256Hex(blockHashStripped.toLowerCase()),
    params_hash: paramsHash,
  };

  const parentIds: readonly Sha256Hex[] = args.extraParentIds
    ? [args.pledge_event_id, ...args.extraParentIds]
    : [args.pledge_event_id];

  const buildArgs: BuildArgs<"loan.origination"> = {
    type: "loan.origination",
    parent_ids: parentIds,
    lineage: args.lineage,
    timestamp: nowSeconds,
    epoch: args.epoch ?? nowSeconds,
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

  let event: SignedLoanOriginationEvent;
  try {
    event = buildAndSign(buildArgs);
  } catch (cause: unknown) {
    throw new OriginationError(
      "event_sign_failed",
      "buildAndSign(loan.origination) failed after on-chain confirmation",
      {
        loan_id: args.loan_id,
        tx_hash: txHashStripped.toLowerCase(),
      },
      cause,
    );
  }

  // ---- Step 7: persist via injected log ------------------------------------
  try {
    args.appendEvent(event);
  } catch (cause: unknown) {
    throw new OriginationError(
      "event_sign_failed",
      "appendEvent failed after build+sign succeeded",
      {
        loan_id: args.loan_id,
        event_id: event.id,
      },
      cause,
    );
  }

  return {
    event,
    tx_hash: body.tx_hash,
    block_number: body.block_number,
    block_hash: body.block_hash,
    params_hash: body.params_hash,
    attestation_hash: body.attestation_hash,
  };
}

/** Re-export the finality default so callers can audit the choice. */
export { ORIGINATION_FINALITY_DEPTH };
