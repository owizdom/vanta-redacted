/**
 * Smoke test for the v3 /api/agents + /api/pool/:id/state routes.
 *
 *   pnpm --filter @vanta/runtime smoke:agents
 *
 * Spins up a fastify instance with the fixture registry + fixture
 * pool readers, hits each route via fastify's `inject`, and asserts
 * the response shape. No network listener, no chain, no TEE.
 */

import Fastify from "fastify";

import {
  createFixturePoolReader,
  type PoolReader,
} from "../../services/pool-reader.js";
import {
  createFixtureRegistryReader,
  DEFAULT_FIXTURE_AGENTS,
} from "../../services/agent-registry-reader.js";

import { registerAgentsRoutes } from "./agents.js";

interface AgentsListResponse {
  readonly agents: readonly {
    readonly agent_id: number;
    readonly name: string;
    readonly thesis: string;
    readonly color_hex: string;
  }[];
}

interface PoolStateResponse {
  readonly agent_id: number;
  readonly nav_usdc6: string;
  readonly max_aum_usdc6: string;
  readonly share_price_e18: string;
}

async function main(): Promise<void> {
  const app = Fastify({ logger: false });

  const registry = createFixtureRegistryReader(DEFAULT_FIXTURE_AGENTS);
  const poolReaders = new Map<number, PoolReader>();
  for (const agent of DEFAULT_FIXTURE_AGENTS) {
    poolReaders.set(
      agent.agent_id,
      createFixturePoolReader({
        agent_id: agent.agent_id,
        pool: agent.pool,
        position_book: agent.position_book,
        nav_usdc6: 1_500_000_000n + BigInt(agent.agent_id) * 250_000_000n,
        total_supply: 1_000_000_000n,
        max_aum_usdc6: 10_000_000_000n,
        open_notional_usdc6: 200_000_000n,
        lifetime_cost_basis_usdc6: 800_000_000n,
        lifetime_proceeds_usdc6: 850_000_000n,
      }),
    );
  }

  await registerAgentsRoutes(app, { registry, poolReaders });

  // GET /api/agents
  const listRes = await app.inject({ method: "GET", url: "/api/agents" });
  if (listRes.statusCode !== 200) {
    throw new Error(`expected 200 from /api/agents, got ${String(listRes.statusCode)}`);
  }
  const list = JSON.parse(listRes.body) as AgentsListResponse;
  if (list.agents.length !== DEFAULT_FIXTURE_AGENTS.length) {
    throw new Error(
      `expected ${String(DEFAULT_FIXTURE_AGENTS.length)} agents, got ${String(list.agents.length)}`,
    );
  }
  console.log(`/api/agents → ${String(list.agents.length)} agents`);
  for (const a of list.agents) {
    console.log(`  ${String(a.agent_id)} ${a.name} (${a.color_hex}) — ${a.thesis.slice(0, 60)}…`);
  }

  // GET /api/agents/0
  const detailRes = await app.inject({ method: "GET", url: "/api/agents/0" });
  if (detailRes.statusCode !== 200) {
    throw new Error(`expected 200 from /api/agents/0, got ${String(detailRes.statusCode)}`);
  }
  const detail = JSON.parse(detailRes.body) as Record<string, unknown>;
  if (detail["name"] !== "vanta-zero") {
    throw new Error(`expected name=vanta-zero, got ${String(detail["name"])}`);
  }
  if (typeof detail["island_offset"] !== "object") {
    throw new Error("expected island_offset object on detail");
  }
  console.log(`/api/agents/0 → name=${String(detail["name"])} offset=${JSON.stringify(detail["island_offset"])}`);

  // GET /api/agents/9999 (missing) → 404
  const missingRes = await app.inject({ method: "GET", url: "/api/agents/9999" });
  if (missingRes.statusCode !== 404) {
    throw new Error(`expected 404 for missing agent, got ${String(missingRes.statusCode)}`);
  }
  console.log(`/api/agents/9999 → 404 (missing) OK`);

  // GET /api/pool/0/state
  const poolRes = await app.inject({ method: "GET", url: "/api/pool/0/state" });
  if (poolRes.statusCode !== 200) {
    throw new Error(`expected 200 from /api/pool/0/state, got ${String(poolRes.statusCode)}`);
  }
  const pool = JSON.parse(poolRes.body) as PoolStateResponse;
  if (pool.agent_id !== 0) throw new Error("expected agent_id=0 on pool state");
  if (pool.nav_usdc6 !== "1500000000") {
    throw new Error(`expected nav_usdc6=1500000000, got ${pool.nav_usdc6}`);
  }
  console.log(
    `/api/pool/0/state → nav=${pool.nav_usdc6} max_aum=${pool.max_aum_usdc6} share_price_e18=${pool.share_price_e18}`,
  );

  // bad agentId formats → 400
  const badRes = await app.inject({ method: "GET", url: "/api/pool/-1/state" });
  if (badRes.statusCode !== 400) {
    throw new Error(`expected 400 for malformed agentId, got ${String(badRes.statusCode)}`);
  }
  console.log("/api/pool/-1/state → 400 (malformed) OK");

  await app.close();
  console.log("\nOK");
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
