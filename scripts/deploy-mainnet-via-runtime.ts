/**
 * Deploy LpVault + LoanBook on Base mainnet by POSTing bytecode to the
 * running TEE runtime's /api/admin/deploy + /api/admin/send-tx routes.
 *
 * Why: the admin private key never leaves the TEE (it's HKDF-derived from
 * /vanta-data/.seed inside the enclave). Foundry can't sign deploy txs
 * externally. The runtime exposes signed-from-TEE deploy/send-tx routes
 * gated by VANTA_DEPLOY_ADMIN_ENABLED=1 + an X-Admin-Token header; this
 * script orchestrates against them.
 *
 * Flow:
 *   1. Read forge artifacts from contracts/out/{LpVault,LoanBook}.json
 *   2. Encode LpVault constructor args (USDC=0x8335…, admin=<derived>)
 *   3. POST bytecode to /api/admin/deploy → capture LpVault address
 *   4. Encode LoanBook constructor args (USDC, LpVault, admin)
 *   5. POST bytecode → capture LoanBook address
 *   6. Encode LpVault.proposeLoanBook(LoanBook) → POST /api/admin/send-tx
 *   7. Encode LoanBook.acceptLpVaultWiring() → POST /api/admin/send-tx
 *   8. Verify LpVault.loanBook() == LoanBook
 *   9. Write contracts/deployments/mainnet-base.json
 *
 * Env required:
 *   RUNTIME_URL          (e.g. http://35.232.60.83:8787)
 *   ADMIN_TOKEN          (matches VANTA_DEPLOY_ADMIN_TOKEN inside the TEE)
 *   USDC_ADDRESS         (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
 *   ADMIN_ADDRESS        (the runtime's /api/tee origination address)
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  http,
  encodeAbiParameters,
  encodeFunctionData,
  type Address,
} from "viem";
import { base } from "viem/chains";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..");

const RUNTIME_URL = mustEnv("RUNTIME_URL").replace(/\/$/, "");
const ADMIN_TOKEN = mustEnv("ADMIN_TOKEN");
const USDC = mustEnv("USDC_ADDRESS") as Address;
const ADMIN = mustEnv("ADMIN_ADDRESS") as Address;

const BASE_RPC = process.env["BASE_RPC"] ?? "https://mainnet.base.org";
const DEPLOYMENTS_PATH = resolve(REPO_ROOT, "contracts", "deployments", "mainnet-base.json");

function mustEnv(name: string): string {
  const v = process.env[name];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`missing required env: ${name}`);
  }
  return v;
}

interface ForgeArtifact {
  readonly bytecode: { readonly object: `0x${string}` };
  readonly abi: ReadonlyArray<unknown>;
}

function loadArtifact(name: string): ForgeArtifact {
  const path = resolve(REPO_ROOT, "contracts", "out", `${name}.sol`, `${name}.json`);
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as ForgeArtifact;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${RUNTIME_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-admin-token": ADMIN_TOKEN,
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`${path} → ${String(r.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as T;
}

interface DeployResp {
  readonly ok: boolean;
  readonly txHash: `0x${string}`;
  readonly contractAddress: Address;
  readonly gasUsed: string;
}

interface SendTxResp {
  readonly ok: boolean;
  readonly txHash: `0x${string}`;
  readonly gasUsed: string;
}

async function deployContract(label: string, deployBytecode: `0x${string}`): Promise<Address> {
  console.log(`\n[deploy] ${label} — POSTing bytecode (${deployBytecode.length / 2 - 1} bytes)…`);
  const r = await postJson<DeployResp>("/api/admin/deploy", { bytecode: deployBytecode });
  console.log(`[deploy] ${label} → ${r.contractAddress} (tx ${r.txHash}, gas ${r.gasUsed})`);
  return r.contractAddress;
}

async function sendTx(label: string, to: Address, data: `0x${string}`): Promise<`0x${string}`> {
  console.log(`\n[send-tx] ${label} — to=${to} data=${data.slice(0, 18)}…`);
  const r = await postJson<SendTxResp>("/api/admin/send-tx", { to, data });
  console.log(`[send-tx] ${label} → ${r.txHash} (gas ${r.gasUsed})`);
  return r.txHash;
}

async function main(): Promise<void> {
  console.log("=== Deploy via TEE runtime ===");
  console.log(`runtime: ${RUNTIME_URL}`);
  console.log(`admin:   ${ADMIN}`);
  console.log(`USDC:    ${USDC}`);

  const lpVaultArt = loadArtifact("LpVault");
  const loanBookArt = loadArtifact("LoanBook");

  // LpVault(IERC20 _usdc, address _admin)
  const lpVaultCtorArgs = encodeAbiParameters(
    [{ type: "address" }, { type: "address" }],
    [USDC, ADMIN],
  );
  const lpVaultDeploy = (lpVaultArt.bytecode.object + lpVaultCtorArgs.slice(2)) as `0x${string}`;
  const lpVaultAddr = await deployContract("LpVault", lpVaultDeploy);

  // LoanBook(IERC20 _usdc, LpVault _lpVault, address _admin)
  const loanBookCtorArgs = encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "address" }],
    [USDC, lpVaultAddr, ADMIN],
  );
  const loanBookDeploy = (loanBookArt.bytecode.object + loanBookCtorArgs.slice(2)) as `0x${string}`;
  const loanBookAddr = await deployContract("LoanBook", loanBookDeploy);

  // Wire — LpVault.proposeLoanBook(loanBook) then LoanBook.acceptLpVaultWiring()
  const proposeData = encodeFunctionData({
    abi: lpVaultArt.abi,
    functionName: "proposeLoanBook",
    args: [loanBookAddr],
  }) as `0x${string}`;
  await sendTx("LpVault.proposeLoanBook", lpVaultAddr, proposeData);

  const acceptData = encodeFunctionData({
    abi: loanBookArt.abi,
    functionName: "acceptLpVaultWiring",
    args: [],
  }) as `0x${string}`;
  await sendTx("LoanBook.acceptLpVaultWiring", loanBookAddr, acceptData);

  // Verify wiring on-chain via public RPC
  const pub = createPublicClient({ chain: base, transport: http(BASE_RPC) });
  const wired = (await pub.readContract({
    address: lpVaultAddr,
    abi: lpVaultArt.abi,
    functionName: "loanBook",
  })) as Address;
  console.log(`\n[verify] LpVault.loanBook() = ${wired}`);
  if (wired.toLowerCase() !== loanBookAddr.toLowerCase()) {
    throw new Error(`wiring failed — LpVault.loanBook()=${wired} != LoanBook=${loanBookAddr}`);
  }

  // Stamp the deployment JSON
  mkdirSync(dirname(DEPLOYMENTS_PATH), { recursive: true });
  const out = {
    chain: "mainnet-base",
    chainId: 8453,
    LpVault: lpVaultAddr,
    LoanBook: loanBookAddr,
    expectedAdmin: ADMIN,
  };
  writeFileSync(DEPLOYMENTS_PATH, JSON.stringify(out, null, 2));
  console.log(`\n=== DONE ===`);
  console.log(`LpVault:  ${lpVaultAddr}`);
  console.log(`LoanBook: ${loanBookAddr}`);
  console.log(`written:  ${DEPLOYMENTS_PATH}`);
}

main().catch((err: unknown) => {
  console.error("FAILED:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
