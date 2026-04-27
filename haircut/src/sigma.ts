/**
 * Paper-anchor σ(τ) — power-law fit through paper §4 anchors.
 *
 * Anchors:
 *   σ·√τ = 0.15 at τ = 365 days
 *   σ·√τ = 0.04 at τ = 14  days
 *
 * Solving σ(τ) = a · τ^k:
 *   (a · 365^k) · √365 = 0.15
 *   (a · 14^k)  · √14  = 0.04
 * Divide:
 *   (365/14)^k · √(365/14) = 0.15 / 0.04 = 3.75
 *   ⇒ k + 0.5 = log(3.75) / log(365/14)
 *   ⇒ k = -0.0946578702826909
 *   ⇒ a = 0.15 / (365^k · √365) = 0.013724167580469696
 *
 * The paper rounds these to a=0.013724, k=-0.094658 for legibility, which
 * misses the τ=365 anchor by ~2e-6. The unrounded constants here hit both
 * anchors to < 1e-6.
 *
 * Output is clamped to [0.005, 0.05]: an unrealistically short or long τ
 * does not blow up the drift term.
 *
 * Isolated behind `SigmaTauFn` so a fitted σ (e.g. Kalman pipeline) can
 * drop in later without changing `computeHaircut`'s public surface.
 */

import { HaircutError } from "./errors.js";
import type { SigmaTauFn } from "./types.js";

const SIGMA_A = 0.013724167580469696;
const SIGMA_K = -0.0946578702826909;
const SIGMA_FLOOR = 0.005;
const SIGMA_CEIL = 0.05;

export const PAPER_ANCHOR_SIGMA: SigmaTauFn = (tauDays: number): number => {
  if (!Number.isFinite(tauDays) || tauDays <= 0) {
    throw new HaircutError("sigma_non_finite", "tauDays must be > 0 and finite", { tauDays });
  }
  const raw = SIGMA_A * Math.pow(tauDays, SIGMA_K);
  if (!Number.isFinite(raw)) {
    throw new HaircutError("sigma_non_finite", "σ(τ) computed non-finite", {
      tauDays,
      raw,
    });
  }
  return Math.min(Math.max(raw, SIGMA_FLOOR), SIGMA_CEIL);
};
