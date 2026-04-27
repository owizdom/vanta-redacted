/**
 * @vanta/haircut — public surface.
 *
 * Pure-TS computation of the resolution-aware haircut from paper §4.
 * No runtime dependencies.
 */

export { computeHaircut, type ComputeHaircutOptions } from "./compute.js";
export { PAPER_ANCHOR_SIGMA } from "./sigma.js";
export {
  BASELINE_PARAMS,
  type HaircutParams,
  type HaircutInput,
  type HaircutResult,
  type HaircutTerms,
  type SigmaTauFn,
} from "./types.js";
export { HaircutError, type HaircutErrorCode } from "./errors.js";
