/**
 * Compute the `paramsHash` that LoanBook stamps into its `Loan` struct.
 *
 * Solidity (LoanBook.sol §originate):
 *
 *   bytes32 paramsHash = keccak256(
 *     abi.encode(borrower, principal, haircutBps, maturityTs)
 *   );
 *
 * with field types:
 *   - borrower:   address (uint160 in ABI; 32-byte left-padded encoding)
 *   - principal:  uint256
 *   - haircutBps: uint32  (matches `Loan.haircutBps`)
 *   - maturityTs: uint64
 *
 * Width-correctness is load-bearing: a `uint16`-encoded haircut would
 * produce a different `abi.encode` frame and the hash would not match
 * the on-chain stamp, breaking the verifier's I-VR-5 cross-check.
 */

import type { Address } from "viem";
import { encodeAbiParameters, keccak256 } from "viem";

import { asSha256Hex, type Sha256Hex } from "@vanta/tee";

import { OriginationError } from "./errors.js";

/** keccak256 ABI types for `LoanBook.originate` paramsHash. */
const PARAMS_HASH_ABI_TYPES = [
  { type: "address" },
  { type: "uint256" },
  { type: "uint32" },
  { type: "uint64" },
] as const;

/**
 * Returns the 32-byte `paramsHash` as an unprefixed lowercase
 * `Sha256Hex` (the brand permits any 64-char lowercase hex).
 *
 * Throws `OriginationError({ code: "params_invalid" })` if any input is
 * out of range (negative principal/haircut/maturity, haircut > 10000,
 * or principal not parsable as a non-negative integer).
 */
export function computeParamsHash(
  borrower: Address,
  principal: string,
  haircutBps: number,
  maturityTs: number,
): Sha256Hex {
  if (!/^[0-9]+$/.test(principal)) {
    throw new OriginationError(
      "params_invalid",
      "principal must be a decimal-digit string (USDC wei)",
      { principal },
    );
  }
  if (
    !Number.isInteger(haircutBps) ||
    haircutBps < 0 ||
    haircutBps > 10000
  ) {
    throw new OriginationError(
      "params_invalid",
      "haircutBps must be an integer in [0, 10000]",
      { haircutBps: String(haircutBps) },
    );
  }
  if (
    !Number.isInteger(maturityTs) ||
    maturityTs <= 0 ||
    !Number.isSafeInteger(maturityTs)
  ) {
    throw new OriginationError(
      "params_invalid",
      "maturityTs must be a positive safe-integer unix-seconds value",
      { maturityTs: String(maturityTs) },
    );
  }

  const principalBig = BigInt(principal);
  const encoded = encodeAbiParameters(PARAMS_HASH_ABI_TYPES, [
    borrower,
    principalBig,
    haircutBps,
    BigInt(maturityTs),
  ]);
  // viem's keccak256 returns 0x-prefixed lowercase; strip the prefix to
  // match our `Sha256Hex` brand convention.
  const hashHex = keccak256(encoded);
  return asSha256Hex(hashHex.slice(2).toLowerCase());
}
