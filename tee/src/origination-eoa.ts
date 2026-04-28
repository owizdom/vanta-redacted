/**
 * Origination admin EOA derivation.
 *
 * The LpVault + LoanBook are owned by an Ownable2Step EOA whose private
 * key is HKDF-SHA256-derived from the enclave's MNEMONIC. The exact
 * derivation MUST match `contracts/script/Common.s.sol::_deriveAdminFromDevSeed()`
 * byte for byte:
 *
 *   PRK = HMAC-SHA256(salt = "", IKM = mnemonic)
 *   OKM = HMAC-SHA256(PRK, info = "vanta-origination-eoa" || 0x01)
 *   sk  = OKM (32 bytes; interpreted as a secp256k1 scalar)
 *   eoa = address derived from sk via standard secp256k1 → keccak256(pubkey)[12..]
 *
 * The salt is intentionally the empty string (RFC 5869 §2.2) because the
 * info label is itself unique to this purpose and the on-chain script has
 * no salt input. Changing the salt or the info label would silently fork
 * the EOA away from the on-chain admin set by the deploy script — which
 * is a load-bearing invariant for the runtime bootstrap (I-RT-2): on boot
 * the runtime asserts `LoanBook.owner() == deriveOriginationEOA(...).address`.
 *
 * This function is the only caller of viem's `privateKeyToAccount` in
 * `@vanta/tee`. We do not store the private key anywhere — the caller is
 * expected to load it into a viem walletClient and discard the local
 * `privateKey` reference once that's done.
 */

import { Buffer } from "node:buffer";
import { hkdfSync } from "node:crypto";

import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

import { TeeError } from "./errors.js";
import { HKDF_INFO, HKDF_SALT, type EthAddressHex } from "./types.js";

/** Length, in bytes, of the canonical mnemonic / dev-seed input. */
export const MNEMONIC_LENGTH = 32;

/** Length, in bytes, of the secp256k1 scalar produced by HKDF-Expand. */
const SECP256K1_SK_LENGTH = 32;

/**
 * Derive the origination admin EOA from a 32-byte mnemonic / dev-seed.
 *
 * @throws {@link TeeError} (`invalid_ikm`) when `mnemonic.length !== 32`.
 *         The salt is empty by design (mirrors the on-chain Foundry
 *         script); the IKM is the only knob, so a wrong-length input is
 *         rejected fail-closed.
 */
export function deriveOriginationEOA(mnemonic: Buffer): {
  readonly address: EthAddressHex;
  readonly privateKey: Hex;
} {
  if (!Buffer.isBuffer(mnemonic) || mnemonic.length !== MNEMONIC_LENGTH) {
    // No raw bytes leak into the error context.
    throw new TeeError("invalid_ikm", "mnemonic must be a 32-byte Buffer", {
      length: String(Buffer.isBuffer(mnemonic) ? mnemonic.length : -1),
    });
  }

  const salt = Buffer.from(HKDF_SALT.ORIGINATION_EOA, "utf8"); // "" → 0 bytes
  const info = Buffer.from(HKDF_INFO.ORIGINATION_EOA, "utf8");
  const okm = hkdfSync("sha256", mnemonic, salt, info, SECP256K1_SK_LENGTH);
  const sk = Buffer.from(okm);

  // viem expects a 0x-prefixed hex string. Lowercase, no checksum needed.
  const privateKey = `0x${sk.toString("hex")}` as Hex;

  // Wipe the intermediate Buffer; viem has already copied the bytes into
  // its internal account object.
  sk.fill(0);

  const account = privateKeyToAccount(privateKey);

  // viem returns an EIP-55 mixed-case address. The branded `EthAddressHex`
  // is `0x${string}` and case-agnostic — leave the casing untouched so
  // checksum tooling works, and let callers lower-case at comparison time.
  return {
    address: account.address as EthAddressHex,
    privateKey,
  };
}
