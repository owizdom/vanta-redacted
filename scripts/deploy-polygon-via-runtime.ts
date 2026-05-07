/**
 * Deploy VantaVault on Polygon mainnet (chain id 137) via the running
 * TEE runtime's /api/admin/deploy route — same admin wallet (TEE-derived
 * `0x2F86…6B14`) signs from inside the enclave on a different chain.
 *
 * Env required:
 *   RUNTIME_URL    (e.g. http://35.232.60.83:8787)
 *   ADMIN_TOKEN    (matches VANTA_DEPLOY_ADMIN_TOKEN inside the TEE)
 *   ADMIN_ADDRESS  (the runtime's TEE-derived origination admin EOA)
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  http,
  encodeAbiParameters,
  type Address,
} from "viem";
import { polygon } from "viem/chains";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..");

const RUNTIME_URL = mustEnv("RUNTIME_URL").replace(/\/$/, "");
const ADMIN_TOKEN = mustEnv("ADMIN_TOKEN");
const ADMIN = mustEnv("ADMIN_ADDRESS") as Address;

const POLYGON_RPC = process.env["POLYGON_RPC"] ?? "https://polygon-rpc.com";
const CTF_POLYGON_MAINNET = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045" as Address;
const DEPLOYMENTS_PATH = resolve(REPO_ROOT, "contracts", "deployments", "mainnet-polygon.json");

function mustEnv(name: string): string {
  const v = process.env[name];
  if (typeof v !== "string" || v.length === 0) throw new Error(`missing required env: ${name}`);
  return v;
}

interface ForgeArtifact {
  readonly bytecode: { readonly object: `0x${string}` };
  readonly abi: ReadonlyArray<unknown>;
}

function loadArtifact(name: string): ForgeArtifact {
  const path = resolve(REPO_ROOT, "contracts", "out", `${name}.sol`, `${name}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as ForgeArtifact;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${RUNTIME_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${path} → ${String(r.status)}: ${text.slice(0, 400)}`);
  return JSON.parse(text) as T;
}

async function main(): Promise<void> {
  console.log("=== Stage 3 — VantaVault on Polygon mainnet (via TEE runtime) ===");
  console.log(`runtime: ${RUNTIME_URL}`);
  console.log(`admin:   ${ADMIN}`);
  console.log(`CTF:     ${CTF_POLYGON_MAINNET}`);

  const art = loadArtifact("VantaVault");

  // VantaVault(IERC1155 ctf, address admin)
  const ctorArgs = encodeAbiParameters(
    [{ type: "address" }, { type: "address" }],
    [CTF_POLYGON_MAINNET, ADMIN],
  );
  const deployBytecode = (art.bytecode.object + ctorArgs.slice(2)) as `0x${string}`;
  console.log(`\n[deploy] VantaVault — POSTing ${deployBytecode.length / 2 - 1} bytes to chain 137…`);

  const r = await postJson<{
    ok: boolean;
    txHash: `0x${string}`;
    contractAddress: Address;
    gasUsed: string;
    chainId: number;
  }>("/api/admin/deploy", {
    bytecode: deployBytecode,
    chain: { chainId: 137 },
  });

  console.log(`[deploy] VantaVault → ${r.contractAddress} (tx ${r.txHash}, gas ${r.gasUsed}, chainId ${r.chainId})`);

  // Verify on-chain via public Polygon RPC
  const pub = createPublicClient({ chain: polygon, transport: http(POLYGON_RPC) });
  const owner = (await pub.readContract({
    address: r.contractAddress,
    abi: art.abi,
    functionName: "owner",
  })) as Address;
  console.log(`\n[verify] VantaVault.owner() = ${owner}`);
  if (owner.toLowerCase() !== ADMIN.toLowerCase()) {
    throw new Error(`owner mismatch — got ${owner}, expected ${ADMIN}`);
  }

  mkdirSync(dirname(DEPLOYMENTS_PATH), { recursive: true });
  const out = {
    chain: "mainnet-polygon",
    chainId: 137,
    VantaVault: r.contractAddress,
    expectedAdmin: ADMIN,
    ctf: CTF_POLYGON_MAINNET,
  };
  writeFileSync(DEPLOYMENTS_PATH, JSON.stringify(out, null, 2));
  console.log(`\n=== DONE ===`);
  console.log(`VantaVault: ${r.contractAddress}`);
  console.log(`written:    ${DEPLOYMENTS_PATH}`);
}

main().catch((err: unknown) => {
  console.error("FAILED:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
