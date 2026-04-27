/**
 * Calibration baselines for the haircut formula h(p, τ, ρ).
 * Per paper §4.
 *
 * These are the v0 values the model loop (paper §7) replays against. Any
 * change to them is a `CalibrationProposal` event under the 4-of-7 lender
 * quorum + 7-day timelock (paper §11 T8). The constants live here, not
 * in @vanta/haircut, so that haircut stays a pure-math library and the
 * governable parameters live alongside the rest of the constitution.
 */

export interface CalibrationParams {
  readonly alpha: number;
  readonly beta: number;
  readonly gamma: number;
  readonly tauGapDays: number;
  readonly epsilon: number;
}

export const CALIBRATION_V0: CalibrationParams = Object.freeze({
  alpha: 1.0,
  beta: 0.6,
  gamma: 1.0,
  tauGapDays: 7,
  epsilon: 0.05,
});

/**
 * σ(τ) anchor pins. The closed-form fit through these anchors lives in
 * @vanta/haircut/sigma — published here as the calibration evidence so a
 * future calibration commit can show its workings.
 */
export const SIGMA_ANCHORS = Object.freeze({
  short: Object.freeze({ tauDays: 14, sigmaSqrtTau: 0.04 }),
  long: Object.freeze({ tauDays: 365, sigmaSqrtTau: 0.15 }),
});

/**
 * Clamp band for σ(τ) — protects the drift term against unrealistic τ.
 */
export const SIGMA_CLAMP = Object.freeze({
  floor: 0.005,
  ceil: 0.05,
});
