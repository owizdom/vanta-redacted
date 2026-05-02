/**
 * Demo bot — consumes VANTA's `/bridge/wizard/quote` Service-Agent
 * affordance the way another agent would.
 *
 * Modes:
 *   default   — Hits the runtime with the internal-bypass header (no
 *               USDC needed) and prints the signed quote. Use this when
 *               you just want to prove the route is alive and producing
 *               TEE-signed haircuts.
 *
 *   --discover — GET /.well-known/x402 to show the pricing + receiver
 *               that an external agent would see before paying.
 *
 *   --metered — Calls without payment and shows the 402 response. Useful
 *               only when the runtime is started with X402_ENABLED=1.
 *
 * Usage:
 *   tsx scripts/x402-pay-quote.ts                 # bypass call (always works)
 *   tsx scripts/x402-pay-quote.ts --discover      # show metering surface
 *   tsx scripts/x402-pay-quote.ts --metered       # prove the 402 wall
 *
 * Output: pretty-prints the signed quote on success, the 402 + discovery
 * doc on metered, or the error otherwise.
 */

const RUNTIME = process.env["RUNTIME_URL"] ?? "http://127.0.0.1:8787";
const INTERNAL_SECRET = process.env["VANTA_INTERNAL_SECRET"] ?? "";

// One of the markets the runtime polls live (Beshear-2028 YES).
const SAMPLE = {
  position_id:
    "26468656392978559668331516709623917078428425933265692717836103090220693717685",
  market_id: "0x1d519b87999e3d4e90e1e8f57b5eee73a0ba488ff3fdb70867f294733aba84a9",
  size: "50000000000", // $50,000 USDC notional cap
} as const;

const args = process.argv.slice(2);

const C = {
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

async function discover(): Promise<void> {
  const r = await fetch(`${RUNTIME}/.well-known/x402`);
  const j = await r.json();
  console.log(C.cyan("● /.well-known/x402"));
  console.log(JSON.stringify(j, null, 2));
}

async function callQuote(headers: Record<string, string>): Promise<{
  status: number;
  body: unknown;
}> {
  const r = await fetch(`${RUNTIME}/bridge/wizard/quote`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(SAMPLE),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function metered(): Promise<void> {
  console.log(C.cyan("● POST /bridge/wizard/quote (no payment)"));
  const { status, body } = await callQuote({});
  if (status === 402) {
    console.log(C.green(`  ✓ 402 Payment Required — metering wall is up`));
    console.log(JSON.stringify(body, null, 2));
  } else {
    console.log(C.yellow(`  ! status=${String(status)} (X402_ENABLED off?)`));
    console.log(JSON.stringify(body, null, 2));
  }
}

async function bypass(): Promise<void> {
  if (INTERNAL_SECRET.length === 0) {
    console.log(
      C.yellow(
        "  ! VANTA_INTERNAL_SECRET unset — call will pass through unmetered (the same effect)",
      ),
    );
  }
  console.log(C.cyan("● POST /bridge/wizard/quote"));
  const headers: Record<string, string> = {};
  if (INTERNAL_SECRET.length > 0) headers["X-Vanta-Internal"] = INTERNAL_SECRET;
  const { status, body } = await callQuote(headers);
  if (status !== 200) {
    console.log(C.red(`  ✗ status=${String(status)}`));
    console.log(JSON.stringify(body, null, 2));
    process.exit(1);
  }
  const q = body as Record<string, string | number>;
  console.log(C.green("  ✓ signed quote"));
  console.log(`  ${C.dim("issuer pubkey")}   ${String(q["issuer_pubkey"]).slice(0, 24)}…`);
  console.log(`  ${C.dim("market id")}       ${String(q["market_id"]).slice(0, 18)}…${String(q["market_id"]).slice(-4)}`);
  console.log(`  ${C.dim("midpoint")}        ${String(q["midpoint"])}`);
  console.log(`  ${C.dim("τ days")}           ${String(q["tau_days"])}`);
  console.log(`  ${C.dim("σ(τ)")}            ${String(q["sigma_tau"])}`);
  console.log(`  ${C.dim("haircut bps")}     ${String(q["haircut_bps"])}`);
  const maxLoanRaw = String(q["max_loan_usdc6"]);
  const maxLoanUsd = Number(BigInt(maxLoanRaw)) / 1e6;
  console.log(`  ${C.dim("max loan")}        $${maxLoanUsd.toFixed(2)} USDC`);
  console.log(`  ${C.dim("expires")}         ${new Date(Number(q["expires_at_unix"]) * 1000).toISOString()}`);
  console.log(`  ${C.dim("request hash")}    ${String(q["request_hash"]).slice(0, 24)}…`);
  console.log(`  ${C.dim("signature")}       ${String(q["signature"]).slice(0, 24)}…`);
}

async function main(): Promise<void> {
  console.log(C.cyan(`runtime  ${RUNTIME}`));
  if (args.includes("--discover")) {
    await discover();
    return;
  }
  if (args.includes("--metered")) {
    await metered();
    return;
  }
  await bypass();
}

main().catch((err: unknown) => {
  console.error(C.red("✗"), err instanceof Error ? err.message : String(err));
  process.exit(1);
});
