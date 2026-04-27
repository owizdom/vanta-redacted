/**
 * Paper §4 worked example.
 *
 * Run via:
 *   pnpm --filter @vanta/haircut example
 *
 * Expected output:
 *   p=0.6, τ=365d, ρ=0.02 → h ≈ 0.170
 *     drift ≈ 0.150, gap ≈ 0.000, oracle = 0.020
 *
 * On a 250,000 USDC notional: collateral value ≈ 0.6 × 0.83 × 250,000 ≈ 124,500 USDC.
 * A 60,000 USDC loan against it is 48.2% LTV.
 */

import { computeHaircut } from "./compute.js";

const input = { p: 0.6, tauDays: 365, rho: 0.02 };
const result = computeHaircut(input);

const fmt = (x: number): string => x.toFixed(6);

const notional = 250_000;
const collateral = input.p * (1 - result.hApplied) * notional;

// eslint-disable-next-line no-console
console.log(
  [
    `p=${String(input.p)}, τ=${String(input.tauDays)}d, ρ=${String(input.rho)}`,
    `  h         = ${fmt(result.h)}`,
    `  hApplied  = ${fmt(result.hApplied)}`,
    `  terms     = { drift: ${fmt(result.terms.drift)}, gap: ${fmt(result.terms.gap)}, oracle: ${fmt(result.terms.oracle)} }`,
    `  V (N=${String(notional)} USDC) = ${collateral.toFixed(2)}`,
  ].join("\n"),
);
