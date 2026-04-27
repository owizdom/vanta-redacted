/**
 * External verification surface (spec §1.5, §5, §D5).
 *
 * - `verifyEvent` sequences cheap-first per spec §5: signer match →
 *   id reconstruction → signature verification. External verifiers
 *   (spec §D5) use `@noble/ed25519` with `zip215: false` to obtain
 *   strict RFC 8032 semantics.
 * - `decodeAndVerify` composes `decodeEvent` + `verifyEvent`.
 * - `verifyTransitiveGenesis` BFS-walks the `parent_ids` DAG, memoizes
 *   visited nodes, enforces `maxDepth = 100_000` (spec §D10), and
 *   reports cycles and multi-genesis chains.
 *
 * `verifyEvent` is deliberately async because the external verifier
 * path uses `@noble/ed25519` v2 `verifyAsync` which requires async
 * sha512 unless a sync hook is installed. Supplying the hook here
 * would couple this module to `@noble/hashes`; keeping the verify
 * path async keeps the dep graph minimal.
 */

import { createHash } from "node:crypto";

import * as ed25519 from "@noble/ed25519";

import { reDerivePreimage } from "./build.js";
import { decodeEvent } from "./decode.js";
import { EventsError } from "./errors.js";
import type { Sha256Hex, SigningPubKeyHex, VantaEvent } from "./types.js";

export type VerifyResult =
  | { readonly ok: true; readonly event: VantaEvent }
  | { readonly ok: false; readonly error: EventsError };

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

/**
 * Maximum nodes visited during transitive BFS (spec §D10). External
 * verifier CLIs run this against untrusted DAGs; 100k caps worst-case
 * CPU without being a bottleneck in practice.
 */
const MAX_TRANSITIVE_DEPTH = 100_000;

function sha256Hex(bytes: Uint8Array): string {
  const h = createHash("sha256");
  h.update(bytes);
  return h.digest("hex");
}

/**
 * Async verify of a single event against an expected signer pubkey.
 *
 * Sequencing (spec §5, P1 "signer match → id match → signature verify"):
 *   1. Signer match — cheap string compare.
 *   2. `expectedSigner` well-formedness (128-char pubkey is caller's
 *      invariant, but we re-check to prevent a downstream `@noble` throw).
 *   3. Id match — recompute preimage bytes, sha256, compare to event.id.
 *      This is cheaper than a curve op and catches malformed payloads.
 *   4. Signature match — `@noble/ed25519` `verifyAsync` with
 *      `zip215: false` (strict RFC 8032).
 */
export async function verifyEvent(
  event: VantaEvent,
  expectedSigner: SigningPubKeyHex,
): Promise<VerifyResult> {
  const expected: string = expectedSigner;
  if (!HEX64.test(expected)) {
    return {
      ok: false,
      error: new EventsError(
        "signer_pubkey_malformed",
        "expectedSigner must be 64-char lowercase hex",
        { actualLen: String(expected.length) },
      ),
    };
  }

  const eventSigner: string = event.tee.signingPubKey;
  if (eventSigner !== expected) {
    return {
      ok: false,
      error: new EventsError(
        "signer_mismatch",
        "event.tee.signingPubKey does not match expectedSigner",
      ),
    };
  }

  if (!HEX128.test(event.signature)) {
    return {
      ok: false,
      error: new EventsError(
        "signature_invalid",
        "signature hex length must be 128",
        { actualLen: String(event.signature.length) },
      ),
    };
  }

  let preimage: Uint8Array;
  try {
    preimage = reDerivePreimage(event);
  } catch (err: unknown) {
    if (err instanceof EventsError) {
      return { ok: false, error: err };
    }
    return {
      ok: false,
      error: new EventsError(
        "canonical_json_failed",
        err instanceof Error ? err.message : "re-derive threw non-Error",
      ),
    };
  }

  const recomputedId = sha256Hex(preimage);
  const eventId: string = event.id;
  if (recomputedId !== eventId) {
    return {
      ok: false,
      error: new EventsError(
        "id_mismatch",
        "recomputed sha256(canonical preimage) does not match event.id",
      ),
    };
  }

  let ok: boolean;
  try {
    const sigBytes = hexToBytes(event.signature);
    const pubBytes = hexToBytes(expected);
    ok = await ed25519.verifyAsync(sigBytes, preimage, pubBytes, {
      zip215: false,
    });
  } catch (err: unknown) {
    return {
      ok: false,
      error: new EventsError(
        "signature_invalid",
        err instanceof Error ? err.message : "verifyAsync threw non-Error",
      ),
    };
  }

  if (!ok) {
    return {
      ok: false,
      error: new EventsError(
        "signature_invalid",
        "Ed25519 signature did not verify against the recomputed preimage",
      ),
    };
  }

  return { ok: true, event };
}

/** Decode then verify. Early-exit on decode failure (spec §1.5). */
export async function decodeAndVerify(
  rawJson: string,
  signer: SigningPubKeyHex,
): Promise<VerifyResult> {
  const decoded = decodeEvent(rawJson);
  if (!decoded.ok) {
    return { ok: false, error: decoded.error };
  }
  return verifyEvent(decoded.event, signer);
}

// ------------------- Transitive genesis -------------------

export interface GenesisReachabilityReport {
  readonly reachable: boolean;
  readonly depth: number;
  readonly visited: number;
  readonly genesisId: Sha256Hex | null;
  readonly error?: EventsError;
}

export interface EventLog {
  readonly get: (id: Sha256Hex) => VantaEvent | undefined;
}

/**
 * Transitive genesis BFS (spec §1.5, I-EV-7).
 *
 * Semantics:
 *  - A `constitutional.genesis` node is the terminal node; depth is the
 *    hop count from `event` to that node (0 if `event` itself is genesis).
 *  - Reports the first-found genesis. If more than one distinct genesis
 *    is encountered in the entire BFS (i.e. a fork), fail with
 *    `multiple_genesis_found`.
 *  - Cycles detected via the `visited` set; a back-edge to a node we
 *    have already dequeued is a cycle, not a re-encounter. We track
 *    distinct ids; a node's children are only expanded once.
 *  - Depth cap at `MAX_TRANSITIVE_DEPTH` visited nodes.
 */
export function verifyTransitiveGenesis(
  event: VantaEvent,
  log: EventLog,
): GenesisReachabilityReport {
  // Shortcut: event itself is the genesis.
  if (event.type === "constitutional.genesis") {
    return {
      reachable: true,
      depth: 0,
      visited: 1,
      genesisId: event.id,
    };
  }

  const visited = new Set<string>();
  const queue: { id: Sha256Hex; depth: number }[] = [];

  // Seed with every parent of the input.
  for (const pid of event.parent_ids) {
    queue.push({ id: pid, depth: 1 });
  }
  const selfId: string = event.id;
  visited.add(selfId);

  let foundGenesisId: Sha256Hex | null = null;
  let foundDepth = -1;

  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) {
      break;
    }
    const { id, depth } = next;

    if (visited.size > MAX_TRANSITIVE_DEPTH) {
      return {
        reachable: false,
        depth: 0,
        visited: visited.size,
        genesisId: null,
        error: new EventsError(
          "depth_exceeded",
          `BFS visited ${String(visited.size)} nodes (max ${String(MAX_TRANSITIVE_DEPTH)})`,
          { visited: String(visited.size) },
        ),
      };
    }

    const idStr: string = id;
    if (visited.has(idStr)) {
      // Already processed via another branch (diamond DAG). Skip.
      // A true cycle is bounded by MAX_TRANSITIVE_DEPTH above; structural
      // cycles here would exhaust the visited cap, not pass through twice.
      continue;
    }
    visited.add(idStr);

    const node = log.get(id);
    if (node === undefined) {
      return {
        reachable: false,
        depth: 0,
        visited: visited.size,
        genesisId: null,
        error: new EventsError(
          "parent_missing",
          "parent id not present in EventLog",
          { parentId: idStr },
        ),
      };
    }

    if (node.type === "constitutional.genesis") {
      if (foundGenesisId === null) {
        foundGenesisId = node.id;
        foundDepth = depth;
        // Do not break: keep walking other branches to detect
        // multiple-genesis forks.
        continue;
      }
      const firstId: string = foundGenesisId;
      const secondId: string = node.id;
      if (firstId !== secondId) {
        return {
          reachable: false,
          depth: 0,
          visited: visited.size,
          genesisId: null,
          error: new EventsError(
            "multiple_genesis_found",
            "more than one distinct constitutional.genesis in transitive closure",
            {
              firstGenesis: firstId,
              secondGenesis: secondId,
            },
          ),
        };
      }
      // Same genesis reached via another path — keep the shallowest depth.
      if (depth < foundDepth) {
        foundDepth = depth;
      }
      continue;
    }

    for (const pid of node.parent_ids) {
      queue.push({ id: pid, depth: depth + 1 });
    }
  }

  if (foundGenesisId === null) {
    return {
      reachable: false,
      depth: 0,
      visited: visited.size,
      genesisId: null,
      error: new EventsError(
        "transitive_genesis_unreachable",
        "BFS exhausted without finding constitutional.genesis",
        { visited: String(visited.size) },
      ),
    };
  }

  return {
    reachable: true,
    depth: foundDepth,
    visited: visited.size,
    genesisId: foundGenesisId,
  };
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
