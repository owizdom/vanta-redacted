/**
 * Typed errors for the @vanta/treasury module.
 *
 * Mirrors the TeeError pattern (packages/tee/src/errors.ts): `code`,
 * frozen `context: Record<string, string>`, `name: "TreasuryError"`.
 *
 * Hard rule (spec §4): `context` NEVER carries the raw HKDF scalar,
 * the MNEMONIC, private-key bytes, or any entropy-bearing hex. Safe
 * fields: chainId (as string), scheduleId, code-adjacent metadata.
 */

export type TreasuryErrorCode =
  | "treasury_already_initialized"
  | "treasury_not_initialized"
  | "hkdf_scalar_invalid"
  | "rpc_unreachable"
  | "rpc_response_inconsistent"
  | "inflow_dedup_collision"
  | "balance_discrepancy_observed"
  | "schedule_entry_missing"
  | "schedule_amount_mismatch"
  | "schedule_period_exhausted"
  | "schedule_constitutional_ref_unresolved"
  | "outflow_dryrun_only";

export class TreasuryError extends Error {
  public override readonly name: "TreasuryError" = "TreasuryError";
  public readonly code: TreasuryErrorCode;
  public readonly context: Readonly<Record<string, string>>;

  public constructor(
    code: TreasuryErrorCode,
    message: string,
    context: Record<string, string> = {},
  ) {
    super(message);
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}
