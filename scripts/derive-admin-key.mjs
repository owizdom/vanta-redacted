#!/usr/bin/env node
/**
 * Derive the origination admin EOA private key from a 32-byte seed.
 *
 * Mirrors `@vanta/tee.deriveOriginationEOA` byte-for-byte:
 *   PRK = HMAC-SHA256(salt = "",        IKM = seed)
 *   OKM = HMAC-SHA256(PRK,              info = "vanta-origination-eoa" || 0x01)
 *   sk  = OKM (32 bytes; secp256k1 scalar / 0x-prefixed hex)
 *
 * Used by `scripts/deploy-local.sh` so the deploy script and the
 * runtime bootstrap always agree on which EOA owns LpVault + LoanBook
 * on Base Sepolia (I-RT-2).
 *
 * Usage:
 *   node scripts/derive-admin-key.mjs path/to/.vanta/dev-seed
 *   # prints 0x<64-hex-chars> on stdout, no trailing newline.
 */

import { Buffer } from "node:buffer";
import { hkdfSync } from "node:crypto";
import { readFileSync } from "node:fs";

const seedPath = process.argv[2];
if (typeof seedPath !== "string" || seedPath.length === 0) {
  process.stderr.write("usage: derive-admin-key.mjs <seed-path>\n");
  process.exit(1);
}

let seed;
try {
  seed = readFileSync(seedPath);
} catch (err) {
  process.stderr.write(`failed to read seed at ${seedPath}: ${err.message}\n`);
  process.exit(1);
}

if (seed.length !== 32) {
  process.stderr.write(
    `seed at ${seedPath} must be exactly 32 bytes, found ${seed.length}\n`,
  );
  process.exit(1);
}

const okm = hkdfSync(
  "sha256",
  seed,
  Buffer.from("", "utf8"),
  Buffer.from("vanta-origination-eoa", "utf8"),
  32,
);
process.stdout.write("0x" + Buffer.from(okm).toString("hex"));
