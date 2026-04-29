/**
 * Minimal ABI for the Polymarket UMA CTF Adapter v3.1 on Amoy
 * (`0x2F6f8DA6…1975A4e12`).
 *
 * Scope: `getQuestion(bytes32)` only. Returns the `QuestionData` tuple
 * whose shape matches `Polymarket/uma-ctf-adapter/src/libraries/QuestionData.sol`:
 *
 *   struct QuestionData {
 *     uint256 requestTimestamp;
 *     address rewardToken;
 *     uint256 reward;
 *     uint256 proposalBond;
 *     uint256 emergencyResolutionTimestamp;
 *     bytes   ancillaryData;
 *     address creator;
 *     bool    resolved;
 *     bool    paused;
 *     bool    reset;
 *     bool    refund;
 *   }
 *
 * Invariant I-PL-4 consumes `{resolved, paused, reset, refund}`; the
 * other fields are kept in the tuple so viem's decode stays
 * structurally correct but they are not re-exported at the module
 * boundary.
 */

export const UMA_CTF_ADAPTER_ABI = [
  {
    type: "function",
    name: "getQuestion",
    stateMutability: "view",
    inputs: [{ name: "questionId", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "requestTimestamp", type: "uint256" },
          { name: "rewardToken", type: "address" },
          { name: "reward", type: "uint256" },
          { name: "proposalBond", type: "uint256" },
          { name: "emergencyResolutionTimestamp", type: "uint256" },
          { name: "ancillaryData", type: "bytes" },
          { name: "creator", type: "address" },
          { name: "resolved", type: "bool" },
          { name: "paused", type: "bool" },
          { name: "reset", type: "bool" },
          { name: "refund", type: "bool" },
        ],
      },
    ],
  },
] as const;

export type UmaCtfAdapterAbi = typeof UMA_CTF_ADAPTER_ABI;
