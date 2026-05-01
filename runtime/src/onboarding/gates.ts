/**
 * Onboarding gate floor — paper §6 Table 1.
 *
 * All seven gates must pass for a candidate market to be onboardable.
 * Each gate is a pure function of the candidate inputs against the
 * thresholds in `@vanta/constitution.GATES_V0`. The agent's reasoning
 * above the floor (reasoning.ts) only runs when `evaluateGateFloor`
 * returns `all_pass = true`.
 *
 * The contract enforces the same thresholds on-chain via the
 * `OnboardingRegistry` — the off-chain runtime call here just front-runs
 * the contract revert so the signed `OnboardEvent` is never emitted for
 * a candidate that would be rejected anyway.
 */

import {
  GATES_V0,
  GATE_NAMES,
  POLYMARKET_TEMPLATE_HASHES_V0,
  TAG_REGISTRY_V0,
  UMA_RESOLVER_WHITELIST_V0,
} from "@vanta/constitution";

import type { CandidateInputs, GateFloorVerdict, GateResult } from "./types.js";

function pass(gate: string, observed: string, threshold: string, reason: string): GateResult {
  return { gate, pass: true, observed, threshold, reason };
}
function fail(gate: string, observed: string, threshold: string, reason: string): GateResult {
  return { gate, pass: false, observed, threshold, reason };
}

function gateDepth(c: CandidateInputs): GateResult {
  const observed = BigInt(c.depth_5pct_usdc);
  const threshold = GATES_V0.depth5pctMinUsdc;
  if (observed >= threshold) {
    return pass(
      "depth",
      observed.toString(),
      threshold.toString(),
      `depth_5pct ${(Number(observed) / 1e6).toFixed(0)} USDC ≥ ${(Number(threshold) / 1e6).toFixed(0)} USDC`,
    );
  }
  return fail(
    "depth",
    observed.toString(),
    threshold.toString(),
    `depth_5pct ${(Number(observed) / 1e6).toFixed(0)} USDC < ${(Number(threshold) / 1e6).toFixed(0)} USDC — liquidation cannot clear within buffer`,
  );
}

function gateDisputes(c: CandidateInputs): GateResult {
  const observed = c.dispute_30d_count;
  const threshold = GATES_V0.disputes30dMax;
  if (observed <= threshold) {
    return pass(
      "disputes30d",
      String(observed),
      String(threshold),
      `0 disputes in trailing 30 days`,
    );
  }
  return fail(
    "disputes30d",
    String(observed),
    String(threshold),
    `${String(observed)} dispute(s) on resolver in last 30 days — 30-day waiting room applies`,
  );
}

function gateAge(c: CandidateInputs): GateResult {
  const observed = c.age_days;
  const threshold = GATES_V0.ageDaysMin;
  if (observed >= threshold) {
    return pass("age", String(observed), String(threshold), `market age ${String(observed)} days ≥ ${String(threshold)}`);
  }
  return fail(
    "age",
    String(observed),
    String(threshold),
    `market age ${String(observed)} days < ${String(threshold)} — toxic-flow window`,
  );
}

function gateVol(c: CandidateInputs): GateResult {
  const observed = c.vol_7d;
  const threshold = GATES_V0.vol7dMax;
  if (observed <= threshold) {
    return pass("vol7d", observed.toFixed(4), threshold.toFixed(4), `7d vol ${observed.toFixed(4)} ≤ ${threshold.toFixed(2)}`);
  }
  return fail(
    "vol7d",
    observed.toFixed(4),
    threshold.toFixed(4),
    `7d vol ${observed.toFixed(4)} > ${threshold.toFixed(2)} — σ(τ) pin is unreliable`,
  );
}

function gateTextScore(c: CandidateInputs, textScore: number): GateResult {
  const threshold = GATES_V0.textScoreMin;
  if (textScore >= threshold) {
    return pass("textScore", String(textScore), String(threshold), `LLM-judge clarity ${String(textScore)}/100`);
  }
  return fail(
    "textScore",
    String(textScore),
    String(threshold),
    `LLM-judge clarity ${String(textScore)}/100 < ${String(threshold)} — text is ambiguous`,
  );
}

function gateTextTemplate(c: CandidateInputs): GateResult {
  const threshold = GATES_V0.textTemplateHammingMax;
  if (c.nearest_template_hash === null) {
    return fail(
      "textTemplate",
      "no_match",
      String(threshold),
      "no Polymarket standard template within Hamming distance — custom-text default-reject",
    );
  }
  if (c.text_template_hamming <= threshold) {
    return pass(
      "textTemplate",
      String(c.text_template_hamming),
      String(threshold),
      `Hamming ${String(c.text_template_hamming)} ≤ ${String(threshold)} from template ${c.nearest_template_hash}`,
    );
  }
  return fail(
    "textTemplate",
    String(c.text_template_hamming),
    String(threshold),
    `Hamming ${String(c.text_template_hamming)} > ${String(threshold)} — too far from any standard template`,
  );
}

function gateTagNovelty(c: CandidateInputs): GateResult {
  const allowed = new Set(TAG_REGISTRY_V0);
  const novel = c.tags.filter((t) => !allowed.has(t));
  if (novel.length === 0) {
    return pass(
      "tagNovelty",
      c.tags.join(","),
      "subset",
      `all ${String(c.tags.length)} tag(s) in pre-registered set`,
    );
  }
  return fail(
    "tagNovelty",
    c.tags.join(","),
    "subset",
    `novel tag(s) ${novel.join(",")} — new tag families require timelocked governance upgrade`,
  );
}

function gateResolverWhitelist(c: CandidateInputs): GateResult {
  const allowed = new Set(UMA_RESOLVER_WHITELIST_V0.map((a) => a.toLowerCase()));
  const observed = c.resolver_address.toLowerCase();
  // Empty whitelist (v0 stub) means "every resolver passes" so local-dev
  // demos can run before the real list is seeded. Production builds MUST
  // populate UMA_RESOLVER_WHITELIST_V0 — assertion lives in Phase 11
  // bootstrap.
  if (allowed.size === 0 || allowed.has(observed)) {
    return pass(
      "resolverWhitelist",
      observed,
      String(allowed.size),
      allowed.size === 0
        ? "whitelist not seeded (v0 dev) — any resolver passes"
        : "resolver in UMA whitelist",
    );
  }
  return fail(
    "resolverWhitelist",
    observed,
    String(allowed.size),
    `resolver ${observed} not in UMA-resolver whitelist`,
  );
}

function gateTemplateRegistered(c: CandidateInputs): GateResult {
  // textTemplate gate handles the Hamming distance; this gate enforces
  // that the matched template hash itself is registered. Stub-empty in
  // v0 means "any template passes" so we don't double-block during dev.
  const registered = new Set(POLYMARKET_TEMPLATE_HASHES_V0);
  if (c.nearest_template_hash === null) {
    // textTemplate gate already failed; no double penalty.
    return pass("templateRegistered", "delegated", "delegated", "delegated to textTemplate gate");
  }
  if (registered.size === 0) {
    return pass(
      "templateRegistered",
      c.nearest_template_hash,
      String(registered.size),
      "template registry not seeded (v0 dev)",
    );
  }
  if (registered.has(c.nearest_template_hash)) {
    return pass(
      "templateRegistered",
      c.nearest_template_hash,
      String(registered.size),
      "template registered",
    );
  }
  return fail(
    "templateRegistered",
    c.nearest_template_hash,
    String(registered.size),
    "template hash not in registry",
  );
}

/**
 * Evaluate the full gate floor against a candidate. `textScore` is fed
 * in by the caller (LLM judge runs before this — the agent's reasoning
 * trace cites the LLM call separately).
 */
export function evaluateGateFloor(
  c: CandidateInputs,
  textScore: number,
): GateFloorVerdict {
  const results: GateResult[] = [
    gateDepth(c),
    gateDisputes(c),
    gateAge(c),
    gateVol(c),
    gateTextScore(c, textScore),
    gateTextTemplate(c),
    gateTagNovelty(c),
    gateResolverWhitelist(c),
    gateTemplateRegistered(c),
  ];
  const all_pass = results.every((r) => r.pass);
  return { all_pass, results };
}

/** Convenience: list of contract-published gate names. Mirrors paper Table 1. */
export const PUBLISHED_GATE_NAMES = GATE_NAMES;
