/**
 * Standalone verifier for the seeded events.log.
 *
 * Parses every line, decodes via @vanta/events, asserts the chain is
 * well-formed: every parent_id references an event that exists or is
 * the zero-hex genesis placeholder. Prints type counts so the operator
 * can sanity-check distribution before booting the runtime.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { decodeEvent } from "@vanta/events";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..");
const VANTA_DATA = process.env["VANTA_DATA_DIR"] ?? resolve(REPO_ROOT, ".vanta");
const LOG_PATH = resolve(VANTA_DATA, "events.log");

if (!existsSync(LOG_PATH)) {
  console.error(`verify-seed: ${LOG_PATH} does not exist. Run seed-events.ts first.`);
  process.exit(1);
}

const raw = readFileSync(LOG_PATH, "utf8");
const lines = raw.split("\n").filter((l) => l.trim().length > 0);

const ids = new Set<string>();
const counts: Record<string, number> = {};
let bad = 0;
let danglingParents = 0;

for (let i = 0; i < lines.length; ++i) {
  const line = lines[i]!;
  let decoded;
  try {
    decoded = decodeEvent(line);
  } catch (err: unknown) {
    bad += 1;
    console.error(`  line ${String(i + 1)}: decode failed: ${err instanceof Error ? err.message : String(err)}`);
    continue;
  }
  if (!decoded.ok) {
    bad += 1;
    console.error(`  line ${String(i + 1)}: invalid: ${decoded.code}`);
    continue;
  }
  ids.add(decoded.event.id);
  counts[decoded.event.type] = (counts[decoded.event.type] ?? 0) + 1;
}

// Second pass: parent integrity
for (const line of lines) {
  let decoded;
  try {
    decoded = decodeEvent(line);
  } catch {
    continue;
  }
  if (!decoded.ok) continue;
  for (const parentId of decoded.event.parent_ids) {
    if (parentId === "0".repeat(64)) continue;
    if (!ids.has(parentId)) danglingParents += 1;
  }
}

console.log("=== seed-events verifier ===");
console.log(`  log path:    ${LOG_PATH}`);
console.log(`  total lines: ${String(lines.length)}`);
console.log(`  decoded ok:  ${String(ids.size)}`);
console.log(`  decode errs: ${String(bad)}`);
console.log(`  dangling:    ${String(danglingParents)}`);
console.log(`  type breakdown:`);
const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
for (const [t, n] of sorted) {
  console.log(`    ${t.padEnd(28)} ${String(n).padStart(4)}`);
}

if (bad > 0 || danglingParents > 0) {
  console.error(`\nverify-seed: FAILED (decode errors=${String(bad)}, dangling parents=${String(danglingParents)})`);
  process.exit(1);
}
console.log("\nverify-seed: OK");
