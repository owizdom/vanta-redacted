/**
 * HKDF wrapper with purpose-pair enforcement.
 *
 * Compile-time layer: `HkdfPurpose` (types.ts) is a union of exactly three
 * object literals, so a caller can pass `{AGENT_TREASURY, AGENT_TREASURY}`
 * but not `{AGENT_TREASURY, VAULT_OPERATOR}` — mismatched salt/info
 * combinations fail at type-check.
 *
 * Runtime layer: per-process `Set<string>` keyed by `${salt}||${info}`
 * rejects reuse. Second derivation with the same pair throws
 * `hkdf_salt_reused`.
 *
 * Derivation follows RFC 5869 via `crypto.hkdfSync`:
 *   - hash: SHA-256 (R2 §3; matches event-preimage hash)
 *   - ikm:  MNEMONIC Buffer from mnemonic.readMnemonicOnce()
 *   - salt: purpose.salt (HKDF-Extract)
 *   - info: purpose.info (HKDF-Expand)
 *   - length: 32 (Ed25519 seed / 256-bit scalar)
 */

import { Buffer } from "node:buffer";
import { hkdfSync } from "node:crypto";

import { TeeError } from "./errors.js";
import { readMnemonicOnce, mnemonicAlreadyConsumed } from "./mnemonic.js";
import { HKDF_SALT, HKDF_INFO } from "./types.js";
import type { HkdfPurpose } from "./types.js";

const usedPairs = new Set<string>();

/**
 * Cache the MNEMONIC Buffer across the `deriveKey` calls in a single
 * boot. This module is responsible for consuming it on first derive and
 * zeroing it on the boot-sequence cleanup.
 *
 * We do NOT expose this Buffer; it is read via `readMnemonicOnce` once
 * and held inside this module until `takeIkmForZeroization` runs.
 */
let ikmCache: Buffer | null = null;

function validPurpose(purpose: HkdfPurpose): boolean {
  // Redundant with the compile-time union, but defends against a caller
  // casting through `unknown`. R2 §4: info-label mismatch is a distinct
  // error class from salt reuse.
  const saltOk =
    purpose.salt === HKDF_SALT.AGENT_TREASURY ||
    purpose.salt === HKDF_SALT.VAULT_OPERATOR ||
    purpose.salt === HKDF_SALT.API_CREDENTIALS ||
    purpose.salt === HKDF_SALT.ORIGINATION_EOA;
  const infoOk =
    purpose.info === HKDF_INFO.AGENT_TREASURY ||
    purpose.info === HKDF_INFO.VAULT_OPERATOR ||
    purpose.info === HKDF_INFO.API_CREDENTIALS ||
    purpose.info === HKDF_INFO.ORIGINATION_EOA;
  if (!saltOk || !infoOk) return false;
  const paired =
    (purpose.salt === HKDF_SALT.AGENT_TREASURY && purpose.info === HKDF_INFO.AGENT_TREASURY) ||
    (purpose.salt === HKDF_SALT.VAULT_OPERATOR && purpose.info === HKDF_INFO.VAULT_OPERATOR) ||
    (purpose.salt === HKDF_SALT.API_CREDENTIALS && purpose.info === HKDF_INFO.API_CREDENTIALS) ||
    (purpose.salt === HKDF_SALT.ORIGINATION_EOA && purpose.info === HKDF_INFO.ORIGINATION_EOA);
  return paired;
}

/**
 * Derive a 32-byte key for the given purpose. Returns a fresh `Buffer`;
 * caller MUST zero it with `buf.fill(0)` after use (spec §1.4).
 *
 * Never includes IKM, PRK, or output bytes in error context (R2 §5).
 */
export function deriveKey(purpose: HkdfPurpose): Buffer {
  if (!validPurpose(purpose)) {
    throw new TeeError(
      "hkdf_info_mismatch",
      "HKDF purpose salt/info pair did not match an approved (salt, info) binding",
    );
  }

  const key = `${purpose.salt}||${purpose.info}`;
  if (usedPairs.has(key)) {
    throw new TeeError(
      "hkdf_salt_reused",
      "HKDF (salt, info) pair has already been used this process",
      { salt: purpose.salt },
    );
  }

  if (ikmCache === null) {
    if (mnemonicAlreadyConsumed()) {
      // The mnemonic was read elsewhere and the Buffer has not been
      // handed to this module; we cannot safely re-read it.
      throw new TeeError(
        "mnemonic_missing",
        "MNEMONIC was consumed outside kdf.deriveKey before first derivation",
      );
    }
    ikmCache = readMnemonicOnce();
  }

  const salt = Buffer.from(purpose.salt, "utf8");
  const info = Buffer.from(purpose.info, "utf8");
  const derived = hkdfSync("sha256", ikmCache, salt, info, 32);
  const out = Buffer.from(derived);
  // Zero intermediate salt/info buffers to reduce residue. IKM is kept in
  // ikmCache until the boot-sequence cleanup explicitly zeroes it.
  salt.fill(0);
  info.fill(0);

  usedPairs.add(key);
  return out;
}

/**
 * Boot-sequence cleanup. Called by `initTEE` after all HKDF derivations
 * the boot needs are done. Zeroes the cached IKM Buffer and clears the
 * in-module reference. Subsequent `deriveKey` calls will fail-closed with
 * `mnemonic_missing` because the MNEMONIC env var has already been
 * deleted by `zeroAndDropMnemonicEnv`.
 *
 * Returns the Buffer (now filled with zeros) so the caller can chain the
 * env-var drop.
 */
export function takeIkmForZeroization(): Buffer | null {
  const ref = ikmCache;
  ikmCache = null;
  return ref;
}

/**
 * Test-only state reset. Gated on NODE_ENV/VITEST. Not re-exported from
 * the package barrel.
 */
export function __resetForTesting(): void {
  if (process.env["NODE_ENV"] !== "test" && process.env["VITEST"] === undefined) {
    throw new TeeError("hkdf_salt_reused", "__resetForTesting is disabled outside tests");
  }
  usedPairs.clear();
  if (ikmCache !== null) {
    ikmCache.fill(0);
    ikmCache = null;
  }
}

/**
 * Test-only reveal of the in-module `ikmCache` reference. Lets the
 * post-boot cleanup regression (T-ikm-peek) assert that after
 * `initTEE` returns, the cached IKM Buffer has been cleared (either
 * replaced with `null` by `takeIkmForZeroization`, or filled with zeros
 * before being nulled). Gated on NODE_ENV/VITEST; not re-exported from
 * the package barrel.
 */
export function __peekIkmCacheForTesting(): Buffer | null {
  if (process.env["NODE_ENV"] !== "test" && process.env["VITEST"] === undefined) {
    throw new TeeError("hkdf_salt_reused", "__peekIkmCacheForTesting is disabled outside tests");
  }
  return ikmCache;
}
