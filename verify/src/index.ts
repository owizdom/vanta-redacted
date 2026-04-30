/**
 * Public API surface for @vanta/verify.
 *
 * The CLI binary is the primary consumer; the programmatic surface is
 * exposed so downstream Node code (CI scripts, dashboards) can call
 * `walkChain(...)` directly without spawning a subprocess.
 */

export { VerifyError } from "./errors.js";
export type { VerifyErrorCode } from "./errors.js";

export {
  fetchTee,
  fetchConstitution,
  fetchEvent,
} from "./fetch.js";
export type {
  ConstitutionResponse,
  RawEventResponse,
  TeeResponse,
} from "./fetch.js";

export { buildPublicClient, fetchLoanParamsHash } from "./onchain.js";

export {
  MAX_WALK_DEPTH,
  defaultVerifyAdapter,
  walkChain,
} from "./walk.js";
export type {
  ProgressItem,
  WalkDeps,
  WalkError,
  WalkResult,
} from "./walk.js";

export { formatHuman, formatJson } from "./output.js";
export type { CliSummary } from "./output.js";

export { runCli } from "./cli.js";
export type { CliOptions } from "./cli.js";
