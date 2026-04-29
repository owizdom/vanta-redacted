/**
 * Frozen chain + address constants for @vanta/venue-poly.
 *
 * Every address was captured during Week-2 recon and verified
 * via live Amoy RPC probes (`roadmap/month1/phase-outputs/phase-1-week-2/
 * canonical-reference.md`, §1 on-chain surface, §2 Safe stack). Changing
 * any constant here rotates the venue binding's target universe and must
 * ship as a `refactor(venue/poly):` with semver bump + compat shim.
 */

import type { EthAddressHex } from "@vanta/tee";

/** Polygon Amoy chain id. The venue binding is pinned to this L2 testnet. */
export const AMOY_CHAIN_ID = 80002 as const;
export type AmoyChainId = typeof AMOY_CHAIN_ID;

// ------------------------------- Polymarket CTF stack -------------------------------

/**
 * Polymarket ConditionalTokens (ERC-1155) on Amoy. Verified via
 * `supportsInterface(0xd9b67a26) === true` and ~29.5KB runtime bytecode.
 * Source: canonical-reference §1.
 */
export const CTF_ADDRESS: EthAddressHex =
  "0x69308FB512518e39F9b16112fA8d994F4e2Bf8bB";

/**
 * Polymarket CTFExchange on Amoy. `getCtf()` returns `CTF_ADDRESS` above
 * (verified probe). `getCollateral()` returns `USDC_AMOY_ADDRESS`.
 */
export const CTF_EXCHANGE_ADDRESS: EthAddressHex =
  "0xdFE02Eb6733538f8Ea35D585af8DE5958AD99E40";

/**
 * Mock USDC collateral used by Polymarket's Amoy deployment. 6 decimals;
 * `symbol()="USDC"`. Open-mint ACL is a Phase-5 probe target
 * (canonical-reference §5 open item 1) — not a concern at the binding layer.
 *
 * Stored lowercase so `abi.encodePacked` paths do not run into viem's
 * strict EIP-55 checksum validator. The on-chain address is
 * case-insensitive; every read and encode normalises to lowercase.
 */
export const USDC_AMOY_ADDRESS: EthAddressHex =
  "0x9c4e1703476e875070ee25b56a58b008cfb8fa78";

/**
 * UMA CTF Adapter v3.1 — the resolution oracle passed as `oracle` in
 * `prepareCondition`. We read `getQuestion(questionId)` to check
 * `{resolved, paused, reset, refund}` per invariant I-PL-4.
 */
export const UMA_CTF_ADAPTER_ADDRESS: EthAddressHex =
  "0x2F6f8DA6A21023E62399801945eed1b1975A4e12";

// ------------------------------- Gnosis Safe stack -------------------------------

/**
 * Gnosis SafeProxyFactory v1.3.0 canonical deployment on Amoy. 3.24KB
 * runtime. `safe-deployments` canonical; verified by recon.
 */
export const SAFE_PROXY_FACTORY_V130: EthAddressHex =
  "0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2";

/**
 * GnosisSafeL2 v1.3.0 singleton. 23.8KB runtime. The proxy's delegatecall
 * target; never called directly by our code.
 */
export const SAFE_SINGLETON_V130: EthAddressHex =
  "0x3E5c63644E683549055b9Be8653de26E0B4CD36E";

/**
 * CompatibilityFallbackHandler v1.3.0 canonical deployment. Required at
 * `setup()` time so the proxy forwards `onERC1155Received` — without it
 * the CTF's `safeTransferFrom` into the proxy reverts (canonical-
 * reference §1 reconciliation note, §2 fresh-proxy setup).
 *
 * Sourced from `safe-deployments/src/assets/v1.3.0/compatibility_fallback_handler.json`.
 */
export const COMPAT_FALLBACK_HANDLER_V130: EthAddressHex =
  "0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4";

// ------------------------------- EIP-712 type hashes (Safe v1.3.0) -------------------------------

/**
 * EIP-712 domain separator typehash. Safe v1.3.0's domain intentionally
 * omits `name` and `version` fields — do NOT add them (canonical-
 * reference §2).
 *
 *   keccak256("EIP712Domain(uint256 chainId,address verifyingContract)")
 */
export const DOMAIN_SEPARATOR_TYPEHASH =
  "0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218" as const;

/**
 * SafeTx typehash. The full struct has 10 fields; the type string is
 * reproduced byte-for-byte in tests and hashed to assert equality.
 *
 *   keccak256(
 *     "SafeTx(address to,uint256 value,bytes data,uint8 operation,"
 *     "uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,"
 *     "address gasToken,address refundReceiver,uint256 nonce)"
 *   )
 */
export const SAFE_TX_TYPEHASH =
  "0xbb8310d486368db6bd6f849402fdd73ad53d316b5a4b2644ad6efe0f941286d8" as const;

// ------------------------------- Confirmation / watchdog depths -------------------------------

/**
 * Amoy finality constant for pledge-event emit (invariants I-PL-1 / I-PL-2).
 * 5 blocks (~10s). Amoy Heimdall v2 reorgs are capped at 2 blocks in the
 * wild; 5 is a safety-margin choice. Matches the events-schema
 * `MIN_PLEDGE_CONFIRMATION_DEPTH` so a binding-layer read at depth < 5
 * cannot canonicalize into a valid pledge event.
 */
export const PLEDGE_CONFIRMATION_DEPTH = 5 as const;
export type PledgeConfirmationDepth = typeof PLEDGE_CONFIRMATION_DEPTH;

/**
 * Watchdog depth for retroactive pledge revocation (invariant I-PL-6).
 * 12 blocks; strictly greater than the emit depth. USDC release and all
 * downstream decisions gate on this depth, not emit depth.
 */
export const PLEDGE_WATCHDOG_DEPTH = 12 as const;
export type PledgeWatchdogDepth = typeof PLEDGE_WATCHDOG_DEPTH;
