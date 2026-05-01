/**
 * Agent reasoning above the gate floor — paper §6 "Reasoning above the
 * floor" + paper §7 (continuous loops surface, of which onboarding is
 * one).
 *
 * Runs only when `evaluateGateFloor` returns `all_pass = true`. Operates
 * on inputs in their *full* form (not just the contract digests):
 *   - Resolution-criteria text against historical resolver behavior
 *     (here: text features + LLM judge clarity score).
 *   - Depth-shape evolution over the trailing 30 days (slope of the
 *     `depth_history_30d` series, not just the snapshot).
 *   - Cluster-correlation evidence across the agent's existing
 *     exposure, *above the explicit tag system*. The tag system is the
 *     contract-enforced floor; the agent reasons about novel
 *     correlations the tag set could not pre-register.
 *
 * Outputs feed the OnboardEvent body and the sibling ReasoningTrace.
 * The reasoning is **bounded above by the contract** — `cap_initial_usdc`
 * is clamped to the probation ceiling (`ENVELOPE_V0.probationCapInitialUsdc`)
 * and `ltv_max_bps` is clamped to `LOAN_INVARIANTS_V0.ltvCeilingBps`.
 * The agent cannot exceed either via reasoning.
 */

import { createHash } from "node:crypto";

import {
  CALIBRATION_V0,
  ENVELOPE_V0,
  LOAN_INVARIANTS_V0,
} from "@vanta/constitution";
import { asSha256Hex } from "@vanta/tee";

import type { AgentReasoningOutput, CandidateInputs } from "./types.js";
import type { JudgeOutput } from "./llm-judge.js";

/**
 * Snapshot of the agent's existing exposure. The credit loop maintains
 * this. Empty for a fresh boot.
 */
export interface ExposureSnapshot {
  /** Total USDC notional already lent against markets carrying each tag. */
  readonly per_tag_usdc: ReadonlyMap<string, bigint>;
  /** Markets the agent currently has open exposure to. */
  readonly open_market_ids: ReadonlySet<string>;
}

/**
 * Cluster reasoning — penalize candidates that share tags with markets
 * the agent already has heavy exposure to. Returns a 0..1 *concentration
 * factor* that scales `cap_initial_usdc` down (1.0 = no concentration,
 * 0.0 = fully concentrated cluster).
 *
 * Heuristic — production v1.x replaces with a portfolio-correlation
 * model. The honest acknowledgment in paper §11 T7 stands: this is
 * weaker than a domain expert who has watched the resolver for years.
 */
function clusterConcentrationFactor(
  c: CandidateInputs,
  exposure: ExposureSnapshot,
): { factor: number; cluster_score: number } {
  if (c.tags.length === 0 || exposure.per_tag_usdc.size === 0) {
    return { factor: 1, cluster_score: 0 };
  }
  // Sum existing exposure across tags this candidate carries.
  let candidateClusterUsdc = 0n;
  for (const tag of c.tags) {
    candidateClusterUsdc += exposure.per_tag_usdc.get(tag) ?? 0n;
  }
  // Sum total exposure for normalization.
  let totalUsdc = 0n;
  for (const v of exposure.per_tag_usdc.values()) totalUsdc += v;
  if (totalUsdc === 0n) return { factor: 1, cluster_score: 0 };

  const concentration = Number(candidateClusterUsdc) / Number(totalUsdc);
  // factor = 1 - concentration², so a half-concentrated cluster gets a
  // 0.75 factor; fully-concentrated drops to 0.
  const factor = Math.max(0, 1 - concentration * concentration);
  return { factor, cluster_score: concentration };
}

/**
 * Depth-shape evolution score in 0..1 (1 = healthy, 0 = thinning).
 * Computes the linear-regression slope of the trailing-30-day series
 * normalized by the mean. Negative slope reduces the score.
 */
function depthShapeScore(c: CandidateInputs): number {
  if (c.depth_history_30d.length < 7) return 1;
  const series = c.depth_history_30d.map((s) => Number(BigInt(s)));
  const n = series.length;
  let mean = 0;
  for (const v of series) mean += v;
  mean /= n;
  if (mean === 0) return 1;

  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i++) {
    const x = i - (n - 1) / 2;
    const y = series[i]! - mean;
    sumXY += x * y;
    sumXX += x * x;
  }
  if (sumXX === 0) return 1;
  const slope = sumXY / sumXX;
  // Normalize slope to a per-day fraction of the mean.
  const normalized = slope / mean;
  // map normalized slope (in [-0.05, 0.05]) to [0, 1] saturating.
  if (normalized >= 0) return 1;
  return Math.max(0, 1 + normalized / 0.05);
}

/**
 * Combine the LLM clarity score, depth-shape score, and cluster
 * concentration into a per-market `cap_initial_usdc` and `ltv_max_bps`
 * within the autonomy envelope.
 */
export function reason(args: {
  readonly candidate: CandidateInputs;
  readonly judge: JudgeOutput;
  readonly exposure: ExposureSnapshot;
}): AgentReasoningOutput {
  const { candidate, judge, exposure } = args;

  const depthScore = depthShapeScore(candidate);
  const cluster = clusterConcentrationFactor(candidate, exposure);

  // Decision: above 70 LLM score + healthy depth + non-saturated cluster
  // → onboard. Borderline → flag_for_human_review. Below threshold →
  // reject (but this branch shouldn't be reached because the gate floor
  // would have rejected first).
  let decision: AgentReasoningOutput["decision"];
  if (judge.score < 70) {
    decision = "reject";
  } else if (depthScore < 0.5 || cluster.factor < 0.4) {
    decision = "flag_for_human_review";
  } else {
    decision = "onboard";
  }

  // Cap is the probation ceiling, scaled by health × cluster factor.
  const capCeiling = ENVELOPE_V0.probationCapInitialUsdc;
  const capScale = Math.max(0, Math.min(1, depthScore * cluster.factor));
  const capInitialUsdc =
    decision === "onboard"
      ? BigInt(Math.floor(Number(capCeiling) * capScale))
      : decision === "flag_for_human_review"
        ? capCeiling / 2n
        : 0n;

  // LTV ceiling: paper §4 + LOAN_INVARIANTS_V0 cap of 50%. Within that,
  // the agent narrows to the safe-floor band — for v0 we use the full
  // 50% on healthy markets and pull back for cluster-concentrated ones.
  const ltvMaxBps =
    decision === "reject"
      ? 0
      : Math.floor(LOAN_INVARIANTS_V0.ltvCeilingBps * cluster.factor);

  const rationaleParts: string[] = [];
  rationaleParts.push(
    `LLM clarity ${String(judge.score)}/100 (model ${judge.model_id}). Gate floor passed.`,
  );
  rationaleParts.push(`Depth-shape score ${depthScore.toFixed(3)} (1=healthy, 0=thinning).`);
  rationaleParts.push(
    `Cluster concentration ${cluster.cluster_score.toFixed(3)} → cap factor ${cluster.factor.toFixed(3)}.`,
  );
  rationaleParts.push(
    `Decision: ${decision}. cap_initial_usdc=${(Number(capInitialUsdc) / 1e6).toFixed(0)} USDC, ltv_max_bps=${String(ltvMaxBps)}.`,
  );
  const rationale = rationaleParts.join(" ");

  const dissentParts: string[] = [];
  if (cluster.cluster_score > 0.3) {
    dissentParts.push(
      `Existing exposure already concentrated in tags ${candidate.tags.join(",")} — paper §11 T7 cluster-risk caveat applies.`,
    );
  }
  if (depthScore < 0.7) {
    dissentParts.push(
      `Depth-shape thinning over trailing 30d — re-evaluate at next cycle if onboarded.`,
    );
  }
  const dissent = dissentParts.join(" ");

  return {
    decision,
    cap_initial_usdc: capInitialUsdc.toString(),
    ltv_max_bps: ltvMaxBps,
    rate_params: {
      alpha: CALIBRATION_V0.alpha,
      beta: CALIBRATION_V0.beta,
      gamma: CALIBRATION_V0.gamma,
      tau_gap_days: CALIBRATION_V0.tauGapDays,
    },
    intermediate_scores: {
      llm_score: judge.score,
      depth_shape_score: depthScore,
      cluster_concentration: cluster.cluster_score,
      cluster_factor: cluster.factor,
    },
    rationale: rationale.slice(0, 4096),
    dissent: dissent.slice(0, 2048),
    model_id: judge.model_id,
    prompt_hash: judge.prompt_hash,
  };
}

/**
 * Build an inputs_hash over the canonical input tuple — matches paper
 * §6 OnboardEvent schema: `keccak256(depth || disputes || age || vol ||
 * text_hash || tags)`. Off-chain we canonicalize to a stable JSON shape
 * and hash with sha256 (same algorithm @vanta/events uses for event
 * ids); the on-chain contract's keccak256 of the same canonical bytes
 * is computed during the OnboardEvent verification step in
 * `OnboardingRegistry.honor()`.
 */
export function inputsHash(c: CandidateInputs): string {
  // Use a stable JSON canonical form so off-chain and on-chain agree.
  // Tags sorted, all numerics stringified.
  const tagsCanonical = [...c.tags].sort();
  const canonical = JSON.stringify({
    depth_5pct_usdc: c.depth_5pct_usdc,
    dispute_30d_count: c.dispute_30d_count,
    age_days: c.age_days,
    vol_7d: c.vol_7d.toFixed(6),
    text_hash: c.text_hash,
    tags: tagsCanonical,
  });
  return asSha256Hex(createHash("sha256").update(canonical, "utf8").digest("hex"));
}
