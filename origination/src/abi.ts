/**
 * Minimal LoanBook ABI used by the origination orchestrator.
 *
 * Only the two function fragments we actually call are exposed; reading
 * the full contract ABI from disk would couple this package to the
 * Foundry build artefacts. Field names + types match
 * `contracts/src/LoanBook.sol` exactly:
 *
 *   function originate(
 *     bytes32 loanId,
 *     address borrower,
 *     uint256 principal,
 *     uint32 haircutBps,
 *     uint64 maturityTs,
 *     bytes32 attestationHash
 *   ) external;
 *
 *   function loans(bytes32 loanId) external view returns (
 *     address borrower,
 *     uint256 principal,
 *     uint64 maturityTs,
 *     uint32 haircutBps,
 *     bytes32 paramsHash,
 *     bytes32 attestationHash,
 *     uint8 status
 *   );
 *
 * The `loans` getter's return-tuple order matches Solidity's auto-
 * generated layout for the `Loan` struct (declaration order in the
 * contract) — borrower, principal, maturityTs, haircutBps, paramsHash,
 * attestationHash, status.
 */

export const LOAN_BOOK_ABI = [
  {
    type: "function",
    name: "originate",
    stateMutability: "nonpayable",
    inputs: [
      { name: "loanId", type: "bytes32" },
      { name: "borrower", type: "address" },
      { name: "principal", type: "uint256" },
      { name: "haircutBps", type: "uint32" },
      { name: "maturityTs", type: "uint64" },
      { name: "attestationHash", type: "bytes32" },
    ],
    outputs: [],
  },
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
