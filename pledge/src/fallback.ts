/**
 * Fallback-handler assertion (I-PL-3 extension).
 *
 * Safe v1.3.0 stores the fallback-handler address at a fixed storage
 * slot computed as `keccak256("fallback_manager.handler.address")`. We
 * read that slot via `eth_getStorageAt`, decode the last 20 bytes as an
 * address, and assert it equals `COMPAT_FALLBACK_HANDLER_V130`.
 *
 * Why this check matters (canonical-reference §1): without a
 * CompatibilityFallbackHandler installed, the proxy's
 * `onERC1155Received` does not forward through the proxy. The CTF's
 * `safeTransferFrom` then reverts silently on the receive side; a
 * borrower without the fallback handler cannot pledge. Refusing up
 * front saves a Safe meta-tx that would otherwise burn gas for nothing
 * and leave an ambiguous tx-receipt.
 */

import type { PublicClient } from "viem";
import { getAddress } from "viem";

import type { EthAddressHex } from "@vanta/tee";
import {
  AMOY_CHAIN_ID,
  COMPAT_FALLBACK_HANDLER_V130,
} from "@vanta/venue-poly";

import { PledgeError } from "./errors.js";

/**
 * Safe v1.3.0 fallback-handler storage slot.
 *
 *   keccak256("fallback_manager.handler.address")
 *
 * The precomputed constant below is the literal; tests re-derive it
 * from the string so a drift in the source const fails loudly.
 */
export const SAFE_FALLBACK_HANDLER_SLOT =
  "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5" as const;

function assertAmoyChain(client: PublicClient): void {
  const actual = client.chain?.id;
  if (actual !== AMOY_CHAIN_ID) {
    throw new PledgeError(
      "chain_id_mismatch",
      "pledge fallback-handler read requires a PublicClient pinned to Polygon Amoy",
      {
        expectedChainId: String(AMOY_CHAIN_ID),
        actualChainId: actual === undefined ? "undefined" : String(actual),
      },
    );
  }
}

/**
 * Return `true` iff the address stored in the proxy's fallback-handler
 * slot equals `COMPAT_FALLBACK_HANDLER_V130` byte-for-byte
 * (case-insensitive). Used by `assertFallbackHandler` to make the
 * check, and by the watchdog path when the actual address is needed
 * for the error detail.
 */
function addressesEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Read the storage slot, decode, assert equality with the canonical
 * CompatibilityFallbackHandler v1.3.0 address. Throws
 * `fallback_handler_mismatch` when the slot holds a different address
 * (including `0x0` — a Safe that was never configured with a fallback
 * handler).
 */
export async function assertFallbackHandler(
  client: PublicClient,
  proxyAddress: EthAddressHex,
): Promise<void> {
  assertAmoyChain(client);
  let raw: `0x${string}` | undefined;
  try {
    raw = await client.getStorageAt({
      address: proxyAddress,
      slot: SAFE_FALLBACK_HANDLER_SLOT,
    });
  } catch (cause: unknown) {
    throw new PledgeError(
      "rpc_unreachable",
      "eth_getStorageAt failed while reading fallback-handler slot",
      { proxyAddress },
      cause,
    );
  }
  if (raw === undefined) {
    throw new PledgeError(
      "fallback_handler_mismatch",
      "eth_getStorageAt returned undefined for fallback-handler slot",
      { proxyAddress },
    );
  }
  // Storage slot is 32 bytes; an address lives in the low 20 bytes.
  // Normalize to a 0x-prefixed 40-char hex string and compare.
  if (raw.length !== 2 + 64) {
    throw new PledgeError(
      "fallback_handler_mismatch",
      "eth_getStorageAt returned a non-32-byte value for fallback-handler slot",
      { proxyAddress, actualLen: String((raw.length - 2) / 2) },
    );
  }
  const addressHex = (`0x${raw.slice(26).toLowerCase()}`) as EthAddressHex;
  // Runtime sanity — ensures the slice is a structurally valid address.
  getAddress(addressHex);
  if (!addressesEqual(addressHex, COMPAT_FALLBACK_HANDLER_V130)) {
    throw new PledgeError(
      "fallback_handler_mismatch",
      "proxy fallback handler is not CompatibilityFallbackHandler v1.3.0",
      {
        proxyAddress,
        expected: COMPAT_FALLBACK_HANDLER_V130.toLowerCase(),
        actual: addressHex,
      },
    );
  }
}
