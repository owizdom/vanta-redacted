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
  // Inference layer — EigenCloud AI Gateway only. Auth is handled by
  // @layr-labs/ai-gateway-provider via TEE attestation: KMS_SERVER_URL +
  // KMS_PUBLIC_KEY are auto-injected when running inside EigenCompute,
  // and the provider exchanges them for short-lived JWTs per call. No
  // bearer tokens, no operator-held keys; billed to the agent's account.
  // Outside EigenCompute (local dev) inference fails closed at request
  // time with `no_credentials`, not at boot.
  INFERENCE_MODEL_ANTHROPIC: z.string().default("anthropic/claude-sonnet-4-6"),
  INFERENCE_MODEL_OPENAI: z.string().default("openai/gpt-5"),
  INFERENCE_MODEL_GOOGLE: z.string().default("google/gemini-2.5-pro"),
  // Eigen Gateway base URL. The provider's default is the dev gateway;
  // we wire it through config so a single env flip overrides per deploy.
  EIGEN_GATEWAY_URL: z
    .string()
    .url()
    .default("https://ai-gateway-dev.eigencloud.xyz"),
  // JWT audience. The upstream `eigen()` singleton hardcodes
  // `'llm-proxy'` (provider/dist/index.js:94). Our deployment hits a
  // crypto/rsa verification error against that audience while the same
  // KMS happily mints externally-verified `vanta.app` JWTs at boot —
  // so we override to `vanta.app` and surface the choice as config.
  INFERENCE_AUDIENCE: z.string().default("vanta.app"),
  // When true, the eigen provider logs request URL + redacted headers +
  // body via console.log. Off by default; flip on for diagnosis.
  INFERENCE_DEBUG: z.coerce.boolean().default(false),
  // Force a static JWT for the gateway (bypasses AttestClient entirely).
  // Diagnostic-only; if set, the provider uses it verbatim.
  INFERENCE_STATIC_JWT: z.string().default(""),
  // Backend selector. `eigen` = KMS-JWT path via @layr-labs/ai-gateway-provider
  // (agent self-funds, billed to its own EigenCompute account). `vercel` =
  // Vercel AI Gateway with operator-held bearer key (operator pays, agent
  // is bounded by the on-chain VendorPayment(Inference) weekly cap). The
  // Eigen gateway has been returning `crypto/rsa: verification error` 401s
  // on every KMS-minted JWT for our sepolia-prod account — reproducible
  // with the official `Layr-Labs/ecloud-inference-example` deployed
  // unmodified — so `vercel` is the default until Eigen ships a fix.
  // The runtime logs the active backend on startup and on every call so
  // the trust story stays explicit about which auth path is live.
  INFERENCE_BACKEND: z.enum(["eigen", "vercel"]).default("vercel"),
  // Vercel AI Gateway endpoint. OpenAI-compatible chat-completions surface
  // at `${baseURL}/v1/chat/completions`; same model slugs as the Eigen path
  // (anthropic/claude-sonnet-4-6, openai/gpt-5, google/gemini-2.5-pro).
  VERCEL_AI_GATEWAY_BASE_URL: z
    .string()
    .url()
    .default("https://ai-gateway.vercel.sh"),
  // Operator bearer key. Only required when INFERENCE_BACKEND=vercel; left
  // empty otherwise so local-dev boots fine without one. The agent's spend
  // is still bounded on chain via VendorPayment(Inference).
  VERCEL_AI_GATEWAY_KEY: z.string().default(""),
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

  // ----- Payouts (paper §7 + §8 — agent self-funds its own bills) -----
  // Three independently-gated buckets; each ships off by default and is
  // flipped on after one verified live disbursement per bucket.
  //
  // Tier 1 (T1) Direct: gas (USDC → ETH via Uniswap V3 multicall) +
  // x402-metered inference (per-call EIP-3009 settlement, lit when the
  // gateway URL points at an x402-aware LLM endpoint).
  // Tier 2 (T2) Contract-mediated: hosting + inference fallback via
  // VendorPayment(Ownable2Step) — caps live on-chain, immutable.
  VANTA_OPERATOR_ADDRESS: z
    .string()
    .regex(ETH_ADDR, "must be a 0x-prefixed 20-byte hex address")
    .optional(),
  PAYOUTS_DRY_RUN: z.coerce.boolean().default(false),

  // Gas (T1)
  PAYOUTS_GAS_ENABLED: z.coerce.boolean().default(false),
  PAYOUTS_GAS_LOW_WEI: z.coerce.bigint().default(5_000_000_000_000_000n),  // 0.005 ETH
  PAYOUTS_GAS_HIGH_WEI: z.coerce.bigint().default(15_000_000_000_000_000n), // 0.015 ETH
  PAYOUTS_GAS_TICK_CAP_USDC6: z.coerce.bigint().default(2_000_000n),       // 2 USDC
  PAYOUTS_GAS_WEEKLY_CAP_USDC6: z.coerce.bigint().default(10_000_000n),    // 10 USDC
  PAYOUTS_GAS_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(10_000).default(100),
  PAYOUTS_GAS_POOL_FEE: z.coerce.number().int().positive().default(500),

  // Hosting (T2)
  PAYOUTS_HOSTING_ENABLED: z.coerce.boolean().default(false),
  PAYOUTS_HOSTING_CONTRACT_ADDRESS: z
    .string()
    .regex(ETH_ADDR, "must be a 0x-prefixed 20-byte hex address")
    .optional(),
  PAYOUTS_HOSTING_WEEKLY_USDC6: z.coerce.bigint().default(55_270_000n),    // $55.27
  PAYOUTS_HOSTING_CONSTITUTIONAL_REF: z.string().default(""),

  // Inference (T2 fallback; T1 active when AI_GATEWAY_BASE_URL is x402-metered)
  PAYOUTS_INFERENCE_ENABLED: z.coerce.boolean().default(false),
  PAYOUTS_INFERENCE_CONTRACT_ADDRESS: z
    .string()
    .regex(ETH_ADDR, "must be a 0x-prefixed 20-byte hex address")
    .optional(),
  PAYOUTS_INFERENCE_WEEKLY_USDC6: z.coerce.bigint().default(10_000_000n),  // $10
  PAYOUTS_INFERENCE_CONSTITUTIONAL_REF: z.string().default(""),
  PAYOUTS_INFERENCE_X402_URL: z.string().default(""),

  // ----- vanta-watchable v0.1 (Minecraft visualizer layer) -----
  // Off by default. When set, registers the `/bridge/*` routes used by
  // the Paper plugin + npc bots. The watchable docker-compose stack
  // expects this on; nothing else does. Adding routes is purely additive
  // (no chain reads, no event-log writes from the bridge surface) so it
  // can stay on safely; default-off is just a defense against operators
  // accidentally exposing the surface in a non-watchable deploy.
  WATCHABLE_ENABLED: z.coerce.boolean().default(false),
});

export interface InferenceModelSlugs {
  readonly anthropic: string;
  readonly openai: string;
  readonly google: string;
}

export type InferenceBackend = "eigen" | "vercel";

export interface InferenceConfig {
  readonly models: InferenceModelSlugs;
  readonly backend: InferenceBackend;
  readonly eigenGatewayUrl: string;
  readonly audience: string;
  readonly debug: boolean;
  readonly staticJwt: string;
  readonly vercelBaseUrl: string;
  readonly vercelApiKey: string;
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

export interface PayoutsGasConfig {
  readonly enabled: boolean;
  readonly dryRun: boolean;
  readonly lowWatermarkWei: bigint;
  readonly highWatermarkWei: bigint;
  readonly tickCapUsdc6: bigint;
  readonly weeklyCapUsdc6: bigint;
  readonly slippageBps: number;
  readonly poolFee: number;
  readonly router: `0x${string}`;
  readonly quoter: `0x${string}`;
  readonly weth: `0x${string}`;
}

export interface PayoutsVendorConfig {
  readonly enabled: boolean;
  readonly dryRun: boolean;
  readonly contractAddress: `0x${string}` | null;
  readonly weeklyCapUsdc6: bigint;
  readonly constitutionalRef: string;
}

export interface PayoutsConfig {
  readonly operatorAddress: `0x${string}` | null;
  readonly gas: PayoutsGasConfig;
  readonly hosting: PayoutsVendorConfig;
  readonly inference: PayoutsVendorConfig;
  readonly inferenceX402Url: string;
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
  readonly payouts: PayoutsConfig;
  readonly watchableEnabled: boolean;
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
      models: {
        anthropic: raw.INFERENCE_MODEL_ANTHROPIC,
        openai: raw.INFERENCE_MODEL_OPENAI,
        google: raw.INFERENCE_MODEL_GOOGLE,
      },
      backend: raw.INFERENCE_BACKEND,
      eigenGatewayUrl: raw.EIGEN_GATEWAY_URL,
      audience: raw.INFERENCE_AUDIENCE,
      debug: raw.INFERENCE_DEBUG,
      staticJwt: raw.INFERENCE_STATIC_JWT,
      vercelBaseUrl: raw.VERCEL_AI_GATEWAY_BASE_URL,
      vercelApiKey: raw.VERCEL_AI_GATEWAY_KEY,
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
    payouts: buildPayoutsConfig(raw),
    watchableEnabled: raw.WATCHABLE_ENABLED,
  };
}

/** Verified Base Sepolia (chainId 84532) Uniswap V3 deployment addresses. */
const UNISWAP_V3_BASE_SEPOLIA = {
  swapRouter02: "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4" as const,
  quoterV2: "0xC5290058841028F1614F3A6F0F5816cAd0df5E27" as const,
  weth9: "0x4200000000000000000000000000000000000006" as const,
} as const;

function buildPayoutsConfig(raw: z.infer<typeof RawConfig>): PayoutsConfig {
  const operatorAddress =
    raw.VANTA_OPERATOR_ADDRESS === undefined
      ? null
      : (raw.VANTA_OPERATOR_ADDRESS as `0x${string}`);
  const dryRun = raw.PAYOUTS_DRY_RUN;

  const gas: PayoutsGasConfig = {
    enabled: raw.PAYOUTS_GAS_ENABLED,
    dryRun,
    lowWatermarkWei: raw.PAYOUTS_GAS_LOW_WEI,
    highWatermarkWei: raw.PAYOUTS_GAS_HIGH_WEI,
    tickCapUsdc6: raw.PAYOUTS_GAS_TICK_CAP_USDC6,
    weeklyCapUsdc6: raw.PAYOUTS_GAS_WEEKLY_CAP_USDC6,
    slippageBps: raw.PAYOUTS_GAS_SLIPPAGE_BPS,
    poolFee: raw.PAYOUTS_GAS_POOL_FEE,
    router: UNISWAP_V3_BASE_SEPOLIA.swapRouter02,
    quoter: UNISWAP_V3_BASE_SEPOLIA.quoterV2,
    weth: UNISWAP_V3_BASE_SEPOLIA.weth9,
  };

  const hosting: PayoutsVendorConfig = {
    enabled: raw.PAYOUTS_HOSTING_ENABLED,
    dryRun,
    contractAddress:
      raw.PAYOUTS_HOSTING_CONTRACT_ADDRESS === undefined
        ? null
        : (raw.PAYOUTS_HOSTING_CONTRACT_ADDRESS as `0x${string}`),
    weeklyCapUsdc6: raw.PAYOUTS_HOSTING_WEEKLY_USDC6,
    constitutionalRef: raw.PAYOUTS_HOSTING_CONSTITUTIONAL_REF,
  };

  const inference: PayoutsVendorConfig = {
    enabled: raw.PAYOUTS_INFERENCE_ENABLED,
    dryRun,
    contractAddress:
      raw.PAYOUTS_INFERENCE_CONTRACT_ADDRESS === undefined
        ? null
        : (raw.PAYOUTS_INFERENCE_CONTRACT_ADDRESS as `0x${string}`),
    weeklyCapUsdc6: raw.PAYOUTS_INFERENCE_WEEKLY_USDC6,
    constitutionalRef: raw.PAYOUTS_INFERENCE_CONSTITUTIONAL_REF,
  };

  // Cross-bucket validation. Fail closed at boot — never half-configured.
  if ((hosting.enabled || inference.enabled) && operatorAddress === null) {
    throw new TeeError(
      "env_not_configured",
      "VANTA_OPERATOR_ADDRESS is required when PAYOUTS_HOSTING_ENABLED or PAYOUTS_INFERENCE_ENABLED is set",
    );
  }
  if (hosting.enabled) {
    if (hosting.contractAddress === null) {
      throw new TeeError(
        "env_not_configured",
        "PAYOUTS_HOSTING_CONTRACT_ADDRESS is required when PAYOUTS_HOSTING_ENABLED=1",
      );
    }
    if (hosting.constitutionalRef.length === 0) {
      throw new TeeError(
        "env_not_configured",
        "PAYOUTS_HOSTING_CONSTITUTIONAL_REF is required when PAYOUTS_HOSTING_ENABLED=1",
      );
    }
  }
  if (inference.enabled) {
    if (inference.contractAddress === null) {
      throw new TeeError(
        "env_not_configured",
        "PAYOUTS_INFERENCE_CONTRACT_ADDRESS is required when PAYOUTS_INFERENCE_ENABLED=1",
      );
    }
    if (inference.constitutionalRef.length === 0) {
      throw new TeeError(
        "env_not_configured",
        "PAYOUTS_INFERENCE_CONSTITUTIONAL_REF is required when PAYOUTS_INFERENCE_ENABLED=1",
      );
    }
  }

  return {
    operatorAddress,
    gas,
    hosting,
    inference,
    inferenceX402Url: raw.PAYOUTS_INFERENCE_X402_URL,
  };
}
