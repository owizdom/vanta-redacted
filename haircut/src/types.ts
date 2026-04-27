/**
 * Public types for @vanta/haircut.
 *
 * Mirrors paper §4: h(p, τ, ρ) = α·σ(τ)·√τ + β·(1−p)·g(τ) + γ·ρ
 * with g(τ) = exp(−τ / τ_gap) and an applied haircut clamped to 1−ε.
 *
 * `SigmaTauFn` isolates the σ(τ) implementation behind a single function
 * type, so a fitted estimator (e.g. a Kirilenko-style Kalman filter) can
 * later replace the paper-anchor power law without touching
 * `computeHaircut`'s surface.
 */

export interface HaircutParams {
  readonly alpha: number;
  readonly beta: number;
  readonly gamma: number;
  readonly tauGapDays: number;
  readonly epsilon: number;
}

export interface HaircutInput {
  readonly p: number;
  readonly tauDays: number;
  readonly rho: number;
}

export interface HaircutTerms {
  readonly drift: number;
  readonly gap: number;
  readonly oracle: number;
}

export interface HaircutResult {
  readonly h: number;
  readonly hApplied: number;
  readonly terms: HaircutTerms;
}

export type SigmaTauFn = (tauDays: number) => number;

export const BASELINE_PARAMS: HaircutParams = Object.freeze({
  alpha: 1.0,
  beta: 0.6,
  gamma: 1.0,
  tauGapDays: 7,
  epsilon: 0.05,
});
