/**
 * Typed `ConstitutionBody` + zod schemas mirroring the §7 wire format.
 *
 * Every struct declares a `.strict()` zod schema — a smuggled unknown
 * top-level or nested field fails at structural parse time. Integer-only
 * and bps-only monetary fields; no floats anywhere in the signed
 * payload (spec §3 "Integer-only or bps-only monetary fields"). Branded
 * primitives (`SigningPubKeyHex`, `Sha256Hex`) are stamped by sibling
 * `canonical.ts` after structural parse succeeds.
 */

import { z } from "zod";

// --- Constants ----------------------------------------------------------

/**
 * Schema version. `v1` is the only accepted value; any other value
 * rejects with `UNSUPPORTED_SCHEMA_VERSION`.
 */
export const CONSTITUTION_SCHEMA_VERSION = "v1" as const;

/**
 * Agent name literal. The body is VANTA-specific — other agents get
 * their own constitution modules.
 */
export const AGENT_NAME = "vanta" as const;

/**
 * Maximum bps (basis points) value. 100% = 10_000 bps.
 */
export const BPS_CEILING = 10_000;

/**
 * Largest JCS-safe integer: `2^53 - 1`. Above this, RFC 8785 serializes
 * via IEEE-754 double and distinct u64 values can hash identically
 *. Matches the RFC 8785 safe-integer bound.
 */
export const MAX_SAFE_JSON_INTEGER = Number.MAX_SAFE_INTEGER;

/**
 * Minimum timelock: 1 hour in seconds. Below this, observers have no
 * realistic window to object.
 */
export const MIN_TIMELOCK_SECONDS = 3_600;

/**
 * Maximum timelock: 1 year in seconds. Above this, a malicious
 * amendment could permanently brick future governance.
 */
export const MAX_TIMELOCK_SECONDS = 365 * 24 * 3_600;

/**
 * Base Sepolia chain id. Hardcoded so an amendment cannot silently
 * retarget the L2.
 */
export const CHAIN_ID_BASE_SEPOLIA = 84_532;

/**
 * Polygon Amoy chain id. Polymarket's CTF venue.
 */
export const CHAIN_ID_POLYGON_AMOY = 80_002;

// --- Primitive schemas --------------------------------------------------

const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_128 = /^[0-9a-f]{128}$/;

/**
 * 64-char lowercase hex. Used for Ed25519 public keys and SHA-256
 * digests. Branding is applied by `canonical.ts`.
 */
const hex64Schema = z.string().regex(HEX_64, "must be 64-char lowercase hex");

/**
 * 128-char lowercase hex (64-byte Ed25519 signature).
 */
const hex128Schema = z.string().regex(HEX_128, "must be 128-char lowercase hex");

/**
 * Basis points: 0..10_000 inclusive. Integer-valued JSON number.
 */
const bpsSchema = z.number().int().min(0).max(BPS_CEILING);

/**
 * A JCS-safe unsigned integer. Rejects fractions, negatives, and values
 * above `2^53 - 1`.
 */
const safeUintSchema = z.number().int().nonnegative().max(MAX_SAFE_JSON_INTEGER);

/**
 * Unix milliseconds timestamp. Integer, non-negative; leaving the
 * upper bound at safe-int rules out overflow.
 */
const unixMsSchema = z.number().int().nonnegative().max(MAX_SAFE_JSON_INTEGER);

// --- Shared sub-structs -------------------------------------------------

/**
 * `(require, of)` threshold. At runtime `require >= 1` and
 * `require <= of` are checked in `semantic.ts`; the zod layer catches
 * negative or fractional values.
 */
export const thresholdSchema = z
  .object({
    require: z.number().int().min(1),
    of: z.number().int().min(1),
  })
  .strict();

export type Threshold = z.infer<typeof thresholdSchema>;

// --- Scope --------------------------------------------------------------

export const scopeSchema = z
  .object({
    venues: z.array(z.string()).readonly(),
    loan_kinds: z.array(z.string()).readonly(),
    borrower_residency_deny: z.array(z.string()).readonly(),
  })
  .strict();

export type Scope = z.infer<typeof scopeSchema>;

// --- Risk envelope ------------------------------------------------------

/**
 * Per-field bps range. Both bounds integer, `min <= max`, both within
 * `[0, 10_000]`. `semantic.ts` checks `baseline` lies inside the range.
 */
const bpsRangeSchema = z
  .object({
    min: bpsSchema,
    max: bpsSchema,
  })
  .strict();

const riskBaselineSchema = z
  .object({
    alpha_bps: bpsSchema,
    haircut_floor_bps: bpsSchema,
    reserve_ratio_bps: bpsSchema,
    max_single_loan_bps_of_treasury: bpsSchema,
    max_aggregate_exposure_bps_of_treasury: bpsSchema,
  })
  .strict();

const riskAllowedRangesSchema = z
  .object({
    alpha_bps: bpsRangeSchema,
    haircut_floor_bps: bpsRangeSchema,
    reserve_ratio_bps: bpsRangeSchema,
    max_single_loan_bps_of_treasury: bpsRangeSchema,
    max_aggregate_exposure_bps_of_treasury: bpsRangeSchema,
  })
  .strict();

export const riskEnvelopeSchema = z
  .object({
    baseline: riskBaselineSchema,
    allowed_ranges: riskAllowedRangesSchema,
  })
  .strict();

export type RiskEnvelope = z.infer<typeof riskEnvelopeSchema>;

// --- Treasury schedule --------------------------------------------------

/**
 * A single treasury outflow lane (one per recurring cost bucket).
 * Integer USD-cents; monthly-equivalent ceilings are aggregated in
 * `semantic.ts`.
 */
export const treasuryEntrySchema = z
  .object({
    label: z.string().min(1),
    cadence_days: z.number().int().min(1),
    ceiling_usd_cents: safeUintSchema,
  })
  .strict();

export type TreasuryEntry = z.infer<typeof treasuryEntrySchema>;

export const treasuryScheduleSchema = z
  .object({
    entries: z.array(treasuryEntrySchema).readonly(),
    overall_monthly_ceiling_usd_cents: safeUintSchema,
  })
  .strict();

export type TreasurySchedule = z.infer<typeof treasuryScheduleSchema>;

// --- Stewards -----------------------------------------------------------

export const stewardEntrySchema = z
  .object({
    handle: z.string().min(1),
    role: z.string().min(1),
    pubkey: hex64Schema,
    contact: z.string().min(1),
  })
  .strict();

export type StewardEntry = z.infer<typeof stewardEntrySchema>;

export const stewardSetSchema = z
  .object({
    entries: z.array(stewardEntrySchema).readonly(),
    threshold: thresholdSchema,
    note: z.string(),
  })
  .strict();

export type StewardSet = z.infer<typeof stewardSetSchema>;

// --- Governance ---------------------------------------------------------

export const amendmentProcedureSchema = z
  .object({
    threshold: thresholdSchema,
    timelock_seconds: z.number().int().min(0),
    timelock_contract: z.union([hex64Schema, z.null()]),
    dissent_window_seconds: z.number().int().min(0),
    observer_feed_url: z.string().url(),
  })
  .strict();

export type AmendmentProcedure = z.infer<typeof amendmentProcedureSchema>;

export const upgradeProcedureSchema = z
  .object({
    threshold: thresholdSchema,
    timelock_seconds: z.number().int().min(0),
    new_identity_signed_over_by_prior: z.boolean(),
    image_hash_publication: z.string().min(1),
  })
  .strict();

export type UpgradeProcedure = z.infer<typeof upgradeProcedureSchema>;

export const emergencyHaltSchema = z
  .object({
    enabled: z.boolean(),
    max_duration_seconds: z.number().int().min(0),
  })
  .strict();

export type EmergencyHalt = z.infer<typeof emergencyHaltSchema>;

/**
 * `stewards_multisig_address` is a 0x-prefixed 40-char hex address or
 * `null` (no multisig deployed in the sole-steward baseline; per spec
 * §11 a multisig is introduced alongside the threshold-reshare
 * amendment).
 */
const ethAddressOrNullSchema = z.union([
  z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be 0x-prefixed 40-char hex"),
  z.null(),
]);

export const governanceSchema = z
  .object({
    bootstrap_authority: z.enum(["agent", "stewards"]),
    stewards_multisig_address: ethAddressOrNullSchema,
    amendment_procedure: amendmentProcedureSchema,
    upgrade_procedure: upgradeProcedureSchema,
    emergency_halt: emergencyHaltSchema,
  })
  .strict();

export type Governance = z.infer<typeof governanceSchema>;

// --- Chain ids ----------------------------------------------------------

const chainIdsSchema = z
  .object({
    base_sepolia: z.number().int(),
    polygon_amoy: z.number().int(),
  })
  .strict();

export type ChainIds = z.infer<typeof chainIdsSchema>;

// --- Constitution body --------------------------------------------------

/**
 * The full typed body (the signed payload). Every field order matches
 * the §7 wire format example. All mutation flows through parse →
 * canonical → sign; mutation after signing is unrepresentable because
 * the body is returned frozen.
 */
export const constitutionBodySchema = z
  .object({
    schema_version: z.literal(CONSTITUTION_SCHEMA_VERSION),
    agent_name: z.literal(AGENT_NAME),
    agent_pk: hex64Schema,
    scope: scopeSchema,
    risk_envelope: riskEnvelopeSchema,
    treasury_schedule: treasuryScheduleSchema,
    stewards: stewardSetSchema,
    governance: governanceSchema,
    genesis_timestamp_unix: unixMsSchema,
    chain_ids: chainIdsSchema,
  })
  .strict();

export type ConstitutionBody = z.infer<typeof constitutionBodySchema>;

// --- Event payloads -----------------------------------------------------

/**
 * One entry inside `ConstitutionalGenesisPayload.signatures`. Under
 * the sole-steward baseline the VANTA agent pk is always
 * `signer_pubkey` (single-steward = the agent itself per spec §5
 * step 6). A fully formed genesis payload has exactly one entry.
 */
export const stewardSignatureSchema = z
  .object({
    signer_pubkey: hex64Schema,
    signature: hex128Schema,
    signed_at_unix_ms: unixMsSchema,
  })
  .strict();

export type StewardSignature = z.infer<typeof stewardSignatureSchema>;

/**
 * The payload field of a `constitutional.genesis` event. Wrapped by
 * `@vanta/events` into the event envelope — this package only
 * defines the payload shape and supplies the assembled struct via
 * `signGenesis`.
 */
export const constitutionalGenesisPayloadSchema = z
  .object({
    version: z.literal(CONSTITUTION_SCHEMA_VERSION),
    body: constitutionBodySchema,
    constitution_hash: hex64Schema,
    diff_summary: z.literal("genesis"),
    signatures: z.array(stewardSignatureSchema).readonly(),
  })
  .strict();

export type ConstitutionalGenesisPayload = z.infer<
  typeof constitutionalGenesisPayloadSchema
>;
