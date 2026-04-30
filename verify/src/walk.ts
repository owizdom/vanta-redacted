/**
 * Chain walker — walk parent_ids from `startId` back to a
 * `constitutional.genesis` event, verifying every event signature and
 * cross-checking on-chain `paramsHash` for `loan.origination` events.
 *
 * Semantics:
 *   - BFS on `parent_ids`. Visited set prevents re-verifying diamond-DAG
 *     re-encounters.
 *   - Every encountered event is verified via @vanta/events.verifyEvent
 *     against the signing pubkey extracted from `/api/tee`. The
 *     verifier already runs strict-RFC8032 (zip215=false) noble checks.
 *   - For every `loan.origination` event, additionally invoke
 *     `fetchLoanParamsHash(loanId)` and compare to the event body's
 *     `params_hash`. Mismatch → `params_hash_mismatch`.
 *   - Caps total visited at MAX_DEPTH (100k) — same as the
 *     `verifyTransitiveGenesis` cap in @vanta/events.
 *   - The terminal genesis event's `body.constitutionHash` MUST match
 *     the constitution hash served at `/api/constitution`. Mismatch →
 *     `genesis_mismatch`.
 *
 * Emits `Progress` per event so the CLI can render incremental output.
 */

import { verifyEvent } from "@vanta/events";
import type { SigningPubKeyHex, VantaEvent } from "@vanta/events";

import { VerifyError } from "./errors.js";

/** Cap consistent with @vanta/events.verifyTransitiveGenesis. */
export const MAX_WALK_DEPTH = 100_000;

export interface ProgressItem {
  readonly id: string;
  readonly type: string;
  readonly ok: boolean;
  readonly reason?: string;
}

export interface WalkError {
  readonly id: string;
  readonly reason: string;
}

export interface WalkResult {
  readonly ok: boolean;
  /** Number of events visited (incl. genesis). */
  readonly depth: number;
  readonly genesisId: string | null;
  readonly errors: readonly WalkError[];
  readonly progress: readonly ProgressItem[];
}

export interface WalkDeps {
  readonly fetchEvent: (id: string) => Promise<VantaEvent>;
  readonly verifyEvent: (
    event: VantaEvent,
    signer: SigningPubKeyHex,
  ) => Promise<{ ok: boolean; reason?: string }>;
  readonly fetchLoanParamsHash: (
    loanId: string,
  ) => Promise<string | null>;
  /** sha256 of the canonical constitution body (from `/api/constitution`). */
  readonly expectedConstitutionHash: string;
  readonly signer: SigningPubKeyHex;
  /**
   * If false, the walk skips the on-chain params_hash cross-check
   * (the CLI's `--rpc` opt-out). The walk emits a single warning entry
   * in `progress` for the first encountered loan.origination so callers
   * can render a notice.
   */
  readonly enableOnChainCheck: boolean;
}

/**
 * BFS walk from `startId` back to a `constitutional.genesis` event.
 */
export async function walkChain(
  deps: WalkDeps,
  startId: string,
): Promise<WalkResult> {
  const visited = new Set<string>();
  const queue: string[] = [startId];
  const errors: WalkError[] = [];
  const progress: ProgressItem[] = [];
  let genesisId: string | null = null;
  let warnedSkipOnChain = false;

  while (queue.length > 0) {
    if (visited.size >= MAX_WALK_DEPTH) {
      errors.push({
        id: "<walk>",
        reason: `chain_too_deep: visited ${String(visited.size)} >= MAX ${String(
          MAX_WALK_DEPTH,
        )}`,
      });
      return {
        ok: false,
        depth: visited.size,
        genesisId,
        errors,
        progress,
      };
    }

    const id = queue.shift();
    if (id === undefined) break;
    if (visited.has(id)) continue;
    visited.add(id);

    let event: VantaEvent;
    try {
      // eslint-disable-next-line no-await-in-loop
      event = await deps.fetchEvent(id);
    } catch (cause: unknown) {
      const reason =
        cause instanceof VerifyError
          ? `${cause.code}: ${cause.message}`
          : `parent_missing: ${cause instanceof Error ? cause.message : "unknown"}`;
      errors.push({ id, reason });
      progress.push({ id, type: "<missing>", ok: false, reason });
      continue;
    }

    // Cheap consistency: the server gave us back an event whose id
    // doesn't equal the id we asked for. Refuse.
    if (event.id !== id) {
      const reason = `id_mismatch: server returned event ${String(event.id)} for query ${id}`;
      errors.push({ id, reason });
      progress.push({ id, type: event.type, ok: false, reason });
      continue;
    }

    // Verify signature.
    // eslint-disable-next-line no-await-in-loop
    const verify = await deps.verifyEvent(event, deps.signer);
    if (!verify.ok) {
      const reason = `signature_invalid: ${verify.reason ?? "unknown"}`;
      errors.push({ id, reason });
      progress.push({ id, type: event.type, ok: false, reason });
      continue;
    }

    // Origination cross-check.
    if (event.type === "loan.origination") {
      if (!deps.enableOnChainCheck) {
        if (!warnedSkipOnChain) {
          warnedSkipOnChain = true;
          progress.push({
            id,
            type: event.type,
            ok: true,
            reason: "on_chain_check_skipped",
          });
        } else {
          progress.push({ id, type: event.type, ok: true });
        }
      } else {
        let onChainHash: string | null;
        try {
          // eslint-disable-next-line no-await-in-loop
          onChainHash = await deps.fetchLoanParamsHash(event.body.loan_id);
        } catch (cause: unknown) {
          const reason =
            cause instanceof VerifyError
              ? `${cause.code}: ${cause.message}`
              : `rpc_unreachable: ${cause instanceof Error ? cause.message : "unknown"}`;
          errors.push({ id, reason });
          progress.push({ id, type: event.type, ok: false, reason });
          continue;
        }
        if (onChainHash === null) {
          const reason =
            "params_hash_mismatch: LoanBook.loans(loanId).status == None — no on-chain stamp";
          errors.push({ id, reason });
          progress.push({ id, type: event.type, ok: false, reason });
          continue;
        }
        if (onChainHash.toLowerCase() !== event.body.params_hash.toLowerCase()) {
          const reason = `params_hash_mismatch: on-chain ${onChainHash} != event ${String(event.body.params_hash)}`;
          errors.push({ id, reason });
          progress.push({ id, type: event.type, ok: false, reason });
          continue;
        }
        progress.push({ id, type: event.type, ok: true });
      }
    } else {
      progress.push({ id, type: event.type, ok: true });
    }

    if (event.type === "constitutional.genesis") {
      // Only record the FIRST genesis we hit; record one and skip
      // pushing further parents (genesis has parent_ids === []).
      if (genesisId === null) {
        genesisId = event.id;
      }
      continue;
    }

    for (const pid of event.parent_ids) {
      if (!visited.has(pid)) {
        queue.push(pid);
      }
    }
  }

  if (genesisId === null) {
    errors.push({
      id: "<walk>",
      reason: "genesis_unreachable: BFS exhausted without finding constitutional.genesis",
    });
    return {
      ok: false,
      depth: visited.size,
      genesisId: null,
      errors,
      progress,
    };
  }

  // Cross-check the genesis body's constitutionHash against
  // /api/constitution.
  let genesisEvent: VantaEvent;
  try {
    genesisEvent = await deps.fetchEvent(genesisId);
  } catch (cause: unknown) {
    errors.push({
      id: genesisId,
      reason: `genesis_mismatch: failed to refetch genesis (${
        cause instanceof Error ? cause.message : "unknown"
      })`,
    });
    return {
      ok: false,
      depth: visited.size,
      genesisId,
      errors,
      progress,
    };
  }
  if (genesisEvent.type !== "constitutional.genesis") {
    errors.push({
      id: genesisId,
      reason: `genesis_mismatch: refetched event has type ${genesisEvent.type}`,
    });
    return {
      ok: false,
      depth: visited.size,
      genesisId,
      errors,
      progress,
    };
  }

  const observed = String(genesisEvent.body.constitutionHash).toLowerCase();
  const expected = deps.expectedConstitutionHash.toLowerCase();
  if (observed !== expected) {
    errors.push({
      id: genesisId,
      reason: `genesis_mismatch: genesis.constitutionHash ${observed} != /api/constitution.hash ${expected}`,
    });
    return {
      ok: false,
      depth: visited.size,
      genesisId,
      errors,
      progress,
    };
  }

  return {
    ok: errors.length === 0,
    depth: visited.size,
    genesisId,
    errors,
    progress,
  };
}

/**
 * Adapter from `@vanta/events.verifyEvent` (returns a tagged union) to
 * the simpler `{ ok, reason }` shape `walkChain` consumes. Exposed so
 * the CLI and tests share one wiring.
 */
export async function defaultVerifyAdapter(
  event: VantaEvent,
  signer: SigningPubKeyHex,
): Promise<{ ok: boolean; reason?: string }> {
  const res = await verifyEvent(event, signer);
  if (res.ok) return { ok: true };
  return { ok: false, reason: res.error.message };
}
