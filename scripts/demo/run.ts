/**
 * `pnpm demo` — single-command 10-minute demo orchestrator.
 *
 * Cold-starts the entire local stack, in order:
 *   1. anvil (Base Sepolia + Polygon Amoy forks) on :8545 / :8546
 *   2. seed-onchain     (deploys v2 lender stack + funds demo wallet
 *                        + writes .vanta/demo-pools.json)
 *   3. seed-events      (resets .vanta/events.log → ~130 historical
 *                        signed events for vanta-opus / gpt / gemini)
 *   4. runtime          (boots @vanta/runtime on :8787 with
 *                        VANTA_DEMO_ADMIN=1 + VANTA_DATA_DIR=.vanta)
 *   5. game             (boots @vanta/game on :3031 — the walkable
 *                        kingdoms world with chat panel + detail card)
 *   6. demo-runner      (long-running: emits a fresh origination
 *                        chain every 60s, credit ticks every 30s,
 *                        signed and posted to the runtime's append
 *                        endpoint so SSE listeners broadcast)
 *
 * On SIGINT / SIGTERM:
 *   - SIGTERM the runner, the game, the runtime, then anvil-down.sh.
 *   - Exit 0.
 *
 * Why this exists: the 10-min demo doesn't survive any
 * "let me set this up" moments. One command from clean → the world
 * is rendered, the chat panel already has 130+ signed events to
 * scroll through, deposits clear on local anvil, and fresh activity
 * keeps landing in the chat panel as you narrate.
 *
 * Honest framing: the seed events + runner activity are real,
 * TEE-signed, byte-for-byte verifiable. The "scripted" part is only
 * the LLM text — substituted from the persona phrase library when
 * `DEMO_LLM=1` isn't set. With `DEMO_LLM=1` the runner attempts
 * live Anthropic Haiku calls (TODO: not yet wired through demo
 * runner; the offline path is sufficient for the demo).
 */

import { ChildProcess, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..");

const RUNTIME_URL = process.env["VANTA_RUNTIME_URL"] ?? "http://127.0.0.1:8787";
const GAME_URL = process.env["VANTA_GAME_URL"] ?? "http://localhost:3031";
const VANTA_DATA = resolve(REPO_ROOT, ".vanta");

const ANSI = {
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

function header(text: string): void {
  console.log(`\n${ANSI.cyan("●")} ${ANSI.bold(text)}`);
}

function info(text: string): void {
  console.log(`  ${ANSI.dim(text)}`);
}

const children: ChildProcess[] = [];
let shuttingDown = false;

function track(child: ChildProcess): ChildProcess {
  children.push(child);
  child.on("exit", (code) => {
    if (!shuttingDown) {
      const idx = children.indexOf(child);
      if (idx !== -1) children.splice(idx, 1);
      if (code !== 0 && code !== null) {
        console.error(ANSI.red(`\n[orchestrator] child process exited with code ${String(code)}`));
        void shutdown(1);
      }
    }
  });
  return child;
}

async function shutdown(exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${ANSI.yellow("●")} shutting down…`);
  // Kill in reverse-launch order so dependents go first.
  for (const child of [...children].reverse()) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  await new Promise((r) => setTimeout(r, 500));
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* gone */
    }
  }
  // Best-effort tear down anvil.
  try {
    spawn("bash", ["scripts/anvil-down.sh"], { cwd: REPO_ROOT, stdio: "ignore" });
  } catch {
    /* ignore */
  }
  await new Promise((r) => setTimeout(r, 200));
  console.log(`${ANSI.green("✓")} demo stack stopped\n`);
  process.exit(exitCode);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
process.on("uncaughtException", (err) => {
  console.error(ANSI.red(`[orchestrator] uncaught: ${err.message}`));
  void shutdown(1);
});

function runForeground(cmd: string, args: readonly string[], envOverride: Readonly<Record<string, string>> = {}): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(cmd, args.slice(), {
      cwd: REPO_ROOT,
      stdio: "inherit",
      env: { ...process.env, ...envOverride },
    });
    child.on("exit", (code) => {
      if (code === 0) resolveP();
      else rejectP(new Error(`${cmd} ${args.join(" ")} → exit ${String(code)}`));
    });
    child.on("error", rejectP);
  });
}

function spawnBackground(
  label: string,
  cmd: string,
  args: readonly string[],
  envOverride: Readonly<Record<string, string>> = {},
): ChildProcess {
  const child = spawn(cmd, args.slice(), {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...envOverride },
  });
  // Surface stdout / stderr with a label prefix so multiplexed output is readable.
  const prefix = ANSI.dim(`[${label}]`);
  child.stdout?.on("data", (chunk) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.length > 0) process.stdout.write(`${prefix} ${line}\n`);
    }
  });
  child.stderr?.on("data", (chunk) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.length > 0) process.stderr.write(`${prefix} ${line}\n`);
    }
  });
  return track(child);
}

async function waitForUrl(label: string, url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
      lastErr = new Error(`${url} → status ${String(r.status)}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${label} did not become ready at ${url} within ${String(timeoutMs)}ms (last: ${lastErr instanceof Error ? lastErr.message : String(lastErr)})`);
}

async function main(): Promise<void> {
  console.log(ANSI.bold("\n=== VANTA — 10-minute demo orchestrator ===\n"));
  mkdirSync(VANTA_DATA, { recursive: true });

  // Step 1 — anvil up
  header("(1/6) starting anvil forks (Base Sepolia :8545 + Polygon Amoy :8546)");
  await runForeground("bash", ["scripts/anvil-up.sh"]);

  // Step 2 — on-chain seed (deploys + funds demo wallet)
  header("(2/6) deploying v2 lender stack + funding demo wallet");
  await runForeground("pnpm", ["tsx", "scripts/demo/seed-onchain.ts"]);

  // Step 3 — event log seed (~130 historical signed events)
  header("(3/6) seeding event log with 30d of historical activity");
  await runForeground("pnpm", ["tsx", "scripts/demo/seed-events.ts", "--reset"]);

  // Step 4 — runtime (background)
  header("(4/6) booting runtime on :8787");
  spawnBackground(
    "runtime",
    "pnpm",
    ["--filter", "@vanta/runtime", "start"],
    {
      VANTA_DEMO_ADMIN: "1",
      VANTA_DATA_DIR: VANTA_DATA,
      VANTA_DEMO_POOLS_PATH: resolve(VANTA_DATA, "demo-pools.json"),
    },
  );
  await waitForUrl("runtime", `${RUNTIME_URL}/healthz`, 60_000);
  info("runtime ready");

  // Step 5 — game frontend (background)
  header("(5/6) booting game frontend on :3031");
  spawnBackground("game", "pnpm", ["--filter", "@vanta/game", "dev"]);
  await waitForUrl("game", GAME_URL, 60_000);
  info("game frontend ready");

  // Step 6 — demo runner (background)
  header("(6/6) starting demo runner (origination/min, tick/30s)");
  spawnBackground("runner", "pnpm", ["tsx", "scripts/demo/demo-runner.ts"], {
    VANTA_RUNTIME_URL: RUNTIME_URL,
  });

  console.log(`\n${ANSI.green("✓")} ${ANSI.bold("demo ready")}\n`);
  console.log(`  ${ANSI.bold("open:")}        ${ANSI.cyan(GAME_URL)}`);
  console.log(`  ${ANSI.bold("runtime API:")} ${ANSI.dim(RUNTIME_URL)}`);
  console.log(`  ${ANSI.bold("anvil base:")}  ${ANSI.dim("http://localhost:8545")}`);
  console.log(`  ${ANSI.bold("anvil amoy:")}  ${ANSI.dim("http://localhost:8546")}`);
  console.log();
  console.log(ANSI.dim("  press CTRL+C to stop everything cleanly"));
  console.log();
}

main().catch((err: unknown) => {
  console.error(ANSI.red(`\norchestrator: ${err instanceof Error ? err.message : String(err)}`));
  void shutdown(1);
});
