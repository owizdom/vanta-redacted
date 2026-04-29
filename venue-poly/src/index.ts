/**
 * Package barrel for @vanta/venue-poly.
 *
 * Re-exports only the public surface. Internal helpers (bytes32
 * adapters, chain-id assertions, error wrappers) stay module-private.
 *
 * Scope:
 *   - CTF ABI + typed read helpers (balance, approval, payout, slot count)
 *   - Pure hash helpers (computeConditionId, computePositionId)
 *   - UMA adapter readQuestion (I-PL-4)
 *   - Branded types PositionId / ConditionId / QuestionId
 *   - Frozen chain + address constants
 *   - Gnosis Safe v1.3.0 meta-tx helpers (SafeTx, digest, proxy
 *     prediction, setup/exec builders, signature packer)
 *   - Safe signer orchestrator (signSafeTx + assertReadyToSign)
 */

// Errors
export { VenuePolyError } from "./errors.js";
export type { VenuePolyErrorCode } from "./errors.js";

// Types
export type { ConditionId, PositionId, QuestionId } from "./types.js";
export { asConditionId, asPositionId, asQuestionId } from "./types.js";

// Constants
export {
  AMOY_CHAIN_ID,
  COMPAT_FALLBACK_HANDLER_V130,
  CTF_ADDRESS,
  CTF_EXCHANGE_ADDRESS,
  DOMAIN_SEPARATOR_TYPEHASH,
  PLEDGE_CONFIRMATION_DEPTH,
  PLEDGE_WATCHDOG_DEPTH,
  SAFE_PROXY_FACTORY_V130,
  SAFE_SINGLETON_V130,
  SAFE_TX_TYPEHASH,
  UMA_CTF_ADAPTER_ADDRESS,
  USDC_AMOY_ADDRESS,
} from "./constants.js";
export type {
  AmoyChainId,
  PledgeConfirmationDepth,
  PledgeWatchdogDepth,
} from "./constants.js";

// ABIs (public because downstream tests and the pledge package encode
// calls against them).
export { CTF_ABI } from "./abi/conditional-tokens.js";
export type { CtfAbi } from "./abi/conditional-tokens.js";
export { CTF_EXCHANGE_ABI } from "./abi/ctf-exchange.js";
export type { CtfExchangeAbi } from "./abi/ctf-exchange.js";
export { UMA_CTF_ADAPTER_ABI } from "./abi/uma-ctf-adapter.js";
export type { UmaCtfAdapterAbi } from "./abi/uma-ctf-adapter.js";

// CTF read helpers + pure hash helpers
export {
  computeConditionId,
  computePositionId,
  readApproval,
  readBalance,
  readOutcomeSlotCount,
  readPayoutDenominator,
  readPayoutNumerators,
} from "./ctf.js";

// UMA adapter read helper
export { readQuestion } from "./uma-adapter.js";
export type { UmaQuestion } from "./uma-adapter.js";

// Safe ABIs (public for downstream pledge-path encoders)
export { SAFE_ABI } from "./abi/safe.js";
export type { SafeAbi } from "./abi/safe.js";
export { SAFE_PROXY_FACTORY_ABI } from "./abi/safe-proxy-factory.js";
export type { SafeProxyFactoryAbi } from "./abi/safe-proxy-factory.js";

// Safe meta-tx helpers
export {
  buildExecTransactionPayload,
  buildSetupInitializer,
  computeSafeTxHash,
  packThresholdOneSignature,
  predictProxyAddress,
} from "./safe.js";
export type { SafeOperation, SafeSignature, SafeTx } from "./safe.js";

// Safe signer orchestrator
export { assertReadyToSign, signSafeTx } from "./signer.js";
export type {
  SignDigestFn,
  SignSafeTxArgs,
  SignSafeTxResult,
} from "./signer.js";
