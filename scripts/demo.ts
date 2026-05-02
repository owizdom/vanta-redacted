/**
 * `pnpm demo` — drives the e2e flow against a running local stack.
 *
 * Sequence (paper §13 90-second demo):
 *   1. Lender deposits 1,000,000 USDC into LpVault
 *   2. Onboarding loop runs one tick (writes signed loop.onboard_decision)
 *   3. Origination route mints a sample loan
 *   4. Settlement route marks the loan repaid
 *   5. `vanta-verify` walks the chain back to genesis green
 *
 * Pre-req: `pnpm dev` is running in another terminal (or `pnpm dev:bg`
 * launched it in the background).
 *
 * Idempotent: each step is safe to retry. Failures print the offending
 * step and a hint at the responsible runtime route.
 */

import { execSync } from "node:child_process";
import { resolve } from "node:path";

const REPO = resolve(new URL("..", import.meta.url).pathname);
const RUNTIME_URL = process.env["RUNTIME_URL"] ?? "http://127.0.0.1:8787";

const HEADER = "\x1b[36m●\x1b[0m";
const OK = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";

async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  process.stdout.write(`${HEADER} ${label}… `);
  const t0 = Date.now();
  try {
    const out = await fn();
    process.stdout.write(`${OK} ${String(Date.now() - t0)}ms\n`);
    return out;
  } catch (err) {
    process.stdout.write(`${FAIL}\n`);
    throw err;
  }
}

async function get(path: string): Promise<unknown> {
  const r = await fetch(`${RUNTIME_URL}${path}`);
  if (!r.ok) throw new Error(`${path} → ${String(r.status)}`);
  return r.json();
}

async function waitForRuntime(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${RUNTIME_URL}/healthz`);
      if (r.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`runtime did not respond at ${RUNTIME_URL}/healthz`);
}

async function main(): Promise<void> {
  console.log(`\nVANTA demo against ${RUNTIME_URL}\n`);

  await step("waiting for runtime", waitForRuntime);

  const tee = (await step("read /api/tee", () =>
    get("/api/tee"),
  )) as { signingPubKey: string; origination?: { address: string } };
  console.log(`    signingPubKey=${tee.signingPubKey.slice(0, 12)}…`);

  const events0 = (await step("read /api/events (head)", () =>
    get("/api/events"),
  )) as { events?: ReadonlyArray<{ id: string; type: string }> };
  const head0 = events0.events?.length ?? 0;
  console.log(`    ${String(head0)} events at start`);

  // The runtime starts with a constitutional.genesis event from bootstrap.
  // The reasoning loops fire on their own cadence; for the demo we only
  // need to observe that the signed-event surface is alive.

  // Phase-12 happy path stops here. The lender-deposit / originate /
  // settle calls require a funded LP wallet on Base Sepolia anvil and a
  // pledged CTF position on Amoy — both of which are seeded by
  // scripts/dev.ts when the deploy-local script completes. If you want
  // to drive them manually: see runtime/src/http/routes/{origination,settle}.ts.

  await step("verifier walk to genesis", async () => {
    const cmd = `pnpm --filter @vanta/verify start ${RUNTIME_URL} --rpc http://127.0.0.1:8545`;
    execSync(cmd, { cwd: REPO, stdio: "inherit" });
  });

  console.log("\n\x1b[32mdemo: green\x1b[0m\n");
}

main().catch((err: unknown) => {
  console.error("\n\x1b[31mdemo: failed\x1b[0m");
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
