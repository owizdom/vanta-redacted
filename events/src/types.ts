/**
 * Public types for the @vanta/events module.
 *
 * Branded primitives (spec §1.1) carry compile-time tags so validated
 * encodings cannot be confused with raw strings. `CanonicalJsonBytes` is
 * minted only by `canonical.ts::canonicalJsonBytes`; external callers
 * must never widen raw `Uint8Array` to this brand.
 *
 * Re-exports from `@vanta/tee` are cited at TEE-SRC types.ts L14-L21.
 */

import { asSha256Hex } from "@vanta/tee";
import type { Sha256Hex, SigningPubKeyHex } from "@vanta/tee";

import { EventsError } from "./errors.js";

export type { AttestationJwt, Sha256Hex, SigningPubKeyHex } from "@vanta/tee";
export { asSha256Hex, asSigningPubKeyHex } from "@vanta/tee";

/**
 * Bytes produced by our RFC 8785 canonicalizer (spec §D2). The brand
 * prevents a raw `Uint8Array` from flowing into an id or signature
 * routine without passing through `canonicalJsonBytes`.
 */
export type CanonicalJsonBytes = Uint8Array & {
  readonly __brand: "canonical-json-bytes";
};

/**
 * Discriminator (spec §1.2). Frozen at Week 1 close per BM1 §7 rule 2.
 * Adding a variant is a semver break and requires an API_FROZEN bump.
 *
 * Month-2 addition: `op.inference` (audit record for an LLM call —
 * wizard, population bot, or model-loop role). API_FROZEN bumped to v2.
 *
 * v3 additions: trading-loop primaries (`trade.decision`,
 * `trade.executed`, `trade.closed`), depositor flows
 * (`pool.deposit`, `pool.withdraw`), belief snapshots
 * (`belief.updated`), and the in-world island-selection event
 * (`visitor.island_entered`). Every v3 body carries `agent_id` so
 * fleet-host consumers can filter per-VANTA. API_FROZEN bumped to v3.
 */
export type EventType =
  | "tee.attestation"
  | "constitutional.genesis"
  | "treasury.inflow"
  | "treasury.outflow"
  | "loan.origination"
  | "loan.pledge"
  | "loan.mark"
  | "loan.pledge_revoked"
  | "loan.mark_revoked"
  | "loan.settlement"
  | "loan.liquidation"
  | "op.mark_gap"
  | "op.mark_sparse"
  | "op.inference"
  | "reasoning.trace"
  | "loop.credit_tick"
  | "loop.calibration_proposal"
  | "loop.onboard_decision"
  | "op.treasury_alert"
  | "op.operational_anomaly"
  | "trade.decision"
  | "trade.executed"
  | "trade.closed"
  | "pool.deposit"
  | "pool.withdraw"
  | "belief.updated"
  | "visitor.island_entered"
  | "npc.thought"
  | "council.synthesised";

import type {
  BeliefUpdatedBody,
  ConstitutionalGenesisBody,
  CouncilSynthesisedBody,
  LoanLiquidationBody,
  LoanMarkBody,
  LoanMarkRevokedBody,
  LoanOriginationBody,
  LoanPledgeBody,
  LoanPledgeRevokedBody,
  LoanSettlementBody,
  LoopCalibrationProposalBody,
  LoopCreditTickBody,
  LoopOnboardDecisionBody,
  NpcThoughtBody,
  OpInferenceBody,
  OpMarkGapBody,
  OpMarkSparseBody,
  OpOperationalAnomalyBody,
  OpTreasuryAlertBody,
  PoolDepositBody,
  PoolWithdrawBody,
  ReasoningTraceBody,
  TeeAttestationBody,
  TradeClosedBody,
  TradeDecisionBody,
  TradeExecutedBody,
  TreasuryInflowBody,
  TreasuryOutflowBody,
  VisitorIslandEnteredBody,
} from "./bodies.js";

/**
 * Frozen top-level envelope (spec §1.2). `version` and `lineage` shape
 * frozen Week 1; `tee.tdxQuoteHash` is a literal `null` per TEE-SPEC §2;
 * `signature` is a 128-char lowercase hex string.
 */
export interface VantaEventBase {
  readonly id: Sha256Hex;
  readonly version: "v1";
  readonly parent_ids: readonly Sha256Hex[];
  readonly type: EventType;
  readonly lineage: string;
  readonly timestamp: number;
  readonly epoch: number;
  readonly tee: {
    readonly signingPubKey: SigningPubKeyHex;
    readonly kmsKeyHash: Sha256Hex;
    readonly tdxQuoteHash: null;
    readonly attestationJwtHash: Sha256Hex;
  };
  readonly instance: string;
  readonly signature: string;
}

/** Discriminated union of concrete event shapes (spec §1.2). */
export type VantaEvent =
  | (VantaEventBase & { readonly type: "tee.attestation"; readonly body: TeeAttestationBody })
  | (VantaEventBase & { readonly type: "constitutional.genesis"; readonly body: ConstitutionalGenesisBody })
  | (VantaEventBase & { readonly type: "treasury.inflow"; readonly body: TreasuryInflowBody })
  | (VantaEventBase & { readonly type: "treasury.outflow"; readonly body: TreasuryOutflowBody })
  | (VantaEventBase & { readonly type: "loan.origination"; readonly body: LoanOriginationBody })
  | (VantaEventBase & { readonly type: "loan.pledge"; readonly body: LoanPledgeBody })
  | (VantaEventBase & { readonly type: "loan.mark"; readonly body: LoanMarkBody })
  | (VantaEventBase & { readonly type: "loan.pledge_revoked"; readonly body: LoanPledgeRevokedBody })
  | (VantaEventBase & { readonly type: "loan.mark_revoked"; readonly body: LoanMarkRevokedBody })
  | (VantaEventBase & { readonly type: "loan.settlement"; readonly body: LoanSettlementBody })
  | (VantaEventBase & { readonly type: "loan.liquidation"; readonly body: LoanLiquidationBody })
  | (VantaEventBase & { readonly type: "op.mark_gap"; readonly body: OpMarkGapBody })
  | (VantaEventBase & { readonly type: "op.mark_sparse"; readonly body: OpMarkSparseBody })
  | (VantaEventBase & { readonly type: "op.inference"; readonly body: OpInferenceBody })
  | (VantaEventBase & { readonly type: "reasoning.trace"; readonly body: ReasoningTraceBody })
  | (VantaEventBase & { readonly type: "loop.credit_tick"; readonly body: LoopCreditTickBody })
  | (VantaEventBase & { readonly type: "loop.calibration_proposal"; readonly body: LoopCalibrationProposalBody })
  | (VantaEventBase & { readonly type: "loop.onboard_decision"; readonly body: LoopOnboardDecisionBody })
  | (VantaEventBase & { readonly type: "op.treasury_alert"; readonly body: OpTreasuryAlertBody })
  | (VantaEventBase & { readonly type: "op.operational_anomaly"; readonly body: OpOperationalAnomalyBody })
  | (VantaEventBase & { readonly type: "trade.decision"; readonly body: TradeDecisionBody })
  | (VantaEventBase & { readonly type: "trade.executed"; readonly body: TradeExecutedBody })
  | (VantaEventBase & { readonly type: "trade.closed"; readonly body: TradeClosedBody })
  | (VantaEventBase & { readonly type: "pool.deposit"; readonly body: PoolDepositBody })
  | (VantaEventBase & { readonly type: "pool.withdraw"; readonly body: PoolWithdrawBody })
  | (VantaEventBase & { readonly type: "belief.updated"; readonly body: BeliefUpdatedBody })
  | (VantaEventBase & { readonly type: "visitor.island_entered"; readonly body: VisitorIslandEnteredBody })
  | (VantaEventBase & { readonly type: "npc.thought"; readonly body: NpcThoughtBody })
  | (VantaEventBase & { readonly type: "council.synthesised"; readonly body: CouncilSynthesisedBody });

/** Per-type narrowing helper (spec §1.2). */
export type VantaEventOfType<T extends EventType> = Extract<VantaEvent, { type: T }>;

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Three-state id helper (spec §1.1). Accepts `""` (pre-signing preimage
 * placeholder) or a valid 64-char lowercase hex. Unlike `asSha256Hex`,
 * this function returns the untagged empty string for the preimage case
 * so that the permissive schema can accept it.
 */
export function asSha256HexOrEmpty(s: string): "" | Sha256Hex {
  if (s === "") {
    return "";
  }
  if (!HEX64.test(s)) {
    throw new EventsError(
      "schema_invalid",
      "asSha256HexOrEmpty: input must be empty string or 64-char lowercase hex",
      { actualLen: String(s.length) },
    );
  }
  return asSha256Hex(s);
}

/**
 * Stamp brand types onto a zod-validated envelope. The schemas have
 * already regex-checked every field that carries a brand (hex64, hex128,
 * ethAddr), so the brand assertions are safe. The cast is load-bearing
 * and isolated to this one helper (spec §D12 correspondence contract).
 */
export function brandStampEvent(record: {
  readonly id: string;
  readonly version: "v1";
  readonly parent_ids: readonly string[];
  readonly type: EventType;
  readonly lineage: string;
  readonly timestamp: number;
  readonly epoch: number;
  readonly tee: {
    readonly signingPubKey: string;
    readonly kmsKeyHash: string;
    readonly tdxQuoteHash: null;
    readonly attestationJwtHash: string;
  };
  readonly instance: string;
  readonly signature: string;
  readonly body: unknown;
}): VantaEvent {
  // All hex strings were regex-validated by the zod schema that produced
  // `record`; stamping the brand is correctness-preserving. A single
  // widening cast lets us hand back the branded discriminated union.
  return record as unknown as VantaEvent;
}
