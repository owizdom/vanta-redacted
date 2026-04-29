/**
 * Typed read helper for the Polymarket UMA CTF Adapter.
 *
 * Invariant I-PL-4 consumes `{resolved, paused, reset, refund}`; we
 * decode the full `QuestionData` tuple from viem, then project via a
 * strict zod schema so adapter-deployment drift (field reorder,
 * renamed fields, tuple length changes) fails loudly as
 * `response_schema_invalid` rather than silently returning booleans
 * decoded from the wrong slot.
 */

import type { PublicClient } from "viem";
import { z } from "zod";

import type { Sha256Hex } from "@vanta/tee";

import { UMA_CTF_ADAPTER_ABI } from "./abi/uma-ctf-adapter.js";
import { AMOY_CHAIN_ID, UMA_CTF_ADAPTER_ADDRESS } from "./constants.js";
import { VenuePolyError } from "./errors.js";
import type { QuestionId } from "./types.js";

function assertAmoyChain(client: PublicClient): void {
  const actual = client.chain?.id;
  if (actual !== AMOY_CHAIN_ID) {
    throw new VenuePolyError(
      "chain_id_mismatch",
      "venue-poly uma-adapter helper requires a PublicClient pinned to Polygon Amoy",
      {
        expectedChainId: String(AMOY_CHAIN_ID),
        actualChainId: actual === undefined ? "undefined" : String(actual),
      },
    );
  }
}

function bytes32FromSha256Hex(h: Sha256Hex): `0x${string}` {
  return `0x${h}` as `0x${string}`;
}

/**
 * The four flags I-PL-4 consumes, plus `requestTimestamp` (useful for
 * "is there an in-flight UMA request?" — non-zero means yes).
 */
export interface UmaQuestion {
  readonly resolved: boolean;
  readonly paused: boolean;
  readonly reset: boolean;
  readonly refund: boolean;
  readonly requestTimestamp: bigint;
}

/**
 * Strict zod schema over the projected flag bundle. Source-side
 * (viem's tuple decode) already narrows the types; this schema is a
 * second gate that rejects missing fields or non-boolean values — the
 * kind of drift that surfaces if a future adapter revision reorders
 * the struct or widens a field.
 */
const umaQuestionSchema = z
  .object({
    resolved: z.boolean(),
    paused: z.boolean(),
    reset: z.boolean(),
    refund: z.boolean(),
    requestTimestamp: z.bigint().nonnegative(),
  })
  .strict();

/**
 * Read `UmaCtfAdapter.getQuestion(questionId)` and project to the four
 * resolution flags used by invariant I-PL-4.
 */
export async function readQuestion(
  client: PublicClient,
  questionId: QuestionId,
): Promise<UmaQuestion> {
  assertAmoyChain(client);
  let raw: unknown;
  try {
    raw = await client.readContract({
      address: UMA_CTF_ADAPTER_ADDRESS,
      abi: UMA_CTF_ADAPTER_ABI,
      functionName: "getQuestion",
      args: [bytes32FromSha256Hex(questionId)],
    });
  } catch (cause: unknown) {
    const msg = cause instanceof Error ? cause.message : "unknown";
    throw new VenuePolyError(
      "uma_read_failed",
      `uma-adapter read 'getQuestion' failed: ${msg}`,
      { op: "getQuestion" },
    );
  }
  // viem types `readContract` output by the ABI; cast to a permissive
  // record for projection, then validate via zod. This keeps the zod
  // schema load-bearing even when the compile-time type narrows.
  const record = raw as Record<string, unknown>;
  const projected = {
    resolved: record["resolved"],
    paused: record["paused"],
    reset: record["reset"],
    refund: record["refund"],
    requestTimestamp: record["requestTimestamp"],
  };
  const parsed = umaQuestionSchema.safeParse(projected);
  if (!parsed.success) {
    throw new VenuePolyError(
      "response_schema_invalid",
      "uma-adapter getQuestion response failed schema validation",
      { field: parsed.error.issues[0]?.path.join(".") ?? "unknown" },
    );
  }
  return parsed.data;
}
