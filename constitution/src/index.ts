/**
 * @vanta/constitution — public surface (Phase 1: constants + types).
 *
 * The autonomy envelope, gate floor, calibration baselines, fees, and
 * whitelists. These are the parameters the contract enforces and the
 * agent reasons within. Phase 2+ will add the full constitutional
 * document (signed genesis, canonical hashing, governance amendment
 * procedure) once @vanta/tee lands.
 */

export {
  CALIBRATION_V0,
  SIGMA_ANCHORS,
  SIGMA_CLAMP,
  type CalibrationParams,
} from "./calibration.js";

export {
  GATES_V0,
  GATE_NAMES,
  type GateThresholds,
  type GateName,
} from "./gates.js";

export {
  ENVELOPE_V0,
  LOAN_INVARIANTS_V0,
  PER_MARKET_FREEZE,
  GLOBAL_PAUSE,
  type AutonomyEnvelope,
  type LoanInvariants,
} from "./envelope.js";

export {
  UMA_RESOLVER_WHITELIST_V0,
  POLYMARKET_TEMPLATE_HASHES_V0,
  TAG_REGISTRY_V0,
  VENUE_REGISTRY_V0,
} from "./whitelists.js";

export { FEES_V0, type FeeSchedule } from "./fees.js";

export {
  ConstitutionError,
  type ConstitutionErrorCode,
} from "./errors.js";

// --- Constitution body schema + canonical hashing -----------------------

export type {
  ConstitutionalGenesisPayload,
  ConstitutionBody,
  EmergencyHalt,
  Governance,
  AmendmentProcedure,
  UpgradeProcedure,
  RiskEnvelope,
  Scope,
  StewardEntry,
  StewardSet,
  TreasuryEntry,
  TreasurySchedule,
} from "./schema.js";

export {
  CONSTITUTION_DOMAIN,
  constitutionHash,
  encodeCanonicalBody,
  parseConstitutionBody,
} from "./canonical.js";

// --- Genesis signing ----------------------------------------------------

export { signGenesis } from "./genesis.js";
export type { GenesisSignFn, SignGenesisArgs } from "./genesis.js";

// --- v1 baseline builder -----------------------------------------------

export { buildVantaGenesisBody } from "./builder.js";
export type { BuildVantaGenesisBodyArgs } from "./builder.js";
