/**
 * Minimal ABI for the Gnosis / Polymarket ConditionalTokens (ERC-1155)
 * contract on Polygon Amoy (`0x69308FB5…8d994F4e2Bf8bB`).
 *
 * Scope: only the surface the pledge path actually touches — balances,
 * approvals, CTF-level resolution reads, and the three condition-
 * lifecycle mutators (`prepareCondition`, `splitPosition`, `mergePositions`,
 * `redeemPositions`). Everything else in the public CTF ABI is
 * intentionally omitted so a consumer cannot accidentally construct a
 * calldata payload outside the reviewed surface.
 *
 * Typed `as const` so viem's type inference narrows event args + decode
 * return types without widening to `unknown`.
 *
 * Sources:
 *   - Gnosis `ConditionalTokens.sol` v1.0 canonical contract
 *   - Polymarket CTF README (Amoy deployment), recon cheat sheet
 *     (§2 `recon-polymarket-ctf`).
 */

export const CTF_ABI = [
  // ----- ERC-1155 core -----
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "id", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "isApprovedForAll",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "operator", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "setApprovalForAll",
    stateMutability: "nonpayable",
    inputs: [
      { name: "operator", type: "address" },
      { name: "approved", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "safeTransferFrom",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "id", type: "uint256" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
  },

  // ----- CTF resolution surface -----
  //
  // `payoutNumerators` is `mapping(bytes32 => uint256[])`; the Solidity
  // auto-getter takes `(bytes32, uint256)` and returns a single
  // `uint256`. Invariant I-PL-4 uses `payoutDenominator` as the primary
  // "is resolved" signal (canonical-reference §3 reconciliation note).
  {
    type: "function",
    name: "payoutNumerators",
    stateMutability: "view",
    inputs: [
      { name: "conditionId", type: "bytes32" },
      { name: "index", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "payoutDenominator",
    stateMutability: "view",
    inputs: [{ name: "conditionId", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getOutcomeSlotCount",
    stateMutability: "view",
    inputs: [{ name: "conditionId", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
  },

  // ----- Condition lifecycle mutators -----
  {
    type: "function",
    name: "prepareCondition",
    stateMutability: "nonpayable",
    inputs: [
      { name: "oracle", type: "address" },
      { name: "questionId", type: "bytes32" },
      { name: "outcomeSlotCount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "splitPosition",
    stateMutability: "nonpayable",
    inputs: [
      { name: "collateralToken", type: "address" },
      { name: "parentCollectionId", type: "bytes32" },
      { name: "conditionId", type: "bytes32" },
      { name: "partition", type: "uint256[]" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "mergePositions",
    stateMutability: "nonpayable",
    inputs: [
      { name: "collateralToken", type: "address" },
      { name: "parentCollectionId", type: "bytes32" },
      { name: "conditionId", type: "bytes32" },
      { name: "partition", type: "uint256[]" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "redeemPositions",
    stateMutability: "nonpayable",
    inputs: [
      { name: "collateralToken", type: "address" },
      { name: "parentCollectionId", type: "bytes32" },
      { name: "conditionId", type: "bytes32" },
      { name: "indexSets", type: "uint256[]" },
    ],
    outputs: [],
  },

  // ----- Events -----
  {
    type: "event",
    name: "TransferSingle",
    inputs: [
      { name: "operator", type: "address", indexed: true },
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "id", type: "uint256", indexed: false },
      { name: "value", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "TransferBatch",
    inputs: [
      { name: "operator", type: "address", indexed: true },
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "ids", type: "uint256[]", indexed: false },
      { name: "values", type: "uint256[]", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ConditionPreparation",
    inputs: [
      { name: "conditionId", type: "bytes32", indexed: true },
      { name: "oracle", type: "address", indexed: true },
      { name: "questionId", type: "bytes32", indexed: true },
      { name: "outcomeSlotCount", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ConditionResolution",
    inputs: [
      { name: "conditionId", type: "bytes32", indexed: true },
      { name: "oracle", type: "address", indexed: true },
      { name: "questionId", type: "bytes32", indexed: true },
      { name: "outcomeSlotCount", type: "uint256", indexed: false },
      { name: "payoutNumerators", type: "uint256[]", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "PositionSplit",
    inputs: [
      { name: "stakeholder", type: "address", indexed: true },
      { name: "collateralToken", type: "address", indexed: false },
      { name: "parentCollectionId", type: "bytes32", indexed: true },
      { name: "conditionId", type: "bytes32", indexed: true },
      { name: "partition", type: "uint256[]", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
] as const;

export type CtfAbi = typeof CTF_ABI;
