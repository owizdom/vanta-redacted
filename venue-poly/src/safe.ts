/**
 * Gnosis Safe v1.3.0 helpers for the VANTA pledge path.
 *
 * Every construct here is pinned to invariant I-PL-5 and the
 * replay-proofing checklist in canonical-reference §2:
 *
 *   - `SafeOperation` is the literal `0` (CALL); DELEGATECALL is
 *     refused at the TYPE level. Consumers trying to pass `1` fail at
 *     compile time, not at runtime.
 *   - `SafeTx` is frozen-shape with `operation: 0` required. Every
 *     field is `readonly`.
 *   - `computeSafeTxHash` follows the canonical-reference §2 EIP-712
 *     recipe exactly: `keccak256("\x19\x01" || domainSeparator ||
 *     safeTxHash)`. Domain has `chainId=80002` + `verifyingContract=<proxy>`;
 *     `name` and `version` are INTENTIONALLY omitted (Safe v1.3.0 quirk).
 *   - `predictProxyAddress` follows the CREATE2 formula in
 *     canonical-reference §2. `proxyCreationCode` is supplied by the
 *     caller (it must be read live from `factory.proxyCreationCode()`;
 *     hardcoding risks v1.3.0-vs-v1.4.1 drift).
 *   - `buildSetupInitializer` produces the exact calldata the fresh-
 *     proxy fixture expects, pinning `fallbackHandler =
 *     CompatibilityFallbackHandler v1.3.0` so the proxy's
 *     `onERC1155Received` forwards (canonical-reference §1 reconciliation).
 *   - `packThresholdOneSignature` packs `(r, s, v)` into the 65-byte
 *     blob Safe expects, REJECTING `v ∉ {27, 28}` with a typed error.
 *
 * No private-key material is touched anywhere in this module. Signing
 * happens via an injected `signDigest` function in `signer.ts`.
 */

import {
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  pad,
  toHex,
  type Hex,
} from "viem";

import type { EthAddressHex, Sha256Hex } from "@vanta/tee";
import { asSha256Hex } from "@vanta/tee";

import { SAFE_ABI } from "./abi/safe.js";
import {
  AMOY_CHAIN_ID,
  COMPAT_FALLBACK_HANDLER_V130,
  DOMAIN_SEPARATOR_TYPEHASH,
  SAFE_TX_TYPEHASH,
} from "./constants.js";
import { VenuePolyError } from "./errors.js";

const ZERO_ADDRESS =
  "0x0000000000000000000000000000000000000000" as const satisfies EthAddressHex;

/**
 * Safe `Operation` enum. DELEGATECALL is not a safe primitive for a
 * pledge-path meta-tx (I-PL-5); its numeric value `1` is refused at
 * the TYPE level. Any consumer attempting `operation: 1 as const`
 * fails compilation.
 */
export type SafeOperation = 0;

/**
 * The ten fields Safe v1.3.0 hashes for an `execTransaction` meta-tx.
 * Every field is `readonly`; `operation` is locked to the literal `0`.
 * Layout matches `SAFE_TX_TYPEHASH` (see canonical-reference §2):
 *
 *   SafeTx(address to,uint256 value,bytes data,uint8 operation,
 *          uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,
 *          address gasToken,address refundReceiver,uint256 nonce)
 */
export interface SafeTx {
  readonly to: EthAddressHex;
  readonly value: bigint;
  readonly data: Hex;
  readonly operation: SafeOperation;
  readonly safeTxGas: bigint;
  readonly baseGas: bigint;
  readonly gasPrice: bigint;
  readonly gasToken: EthAddressHex;
  readonly refundReceiver: EthAddressHex;
  readonly nonce: bigint;
}

/**
 * ECDSA signature triple over an EIP-712 digest. `v ∈ {27, 28}` only;
 * reject `0/1/31/32` at the runtime boundary (I-PL-3 extension / prior
 * attack-scenarios §15). Canonical {r}{s}{v} ordering is asserted by
 * `packThresholdOneSignature`.
 */
export interface SafeSignature {
  readonly r: Hex;
  readonly s: Hex;
  readonly v: 27 | 28;
}

/**
 * Compute the EIP-712 SafeTx digest per canonical-reference §2.
 *
 *   domainSeparator = keccak256(abi.encode(
 *     DOMAIN_SEPARATOR_TYPEHASH, chainId=80002, verifyingContract=<proxy>
 *   ))
 *
 *   safeTxHash = keccak256(abi.encode(
 *     SAFE_TX_TYPEHASH, to, value, keccak256(data), operation,
 *     safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, nonce
 *   ))
 *
 *   digest = keccak256(0x1901 || domainSeparator || safeTxHash)
 */
export function computeSafeTxHash(
  proxyAddress: EthAddressHex,
  tx: SafeTx,
): Sha256Hex {
  // Defense in depth — the `operation: 0` literal already fires at
  // compile time, but an `as SafeTx` escape hatch can smuggle a
  // widened numeric value through the type system at runtime.
  if (tx.operation !== 0) {
    throw new VenuePolyError(
      "safe_bad_operation",
      "SafeTx.operation must be 0 (CALL); DELEGATECALL forbidden (I-PL-5)",
      { actualOperation: String(tx.operation) },
    );
  }

  // keccak256 over the raw data bytes, as SAFE_TX_TYPEHASH requires.
  const dataHash = keccak256(tx.data);

  const domainSeparator = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" }, // DOMAIN_SEPARATOR_TYPEHASH
        { type: "uint256" }, // chainId
        { type: "address" }, // verifyingContract
      ],
      [DOMAIN_SEPARATOR_TYPEHASH, BigInt(AMOY_CHAIN_ID), proxyAddress],
    ),
  );

  const safeTxHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" }, // SAFE_TX_TYPEHASH
        { type: "address" }, // to
        { type: "uint256" }, // value
        { type: "bytes32" }, // keccak256(data)
        { type: "uint8" }, //   operation
        { type: "uint256" }, // safeTxGas
        { type: "uint256" }, // baseGas
        { type: "uint256" }, // gasPrice
        { type: "address" }, // gasToken
        { type: "address" }, // refundReceiver
        { type: "uint256" }, // nonce
      ],
      [
        SAFE_TX_TYPEHASH,
        tx.to,
        tx.value,
        dataHash,
        tx.operation,
        tx.safeTxGas,
        tx.baseGas,
        tx.gasPrice,
        tx.gasToken,
        tx.refundReceiver,
        tx.nonce,
      ],
    ),
  );

  // EIP-712 envelope: 0x19 || 0x01 || domainSeparator || safeTxHash.
  const digest = keccak256(concat(["0x1901", domainSeparator, safeTxHash]));
  return asSha256Hex(digest.slice(2).toLowerCase());
}

/**
 * Predict the CREATE2 address of a Safe proxy per canonical-reference §2:
 *
 *   salt     = keccak256(abi.encodePacked(keccak256(initializer), saltNonce))
 *   initCode = proxyCreationCode ++ abi.encode(uint256(uint160(singleton)))
 *   addr     = keccak256(0xff || factory || salt || keccak256(initCode))[12:32]
 *
 * `proxyCreationCode` is accepted as a parameter so the caller can
 * source it live via `factory.proxyCreationCode()`. Hardcoding it
 * would drift between Safe v1.3.0 and v1.4.1 deployments.
 */
export function predictProxyAddress(
  factory: EthAddressHex,
  singleton: EthAddressHex,
  initializer: Hex,
  saltNonce: bigint,
  proxyCreationCode: Hex,
): EthAddressHex {
  // salt = keccak256(keccak256(initializer) || uint256(saltNonce))
  const initHash = keccak256(initializer);
  const salt = keccak256(
    concat([initHash, pad(toHex(saltNonce), { size: 32 })]),
  );

  // initCode = proxyCreationCode ++ abi.encode(uint256(uint160(singleton)))
  const singletonAsUint256 = encodeAbiParameters(
    [{ type: "uint256" }],
    [BigInt(singleton)],
  );
  const initCode = concat([proxyCreationCode, singletonAsUint256]);
  const initCodeHash = keccak256(initCode);

  // address = keccak256(0xff || factory || salt || keccak256(initCode))[12:32]
  const preImage = concat(["0xff", factory, salt, initCodeHash]);
  const hashed = keccak256(preImage);
  // Last 20 bytes = addr; the 0x-prefix is 2 chars, then 32 bytes = 64 hex;
  // address slice starts at 2 + 24 = 26.
  const addr = `0x${hashed.slice(26).toLowerCase()}` as EthAddressHex;
  // getAddress normalises to EIP-55; we keep our lowercase form to
  // stay consistent with the rest of the module's address shape.
  getAddress(addr); // runtime hex-length sanity check
  return addr;
}

/**
 * Produce the `setup()` calldata for a fresh test-borrower proxy.
 *
 * Canonical-reference §2 fresh-proxy setup:
 *   _owners           = [ownerEOA]
 *   _threshold        = 1
 *   to                = 0x0 (no delegatecall setup)
 *   data              = 0x
 *   fallbackHandler   = CompatibilityFallbackHandler v1.3.0
 *   paymentToken      = 0x0
 *   payment           = 0
 *   paymentReceiver   = 0x0
 *
 * `fallbackHandler` MUST be the canonical v1.3.0 address — without it
 * the proxy's `onERC1155Received` does not forward and CTF
 * `safeTransferFrom` reverts (canonical-reference §1).
 */
export function buildSetupInitializer(ownerEOA: EthAddressHex): Hex {
  return encodeFunctionData({
    abi: SAFE_ABI,
    functionName: "setup",
    args: [
      [ownerEOA],
      1n,
      ZERO_ADDRESS,
      "0x",
      COMPAT_FALLBACK_HANDLER_V130,
      ZERO_ADDRESS,
      0n,
      ZERO_ADDRESS,
    ],
  });
}

/**
 * Produce the full calldata for `proxy.execTransaction(...)` given the
 * SafeTx and a packed signature blob.
 */
export function buildExecTransactionPayload(
  tx: SafeTx,
  signatures: Hex,
): Hex {
  if (tx.operation !== 0) {
    throw new VenuePolyError(
      "safe_bad_operation",
      "SafeTx.operation must be 0 (CALL); DELEGATECALL forbidden (I-PL-5)",
      { actualOperation: String(tx.operation) },
    );
  }
  return encodeFunctionData({
    abi: SAFE_ABI,
    functionName: "execTransaction",
    args: [
      tx.to,
      tx.value,
      tx.data,
      tx.operation,
      tx.safeTxGas,
      tx.baseGas,
      tx.gasPrice,
      tx.gasToken,
      tx.refundReceiver,
      signatures,
    ],
  });
}

/**
 * Pack a single ECDSA signature into Safe's 65-byte `{r}{s}{v}` blob
 * for a threshold-1 meta-tx. Rejects `v ∉ {27, 28}` at the boundary —
 * legacy `v ∈ {0,1}` and EIP-155 normalised `v ∈ {>=31}` are not
 * accepted here (Safe v1.3.0 requires canonical `27/28` for owner
 * signatures; see canonical-reference §2 replay-proofing checklist).
 */
export function packThresholdOneSignature(sig: SafeSignature): Hex {
  // TypeScript narrows to `27 | 28` already, but a runtime `as` escape
  // hatch can widen; fail loudly rather than silently packing bad v.
  const v: number = sig.v;
  if (v !== 27 && v !== 28) {
    throw new VenuePolyError(
      "safe_bad_signature_v",
      "SafeSignature.v must be 27 or 28 for threshold-1 Safe meta-tx",
      { actualV: String(v) },
    );
  }

  // r and s must each be 32 bytes (0x-prefixed 66-char hex). Normalise
  // to lowercase and pad so a shorter-than-expected value can't slip
  // into the 65-byte blob as zero-prefix garbage.
  const r = pad(sig.r, { size: 32 });
  const s = pad(sig.s, { size: 32 });
  const vByte = pad(toHex(v), { size: 1 });

  // Fail loudly if padding inflated beyond 32 bytes — the input was
  // too large to be a valid r or s.
  if (r.length !== 2 + 64) {
    throw new VenuePolyError(
      "safe_bad_signature_v",
      "SafeSignature.r must be <= 32 bytes",
      { actualLen: String((r.length - 2) / 2) },
    );
  }
  if (s.length !== 2 + 64) {
    throw new VenuePolyError(
      "safe_bad_signature_v",
      "SafeSignature.s must be <= 32 bytes",
      { actualLen: String((s.length - 2) / 2) },
    );
  }

  return concat([r, s, vByte]);
}
