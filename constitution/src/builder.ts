/**
 * `buildVantaGenesisBody` — v1 baseline constructor.
 *
 * Stamps the genesis body with frozen defaults. `signGenesis`
 * consumes this output; tests use it to produce fixtures. Every field
 * listed in the §7 wire format is populated here with the baseline
 * value named in the constitution synthesis or falls through from an
 * argument.
 *
 * Baseline defaults — non-exhaustive snapshot from the synthesis §7
 * sample:
 *
 * - `schema_version: "v1"`
 * - `agent_name: "vanta"`
 * - `scope.venues: ["polymarket-ctf-polygon-amoy"]`
 * - `scope.loan_kinds: ["event-terminal-zero-coupon"]`
 * - `scope.borrower_residency_deny: ["US"]`
 * - `stewards`: single entry (Wisdom), `threshold: {require: 1, of: 1}`
 *   (spec §7).
 * - Governance: `bootstrap_authority: "agent"`,
 *   `stewards_multisig_address: null`, `emergency_halt.enabled: false`,
 *   `new_identity_signed_over_by_prior: true` (mandatory for the
 *   upgrade amendment).
 * - Chain IDs: `base_sepolia: 84532`, `polygon_amoy: 80002`.
 *
 * Risk-envelope and treasury-schedule baselines are hardcoded to
 * conservative values; spec §7 pins the outer shape and leaves the
 * numeric values as a verbatim baseline. Values not explicitly named
 * in the synthesis are chosen here conservatively (100% ceilings for
 * bps where a lower value would restrict legitimate operation, 50%
 * for structural reserves).
 */

import { asSigningPubKeyHex } from "@vanta/tee";
import type { SigningPubKeyHex } from "@vanta/tee";

import {
  AGENT_NAME,
  CHAIN_ID_BASE_SEPOLIA,
  CHAIN_ID_POLYGON_AMOY,
  CONSTITUTION_SCHEMA_VERSION,
} from "./schema.js";
import type { ConstitutionBody, StewardEntry } from "./schema.js";
import { validateSemantic } from "./semantic.js";

/**
 * Inputs: enough to assemble the v1 genesis body. Caller is
 * responsible for:
 *
 * - providing `agentPk` from `@vanta/tee` `signingPubKey`;
 * - supplying a fully populated `wisdomSteward` (handle, role,
 *   pubkey, contact). In the sole-steward baseline,
 *   `wisdomSteward.pubkey === agentPk` (single-steward = the agent).
 *   The builder does NOT re-derive this relationship — it accepts
 *   the caller's entry verbatim so fixtures can populate distinct
 *   pubkeys for negative tests.
 * - supplying the genesis timestamp (unix ms), usually
 *   `Date.now()` at first boot.
 */
export interface BuildVantaGenesisBodyArgs {
  readonly agentPk: SigningPubKeyHex;
  readonly wisdomSteward: StewardEntry;
  readonly genesisTimestampUnixMs: number;
}

/**
 * Default observer feed URL. Spec §10 Q1 flags the format
 * (signed-feed vs pull-only) as an open question; the URL itself is
 * pinned verbatim in the signed body.
 */
const OBSERVER_FEED_URL =
  "https://vanta.app/.well-known/observer-feed" as const;

/** One week, in seconds. */
const ONE_WEEK_SECONDS = 7 * 24 * 3_600;

/**
 * Assemble the v1 genesis body. Runs semantic validation on the
 * produced body — direct callers (tests, fixture producers) cannot
 * construct a malformed baseline via this helper. `signGenesis`
 * re-runs defensively; spec §5 step 2.
 */
export function buildVantaGenesisBody(
  args: BuildVantaGenesisBodyArgs,
): ConstitutionBody {
  // Re-brand agentPk defensively: the argument is already branded, but
  // `asSigningPubKeyHex` enforces the 64-hex format at runtime — a
  // caller passing an unbranded string via `as SigningPubKeyHex` would
  // be caught here rather than at signature time.
  const agentPk = asSigningPubKeyHex(args.agentPk);

  const body: ConstitutionBody = {
    schema_version: CONSTITUTION_SCHEMA_VERSION,
    agent_name: AGENT_NAME,
    agent_pk: agentPk,
    scope: {
      venues: ["polymarket-ctf-polygon-amoy"],
      loan_kinds: ["event-terminal-zero-coupon"],
      borrower_residency_deny: ["US"],
    },
    risk_envelope: {
      baseline: {
        // 100% Kelly cap; loan sizing actually derived at allocation
        // time. A genesis ceiling of 10_000 bps permits the full
        // allocation policy shape; amendments can tighten.
        alpha_bps: 10_000,
        // 10% haircut floor on event-terminal collateral at pledge.
        haircut_floor_bps: 1_000,
        // 30% of treasury held in reserve at all times.
        reserve_ratio_bps: 3_000,
        // 20% max single-loan exposure of treasury.
        max_single_loan_bps_of_treasury: 2_000,
        // 50% max aggregate exposure.
        max_aggregate_exposure_bps_of_treasury: 5_000,
      },
      allowed_ranges: {
        alpha_bps: { min: 0, max: 10_000 },
        haircut_floor_bps: { min: 0, max: 10_000 },
        reserve_ratio_bps: { min: 0, max: 10_000 },
        max_single_loan_bps_of_treasury: { min: 0, max: 10_000 },
        max_aggregate_exposure_bps_of_treasury: { min: 0, max: 10_000 },
      },
    },
    treasury_schedule: {
      entries: [
        // Baseline lanes mirror the operational cadences defined in
        // the constitution brief. Values in USD cents;
        // 30-day-equivalent sum must not exceed the overall ceiling.
        {
          label: "llm-inference",
          cadence_days: 1,
          ceiling_usd_cents: 500, // $5/day, $150/month-equiv
        },
        {
          label: "gas-topup",
          cadence_days: 7,
          ceiling_usd_cents: 2_000, // $20/week, ~$80/month-equiv
        },
        {
          label: "domain-renewal",
          cadence_days: 30,
          ceiling_usd_cents: 2_000, // $20/month
        },
        {
          label: "api-credentials",
          cadence_days: 30,
          ceiling_usd_cents: 5_000, // $50/month
        },
      ],
      // Sum of monthly-equivalents for the above lanes:
      // (30/1)*500 + (30/7 floor = 4)*2000 + (30/30)*2000 + (30/30)*5000
      // = 15_000 + 8_000 + 2_000 + 5_000 = 30_000 cents ($300/month).
      // Overall ceiling sits 67% above that for future operational
      // headroom.
      overall_monthly_ceiling_usd_cents: 50_000,
    },
    stewards: {
      entries: [args.wisdomSteward],
      threshold: { require: 1, of: 1 },
      note: "Upgraded to 2-of-3 by threshold-reshare amendment",
    },
    governance: {
      bootstrap_authority: "agent",
      stewards_multisig_address: null,
      amendment_procedure: {
        threshold: { require: 1, of: 1 },
        timelock_seconds: ONE_WEEK_SECONDS,
        timelock_contract: null,
        dissent_window_seconds: ONE_WEEK_SECONDS,
        observer_feed_url: OBSERVER_FEED_URL,
      },
      upgrade_procedure: {
        threshold: { require: 1, of: 1 },
        timelock_seconds: ONE_WEEK_SECONDS,
        new_identity_signed_over_by_prior: true,
        image_hash_publication: "ipfs-pinned",
      },
      emergency_halt: {
        enabled: false,
        max_duration_seconds: ONE_WEEK_SECONDS,
      },
    },
    genesis_timestamp_unix: args.genesisTimestampUnixMs,
    chain_ids: {
      base_sepolia: CHAIN_ID_BASE_SEPOLIA,
      polygon_amoy: CHAIN_ID_POLYGON_AMOY,
    },
  };

  // Defensive re-validation. Callers constructing a malformed input
  // (e.g. wrong-length pubkey in `wisdomSteward`) surface here rather
  // than at signing. Defensive re-validation pattern.
  validateSemantic(body);

  return body;
}
