/**
 * Public types for the @vanta/origination module.
 *
 * `OriginationRequest` is the orchestrator's input — every field at the
 * module boundary carries a branded type or a constrained primitive.
 * `OriginationReceipt` is the output, carrying both the signed event and
 * the post-image on-chain citations a caller needs to persist alongside
 * the event.
 */

import type {
  EthAddressHex,
  Sha256Hex,
  SigningPubKeyHex,
  VantaEventOfType,
} from "@vanta/events";

/**
 * A signed `loan.origination` event narrowed by the discriminated union
 * in @vanta/events. Re-exported here so callers don't need to reach into
 * the union helper themselves.
 */
export type SignedLoanOriginationEvent = VantaEventOfType<"loan.origination">;

/**
 * TEE inner-envelope fields the origination event's `tee` sub-envelope
 * needs. Matches the @vanta/events `BuildArgs.tee` shape exactly;
 * callers pass the values from their runtime's `getAttestation` result.
 */
export interface OriginationTeeEnvelope {
  readonly signingPubKey: SigningPubKeyHex;
  readonly kmsKeyHash: Sha256Hex;
  readonly attestationJwtHash: Sha256Hex;
}

/**
 * Inputs to the top-level `originate()` orchestrator.
 *
 *   - `loan_id`              — the chosen 32-byte id (as 64-hex with `0x`
 *                              prefix; passed straight into LoanBook).
 *   - `pledge_event_id`      — id of the `loan.pledge` event whose USDC
 *                              release this origination triggers
 *                              (cited as a parent on the emitted event).
 *   - `borrower`             — must equal the pledge's `borrower_proxy`
 *                              (I-OR-5).
 *   - `principal_usdc`       — USDC wei (6 decimals) decimal-digit
 *                              string. Caller is responsible for
 *                              applying `floor((1 - h) * p * notional)`
 *                              upstream — see `@vanta/haircut` (I-OR-4).
 *   - `haircut_bps`          — 0..10000; matches LoanBook `uint32
 *                              haircutBps` field.
 *   - `maturity_ts_unix`     — uint64 unix seconds; must be in the
 *                              future relative to wall clock.
 *   - `risk_model_attestation_body` — raw JSON string; sha256 →
 *                              `attestation_hash` on-chain + on the
 *                              event body.
 */
export interface OriginationRequest {
  readonly loan_id: Sha256Hex;
  readonly pledge_event_id: Sha256Hex;
  readonly borrower: EthAddressHex;
  readonly principal_usdc: string;
  readonly haircut_bps: number;
  readonly maturity_ts_unix: number;
  readonly risk_model_attestation_body: string;
}

/**
 * Output of a successful `originate()` call. Carries the signed event
 * plus the on-chain citations a caller persists alongside the event.
 */
export interface OriginationReceipt {
  readonly event: SignedLoanOriginationEvent;
  readonly tx_hash: Sha256Hex;
  readonly block_number: number;
  readonly block_hash: Sha256Hex;
  readonly params_hash: Sha256Hex;
  readonly attestation_hash: Sha256Hex;
}
