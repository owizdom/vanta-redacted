/**
 * Agents routes — multi-VANTA marketplace surface.
 *
 *   GET /api/agents                  → array of registered agents (summary)
 *   GET /api/agents/:agentId         → single agent (full record)
 *   GET /api/pool/:agentId/state     → that agent's pool state (NAV, AUM,
 *                                      share price, lifetime PnL)
 *
 * Read-only. Backed by AgentRegistryReader + PoolReader. The web
 * marketplace renders /api/agents as a grid of island cards;
 * /api/pool/:id/state is what each card pulls for its AUM + PnL
 * line.
 *
 * The fleet-host wiring at boot stamps a `PoolReader` into the
 * `poolReaders` map for every registered agent. Agents added after
 * boot need a runtime restart to surface their pool state. v3.1
 * may add a hot-resolve path (lookup by agentId, build a viem
 * reader on demand).
 */

import type { FastifyInstance } from "fastify";

import type { AgentRecord, AgentRegistryReader, AgentSummary } from "../../services/agent-registry-reader.js";
import type { PoolReader, PoolState } from "../../services/pool-reader.js";

export interface RegisterAgentsOpts {
  readonly registry: AgentRegistryReader;
  /** Per-agent pool reader, keyed by agent_id. */
  readonly poolReaders: ReadonlyMap<number, PoolReader>;
}

export async function registerAgentsRoutes(
  app: FastifyInstance,
  opts: RegisterAgentsOpts,
): Promise<void> {
  app.get("/api/agents", async () => {
    const agents = await opts.registry.listAgents();
    return { agents: agents.map(serializeSummary) };
  });

  app.get<{ Params: { agentId: string } }>(
    "/api/agents/:agentId",
    async (req, reply) => {
      const agentId = parseAgentId(req.params.agentId);
      if (agentId === null) {
        reply.code(400);
        return { error: "agent_id_invalid", agentId: req.params.agentId };
      }
      const agent = await opts.registry.getAgent(agentId);
      if (agent === null) {
        reply.code(404);
        return { error: "agent_not_found", agentId };
      }
      return serializeRecord(agent);
    },
  );

  app.get<{ Params: { agentId: string } }>(
    "/api/pool/:agentId/state",
    async (req, reply) => {
      const agentId = parseAgentId(req.params.agentId);
      if (agentId === null) {
        reply.code(400);
        return { error: "agent_id_invalid", agentId: req.params.agentId };
      }
      const reader = opts.poolReaders.get(agentId);
      if (reader === undefined) {
        reply.code(404);
        return { error: "pool_reader_not_wired", agentId };
      }
      const state = await reader.read();
      return serializePoolState(state);
    },
  );

  app.log.info({
    msg: "agents routes registered",
    poolReaderCount: opts.poolReaders.size,
  });
}

function parseAgentId(s: string): number | null {
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function serializeSummary(a: AgentSummary): Record<string, unknown> {
  return {
    agent_id: a.agent_id,
    name: a.name,
    thesis: a.thesis,
    color_rgb: a.color_rgb,
    color_hex: rgbToHex(a.color_rgb),
    pool: a.pool,
    position_book: a.position_book,
    op_cap: a.op_cap,
    operator: a.operator,
    registered_at_unix: a.registered_at_unix,
    paused: a.paused,
    /**
     * `shared-pool-v1` → three TEE-resident underwriting personas
     * routed at one shared LpVault + LoanBook (`pool` is the shared
     * mainnet LpVault; `position_book` / `op_cap` / `operator` are
     * null because those per-agent contracts aren't deployed yet —
     * AgentFactory.deploy() path is on the roadmap).
     * `per-agent-v2` → AgentRegistry source of truth, every per-agent
     * contract has its own deployed address.
     */
    infra_mode: a.infra_mode,
  };
}

function serializeRecord(a: AgentRecord): Record<string, unknown> {
  return {
    ...serializeSummary(a),
    image_digest: a.image_digest,
    attestation_hash: a.attestation_hash,
    island_offset: a.island_offset,
  };
}

function serializePoolState(s: PoolState): Record<string, unknown> {
  const realisedPnl =
    s.lifetime_proceeds_usdc6 >= s.lifetime_cost_basis_usdc6
      ? (s.lifetime_proceeds_usdc6 - s.lifetime_cost_basis_usdc6).toString()
      : `-${(s.lifetime_cost_basis_usdc6 - s.lifetime_proceeds_usdc6).toString()}`;
  return {
    agent_id: s.agent_id,
    pool: s.pool,
    position_book: s.position_book,
    nav_usdc6: s.nav_usdc6.toString(),
    total_supply: s.total_supply.toString(),
    share_price_e18: s.share_price_e18.toString(),
    max_aum_usdc6: s.max_aum_usdc6.toString(),
    free_usdc6: s.free_usdc6.toString(),
    open_notional_usdc6: s.open_notional_usdc6.toString(),
    lifetime_cost_basis_usdc6: s.lifetime_cost_basis_usdc6.toString(),
    lifetime_proceeds_usdc6: s.lifetime_proceeds_usdc6.toString(),
    realised_pnl_usdc6: realisedPnl,
  };
}

function rgbToHex(rgb: number): string {
  return `#${rgb.toString(16).padStart(6, "0")}`;
}
