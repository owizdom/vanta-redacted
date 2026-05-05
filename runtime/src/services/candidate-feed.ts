/**
 * Candidate feed — turns the live Polymarket markets-cache snapshot into
 * `CandidateInputs[]` for the onboarding loop (paper §6 input list).
 *
 * Real signals we have today:
 *   - Resolution-criteria text (used by the LLM judge — the load-bearing
 *     thing that justifies running this in a TDX enclave)
 *   - market_id (conditionId)
 *   - text_hash (sha256 of the question text)
 *
 * Stubs (replaced in later phases by venue-poly + UMA + clob depth):
 *   - depth_5pct_usdc → fixture above the gate floor so the demo flows
 *   - dispute_30d_count → 0
 *   - age_days → 30 (representative)
 *   - vol_7d → 0.18 (typical political market)
 *   - tags → ["us-elections-2028"] when the question matches
 *   - resolver_address → UMA CTF adapter on mainnet (single whitelisted)
 *   - nearest_template_hash + text_template_hamming → 32 (passes by 1)
 *   - depth_history_30d → flat synth
 *
 * The point of wiring this NOW (vs waiting for full venue-poly depth
 * reads): every onboarding tick emits a real `op.inference` event with
 * a real LLM score on a real Polymarket question. That is the proof
 * that VANTA is "an agent that can't run outside the enclave."
 */

import { createHash } from "node:crypto";

import { asSha256Hex, type Sha256Hex } from "@vanta/tee";

import type { CandidateInputs } from "../onboarding/types.js";

import type { MarketsCache } from "./markets-cache.js";

const UMA_CTF_ADAPTER_MAINNET = "0x2F6f8DA6A21023E62399801945eed1b1975A4e12" as const;

/** Static fallback for the rare case `marketsCache` returns nothing. */
const FALLBACK: ReadonlyArray<{ readonly cid: string; readonly text: string }> = [
  {
    cid: "1d519b87999e3d4e90e1e8f57b5eee73a0ba488ff3fdb70867f294733aba84a9",
    text:
      "This market will resolve YES if Andy Beshear is the Democratic Party's official 2028 presidential nominee. Resolution is determined by AP, Reuters, or major nominating-convention coverage.",
  },
];

const TAG_RULES: ReadonlyArray<{ readonly re: RegExp; readonly tags: readonly string[] }> = [
  { re: /(2028).*(democratic|republican|nomination|primary|president)/i, tags: ["us-elections-2028"] },
  { re: /(world cup|fifa)/i, tags: ["sports-world-cup-2026"] },
  { re: /(senate|congressional|house)/i, tags: ["us-elections-2026"] },
  { re: /(bitcoin|btc|eth|ether|crypto|sol)/i, tags: ["crypto-price"] },
];

/**
 * Map a market's question text to its onboarding tags. Exported so the
 * exposure-reader can bucket existing active-loan exposure with the
 * exact same regex set the onboarding feed uses — keeping tag identity
 * consistent between origination-time bookkeeping and credit-loop
 * monitoring.
 */
export function tagsFor(text: string): readonly string[] {
  for (const r of TAG_RULES) {
    if (r.re.test(text)) return r.tags;
  }
  return [];
}

function sha256Hex(s: string): Sha256Hex {
  return asSha256Hex(createHash("sha256").update(s, "utf8").digest("hex"));
}

/**
 * Build the candidate batch the onboarding loop should evaluate this
 * tick. Capped to `limit` so the LLM judge cost stays bounded.
 */
export function buildCandidateBatch(
  cache: MarketsCache,
  limit: number,
): readonly CandidateInputs[] {
  const snaps = cache.snapshotAll().filter((s) => s.question !== null && !s.closed);
  const pool: ReadonlyArray<{ cid: string; text: string }> =
    snaps.length === 0
      ? FALLBACK
      : snaps.map((s) => ({ cid: s.conditionId, text: s.question ?? "" }));

  return pool.slice(0, limit).map((m) => ({
    market_id: asSha256Hex(m.cid),
    depth_5pct_usdc: "300000000000", // $300k — comfortably above $250k gate
    dispute_30d_count: 0,
    age_days: 30,
    vol_7d: 0.18,
    text_hash: sha256Hex(m.text),
    text: m.text,
    tags: tagsFor(m.text),
    resolver_address: UMA_CTF_ADAPTER_MAINNET,
    nearest_template_hash: sha256Hex("polymarket-binary-resolution-v1"),
    text_template_hamming: 24,
    depth_history_30d: Array.from({ length: 30 }, () => "300000000000"),
  }));
}
