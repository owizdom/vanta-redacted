/**
 * Public types for the @vanta/pledge module.
 *
 * Every external input carries a branded type at the module boundary;
 * the orchestrator's own intermediate state stays internal.
 */

import type {
  EthAddressHex,
  Sha256Hex,
  VantaEventOfType,
} from "@vanta/events";

/**
 * Signed `loan.pledge` event narrowed by the discriminated union in
 * @vanta/events. Re-exported here so callers don't need to reach into
 * the union helper themselves.
 */
export type SignedLoanPledgeEvent = VantaEventOfType<"loan.pledge">;
export type SignedLoanPledgeRevokedEvent =
  VantaEventOfType<"loan.pledge_revoked">;

/**
 * Closed-set registry of borrower Gnosis Safe proxies the VANTA vault
 * accepts pledges from (I-PL-3). Builder asserts inclusion against this
 * set; the vault contract itself re-asserts at the EVM layer.
 */
export interface BorrowerRegistryEntry {
  readonly proxyAddress: EthAddressHex;
  readonly ownerEOA: EthAddressHex;
}

export type BorrowerRegistry = ReadonlyArray<BorrowerRegistryEntry>;

/**
 * All inputs to the top-level `pledge()` orchestrator. Amounts and
 * position ids are decimal-digit strings (I-EV-8), matching the
 * `loan.pledge` body shape.
 */
export interface PledgeRequest {
  readonly loan_id: Sha256Hex;
  readonly borrower_proxy: EthAddressHex;
  readonly vault_address: EthAddressHex;
  readonly position_id: string;
  readonly amount: string;
  readonly condition_id: Sha256Hex;
  readonly question_id: Sha256Hex;
  readonly outcome_slot_count: bigint;
  readonly expected_owner_eoa: EthAddressHex;
}

/**
 * Output of a successful `pledge()` call. Carries the signed event plus
 * the finality-confirmed on-chain citations so a caller can persist both
 * in the same transaction.
 */
export interface PledgeReceipt {
  readonly event: SignedLoanPledgeEvent;
  readonly safe_tx_hash: Sha256Hex;
  readonly tx_hash: Sha256Hex;
  readonly block_number: number;
  readonly block_hash: Sha256Hex;
  readonly log_index: number;
  readonly confirmation_depth: number;
}

/**
 * Output of `checkEligibility`. `ok: true` means the pledge may proceed;
 * `ok: false` carries the structured reason consumed by the
 * `ineligible` error detail. Reasons:
 *   - resolved        — CTF `payoutDenominator != 0` (I-PL-4)
 *   - halted          — UMA `paused=true` (I-PL-4)
 *   - disputed        — UMA `reset=true` (I-PL-4)
 *   - reset           — UMA `reset=true`, distinct from disputed path
 *   - refund          — UMA `refund=true` (I-PL-4)
 *   - clob_disagrees  — CLOB says `closed && winner` but on-chain says unresolved (I-PL-7)
 *   - slot_count_mismatch — CTF `getOutcomeSlotCount` != request.outcome_slot_count
 *
 * `disputed` and `reset` are currently produced by the same UMA flag;
 * kept distinct in the enum so a future UMA adapter revision that
 * separates them does not reshape this surface.
 */
export type PledgeEligibility =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        | "resolved"
        | "halted"
        | "disputed"
        | "reset"
        | "refund"
        | "clob_disagrees"
        | "slot_count_mismatch";
    };

/**
 * The CLOB-derived resolution snapshot the caller is expected to fetch
 * via `@vanta/mark`'s `fetchMarket` and pass in. Keeping it injected
 * keeps this module free of HTTP / TLS-pinning dependencies (spec-level
 * separation — mark is a distinct layer with its own attestation).
 */
export interface ClobResolutionSnapshot {
  readonly closed: boolean;
  readonly winners: readonly string[];
  readonly accepting_orders: boolean;
}

/**
 * Decoded `TransferSingle` log extracted by `awaitFinality`. Matches the
 * CTF ERC-1155 event shape — operator, from, to, id (uint256), value
 * (uint256). The caller uses `(from, to, id, value)` to cross-check
 * against the pledge's inputs.
 */
export interface TransferSingleLog {
  readonly operator: EthAddressHex;
  readonly from: EthAddressHex;
  readonly to: EthAddressHex;
  readonly id: bigint;
  readonly value: bigint;
  readonly logIndex: number;
}
