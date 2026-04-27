/**
 * computeHaircut — paper §4 closed-form haircut.
 *
 *   h(p, τ, ρ) = α·σ(τ)·√τ + β·(1 − p)·exp(−τ / τ_gap) + γ·ρ
 *   hApplied   = min(h, 1 − ε)
 *
 * Invariants:
 *   I-HC-1  p ∈ [0, 1], τ > 0, ρ ∈ [0, 1]
 *   I-HC-2  ε ∈ (0, 1); α, β, γ ≥ 0; τ_gap > 0
 *   I-HC-3  paper §4 worked example pinned (see example.ts)
 */

import { PAPER_ANCHOR_SIGMA } from "./sigma.js";
import { HaircutError } from "./errors.js";
import {
  BASELINE_PARAMS,
  type HaircutInput,
  type HaircutParams,
  type HaircutResult,
  type SigmaTauFn,
} from "./types.js";

export interface ComputeHaircutOptions {
  readonly sigma?: SigmaTauFn;
}

export function computeHaircut(
  input: HaircutInput,
  params: HaircutParams = BASELINE_PARAMS,
  options: ComputeHaircutOptions = {},
): HaircutResult {
  // I-HC-1
  if (!Number.isFinite(input.p) || input.p < 0 || input.p > 1) {
    throw new HaircutError("input_out_of_range", "p must be in [0, 1]", { p: input.p });
  }
  if (!Number.isFinite(input.tauDays) || input.tauDays <= 0) {
    throw new HaircutError("input_out_of_range", "tauDays must be > 0", {
      tauDays: input.tauDays,
    });
  }
  if (!Number.isFinite(input.rho) || input.rho < 0 || input.rho > 1) {
    throw new HaircutError("input_out_of_range", "rho must be in [0, 1]", { rho: input.rho });
  }

  // I-HC-2
  if (!Number.isFinite(params.epsilon) || params.epsilon <= 0 || params.epsilon >= 1) {
    throw new HaircutError("params_invalid", "epsilon must be in (0, 1)", {
      epsilon: params.epsilon,
    });
  }
  if (!Number.isFinite(params.tauGapDays) || params.tauGapDays <= 0) {
    throw new HaircutError("params_invalid", "tauGapDays must be > 0", {
      tauGapDays: params.tauGapDays,
    });
  }
  if (
    !Number.isFinite(params.alpha) ||
    !Number.isFinite(params.beta) ||
    !Number.isFinite(params.gamma) ||
    params.alpha < 0 ||
    params.beta < 0 ||
    params.gamma < 0
  ) {
    throw new HaircutError(
      "params_invalid",
      "alpha, beta, gamma must be finite and non-negative",
      { alpha: params.alpha, beta: params.beta, gamma: params.gamma },
    );
  }

  const sigmaFn = options.sigma ?? PAPER_ANCHOR_SIGMA;
  const sigma = sigmaFn(input.tauDays);

  const drift = params.alpha * sigma * Math.sqrt(input.tauDays);
  const gap = params.beta * (1 - input.p) * Math.exp(-input.tauDays / params.tauGapDays);
  const oracle = params.gamma * input.rho;

  const h = drift + gap + oracle;
  const hApplied = Math.min(h, 1 - params.epsilon);

  return { h, hApplied, terms: { drift, gap, oracle } };
}
