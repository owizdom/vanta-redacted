/**
 * Real ExposureSnapshot builder — wires the onboarding loop's
 * cluster-concentration gate to the agent's actual book.
 *
 * Replaces the stub at main.ts that returned empty maps for every
 * onboarding tick, making `clusterConcentrationFactor` (in
 * `onboarding/reasoning.ts`) pass vacuously regardless of how many
 * loans the agent already had open against the same tag.
 *
 * Pipeline (pure composition, no RPC):
 *   - LoanRegistry.list()          → ActiveLoan[]
 *   - marketsCache.snapshotOne(cid) → question text
 *   - tagsFor(question)            → onboarding tag set (re-used from
 *                                    candidate-feed so identity matches)
 *   - aggregate `principal_usdc` per tag, build `open_market_ids` set
 *
 * Edge case: a loan whose market hasn't yet been hit by the metadata
 * refresh (cold start) has `question === null` in the cache. We still
 * include its conditionId in `open_market_ids` (it counts as exposure),
 * but skip it for `per_tag_usdc` aggregation — there's no way to bucket
 * untyped exposure without inventing a tag.
 */

import type { ExposureSnapshot } from "../onboarding/reasoning.js";

import { tagsFor } from "./candidate-feed.js";
import type { LoanRegistry } from "./loan-registry.js";
import type { MarketsCache } from "./markets-cache.js";

export interface ExposureReaderArgs {
  readonly loanRegistry: LoanRegistry;
  readonly marketsCache: MarketsCache;
}

export function createExposureReader(
  args: ExposureReaderArgs,
): () => Promise<ExposureSnapshot> {
  return async (): Promise<ExposureSnapshot> => {
    const perTag = new Map<string, bigint>();
    const openMarketIds = new Set<string>();

    for (const loan of args.loanRegistry.list()) {
      openMarketIds.add(loan.conditionId);
      const snap = args.marketsCache.snapshotOne(loan.conditionId);
      const question = snap?.question ?? null;
      if (question === null) continue;
      const tags = tagsFor(question);
      if (tags.length === 0) continue;
      for (const tag of tags) {
        perTag.set(tag, (perTag.get(tag) ?? 0n) + loan.principal);
      }
    }

    return {
      per_tag_usdc: perTag,
      open_market_ids: openMarketIds,
    };
  };
}
