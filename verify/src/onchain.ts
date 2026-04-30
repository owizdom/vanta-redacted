/**
 * On-chain `LoanBook.loans(loanId)` reader for the verifier CLI.
 *
 * Returns the `paramsHash` field from the `Loan` struct, or `null` if
 * the loan does not exist on-chain (status == None == 0). The verifier
 * uses the comparison `onChainParamsHash == event.body.params_hash` to
 * enforce I-VR-5.
 *
 * The ABI fragment is duplicated rather than imported from
 * @vanta/origination so the verifier package's dep graph stays
 * minimal — verify imports nothing from origination, only events + tee.
 */

import { createPublicClient, http } from "viem";
import type { Address, Hex, PublicClient } from "viem";

import { VerifyError } from "./errors.js";

/** Subset of LoanBook ABI we need: `loans(bytes32) view returns (...)`. */
const LOAN_BOOK_ABI = [
  {
    type: "function",
    name: "loans",
    stateMutability: "view",
    inputs: [{ name: "loanId", type: "bytes32" }],
    outputs: [
      { name: "borrower", type: "address" },
      { name: "principal", type: "uint256" },
      { name: "maturityTs", type: "uint64" },
      { name: "haircutBps", type: "uint32" },
      { name: "paramsHash", type: "bytes32" },
      { name: "attestationHash", type: "bytes32" },
      { name: "status", type: "uint8" },
    ],
  },
] as const;

/**
 * Build a public client over an arbitrary RPC URL. Caller-injectable
 * via the test seam in `walk.ts`.
 */
export function buildPublicClient(rpcUrl: string): PublicClient {
  return createPublicClient({
    transport: http(rpcUrl),
  });
}

/**
 * Read the on-chain `paramsHash` for a given loanId. Returns `null` if
 * `status == 0` (the loan id is unused). Throws `rpc_unreachable` on
 * read failure.
 *
 * The id is provided as our 64-char unprefixed hex `Sha256Hex`; we
 * convert to viem's 0x-prefixed `Hex` here.
 */
export async function fetchLoanParamsHash(
  client: PublicClient,
  loanBookAddress: Address,
  loanIdHex64: string,
): Promise<string | null> {
  const loanIdBytes32 = (`0x${loanIdHex64}` as Hex);
  let result;
  try {
    result = await client.readContract({
      address: loanBookAddress,
      abi: LOAN_BOOK_ABI,
      functionName: "loans",
      args: [loanIdBytes32],
    });
  } catch (cause: unknown) {
    throw new VerifyError(
      "rpc_unreachable",
      "LoanBook.loans read failed",
      { loanId: loanIdHex64, loanBookAddress },
      cause,
    );
  }
  // viem returns the tuple as a positional array per the ABI outputs.
  // Indices match LOAN_BOOK_ABI.outputs above:
  //   0 borrower, 1 principal, 2 maturityTs, 3 haircutBps,
  //   4 paramsHash, 5 attestationHash, 6 status.
  const tuple = result as readonly unknown[];
  const status = Number(tuple[6]);
  if (status === 0) {
    return null;
  }
  const paramsHashHex = tuple[4] as string;
  // Strip 0x prefix to match our `Sha256Hex` brand convention.
  return paramsHashHex.startsWith("0x")
    ? paramsHashHex.slice(2).toLowerCase()
    : paramsHashHex.toLowerCase();
}
