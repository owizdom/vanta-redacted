/**
 * One-shot `MNEMONIC` reader.
 *
 * `process.env.MNEMONIC` is the HMAC(appId) secret surfaced by EigenCloud
 * KMS (user memory; R1 §2). JS strings are interned and cannot be zeroed
 * (R2 §5) — the best we can do is read once into a `Buffer`, let the
 * caller zero that buffer after HKDF, and then `delete process.env.MNEMONIC`.
 *
 * API shape per spec §3 + §1.4:
 *   - `readMnemonicOnce()` returns a fresh Buffer; subsequent calls throw
 *     `mnemonic_missing`.
 *   - `mnemonicAlreadyConsumed()` is a non-throwing predicate for init
 *     sequence ordering.
 *   - `zeroAndDropMnemonicEnv(buf)` is the boot-sequence cleanup the
 *     caller runs after all HKDF derivations. Zeroes the buffer and
 *     removes the env entry.
 */

import { Buffer } from "node:buffer";

import { TeeError } from "./errors.js";

let consumed = false;

/**
 * Read `process.env.MNEMONIC` exactly once and return its bytes as a
 * Buffer. Throws on second call, on missing env var, or on IKM < 32
 * bytes (HKDF §3.3 entropy assertion, R2 §3).
 *
 * Never echoes the MNEMONIC into error context.
 */
export function readMnemonicOnce(): Buffer {
  if (consumed) {
    throw new TeeError(
      "mnemonic_missing",
      "MNEMONIC has already been consumed this process; cannot be read twice",
    );
  }
  const raw = process.env["MNEMONIC"];
  if (typeof raw !== "string" || raw.length === 0) {
    consumed = true;
    throw new TeeError(
      "mnemonic_missing",
      "MNEMONIC env var is not set",
    );
  }
  const buf = Buffer.from(raw, "utf8");
  consumed = true;
  if (buf.length < 32) {
    // Zero the short-IKM buffer before throwing — do not let it linger.
    const actualLength = buf.length;
    buf.fill(0);
    throw new TeeError(
      "mnemonic_invalid",
      "MNEMONIC IKM must be at least 32 bytes",
      { length: String(actualLength) },
    );
  }
  return buf;
}

/** Non-throwing predicate: has `readMnemonicOnce` already been invoked? */
export function mnemonicAlreadyConsumed(): boolean {
  return consumed;
}

/**
 * Zero the supplied Buffer and delete `process.env.MNEMONIC`.
 *
 * Partial mitigation per R2 §5: JS strings are interned, so the V8 string
 * table may retain the original MNEMONIC string until GC. The enclave is
 * the real boundary; this is defense-in-depth.
 */
export function zeroAndDropMnemonicEnv(buf: Buffer): void {
  buf.fill(0);
  delete process.env["MNEMONIC"];
}

/**
 * Test-only state reset. Gated on NODE_ENV/VITEST. Not re-exported from
 * the package barrel.
 */
export function __resetForTesting(): void {
  if (process.env["NODE_ENV"] !== "test" && process.env["VITEST"] === undefined) {
    throw new TeeError("mnemonic_missing", "__resetForTesting is disabled outside tests");
  }
  consumed = false;
}
