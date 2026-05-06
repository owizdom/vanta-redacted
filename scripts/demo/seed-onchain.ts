/**
 * Demo seed — on-chain + fixture pool state.
 *
 * What this does:
 *   1. Defers to the existing `bash scripts/deploy-local.sh` for the single
 *      v2 lender stack on anvil (LpVault + LoanBook + VantaVault wired).
 *      That gives vanta-opus (agent_id=0) a *real* on-chain deployment so
 *      a wallet can deposit USDC into it during the demo.
 *   2. Writes `.vanta/demo-pools.json` with realistic per-agent fixture
 *      pool state (TVL, share price, interest accrued, loans outstanding)
 *      for all 3 VANTAs. The runtime's fixture pool-reader picks this up
 *      so the marketplace + agent detail card show "lived-in" numbers.
 *   3. Prints a summary the operator can paste into chat.
 *
 * vanta-opus (agent_id=0) gets the only on-chain stack — its TVL is
 * grown by the seed-events.ts signed `pool.deposit` history + any live
 * deposits during the demo. vanta-gpt and vanta-gemini are *fixture-only*
 * lenders for the demo; their TVL + activity is event-driven (the chat
 * panel + detail card show real signed events; their "balances" are the
 * fixture state rolled into pool-reader output).
 *
 * NOT a substitute for production deployment. This is the 10-minute
 * demo runway only.
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..");
const VANTA_DATA = process.env["VANTA_DATA_DIR"] ?? resolve(REPO_ROOT, ".vanta");

interface FixturePoolState {
  readonly agent_id: number;
  readonly nav_usdc6: string; // raw 6-decimal USDC wei
  readonly total_supply: string; // raw 18-decimal share token wei
  readonly max_aum_usdc6: string;
  readonly free_usdc6: string;
  readonly open_notional_usdc6: string;
  readonly lifetime_cost_basis_usdc6: string;
  readonly lifetime_proceeds_usdc6: string;
  /** Realised PnL = lifetime_proceeds - lifetime_cost_basis. Stored separately
   * so the frontend's signed-USDC formatter can render losses with a leading "-". */
  readonly realised_pnl_usdc6: string;
}

/**
 * Demo pool state per agent. All values are sized to read like a small
 * but real lender after a few weeks of activity. Numbers chosen so the
 * marketplace renders interest YTD as visibly positive without being
 * implausible.
 *
 *   vanta-opus    — TVL $312k, $14.8k interest YTD (≈4.7%)
 *   vanta-gpt     — TVL $187k, $7.3k interest YTD  (≈3.9%)
 *   vanta-gemini  — TVL $241k, $9.6k interest YTD  (≈4.0%)
 */
const FIXTURE_POOLS: readonly FixturePoolState[] = [
  {
    agent_id: 0,
    nav_usdc6: "312_400_000_000".replace(/_/g, ""),
    total_supply: "298_300_000_000_000_000_000_000".replace(/_/g, ""), // ~298.3k vLP at share price ≈ 1.047
    max_aum_usdc6: "1_000_000_000_000".replace(/_/g, ""), // $1M cap (demo allows headroom)
    free_usdc6: "192_000_000_000".replace(/_/g, ""), // $192k idle
    open_notional_usdc6: "120_400_000_000".replace(/_/g, ""), // $120.4k in active loans
    lifetime_cost_basis_usdc6: "452_000_000_000".replace(/_/g, ""),
    lifetime_proceeds_usdc6: "466_800_000_000".replace(/_/g, ""),
    realised_pnl_usdc6: "14_800_000_000".replace(/_/g, ""),
  },
  {
    agent_id: 1,
    nav_usdc6: "187_300_000_000".replace(/_/g, ""),
    total_supply: "180_100_000_000_000_000_000_000".replace(/_/g, ""),
    max_aum_usdc6: "1_000_000_000_000".replace(/_/g, ""),
    free_usdc6: "118_500_000_000".replace(/_/g, ""),
    open_notional_usdc6: "68_800_000_000".replace(/_/g, ""),
    lifetime_cost_basis_usdc6: "236_000_000_000".replace(/_/g, ""),
    lifetime_proceeds_usdc6: "243_300_000_000".replace(/_/g, ""),
    realised_pnl_usdc6: "7_300_000_000".replace(/_/g, ""),
  },
  {
    agent_id: 2,
    nav_usdc6: "241_900_000_000".replace(/_/g, ""),
    total_supply: "232_500_000_000_000_000_000_000".replace(/_/g, ""),
    max_aum_usdc6: "1_000_000_000_000".replace(/_/g, ""),
    free_usdc6: "159_100_000_000".replace(/_/g, ""),
    open_notional_usdc6: "82_800_000_000".replace(/_/g, ""),
    lifetime_cost_basis_usdc6: "318_000_000_000".replace(/_/g, ""),
    lifetime_proceeds_usdc6: "327_600_000_000".replace(/_/g, ""),
    realised_pnl_usdc6: "9_600_000_000".replace(/_/g, ""),
  },
];

function step(label: string, fn: () => void): void {
  process.stdout.write(`vanta/demo-seed: ${label}… `);
  try {
    fn();
    process.stdout.write("ok\n");
  } catch (err: unknown) {
    process.stdout.write("FAILED\n");
    throw err;
  }
}

function main(): void {
  console.log("=== VANTA demo seed (on-chain + fixture pool state) ===");
  console.log(`repo root: ${REPO_ROOT}`);
  console.log(`vanta data dir: ${VANTA_DATA}\n`);

  // 1) Ensure anvil is up. (Caller is expected to have run `pnpm anvil:up`.)
  //    The orchestrator (`scripts/demo/run.ts`) handles boot order.
  step("verifying anvil reachable on :8545", () => {
    try {
      execSync("curl -fs --max-time 2 -X POST -H 'Content-Type: application/json' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_blockNumber\",\"params\":[]}' http://localhost:8545 > /dev/null", {
        stdio: "pipe",
      });
    } catch {
      throw new Error(
        "anvil not reachable on :8545 — run `pnpm anvil:up` first",
      );
    }
  });

  // 2) Deploy the v2 lender stack (LpVault + LoanBook + VantaVault).
  //    deploy-local.sh is idempotent on a fresh anvil; if the contracts
  //    already exist at the deterministic addresses, this no-ops.
  step("deploying v2 lender stack via deploy-local.sh", () => {
    execSync("bash scripts/deploy-local.sh", {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
  });

  // 2b) Mint USDC to the demo wallet via anvil_setStorageAt. The
  //     Base Sepolia USDC FiatToken stores `_balances` at storage slot 9
  //     (verified empirically against the deployed proxy). Writing
  //     keccak256(addr || slot) lets us synthesize any test balance
  //     without going through a real mint flow.
  step("funding demo wallet with $5,000 test USDC", () => {
    const demoAddr = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // anvil's account[0]
    const usdc = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
    const FIVE_THOUSAND_USDC6 = "0x" + (5_000_000_000n).toString(16).padStart(64, "0");
    const computeSlot = `cast index address ${demoAddr} 9`;
    const slot = execSync(computeSlot, { encoding: "utf8" }).trim();
    const setStorage = `cast rpc anvil_setStorageAt ${usdc} ${slot} ${FIVE_THOUSAND_USDC6} --rpc-url http://127.0.0.1:8545`;
    execSync(setStorage, { stdio: "pipe" });
    const checkBalance = `cast call ${usdc} "balanceOf(address)(uint256)" ${demoAddr} --rpc-url http://127.0.0.1:8545`;
    const balance = execSync(checkBalance, { encoding: "utf8" }).trim();
    console.log(`\n  demo wallet USDC balance: ${balance.split(" ")[0]} (raw 6dp)`);
  });

  // 3) Write fixture pool state for all 3 VANTAs. The runtime will pick
  //    this up via VANTA_DEMO_POOLS_PATH (see main.ts pool-reader wiring).
  step("writing .vanta/demo-pools.json", () => {
    mkdirSync(VANTA_DATA, { recursive: true });
    const path = resolve(VANTA_DATA, "demo-pools.json");
    const payload = {
      generated_at_unix: Math.floor(Date.now() / 1000),
      pools: FIXTURE_POOLS,
    };
    writeFileSync(path, JSON.stringify(payload, null, 2));
    console.log(`\n  → ${path}`);
  });

  // 4) Print summary.
  console.log("\n=== seed complete ===");
  for (const p of FIXTURE_POOLS) {
    const tvl = (Number(BigInt(p.nav_usdc6)) / 1_000_000).toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    });
    const interest = (Number(BigInt(p.realised_pnl_usdc6)) / 1_000_000).toLocaleString(
      "en-US",
      { style: "currency", currency: "USD", maximumFractionDigits: 0 },
    );
    const open = (Number(BigInt(p.open_notional_usdc6)) / 1_000_000).toLocaleString(
      "en-US",
      { style: "currency", currency: "USD", maximumFractionDigits: 0 },
    );
    console.log(
      `  agent_id=${String(p.agent_id)} TVL=${tvl} open=${open} interest_ytd=${interest}`,
    );
  }
  console.log("\nNext: pnpm tsx scripts/demo/seed-events.ts (to populate the event log)");
}

try {
  main();
} catch (err: unknown) {
  console.error("vanta/demo-seed: FAILED");
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
