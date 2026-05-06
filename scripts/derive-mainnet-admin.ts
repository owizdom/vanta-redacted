/**
 * Derive the mainnet admin EOA from a fresh 32-byte seed.
 *
 *   pnpm tsx scripts/derive-mainnet-admin.ts            # generates new seed → .vanta/mainnet-seed
 *   pnpm tsx scripts/derive-mainnet-admin.ts --from .vanta/mainnet-seed   # re-derives from existing
 *
 * Outputs:
 *   - admin address (send Base mainnet ETH here for gas)
 *   - private key hex (for deploy scripts via ADMIN_PRIVATE_KEY env)
 *   - mnemonic-equivalent hex (for the runtime's MNEMONIC env when
 *     deploying via ecloud — the runtime's deriveOriginationEOA
 *     reads either a 32-byte file OR a hex MNEMONIC env var)
 *
 * Seed is stored in .vanta/mainnet-seed (gitignored). DO NOT commit.
 * DO NOT share. Lose this seed → lose admin control of the mainnet
 * contracts (LoanBook origin/markRepaid/markLiquidated all gated on
 * ownerOnly checks against the derived address).
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveOriginationEOA } from "@vanta/tee";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");
const SEED_PATH = resolve(REPO_ROOT, ".vanta", "mainnet-seed");

function getOrGenerateSeed(): Buffer {
  const fromIdx = process.argv.indexOf("--from");
  const target = fromIdx >= 0 ? process.argv[fromIdx + 1] ?? SEED_PATH : SEED_PATH;
  if (existsSync(target)) {
    const buf = readFileSync(target);
    if (buf.length !== 32) {
      throw new Error(`seed at ${target} must be 32 bytes, got ${String(buf.length)}`);
    }
    return buf;
  }
  if (fromIdx >= 0) {
    throw new Error(`seed file not found: ${target}`);
  }
  // Generate fresh 32-byte seed, save with 0600 perms.
  mkdirSync(dirname(SEED_PATH), { recursive: true });
  const seed = randomBytes(32);
  writeFileSync(SEED_PATH, seed);
  chmodSync(SEED_PATH, 0o600);
  console.log(`generated new seed: ${SEED_PATH}`);
  return seed;
}

function main(): void {
  const seed = getOrGenerateSeed();
  const acct = deriveOriginationEOA(seed);

  console.log("\n=== VANTA mainnet admin EOA ===");
  console.log(`address:        ${acct.address}`);
  console.log(`seed file:      ${SEED_PATH}`);
  console.log(`seed (hex):     ${seed.toString("hex")}`);
  console.log("");
  console.log(`MNEMONIC env (paste into runtime/.env.mainnet):`);
  console.log(`  MNEMONIC=${seed.toString("hex")}`);
  console.log("");
  console.log("Next steps:");
  console.log(`  1. Send Base mainnet ETH (≥ $5 worth) to: ${acct.address}`);
  console.log(`  2. Send Polygon mainnet POL (~$1 worth) to: ${acct.address}`);
  console.log(`  3. Run scripts/deploy-mainnet.sh to deploy contracts`);
  console.log(`  4. Add MNEMONIC=<seed-hex> to runtime/.env.mainnet`);
  console.log(`  5. ecloud compute app upgrade <app-id> --verifiable --env-file runtime/.env.mainnet`);
  console.log("");
  console.log("⚠  KEEP THE SEED FILE SAFE. It is the operator key for");
  console.log("   the mainnet runtime. Lose it → lose admin control.");

  // Zero the seed buffer in memory before exiting (defensive).
  seed.fill(0);
}

main();
