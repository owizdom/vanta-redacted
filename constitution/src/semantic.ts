/**
 * Semantic validator for a structurally-parsed `ConstitutionBody`.
 *
 * Second layer of the two-layer parse pipeline (zod → semantic).
 * Catches constraint violations that the zod layer cannot express
 * structurally — range checks, safe-int ceilings, threshold sanity,
 * the allowed-chain-id set, and the bps range of every risk-envelope
 * baseline.
 *
 * Every check emits a specific `ConstitutionErrorCode` from the
 * spec §4 union. Runs in a fixed order; first failure returns.
 */

import { ConstitutionError } from "./errors.js";
import {
  AGENT_NAME,
  BPS_CEILING,
  CHAIN_ID_BASE_SEPOLIA,
  CHAIN_ID_POLYGON_AMOY,
  CONSTITUTION_SCHEMA_VERSION,
  MAX_SAFE_JSON_INTEGER,
  MAX_TIMELOCK_SECONDS,
  MIN_TIMELOCK_SECONDS,
} from "./schema.js";
import type {
  ConstitutionBody,
  RiskEnvelope,
  Threshold,
  TreasurySchedule,
} from "./schema.js";

// --- Helpers ------------------------------------------------------------

function checkThreshold(t: Threshold, field: string): void {
  if (t.require < 1) {
    throw new ConstitutionError(
      "INVALID_THRESHOLD",
      `threshold.require must be >= 1`,
      { field, require: t.require, of: t.of },
    );
  }
  if (t.require > t.of) {
    throw new ConstitutionError(
      "INVALID_THRESHOLD",
      `threshold.require must be <= threshold.of`,
      { field, require: t.require, of: t.of },
    );
  }
}

function checkBpsInRange(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > BPS_CEILING) {
    throw new ConstitutionError(
      "BPS_OUT_OF_RANGE",
      `bps field ${field} must be integer in [0, ${BPS_CEILING}]`,
      { field, value, min: 0, max: BPS_CEILING },
    );
  }
}

function checkSafeInt(value: number, field: string): void {
  if (
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_SAFE_JSON_INTEGER
  ) {
    throw new ConstitutionError(
      "TREASURY_CEILING_EXCEEDS_SAFE_INT",
      `integer field ${field} must be in [0, ${MAX_SAFE_JSON_INTEGER}]`,
      { field, value, cap: MAX_SAFE_JSON_INTEGER },
    );
  }
}

function checkTimelockBound(seconds: number, field: string): void {
  if (
    !Number.isInteger(seconds) ||
    seconds < MIN_TIMELOCK_SECONDS ||
    seconds > MAX_TIMELOCK_SECONDS
  ) {
    throw new ConstitutionError(
      "TIMELOCK_BOUND_VIOLATION",
      `${field} must be in [${MIN_TIMELOCK_SECONDS}, ${MAX_TIMELOCK_SECONDS}]`,
      { field, seconds, min: MIN_TIMELOCK_SECONDS, max: MAX_TIMELOCK_SECONDS },
    );
  }
}

// --- Risk envelope ------------------------------------------------------

function validateRiskEnvelope(envelope: RiskEnvelope): void {
  // Every baseline field lies inside [min, max] of its allowed range.
  // Also checks min <= max within each range.
  const fields = [
    "alpha_bps",
    "haircut_floor_bps",
    "reserve_ratio_bps",
    "max_single_loan_bps_of_treasury",
    "max_aggregate_exposure_bps_of_treasury",
  ] as const;

  for (const field of fields) {
    const baseline = envelope.baseline[field];
    const range = envelope.allowed_ranges[field];
    checkBpsInRange(baseline, `risk_envelope.baseline.${field}`);
    checkBpsInRange(range.min, `risk_envelope.allowed_ranges.${field}.min`);
    checkBpsInRange(range.max, `risk_envelope.allowed_ranges.${field}.max`);
    if (range.min > range.max) {
      throw new ConstitutionError(
        "RISK_ENVELOPE_BOUND_VIOLATION",
        `risk_envelope.allowed_ranges.${field}: min > max`,
        { field, min: range.min, max: range.max },
      );
    }
    if (baseline < range.min || baseline > range.max) {
      throw new ConstitutionError(
        "RISK_ENVELOPE_BOUND_VIOLATION",
        `risk_envelope.baseline.${field} outside allowed_ranges`,
        {
          field,
          baseline,
          min: range.min,
          max: range.max,
        },
      );
    }
  }
}

// --- Treasury schedule --------------------------------------------------

/**
 * 30-day reference month used to normalize lane cadences to monthly
 * equivalents for the aggregate-ceiling coherence check. A calendar-
 * accurate conversion (28/30/31) would be over-engineering — the
 * check is a sanity guard, not a time-series computation.
 */
const DAYS_PER_MONTH = 30;

function validateTreasurySchedule(schedule: TreasurySchedule): void {
  checkSafeInt(
    schedule.overall_monthly_ceiling_usd_cents,
    "treasury_schedule.overall_monthly_ceiling_usd_cents",
  );
  let summedMonthlyEquivalent = 0;
  for (let i = 0; i < schedule.entries.length; i++) {
    // `noUncheckedIndexedAccess` forces an undefined guard.
    const entry = schedule.entries[i];
    if (entry === undefined) {
      // Unreachable: the loop bound is the array's length.
      throw new ConstitutionError(
        "TREASURY_CEILING_EXCEEDS_SAFE_INT",
        `treasury_schedule.entries[${i}] missing`,
        { index: i },
      );
    }
    checkSafeInt(
      entry.ceiling_usd_cents,
      `treasury_schedule.entries[${i}].ceiling_usd_cents`,
    );
    if (entry.cadence_days < 1) {
      throw new ConstitutionError(
        "TREASURY_CEILING_EXCEEDS_SAFE_INT",
        `treasury_schedule.entries[${i}].cadence_days must be >= 1`,
        { index: i, cadence_days: entry.cadence_days },
      );
    }
    // Normalize this lane to a 30-day equivalent. Integer math only.
    // `ceiling_usd_cents` is the per-cadence ceiling; over 30 days
    // it fires (30 / cadence_days) times (rounded down, defensive).
    const firings = Math.floor(DAYS_PER_MONTH / entry.cadence_days);
    const monthlyEquivalent = firings * entry.ceiling_usd_cents;
    // Overflow guard: both operands are bounded by MAX_SAFE_JSON_INTEGER
    // but their product could overflow. Check before accumulation.
    if (!Number.isSafeInteger(monthlyEquivalent)) {
      throw new ConstitutionError(
        "TREASURY_CEILING_EXCEEDS_SAFE_INT",
        `treasury_schedule.entries[${i}] monthly-equivalent overflows safe int`,
        { index: i, firings, ceiling: entry.ceiling_usd_cents },
      );
    }
    summedMonthlyEquivalent += monthlyEquivalent;
    if (!Number.isSafeInteger(summedMonthlyEquivalent)) {
      throw new ConstitutionError(
        "TREASURY_CEILING_EXCEEDS_SAFE_INT",
        `treasury_schedule aggregate monthly-equivalent overflows safe int`,
        { index: i },
      );
    }
  }
  if (schedule.overall_monthly_ceiling_usd_cents < summedMonthlyEquivalent) {
    throw new ConstitutionError(
      "TREASURY_AGGREGATE_CEILING_INCONSISTENT",
      `overall_monthly_ceiling_usd_cents (${schedule.overall_monthly_ceiling_usd_cents}) < sum of monthly-equivalents (${summedMonthlyEquivalent})`,
      {
        overall: schedule.overall_monthly_ceiling_usd_cents,
        summedMonthlyEquivalent,
      },
    );
  }
}

// --- Entry point --------------------------------------------------------

/**
 * Run every semantic check defined by spec §2 / §4. First failure
 * throws `ConstitutionError` with the specific code; on success
 * returns undefined.
 *
 * Order (matches spec §4 listing for determinism):
 *
 * 1. schema_version
 * 2. agent_name
 * 3. agent_pk hex format already checked by zod — re-asserted here
 *    as defence against direct struct construction.
 * 4. stewards threshold and count
 * 5. bps ranges (risk envelope)
 * 6. treasury safe-int + aggregate coherence
 * 7. chain IDs match allowed set
 * 8. emergency halt duration
 * 9. timelocks within [1h, 1y]
 */
export function validateSemantic(body: ConstitutionBody): void {
  // 1. schema_version — zod enforces literal but a direct struct
  //    construction could bypass. Re-assert defensively.
  if (body.schema_version !== CONSTITUTION_SCHEMA_VERSION) {
    throw new ConstitutionError(
      "UNSUPPORTED_SCHEMA_VERSION",
      `schema_version must be "${CONSTITUTION_SCHEMA_VERSION}"`,
      { got: body.schema_version, expected: CONSTITUTION_SCHEMA_VERSION },
    );
  }

  // 2. agent_name must be the literal "vanta".
  if (body.agent_name !== AGENT_NAME) {
    throw new ConstitutionError(
      "AGENT_NAME_MISMATCH",
      `agent_name must be "${AGENT_NAME}"`,
      { got: body.agent_name, expected: AGENT_NAME },
    );
  }

  // 3. agent_pk: 64-char lowercase hex. zod already checked but
  //    direct struct construction could bypass.
  if (!/^[0-9a-f]{64}$/.test(body.agent_pk)) {
    throw new ConstitutionError(
      "INVALID_AGENT_PK",
      `agent_pk must be 64-char lowercase hex`,
      { length: body.agent_pk.length },
    );
  }

  // 4. Stewards threshold sanity + count coherence.
  checkThreshold(body.stewards.threshold, "stewards.threshold");
  if (body.stewards.entries.length !== body.stewards.threshold.of) {
    throw new ConstitutionError(
      "STEWARDS_COUNT_MISMATCH",
      `stewards.entries.length (${body.stewards.entries.length}) !== stewards.threshold.of (${body.stewards.threshold.of})`,
      {
        entries: body.stewards.entries.length,
        of: body.stewards.threshold.of,
      },
    );
  }
  for (let i = 0; i < body.stewards.entries.length; i++) {
    const entry = body.stewards.entries[i];
    if (entry === undefined) {
      // Unreachable: loop bound is array length.
      throw new ConstitutionError(
        "STEWARDS_COUNT_MISMATCH",
        `stewards.entries[${i}] missing`,
        { index: i },
      );
    }
    if (!/^[0-9a-f]{64}$/.test(entry.pubkey)) {
      throw new ConstitutionError(
        "INVALID_AGENT_PK",
        `stewards.entries[${i}].pubkey must be 64-char lowercase hex`,
        { index: i, length: entry.pubkey.length },
      );
    }
  }

  // 5. Risk envelope baselines inside allowed_ranges.
  validateRiskEnvelope(body.risk_envelope);

  // 6. Treasury ceilings safe + aggregate coherent.
  validateTreasurySchedule(body.treasury_schedule);

  // 7. Chain IDs match the allowed set.
  if (body.chain_ids.base_sepolia !== CHAIN_ID_BASE_SEPOLIA) {
    throw new ConstitutionError(
      "CHAIN_ID_UNSUPPORTED",
      `chain_ids.base_sepolia must be ${CHAIN_ID_BASE_SEPOLIA}`,
      { got: body.chain_ids.base_sepolia, expected: CHAIN_ID_BASE_SEPOLIA },
    );
  }
  if (body.chain_ids.polygon_amoy !== CHAIN_ID_POLYGON_AMOY) {
    throw new ConstitutionError(
      "CHAIN_ID_UNSUPPORTED",
      `chain_ids.polygon_amoy must be ${CHAIN_ID_POLYGON_AMOY}`,
      { got: body.chain_ids.polygon_amoy, expected: CHAIN_ID_POLYGON_AMOY },
    );
  }

  // 8. Emergency halt: if enabled, duration must be positive.
  if (
    body.governance.emergency_halt.enabled &&
    body.governance.emergency_halt.max_duration_seconds === 0
  ) {
    throw new ConstitutionError(
      "EMERGENCY_HALT_DURATION_INVALID",
      `emergency_halt.max_duration_seconds must be > 0 when emergency_halt.enabled is true`,
      {},
    );
  }

  // 9. Amendment + upgrade timelocks within [1h, 1y].
  checkTimelockBound(
    body.governance.amendment_procedure.timelock_seconds,
    "governance.amendment_procedure.timelock_seconds",
  );
  checkTimelockBound(
    body.governance.upgrade_procedure.timelock_seconds,
    "governance.upgrade_procedure.timelock_seconds",
  );
  // Governance thresholds also sanity-check.
  checkThreshold(
    body.governance.amendment_procedure.threshold,
    "governance.amendment_procedure.threshold",
  );
  checkThreshold(
    body.governance.upgrade_procedure.threshold,
    "governance.upgrade_procedure.threshold",
  );
}
