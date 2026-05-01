/**
 * Server-side haircut + principal computation.
 *
 * The HTTP origination endpoint is strict per I-RT-4: callers cannot
 * supply `haircutBps` or `principalUsdc6` in the request body. The
 * runtime computes both server-side from:
 *
 *   1. `requestedPrincipalCapUsdc6` — the upper bound the borrower
 *      consented to. The actual principal is min(cap, floor((1 - h) * p
 *      * cap)) — never above cap.
 *   2. The current Polymarket midpoint p ∈ [0, 1] for the cited token.
 *   3. `tauDays = (maturityTs - now) / 86400` — must be > 0.
 *   4. `rho` (oracle dispute rate). Constant 0.0 in the v0 dev path
 *      (no dispute history wired into the runtime yet); production
 *      pulls a paper-§5 estimate from a real oracle dispute feed.
 *
 * Output `principalUsdc6` is bounded to the cap and `haircutBps` is in
 * `[0, 10000]`. Property-tested via fast-check downstream.
 */

import {
  BASELINE_PARAMS,
  PAPER_ANCHOR_SIGMA,
  computeHaircut,
} from "@vanta/haircut";
import { fetchMidpoint } from "@vanta/mark";
import type { Sha256Hex } from "@vanta/tee";

export interface QuoteArgs {
  readonly positionId: string;
  readonly tokenId: string;
  readonly conditionId: Sha256Hex;
  readonly requestedPrincipalCapUsdc6: bigint;
  readonly maturityTsUnix: number;
  readonly nowUnix: () => number;
  /** Override the oracle dispute rate (default 0.0). */
  readonly rho?: number;
  /**
   * Override `fetchMidpoint`. Tests + the fixture-mode runtime inject
   * a deterministic implementation here. There is NO env-gated
   * client-side knob: the public route never accepts a midpoint from
   * the request body.
   */
  readonly fetchMidpoint?: (tokenId: string) => Promise<{ readonly mid: string }>;
}

export interface QuoteResult {
  readonly haircutBps: number;
  readonly principalUsdc6: bigint;
  readonly p: number;
  readonly tauDays: number;
  readonly sigmaTau: number;
  readonly rho: number;
}

const SECONDS_PER_DAY = 86_400;

export class QuoteError extends Error {
  public readonly code:
    | "midpoint_unavailable"
    | "maturity_in_past"
    | "principal_cap_zero";
  public constructor(
    code: QuoteError["code"],
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = "QuoteError";
  }
}

export async function quote(args: QuoteArgs): Promise<QuoteResult> {
  if (args.requestedPrincipalCapUsdc6 <= 0n) {
    throw new QuoteError(
      "principal_cap_zero",
      "requestedPrincipalCapUsdc6 must be > 0",
    );
  }
  const nowSeconds = args.nowUnix();
  const tauSeconds = args.maturityTsUnix - nowSeconds;
  if (tauSeconds <= 0) {
    throw new QuoteError(
      "maturity_in_past",
      "maturityTsUnix must be in the future",
    );
  }
  const tauDays = tauSeconds / SECONDS_PER_DAY;

  const fetchFn = args.fetchMidpoint ?? fetchMidpoint;
  let p: number;
  try {
    const mid = await fetchFn(args.tokenId);
    p = Number(mid.mid);
    if (!Number.isFinite(p) || p < 0 || p > 1) {
      throw new Error(`midpoint out of range: ${String(p)}`);
    }
  } catch (cause: unknown) {
    throw new QuoteError(
      "midpoint_unavailable",
      `fetchMidpoint(${args.tokenId}) failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const rho = args.rho ?? 0.0;
  const haircut = computeHaircut(
    { p, tauDays, rho },
    BASELINE_PARAMS,
    { sigma: PAPER_ANCHOR_SIGMA },
  );

  // hApplied ∈ [0, 1 - epsilon). Convert to bps; clamp to [0, 10000].
  const haircutBps = Math.min(
    10_000,
    Math.max(0, Math.round(haircut.hApplied * 10_000)),
  );

  // principal = min(cap, floor((1 - h) * p * cap))
  // Use bigint math after scaling by 10_000 so we stay integer-clean.
  const oneMinusHBps = BigInt(10_000 - haircutBps);
  const pScaled = BigInt(Math.round(p * 1_000_000));
  const cap = args.requestedPrincipalCapUsdc6;
  // (cap * (1 - h) * p) / 1 = cap * oneMinusHBps * pScaled / (10_000 * 1_000_000)
  const numerator = cap * oneMinusHBps * pScaled;
  const denom = 10_000n * 1_000_000n;
  const computed = numerator / denom;
  const principalUsdc6 = computed > cap ? cap : computed;

  const sigmaTau = PAPER_ANCHOR_SIGMA(tauDays);
  return {
    haircutBps,
    principalUsdc6,
    p,
    tauDays,
    sigmaTau,
    rho,
  };
}
