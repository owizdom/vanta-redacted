/**
 * Typed read helpers for the Polymarket ConditionalTokens contract.
 *
 * Every read that hits an RPC is chain-id-guarded: the supplied
 * `PublicClient`'s `chain.id` must equal `AMOY_CHAIN_ID` (80002). This
 * matches the treasury pattern in `client.ts` (`assertBaseSepoliaChain`)
 * and defends against a caller accidentally binding this module's
 * addresses to a different chain's state.
 *
 * Pure helpers (`computeConditionId`, `computePositionId`) are
 * deliberately keccak-only — no RPC call, no `bigint` encoding pitfalls.
 * Collection ids are derived on-chain via the `CTHelpers` exposer at
 * fixture time (canonical-reference §3); there is no pure-JS path.
 */

import type { PublicClient } from "viem";
import { encodePacked, keccak256 } from "viem";

import type { EthAddressHex, Sha256Hex } from "@vanta/tee";
import { asSha256Hex } from "@vanta/tee";

import { CTF_ABI } from "./abi/conditional-tokens.js";
import { AMOY_CHAIN_ID, CTF_ADDRESS } from "./constants.js";
import { VenuePolyError } from "./errors.js";
import type { ConditionId, PositionId, QuestionId } from "./types.js";
import { asPositionId } from "./types.js";

/**
 * Bytes32 string as viem expects (0x-prefixed 64 hex chars). Internal
 * to this module so callers pass branded `ConditionId` / `QuestionId`
 * values without a prefix and we stamp the prefix at the boundary.
 */
type Bytes32Hex = `0x${string}`;

function bytes32FromSha256Hex(h: Sha256Hex): Bytes32Hex {
  return `0x${h}` as Bytes32Hex;
}

function assertAmoyChain(client: PublicClient): void {
  const actual = client.chain?.id;
  if (actual !== AMOY_CHAIN_ID) {
    throw new VenuePolyError(
      "chain_id_mismatch",
      "venue-poly ctf helper requires a PublicClient pinned to Polygon Amoy",
      {
        expectedChainId: String(AMOY_CHAIN_ID),
        actualChainId: actual === undefined ? "undefined" : String(actual),
      },
    );
  }
}

function wrapCtfRead<T>(op: string, fn: () => Promise<T>): Promise<T> {
  return fn().catch((cause: unknown) => {
    if (cause instanceof VenuePolyError) {
      throw cause;
    }
    const causeMsg = cause instanceof Error ? cause.message : "unknown";
    throw new VenuePolyError(
      "ctf_read_failed",
      `ctf read '${op}' failed: ${causeMsg}`,
      { op },
    );
  });
}

// ---------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------

/**
 * Read `CTF.balanceOf(owner, positionId)` returning the raw uint256 as
 * `bigint`. Chain-id-guarded; wraps RPC failures as
 * `VenuePolyError("ctf_read_failed", ...)`.
 */
export async function readBalance(
  client: PublicClient,
  owner: EthAddressHex,
  positionId: PositionId,
): Promise<bigint> {
  assertAmoyChain(client);
  return wrapCtfRead("balanceOf", async () => {
    const raw = await client.readContract({
      address: CTF_ADDRESS,
      abi: CTF_ABI,
      functionName: "balanceOf",
      args: [owner, positionId],
    });
    return raw;
  });
}

/**
 * Read `CTF.isApprovedForAll(owner, operator)`.
 */
export async function readApproval(
  client: PublicClient,
  owner: EthAddressHex,
  operator: EthAddressHex,
): Promise<boolean> {
  assertAmoyChain(client);
  return wrapCtfRead("isApprovedForAll", async () => {
    const raw = await client.readContract({
      address: CTF_ADDRESS,
      abi: CTF_ABI,
      functionName: "isApprovedForAll",
      args: [owner, operator],
    });
    return raw;
  });
}

/**
 * Read `CTF.payoutDenominator(conditionId)`. This is the primary
 * "is resolved" check per invariant I-PL-4 (canonical-reference §3): a
 * non-zero value means `reportPayouts` has fired and the market is
 * resolved. `0n` means unresolved.
 */
export async function readPayoutDenominator(
  client: PublicClient,
  conditionId: ConditionId,
): Promise<bigint> {
  assertAmoyChain(client);
  return wrapCtfRead("payoutDenominator", async () => {
    const raw = await client.readContract({
      address: CTF_ADDRESS,
      abi: CTF_ABI,
      functionName: "payoutDenominator",
      args: [bytes32FromSha256Hex(conditionId)],
    });
    return raw;
  });
}

/**
 * Read `CTF.payoutNumerators(conditionId, i)` for every `i ∈ [0, outcomeSlotCount)`.
 *
 * Rejects when the array returned by any read is inconsistent with the
 * supplied slot count — the caller must pass a slot count already
 * fetched via `readOutcomeSlotCount`, not a hand-rolled guess.
 * `outcomeSlotCount === 0n` is rejected up front (condition never
 * prepared; see canonical-reference §3 read sequence step 1).
 */
export async function readPayoutNumerators(
  client: PublicClient,
  conditionId: ConditionId,
  outcomeSlotCount: bigint,
): Promise<bigint[]> {
  assertAmoyChain(client);
  if (outcomeSlotCount <= 0n) {
    throw new VenuePolyError(
      "response_schema_invalid",
      "readPayoutNumerators: outcomeSlotCount must be > 0 (condition never prepared?)",
      { outcomeSlotCount: outcomeSlotCount.toString() },
    );
  }
  // CTF's `getOutcomeSlotCount` returns uint256; practical condition
  // counts are tiny (<= 256). We still clamp defensively so a bogus
  // client return cannot force an enormous loop.
  if (outcomeSlotCount > 256n) {
    throw new VenuePolyError(
      "response_schema_invalid",
      "readPayoutNumerators: outcomeSlotCount exceeds sane bound (256)",
      { outcomeSlotCount: outcomeSlotCount.toString() },
    );
  }
  return wrapCtfRead("payoutNumerators", async () => {
    const cid = bytes32FromSha256Hex(conditionId);
    const count = Number(outcomeSlotCount);
    const slots: bigint[] = [];
    for (let i = 0; i < count; i++) {
      // eslint-disable-next-line no-await-in-loop
      const raw = await client.readContract({
        address: CTF_ADDRESS,
        abi: CTF_ABI,
        functionName: "payoutNumerators",
        args: [cid, BigInt(i)],
      });
      slots.push(raw);
    }
    if (slots.length !== count) {
      throw new VenuePolyError(
        "response_schema_invalid",
        "readPayoutNumerators: decoded length mismatches outcomeSlotCount",
        {
          expectedLen: String(count),
          actualLen: String(slots.length),
        },
      );
    }
    return slots;
  });
}

/**
 * Read `CTF.getOutcomeSlotCount(conditionId)`. A return of `0n` means
 * the condition was never prepared on-chain — reject the pledge path.
 */
export async function readOutcomeSlotCount(
  client: PublicClient,
  conditionId: ConditionId,
): Promise<bigint> {
  assertAmoyChain(client);
  return wrapCtfRead("getOutcomeSlotCount", async () => {
    const raw = await client.readContract({
      address: CTF_ADDRESS,
      abi: CTF_ABI,
      functionName: "getOutcomeSlotCount",
      args: [bytes32FromSha256Hex(conditionId)],
    });
    return raw;
  });
}

// ---------------------------------------------------------------------
// Pure hash helpers
// ---------------------------------------------------------------------

/**
 * Compute a CTF condition id per Gnosis `ConditionalTokens.sol`:
 *
 *   conditionId = keccak256(abi.encodePacked(oracle, questionId, outcomeSlotCount))
 *
 * The encoding matches Solidity's `abi.encodePacked`: `address` as
 * 20 bytes, `bytes32` as 32 bytes, `uint256` as 32 bytes — no padding,
 * no length prefix. Returned as an unprefixed 64-char lowercase hex
 * string, branded `Sha256Hex` (64 hex chars = 32 bytes).
 */
export function computeConditionId(
  oracle: EthAddressHex,
  questionId: QuestionId,
  outcomeSlotCount: bigint,
): Sha256Hex {
  if (outcomeSlotCount <= 0n) {
    throw new VenuePolyError(
      "response_schema_invalid",
      "computeConditionId: outcomeSlotCount must be > 0",
      { outcomeSlotCount: outcomeSlotCount.toString() },
    );
  }
  const packed = encodePacked(
    ["address", "bytes32", "uint256"],
    [oracle, bytes32FromSha256Hex(questionId), outcomeSlotCount],
  );
  const hash = keccak256(packed);
  // `keccak256` returns a 0x-prefixed 66-char string; strip the prefix
  // and normalise the case so the result slots into our Sha256Hex brand.
  const stripped = hash.slice(2).toLowerCase();
  return asSha256Hex(stripped);
}

/**
 * Compute a CTF position id per Gnosis `ConditionalTokens.sol`:
 *
 *   positionId = uint256(keccak256(abi.encodePacked(collateralToken, collectionId)))
 *
 * `collectionId` is a `bytes32` derived on-chain by the `CTHelpers`
 * exposer at fixture time (canonical-reference §3); we do not derive it
 * in pure JS. Returned as a branded `PositionId` (`bigint`).
 */
export function computePositionId(
  collateralToken: EthAddressHex,
  collectionId: Sha256Hex,
): PositionId {
  const packed = encodePacked(
    ["address", "bytes32"],
    [collateralToken, bytes32FromSha256Hex(collectionId)],
  );
  const hash = keccak256(packed); // 0x + 64 hex = 32 bytes
  // Parse the full 32-byte digest as a uint256 bigint.
  const asUint = BigInt(hash);
  return asPositionId(asUint);
}
