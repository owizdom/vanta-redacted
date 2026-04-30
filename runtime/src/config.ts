/**
 * Runtime config. Strict zod validation at boot so bad inputs fail
 * loudly, not at first-request time. Nothing exotic — env-only.
 *
 * `LOAN_BOOK_ADDRESS` and `LP_VAULT_ADDRESS` are read from
 * `contracts/deployments/local-base-sepolia.json` if not provided
 * directly. Production callers will override both.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

import { TeeError } from "@vanta/tee";

const ETH_ADDR = /^0x[0-9a-fA-F]{40}$/;

const RawConfig = z.object({
  // PORT=0 means "OS assigns ephemeral" (test mode); >= 1 is a real bind.
  PORT: z.coerce.number().int().min(0).max(65535).default(8787),
  HOST: z.string().min(1).default("127.0.0.1"),
  VANTA_DATA_DIR: z.string().min(1).default("./vanta-data"),
  LOAN_BOOK_RPC_URL: z
    .string()
    .url()
    .default("http://127.0.0.1:8545"),
  AMOY_RPC_URL: z
    .string()
    .url()
    .default("http://127.0.0.1:8546"),
  LOAN_BOOK_ADDRESS: z
    .string()
    .regex(ETH_ADDR, "must be a 0x-prefixed 20-byte hex address")
    .optional(),
  LP_VAULT_ADDRESS: z
    .string()
    .regex(ETH_ADDR, "must be a 0x-prefixed 20-byte hex address")
    .optional(),
  EXPECTED_ADMIN: z
    .string()
    .regex(ETH_ADDR, "must be a 0x-prefixed 20-byte hex address")
    .optional(),
  MARK_TICK_SECONDS: z.coerce.number().int().positive().default(30),
  /** Where the deploy JSONs live; default points at the repo's checked-in path. */
  DEPLOYMENTS_DIR: z
    .string()
    .min(1)
    .default(resolve(process.cwd(), "..", "contracts", "deployments")),
  // Bootstrap escape hatch for the FIRST EigenCompute deploy: the
  // KMS-derived admin EOA isn't known until the runtime boots, but the
  // I-RT-2 owner check requires contracts already deployed against that
  // admin. Set SKIP_CONTRACT_CHECKS=1 for the bootstrap deploy, harvest
  // the derived admin from /api/tee, deploy contracts owned by it, then
  // redeploy without the flag. Boot-time chain reads (LoanBook.owner())
  // and the deployments-JSON requirement are bypassed; address-dependent
  // routes (origination/settle) still 503 with no real backing.
  SKIP_CONTRACT_CHECKS: z.coerce.boolean().default(false),
  // Second-stage bootstrap: contracts are now deployed but unwired
  // (LpVault.loanBook() == 0). Foundry script 03 cannot run because
  // both calls require admin authority and admin's private key lives in
  // the TEE. With BOOT_AND_WIRE=1, the runtime — which DOES have the
  // admin key — performs the propose/accept handshake itself on first
  // boot, then continues normally. Idempotent: if vault.loanBook()
  // already equals the configured LoanBook address, the step is a no-op.
  BOOT_AND_WIRE: z.coerce.boolean().default(false),
  // Inference layer. Both can be empty in local-only mode; calls that
  // need inference will fail closed at request time, not at boot.
  AI_GATEWAY_BASE_URL: z.string().default(""),
  AI_GATEWAY_API_KEY: z.string().default(""),
  INFERENCE_MODEL_ANTHROPIC: z.string().default("anthropic/claude-sonnet-4-6"),
  INFERENCE_MODEL_OPENAI: z.string().default("openai/gpt-5"),
  INFERENCE_MODEL_GOOGLE: z.string().default("google/gemini-2.5-pro"),
  // ----- X402 metering (paper §8 / EigenCloud Service-Agent affordance) ---
  // When false (default for local Docker compose), the metered routes
  // pass through unmetered. Production / preview deployments flip this
  // on and bots / curl callers must include a paid X-PAYMENT header.
  X402_ENABLED: z.coerce.boolean().default(false),
  X402_QUOTE_PRICE_USDC: z.coerce.number().nonnegative().default(0.05),
  X402_MARK_PRICE_USDC: z.coerce.number().nonnegative().default(0.001),
  /** Override the EIP-712 USDC token name. Base Sepolia Circle USDC is "USDC". */
  X402_TOKEN_NAME: z.string().default("USDC"),
  X402_TOKEN_VERSION: z.string().default("2"),
  /** Override the receiver address. Defaults to the HKDF-derived treasury account. */
  X402_RECEIVER_OVERRIDE: z
    .string()
    .regex(ETH_ADDR, "must be a 0x-prefixed 20-byte hex address")
    .optional(),
  /** Internal-bypass header secret. Internal callers (Mineflayer bridge, the
   *  wizard's own loop) set X-Vanta-Internal=<this> to skip metering. Empty = no bypass. */
  VANTA_INTERNAL_SECRET: z.string().default(""),
});

export interface InferenceModelSlugs {
  readonly anthropic: string;
  readonly openai: string;
  readonly google: string;
}

export interface InferenceConfig {
  /** Vercel AI Gateway base URL (e.g. `https://ai-gateway.vercel.sh/v1`). Empty = unset. */
  readonly gatewayBaseUrl: string;
  /** Vercel AI Gateway bearer token. Empty = unset. */
  readonly gatewayApiKey: string;
  readonly models: InferenceModelSlugs;
}

export interface X402Config {
  readonly enabled: boolean;
  readonly quotePriceUsdc: number;
  readonly markPriceUsdc: number;
  readonly tokenName: string;
  readonly tokenVersion: string;
  readonly receiverOverride: `0x${string}` | null;
  readonly internalSecret: string;
}

export interface RuntimeConfig {
  readonly port: number;
  readonly host: string;
  readonly dataDir: string;
  readonly loanBookRpcUrl: string;
  readonly amoyRpcUrl: string;
  readonly loanBookAddress: `0x${string}`;
  readonly lpVaultAddress: `0x${string}`;
  readonly expectedAdmin: `0x${string}` | null;
  readonly markTickSeconds: number;
  readonly deploymentsDir: string;
  readonly skipContractChecks: boolean;
  readonly bootAndWire: boolean;
  readonly inference: InferenceConfig;
  readonly x402: X402Config;
}

interface DeploymentsBaseSepolia {
  readonly LpVault?: string;
  readonly LoanBook?: string;
  readonly expectedAdmin?: string;
}

function readDeployments(deploymentsDir: string): DeploymentsBaseSepolia {
  const path = resolve(deploymentsDir, "local-base-sepolia.json");
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as DeploymentsBaseSepolia;
  } catch (err: unknown) {
    throw new TeeError(
      "env_not_configured",
      `failed to read deployments at ${path}: provide LOAN_BOOK_ADDRESS + LP_VAULT_ADDRESS or run scripts/deploy-local.sh`,
      { cause: err instanceof Error ? err.message : String(err) },
    );
  }
}

/**
 * Parse and finalize the runtime config from `process.env` (defaults
 * applied). Throws `TeeError(env_not_configured)` on any validation
 * failure — boot must fail closed, never with partial config.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const parse = RawConfig.safeParse(env);
  if (!parse.success) {
    throw new TeeError(
      "env_not_configured",
      "RuntimeConfig validation failed",
      { issues: String(parse.error.issues.length) },
    );
  }
  const raw = parse.data;

  let loanBookAddress = raw.LOAN_BOOK_ADDRESS;
  let lpVaultAddress = raw.LP_VAULT_ADDRESS;
  let expectedAdmin = raw.EXPECTED_ADMIN;

  if (loanBookAddress === undefined || lpVaultAddress === undefined || expectedAdmin === undefined) {
    if (raw.SKIP_CONTRACT_CHECKS) {
      // Bootstrap-deploy escape hatch: the deployments JSON doesn't yet
      // exist (we haven't deployed contracts owned by the as-yet-
      // underived admin). Substitute zero addresses; chain-touching
      // routes will short-circuit at request time.
      const ZERO = "0x0000000000000000000000000000000000000000";
      if (loanBookAddress === undefined) loanBookAddress = ZERO;
      if (lpVaultAddress === undefined) lpVaultAddress = ZERO;
      // Deliberately leave expectedAdmin undefined → will be left null
      // below; bootstrap.ts then accepts whatever the KMS-derived EOA is.
    } else {
      const deployments = readDeployments(raw.DEPLOYMENTS_DIR);
      if (loanBookAddress === undefined && deployments.LoanBook !== undefined) {
        loanBookAddress = deployments.LoanBook;
      }
      if (lpVaultAddress === undefined && deployments.LpVault !== undefined) {
        lpVaultAddress = deployments.LpVault;
      }
      if (expectedAdmin === undefined && deployments.expectedAdmin !== undefined) {
        expectedAdmin = deployments.expectedAdmin;
      }
    }
  }

  if (loanBookAddress === undefined) {
    throw new TeeError(
      "env_not_configured",
      "LOAN_BOOK_ADDRESS not set and not present in deployments JSON",
    );
  }
  if (lpVaultAddress === undefined) {
    throw new TeeError(
      "env_not_configured",
      "LP_VAULT_ADDRESS not set and not present in deployments JSON",
    );
  }

  return {
    port: raw.PORT,
    host: raw.HOST,
    dataDir: resolve(raw.VANTA_DATA_DIR),
    loanBookRpcUrl: raw.LOAN_BOOK_RPC_URL,
    amoyRpcUrl: raw.AMOY_RPC_URL,
    loanBookAddress: loanBookAddress as `0x${string}`,
    lpVaultAddress: lpVaultAddress as `0x${string}`,
    expectedAdmin: expectedAdmin === undefined ? null : (expectedAdmin as `0x${string}`),
    markTickSeconds: raw.MARK_TICK_SECONDS,
    deploymentsDir: raw.DEPLOYMENTS_DIR,
    skipContractChecks: raw.SKIP_CONTRACT_CHECKS,
    bootAndWire: raw.BOOT_AND_WIRE,
    inference: {
      gatewayBaseUrl: raw.AI_GATEWAY_BASE_URL,
      gatewayApiKey: raw.AI_GATEWAY_API_KEY,
      models: {
        anthropic: raw.INFERENCE_MODEL_ANTHROPIC,
        openai: raw.INFERENCE_MODEL_OPENAI,
        google: raw.INFERENCE_MODEL_GOOGLE,
      },
    },
    x402: {
      enabled: raw.X402_ENABLED,
      quotePriceUsdc: raw.X402_QUOTE_PRICE_USDC,
      markPriceUsdc: raw.X402_MARK_PRICE_USDC,
      tokenName: raw.X402_TOKEN_NAME,
      tokenVersion: raw.X402_TOKEN_VERSION,
      receiverOverride:
        raw.X402_RECEIVER_OVERRIDE === undefined
          ? null
          : (raw.X402_RECEIVER_OVERRIDE as `0x${string}`),
      internalSecret: raw.VANTA_INTERNAL_SECRET,
    },
  };
}
