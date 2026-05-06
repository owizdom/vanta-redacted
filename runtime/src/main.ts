/**
 * Top-level entry. Boots TEE, opens the log, signs genesis if needed,
 * brings the HTTP surface up, starts the mark + reasoning loops, then
 * awaits SIGINT/SIGTERM.
 *
 * Single-process binary. Re-entry is not supported; the runtime is
 * designed to be process-restart-able and replay-safe via the on-disk
 * event log.
 *
 * v2 differences vs v1:
 *   - Three continuous reasoning loops (paper §7) — credit, model,
 *     operational — wired around a shared `LoopContext`.
 *   - Onboarding cycle (paper §6) — six-hour scheduler with the gate
 *     floor + agent reasoning above the floor.
 *   - Minecraft watchable layer is OUT of scope (Phase 10 skipped):
 *     no bridge / drill / erc8004 / open / paper / viewer routes.
 */

import { fetchMarket, fetchTrades } from "@vanta/mark";
import { buildAndSign, type VantaEvent } from "@vanta/events";
import { Payouts } from "./services/payouts.js";
import {
  asSha256Hex,
  sign as teeSign,
  type EthAddressHex,
  type Sha256Hex,
} from "@vanta/tee";
import {
  createPublicClient,
  defineChain,
  http,
  type PublicClient,
} from "viem";

import { loadConfig } from "./config.js";
import { bootstrap, type Bootstrap } from "./bootstrap.js";
import { createApp } from "./http/server.js";
import { registerHealthzRoute } from "./http/routes/healthz.js";
import { registerTeeRoute } from "./http/routes/tee.js";
import { registerIdentityRoute } from "./http/routes/identity.js";
import { registerAttestationRoute } from "./http/routes/attestation.js";
import { registerConstitutionRoute } from "./http/routes/constitution.js";
import { registerEventsRoutes } from "./http/routes/events.js";
import { registerAdminDemoRoutes } from "./http/routes/admin-demo.js";
import { registerOriginationRoute } from "./http/routes/origination.js";
import { registerSettleRoute } from "./http/routes/settle.js";
import { registerHealthRoute } from "./http/routes/health.js";
import { registerMarketsRoutes } from "./http/routes/markets.js";
import { registerServiceRoutes } from "./http/routes/services.js";
import { registerStateRoute } from "./http/routes/state.js";
import { registerDevProbeRoute } from "./http/routes/dev-probe.js";
import { registerBridgeRoutes } from "./http/routes/bridge.js";
import { registerAgentsRoutes } from "./http/routes/agents.js";
import {
  createFixtureRegistryReader,
  DEFAULT_FIXTURE_AGENTS,
} from "./services/agent-registry-reader.js";
import {
  createFixturePoolReader,
  type PoolReader,
} from "./services/pool-reader.js";
import { createFleetHost, type FleetHost } from "./services/fleet-host.js";
import {
  adaptInferenceClient,
  type CouncilInferenceFn,
} from "./services/npc-council.js";
import { createCreditObserver } from "./services/credit-observer.js";
import { createExposureReader } from "./services/exposure-reader.js";
import { createMarkLoop } from "./services/mark-loop.js";
import {
  createOperationalReader,
  type OperationalReader,
} from "./services/operational-snapshot.js";
import { createReplayDataset } from "./services/replay-dataset.js";
import { installX402Hook, type X402RouteConfig } from "./services/x402.js";

import { createCreditLoop, type ActiveLoanView } from "./loops/credit.js";
import { createModelLoop } from "./loops/model.js";
import {
  createOperationalLoop,
  type OperationalSnapshot,
} from "./loops/operational.js";
import { createOnboardingLoop, createGatewayJudge, type JudgeFn } from "./onboarding/index.js";
import type { CandidateInputs } from "./onboarding/types.js";
import { buildCandidateBatch } from "./services/candidate-feed.js";
import type { EventSink, LoopContext, ReasoningLoop } from "./loops/types.js";

// Mirrors @vanta/treasury constants (not imported to avoid bumping
// runtime/package.json + lockfile during this slice).
const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const CHAIN_ID = 84532 as const;

// -----------------------------------------------------------------------
// EventSink — wraps the FileEventLog with the canonical buildAndSign
// pipeline so loop events reach the on-disk chain with real signatures
// and the verifier can walk them back to genesis.
// -----------------------------------------------------------------------

function createSignedEventSink(boot: Bootstrap): EventSink {
  return {
    async emit({ type, body, parentIds }) {
      const parents = parentIds.length === 0 ? [boot.genesis.id] : parentIds;
      const event = buildAndSign({
        type: type as VantaEvent["type"],
        parent_ids: parents,
        lineage: "vanta-runtime",
        timestamp: Math.floor(Date.now() / 1000),
        epoch: Math.floor(boot.tee.bootedAt / 1000),
        tee: {
          signingPubKey: boot.tee.signingPubKey,
          kmsKeyHash: boot.genesis.tee.kmsKeyHash,
          tdxQuoteHash: null,
          attestationJwtHash: boot.genesis.tee.attestationJwtHash,
        },
        instance: boot.genesis.instance,
        body: body as VantaEvent["body"],
        sign: teeSign,
      });
      await boot.log.append(event);
      return event.id;
    },
  };
}

// -----------------------------------------------------------------------
// Loop wiring helpers — turn the bootstrap struct into the per-loop
// dependencies. Keep these small and explicit.
// -----------------------------------------------------------------------

function buildLoopContext(boot: Bootstrap, amoy: PublicClient): LoopContext {
  return {
    base: boot.publicClient,
    amoy,
    events: createSignedEventSink(boot),
    clock: { nowMs: () => Date.now() },
    genesisId: boot.genesis.id,
  };
}

function listActiveLoansForCreditLoop(
  boot: Bootstrap,
): () => Promise<readonly ActiveLoanView[]> {
  return async () => {
    const out: ActiveLoanView[] = [];
    for (const loan of boot.loanRegistry.list()) {
      out.push({
        loan_id: loan.loanId,
        principal_usdc: loan.principal.toString(),
        notional_tokens: loan.notional.toString(),
        maturity_ts_ms: loan.maturityTsUnix * 1000,
        condition_id: loan.conditionId,
        token_id: loan.tokenId,
        origination_event_id: loan.originationEventId,
        originated_haircut_bps: loan.haircutBps,
      });
    }
    return out;
  };
}

async function stubOperationalSnapshot(): Promise<OperationalSnapshot> {
  // Retained only for the smoke entrypoint / unit tests. Production
  // wiring uses createOperationalReader (real chain reads). See main()
  // below for the live binding.
  return {
    treasury_balance_usdc: "1000000000000",
    weekly_spend_usdc: "5000000000",
    base_gas_gwei: 0.05,
    amoy_gas_gwei: 30,
    base_gas_p95_gwei: 0.2,
    amoy_gas_p95_gwei: 60,
    inference_cost_per_1k_usdc: 0.003,
    inference_cost_baseline_usdc: 0.003,
    oracle_read_failures: 0,
    rpc_healthy_pct: 100,
    admin_native_wei: (10n ** 17n).toString(), // 0.1 ETH
    treasury_native_wei: (10n ** 16n).toString(), // 0.01 ETH
  };
}

async function emptyCandidates(): Promise<readonly CandidateInputs[]> {
  return [];
}

interface DemoPoolOverride {
  readonly nav_usdc6: bigint;
  readonly total_supply: bigint;
  readonly max_aum_usdc6: bigint;
  readonly open_notional_usdc6: bigint;
  readonly lifetime_cost_basis_usdc6: bigint;
  readonly lifetime_proceeds_usdc6: bigint;
}

/**
 * Demo seed integration. If `VANTA_DEMO_POOLS_PATH` is set, read the
 * JSON file and parse out per-agent fixture pool overrides. Used by
 * the 10-min demo orchestrator to render lived-in TVL + interest
 * accrued before the runtime even ticks. Returns an empty map when
 * the env var is absent or the file is missing/malformed (silent —
 * production never hits this path).
 */
function loadDemoPoolOverrides(): Map<number, DemoPoolOverride> {
  const path = process.env["VANTA_DEMO_POOLS_PATH"];
  if (typeof path !== "string" || path.length === 0) return new Map();
  try {
    // Local imports to keep startup unaffected when env is absent.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    if (!fs.existsSync(path)) return new Map();
    const raw = fs.readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as {
      pools?: ReadonlyArray<{
        agent_id?: number;
        nav_usdc6?: string;
        total_supply?: string;
        max_aum_usdc6?: string;
        open_notional_usdc6?: string;
        lifetime_cost_basis_usdc6?: string;
        lifetime_proceeds_usdc6?: string;
      }>;
    };
    const out = new Map<number, DemoPoolOverride>();
    for (const p of parsed.pools ?? []) {
      if (typeof p.agent_id !== "number") continue;
      try {
        out.set(p.agent_id, {
          nav_usdc6: BigInt(p.nav_usdc6 ?? "0"),
          total_supply: BigInt(p.total_supply ?? "0"),
          max_aum_usdc6: BigInt(p.max_aum_usdc6 ?? "0"),
          open_notional_usdc6: BigInt(p.open_notional_usdc6 ?? "0"),
          lifetime_cost_basis_usdc6: BigInt(p.lifetime_cost_basis_usdc6 ?? "0"),
          lifetime_proceeds_usdc6: BigInt(p.lifetime_proceeds_usdc6 ?? "0"),
        });
      } catch {
        // Skip malformed entries; rest still load.
      }
    }
    return out;
  } catch {
    return new Map();
  }
}

// -----------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------

async function startMain(): Promise<void> {
  const config = loadConfig();
  const boot = await bootstrap(config);

  const polygonAmoyLocal = defineChain({
    id: 80002,
    name: "polygon-amoy-local",
    nativeCurrency: { decimals: 18, name: "MATIC", symbol: "MATIC" },
    rpcUrls: { default: { http: [config.amoyRpcUrl] } },
  });
  const amoyClient = createPublicClient({
    chain: polygonAmoyLocal,
    transport: http(config.amoyRpcUrl),
  });

  const app = createApp({ config, bootstrap: boot });
  await registerHealthzRoute(app);
  await registerTeeRoute(app);
  await registerIdentityRoute(app);
  await registerAttestationRoute(app);
  await registerConstitutionRoute(app);
  await registerEventsRoutes(app);
  await registerAdminDemoRoutes(app, createSignedEventSink(boot));
  await registerOriginationRoute(app);
  await registerSettleRoute(app);
  await registerMarketsRoutes(app, { marketsCache: boot.marketsCache });
  await registerHealthRoute(app, { bootstrap: boot });
  await registerDevProbeRoute(app);

  // v3 multi-VANTA marketplace surface. The fixture reader seeds three
  // islands so the marketplace UI renders before any on-chain
  // registration happens; viem-backed readers replace this when the
  // AgentRegistry is deployed and `V3_REGISTRY_ADDRESS` is set in env.
  //
  // Demo override: if `VANTA_DEMO_POOLS_PATH` points at a JSON file with
  // `{pools: [{agent_id, nav_usdc6, ...}, ...]}`, we replace the zero
  // defaults with those values per agent. Used by `scripts/demo/seed-onchain.ts`
  // so the demo's marketplace + agent detail card render lived-in TVL.
  const v3Registry = createFixtureRegistryReader(DEFAULT_FIXTURE_AGENTS);
  const demoPools = loadDemoPoolOverrides();
  const v3PoolReaders = new Map<number, PoolReader>();
  for (const agent of DEFAULT_FIXTURE_AGENTS) {
    const override = demoPools.get(agent.agent_id);
    v3PoolReaders.set(
      agent.agent_id,
      createFixturePoolReader({
        agent_id: agent.agent_id,
        pool: agent.pool,
        position_book: agent.position_book,
        nav_usdc6: override?.nav_usdc6 ?? 0n,
        total_supply: override?.total_supply ?? 0n,
        max_aum_usdc6: override?.max_aum_usdc6 ?? 10_000_000_000n,
        open_notional_usdc6: override?.open_notional_usdc6 ?? 0n,
        lifetime_cost_basis_usdc6: override?.lifetime_cost_basis_usdc6 ?? 0n,
        lifetime_proceeds_usdc6: override?.lifetime_proceeds_usdc6 ?? 0n,
      }),
    );
  }
  if (demoPools.size > 0) {
    app.log.info(
      { agents: Array.from(demoPools.keys()) },
      "demo_pool_overrides_loaded",
    );
  }
  await registerAgentsRoutes(app, {
    registry: v3Registry,
    poolReaders: v3PoolReaders,
  });
  if (config.watchableEnabled) {
    await registerBridgeRoutes(app);
    app.log.info("watchable: bridge routes registered (WATCHABLE_ENABLED=1)");
  }

  const quotePriceUsdc6 = BigInt(Math.round(config.x402.quotePriceUsdc * 1_000_000));
  const markPriceUsdc6 = BigInt(Math.round(config.x402.markPriceUsdc * 1_000_000));
  // Paths must match the routes registered in `services.ts` for the
  // x402 hook (which inspects `req.routerPath`) to pick them up.
  const meteredRoutes: X402RouteConfig[] = [
    {
      path: "/bridge/wizard/quote",
      method: "POST",
      priceUsdc6: quotePriceUsdc6,
      description:
        "VANTA quote — signed haircut + max-loan for a Polymarket position",
    },
    {
      path: "/mark/:market_id",
      method: "GET",
      priceUsdc6: markPriceUsdc6,
      description: "VANTA mark — signed Polymarket TWAP read for a market",
    },
  ];
  const x402Receiver = (config.x402.receiverOverride ?? boot.treasury.address) as `0x${string}`;
  installX402Hook(app, {
    enabled: config.x402.enabled,
    routes: meteredRoutes,
    receiver: x402Receiver,
    usdcAddress: USDC_BASE_SEPOLIA as `0x${string}`,
    network: "base-sepolia",
    chainId: CHAIN_ID,
    tokenName: config.x402.tokenName,
    tokenVersion: config.x402.tokenVersion,
    walletClient: boot.walletClient,
    publicClient: boot.publicClient,
    internalSecret:
      config.x402.internalSecret.length === 0 ? null : config.x402.internalSecret,
    onSettled: async (info) => {
      try {
        const txHashHex: Sha256Hex = asSha256Hex(
          info.txHash.replace(/^0x/, "").toLowerCase(),
        );
        const event = buildAndSign({
          type: "treasury.inflow",
          parent_ids: [boot.genesis.id],
          lineage: "vanta-runtime",
          timestamp: Math.floor(Date.now() / 1000),
          epoch: Math.floor(boot.tee.bootedAt / 1000),
          tee: {
            signingPubKey: boot.tee.signingPubKey,
            kmsKeyHash: boot.genesis.tee.kmsKeyHash,
            tdxQuoteHash: null,
            attestationJwtHash: boot.genesis.tee.attestationJwtHash,
          },
          instance: boot.genesis.instance,
          body: {
            txHash: txHashHex,
            chainId: CHAIN_ID,
            asset: USDC_BASE_SEPOLIA,
            amount: info.amountUsdc6.toString(),
            fromAddr: info.payer as EthAddressHex,
            toAddr: info.receiver as EthAddressHex,
            blockNumber: info.blockNumber,
          },
          sign: teeSign,
        });
        await boot.log.append(event);
      } catch (err) {
        app.log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "x402_inflow_emit_failed",
        );
      }
    },
  });

  await registerServiceRoutes(app, {
    priceConfig: meteredRoutes,
    receiver: x402Receiver,
    usdcAddress: USDC_BASE_SEPOLIA,
    network: "base-sepolia",
    metered: config.x402.enabled,
  });

  // ----- Three continuous reasoning loops (paper §7) ---------------------
  // Construct the loops BEFORE app.listen so we can bind their refs
  // into the state route registration; loops are start()-ed later so
  // ticks only fire once the HTTP surface is alive.
  const ctx: LoopContext = buildLoopContext(boot, amoyClient);

  const creditLoop = createCreditLoop({
    ctx,
    listActiveLoans: listActiveLoansForCreditLoop(boot),
    observe: createCreditObserver({ marketsCache: boot.marketsCache }),
    tickSeconds: 60,
  });
  const modelLoop = createModelLoop({
    ctx,
    fetchDataset: createReplayDataset({ eventsStore: boot.log }),
    tickSeconds: 7 * 24 * 60 * 60,
  });
  // Real operational snapshot — reads treasury USDC, native balances,
  // and live gas prices from chain. Replaces the stub. See
  // services/operational-snapshot.ts for the (honest) cost calibration.
  const operationalReader: OperationalReader = createOperationalReader({
    treasuryAddress: boot.treasury.address,
    adminAddress: boot.origination.address,
    baseRpcUrl: config.loanBookRpcUrl,
    amoyRpcUrl: config.amoyRpcUrl,
  });
  // Payouts orchestrator — gas refill (T1) + hosting/inference (T2) on
  // the operational tick. Each bucket gates on its own *_ENABLED flag;
  // default off so a misconfigured deploy is safe.
  const payouts = new Payouts({
    bootstrap: boot,
    config: config.payouts,
    usdcAddress: USDC_BASE_SEPOLIA,
  });
  const operationalLoop = createOperationalLoop({
    ctx,
    observe: async () => {
      const snap = await operationalReader.snapshot();
      // Best-effort — per-bucket failures emit a trace and never block
      // the snapshot return (the loop's own anomaly detection still
      // fires on stale snapshots).
      try {
        await payouts.runTick();
      } catch (err) {
        app.log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "payouts_tick_failed",
        );
      }
      return snap;
    },
    tickSeconds: 60 * 60,
  });

  // ----- Onboarding cycle (paper §6) -------------------------------------
  // Real Polymarket questions go through the LLM judge → resolution-
  // criteria clarity score → gate floor + agent reasoning → signed
  // `loop.onboard_decision` + sibling `reasoning.trace`. The gateway
  // judge is wired iff KMS_SERVER_URL + KMS_PUBLIC_KEY are set (the
  // EigenCompute attestation env), since `@layr-labs/ai-gateway-provider`
  // needs them to mint per-call JWTs. Outside the TEE the deterministic
  // stub keeps the loop honest in offline mode.
  const eigenAuthReady =
    typeof process.env["KMS_SERVER_URL"] === "string" &&
    process.env["KMS_SERVER_URL"].length > 0 &&
    typeof process.env["KMS_PUBLIC_KEY"] === "string" &&
    process.env["KMS_PUBLIC_KEY"].length > 0;
  const judge: JudgeFn | undefined =
    eigenAuthReady
      ? createGatewayJudge({
          call: async (req) => {
            // Spread the optional fields only when present —
            // exactOptionalPropertyTypes rejects T | undefined where the
            // target type asks for T or absence.
            const r = await boot.inference.call({
              role: req.role,
              messages: req.messages,
              ...(req.system !== undefined ? { system: req.system } : {}),
              ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
              ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
            });
            return { text: r.text, model: r.model, latencyMs: r.latencyMs };
          },
        })
      : undefined;
  if (judge !== undefined) {
    app.log.info("onboarding: using gateway-backed LLM judge");
  } else {
    app.log.info("onboarding: AI gateway unset, using deterministic stub judge");
  }

  const fetchCandidates = (): Promise<readonly CandidateInputs[]> =>
    Promise.resolve(buildCandidateBatch(boot.marketsCache, 3));

  // Empty fetcher fallback used only by the unit-tested smoke entrypoint.
  void emptyCandidates;

  const onboardingLoop = createOnboardingLoop({
    ctx,
    fetchCandidates,
    fetchExposure: createExposureReader({
      loanRegistry: boot.loanRegistry,
      marketsCache: boot.marketsCache,
    }),
    // Only attach the judge when present (exactOptionalPropertyTypes).
    ...(judge !== undefined ? { judge } : {}),
    tickSeconds: 6 * 60 * 60,
  });

  // State aggregator route (must register before listen so fastify is
  // still mutable; route closure binds the live loop refs).
  await registerStateRoute(app, {
    marketsCache: boot.marketsCache,
    loanRegistry: boot.loanRegistry,
    log: boot.log,
    operationalReader,
    loops: {
      credit: creditLoop,
      model: modelLoop,
      operational: operationalLoop,
      onboarding: onboardingLoop,
    },
  });

  // Warm the operational reader with one snapshot before the loop's
  // first hourly tick — so /api/state's runway_days is real on the
  // first poll instead of returning null until the loop catches up.
  void operationalReader.snapshot().catch(() => {
    /* RPC may be transient; loop will retry */
  });

  await app.listen({ port: config.port, host: config.host });
  console.log(
    `VANTA alive on http://${config.host}:${String(config.port)} (origination=${boot.origination.address})`,
  );

  // ----- Mark loop. One @vanta/mark.createMarkPoller per active loan. -----
  const markLoop = createMarkLoop({
    bootstrap: boot,
    registry: boot.loanRegistry,
    fetchTrades,
    fetchMarket,
    tickSeconds: config.markTickSeconds,
  });
  markLoop.start();

  boot.agentState.start();
  boot.marketsCache.start();

  const reasoningLoops: readonly ReasoningLoop[] = [
    creditLoop,
    modelLoop,
    operationalLoop,
    onboardingLoop,
  ];
  for (const loop of reasoningLoops) {
    loop.start();
    app.log.info({ loop: loop.name }, "reasoning_loop_started");
  }

  // ----- Fleet host: per-VANTA lender credit loop with NPC council ------
  // For each registered VANTA, spawn its own credit loop (lender mode)
  // with an NPC council deliberating each tick. agent_id=0 is the
  // "VANTA-zero" agent — we let the existing v2 creditLoop handle its
  // boot.loanRegistry, so the fleet host's loansFor(0) returns []
  // (avoids duplicate ticks). Per-agent registries land in v3.5 prod
  // wiring; until then, agents 1+ also produce empty loan lists.
  const fleetCouncilInferenceFor = (
    agentId: number,
  ): CouncilInferenceFn | null => {
    return adaptInferenceClient({
      client: boot.inference,
      defaultParentId: boot.genesis.id,
      npcBotHandle: `vanta-${String(agentId)}-npc`,
    });
  };
  const fleetObserve = createCreditObserver({ marketsCache: boot.marketsCache });
  const fleetHost: FleetHost = createFleetHost({
    registry: v3Registry,
    ctx,
    loansFor: async () => [],
    observeFor: (_agentId, loan) => fleetObserve(loan),
    councilInferenceFor: fleetCouncilInferenceFor,
    tickSeconds: 60,
  });
  await fleetHost.start();
  for (const { agent_id } of fleetHost.loops()) {
    app.log.info(
      { fleet_loop: `credit-${String(agent_id)}` },
      "fleet_loop_started",
    );
  }

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`vanta/runtime: received ${signal}, draining…`);
    try {
      boot.agentState.stop();
      boot.marketsCache.stop();
      await Promise.all(reasoningLoops.map((l) => l.stop()));
      await fleetHost.stop();
      await markLoop.stop();
      await app.close();
    } catch (err: unknown) {
      console.error("vanta/runtime: shutdown error", err);
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

startMain().catch((err: unknown) => {
  console.error("vanta/runtime: boot failed", err);
  process.exit(1);
});
