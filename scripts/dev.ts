/**
 * `pnpm dev` — Phase 12 cold-start orchestrator.
 *
 * Brings the full local stack up in one process:
 *   1. anvil-up.sh        — Base Sepolia (8545) + Polygon Amoy (8546) forks
 *   2. deploy-local.sh    — runs the four foundry deploy scripts; writes
 *                           contracts/deployments/local-{base-sepolia,amoy}.json
 *   3. runtime            — `pnpm --filter @vanta/runtime start` against the
 *                           local anvils, with the deployed addresses pinned
 *
 * Target: cold start to a green /healthz in < 90 seconds (paper §13).
 *
 * Lifecycle:
 *   - SIGINT/SIGTERM tears down the runtime first, then the anvils.
 *   - On runtime crash we tear down the anvils and exit non-zero.
 *
 * Logs:
 *   - anvil stdout/stderr → /tmp/vanta-anvil/{base,amoy}.log (anvil-up)
 *   - deploy stdout/stderr → /tmp/vanta-anvil/0[1-4].log (deploy-local)
 *   - runtime stdout/stderr → inherited (visible in this terminal)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = resolve(new URL("..", import.meta.url).pathname);

function bash(script: string, env: Record<string, string> = {}): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    const proc = spawn("bash", [script], {
      cwd: REPO,
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    proc.on("exit", (code) => {
      if (code === 0) resolveP();
      else rejectP(new Error(`${script} exited ${String(code)}`));
    });
    proc.on("error", rejectP);
  });
}

async function ensureSeed(): Promise<void> {
  const seedPath = resolve(REPO, ".vanta", "dev-seed");
  if (existsSync(seedPath)) return;
  console.log("[dev] no .vanta/dev-seed — running installer.sh");
  await bash("installer.sh");
}

async function up(): Promise<void> {
  console.log("[dev] step 1/3: anvils");
  await bash("scripts/anvil-up.sh");

  console.log("[dev] step 2/3: foundry deploy");
  await bash("scripts/deploy-local.sh");

  console.log("[dev] step 3/3: runtime");
  const deployJson = JSON.parse(
    readFileSync(
      resolve(REPO, "contracts/deployments/local-base-sepolia.json"),
      "utf8",
    ),
  ) as { LpVault?: string; LoanBook?: string; expectedAdmin?: string };

  const rt = spawn("pnpm", ["--filter", "@vanta/runtime", "start"], {
    cwd: REPO,
    stdio: "inherit",
    env: {
      ...process.env,
      LOAN_BOOK_RPC_URL: "http://127.0.0.1:8545",
      AMOY_RPC_URL: "http://127.0.0.1:8546",
      LOAN_BOOK_ADDRESS: deployJson.LoanBook ?? "",
      LP_VAULT_ADDRESS: deployJson.LpVault ?? "",
      EXPECTED_ADMIN: deployJson.expectedAdmin ?? "",
      PORT: process.env["PORT"] ?? "8787",
      HOST: process.env["HOST"] ?? "127.0.0.1",
    },
  });

  let runtime: ChildProcess | null = rt;

  const teardown = async (signal: string): Promise<void> => {
    console.log(`\n[dev] received ${signal}, draining…`);
    if (runtime !== null) {
      runtime.kill("SIGTERM");
      runtime = null;
    }
    try {
      await bash("scripts/anvil-down.sh");
    } catch (err) {
      console.error("[dev] anvil-down failed:", err);
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void teardown("SIGINT"));
  process.on("SIGTERM", () => void teardown("SIGTERM"));

  rt.on("exit", (code) => {
    console.error(`[dev] runtime exited ${String(code)}; tearing down anvils`);
    void bash("scripts/anvil-down.sh").finally(() => {
      process.exit(code ?? 1);
    });
  });
}

up().catch((err: unknown) => {
  console.error("[dev] fatal:", err);
  void bash("scripts/anvil-down.sh").finally(() => {
    process.exit(1);
  });
});

void ensureSeed; // referenced for future use; installer flow lives in installer.sh
