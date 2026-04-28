/**
 * UMA-resolver whitelist and Polymarket template family registry.
 *
 * Both are governance-controlled stubs at this stage of the build. New
 * resolver addresses or template families require a 7-day timelocked
 * lender-quorum upgrade — they are NOT on the agent's authority (paper
 * §6 Whitelist envelope, §11 T8).
 *
 * The on-chain `OnboardingRegistry` (Phase 5) will hold the canonical
 * versions; this module exports the v0 baseline that the local dev
 * stack and the genesis deployment seed.
 */

/**
 * UMA Optimistic Oracle proposer addresses on the whitelisted-proposer
 * regime introduced August 2025 (paper §4 / §11 T4). Stub for v0 — fill
 * before mainnet from UMA's published proposer set.
 */
export const UMA_RESOLVER_WHITELIST_V0: ReadonlyArray<`0x${string}`> = Object.freeze([
  // TODO(phase-9): seed with the 37-proposer set covering 96% of Polymarket
  // proposals at 99.7% accuracy (paper §11 T4 / [14] uma-managed).
]);

/**
 * Polymarket standard resolution-criteria template families. Each entry
 * is the sha256 (lowercase 64-hex) of a canonicalized template;
 * candidate market texts onboard if Hamming(candidate, nearest_template)
 * ≤ `GATES_V0.textTemplateHammingMax`.
 *
 * Stub for v0 — to be seeded from Polymarket's published template set
 * during Phase 9 (onboarding cycle). Stored as plain `string` (not
 * branded) because the entries are governance-published rather than
 * derived from a runtime hash; the on-chain `OnboardingRegistry` will
 * carry the canonical brand-binding.
 */
export const POLYMARKET_TEMPLATE_HASHES_V0: ReadonlyArray<string> = Object.freeze([
  // TODO(phase-9): seed with Polymarket standard template family hashes.
]);

/**
 * Pre-registered correlation tags. New tag families require a separate
 * timelocked governance action; they are not onboardable by the agent.
 */
export const TAG_REGISTRY_V0: ReadonlyArray<string> = Object.freeze([
  "us-elections-2028",
  "us-elections-2026-midterms",
  "fomc-2026",
  "geopolitics",
  "tech-regulation",
]);

/**
 * Venue registry — the venues VANTA accepts collateral from. Paper §13
 * Month 6+ adds Hyperliquid HIP-4 once resolution criteria stabilize;
 * Kalshi is gated on FCM compliance and not in current scope.
 */
export const VENUE_REGISTRY_V0 = Object.freeze({
  polymarket: {
    chainId: 137, // Polygon mainnet — testnet runs against Polygon Amoy 80002
    ctfAddress: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045" as `0x${string}`,
  },
});
