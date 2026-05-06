/**
 * Read-only adapter for the AgentRegistry contract (v3 multi-VANTA).
 *
 * The runtime is a *fleet host* in v3: at boot it reads the
 * AgentRegistry, materialises one trading loop per registered VANTA,
 * and serves the marketplace surface from this registry view.
 *
 * Two implementations live behind the same interface:
 *
 *   - `createFixtureRegistryReader` — in-memory list, useful for
 *     local-dev and tests when no chain is available. Lets the
 *     marketplace UI render a 3-island layout without anvil.
 *   - `createViemRegistryReader` — real on-chain reader, calls
 *     `AgentRegistry.count()` + `agentOf(i)` via viem. Wired to the
 *     LoopContext.base client (the registry deploys on Base Sepolia /
 *     Base mainnet — same chain as v2's LpVault).
 *
 * Either way the runtime's HTTP routes (`/api/agents/*`) consume the
 * `AgentSummary` / `AgentRecord` shape produced by this adapter, and
 * the fleet-host startup wiring resolves each registered VANTA's
 * `(pool, positionBook, opCap)` triple from it.
 */

import type { Address, PublicClient } from "viem";

export interface AgentSummary {
  readonly agent_id: number;
  readonly name: string;
  readonly thesis: string;
  readonly color_rgb: number; // 0xRRGGBB packed
  readonly pool: Address;
  readonly position_book: Address;
  readonly op_cap: Address;
  readonly operator: Address;
  readonly registered_at_unix: number;
  readonly paused: boolean;
}

export interface AgentRecord extends AgentSummary {
  readonly image_digest: `0x${string}`;
  readonly attestation_hash: `0x${string}`;
  /** Deterministic Minecraft offset from `AgentRegistry.islandOffsetOf`. */
  readonly island_offset: { readonly x: number; readonly z: number };
}

export interface AgentRegistryReader {
  readonly listAgents: () => Promise<readonly AgentSummary[]>;
  readonly getAgent: (agentId: number) => Promise<AgentRecord | null>;
}

// ----------------------- fixture reader ----------------------------

export interface FixtureAgent extends AgentRecord {}

export function createFixtureRegistryReader(
  agents: readonly FixtureAgent[],
): AgentRegistryReader {
  const byId = new Map<number, FixtureAgent>();
  for (const a of agents) byId.set(a.agent_id, a);

  return {
    listAgents: async () => Promise.resolve([...agents]),
    getAgent: async (agentId) => Promise.resolve(byId.get(agentId) ?? null),
  };
}

/**
 * The seed fixture every local-dev runtime ships with: VANTA-zero
 * (the original Claude-thesis agent) at the world origin. Two more
 * islands seeded so the marketplace UI renders something interesting
 * before any real registration happens.
 */
export const DEFAULT_FIXTURE_AGENTS: readonly FixtureAgent[] = [
  {
    agent_id: 0,
    name: "vanta-opus",
    thesis:
      "Anthropic Claude Opus thesis — macro / Fed / geopolitics markets where mid mispricing reflects retail attention bias.",
    color_rgb: 0x9b6bff,
    pool: "0x0000000000000000000000000000000000000001",
    position_book: "0x0000000000000000000000000000000000000002",
    op_cap: "0x0000000000000000000000000000000000000003",
    operator: "0x0000000000000000000000000000000000000004",
    registered_at_unix: Math.floor(Date.UTC(2026, 4, 5) / 1000),
    paused: false,
    image_digest:
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    attestation_hash:
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    island_offset: { x: 0, z: 0 },
  },
  {
    agent_id: 1,
    name: "vanta-gpt",
    thesis:
      "OpenAI GPT-5 thesis — sport / weather / earnings markets where structured priors and short-horizon momentum dominate.",
    color_rgb: 0x4fae5a,
    pool: "0x0000000000000000000000000000000000000005",
    position_book: "0x0000000000000000000000000000000000000006",
    op_cap: "0x0000000000000000000000000000000000000007",
    operator: "0x0000000000000000000000000000000000000008",
    registered_at_unix: Math.floor(Date.UTC(2026, 4, 5) / 1000),
    paused: false,
    image_digest:
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    attestation_hash:
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    island_offset: { x: 0, z: -220 },
  },
  {
    agent_id: 2,
    name: "vanta-gemini",
    thesis:
      "Google Gemini 2.5 Pro thesis — long-horizon technology + AI markets where slow-moving consensus drifts away from actual progress.",
    color_rgb: 0x4287f5,
    pool: "0x0000000000000000000000000000000000000009",
    position_book: "0x000000000000000000000000000000000000000a",
    op_cap: "0x000000000000000000000000000000000000000b",
    operator: "0x000000000000000000000000000000000000000c",
    registered_at_unix: Math.floor(Date.UTC(2026, 4, 5) / 1000),
    paused: false,
    image_digest:
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    attestation_hash:
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    island_offset: { x: 155, z: -155 },
  },
];

// ----------------------- viem reader -------------------------------

const REGISTRY_ABI = [
  {
    type: "function",
    name: "count",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "agentOf",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "agentId", type: "uint256" },
          { name: "name", type: "string" },
          { name: "thesis", type: "string" },
          { name: "imageDigest", type: "bytes32" },
          { name: "colorRgb", type: "uint24" },
          { name: "pool", type: "address" },
          { name: "positionBook", type: "address" },
          { name: "opCap", type: "address" },
          { name: "operator", type: "address" },
          { name: "attestationHash", type: "bytes32" },
          { name: "registeredAt", type: "uint64" },
          { name: "paused", type: "bool" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "islandOffsetOf",
    stateMutability: "pure",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [
      { type: "int32" },
      { type: "int32" },
    ],
  },
] as const;

interface ViemRegistryReaderArgs {
  readonly client: PublicClient;
  readonly registry: Address;
}

interface OnChainAgentTuple {
  readonly agentId: bigint;
  readonly name: string;
  readonly thesis: string;
  readonly imageDigest: `0x${string}`;
  readonly colorRgb: number;
  readonly pool: Address;
  readonly positionBook: Address;
  readonly opCap: Address;
  readonly operator: Address;
  readonly attestationHash: `0x${string}`;
  readonly registeredAt: bigint;
  readonly paused: boolean;
}

function tupleToRecord(t: OnChainAgentTuple, offset: readonly [number, number]): AgentRecord {
  return {
    agent_id: Number(t.agentId),
    name: t.name,
    thesis: t.thesis,
    color_rgb: t.colorRgb,
    pool: t.pool,
    position_book: t.positionBook,
    op_cap: t.opCap,
    operator: t.operator,
    registered_at_unix: Number(t.registeredAt),
    paused: t.paused,
    image_digest: t.imageDigest,
    attestation_hash: t.attestationHash,
    island_offset: { x: offset[0], z: offset[1] },
  };
}

export function createViemRegistryReader(
  args: ViemRegistryReaderArgs,
): AgentRegistryReader {
  const listAgents = async (): Promise<readonly AgentSummary[]> => {
    const count = (await args.client.readContract({
      address: args.registry,
      abi: REGISTRY_ABI,
      functionName: "count",
    })) as bigint;
    const total = Number(count);
    const rows: AgentSummary[] = [];
    for (let i = 0; i < total; ++i) {
      const tuple = (await args.client.readContract({
        address: args.registry,
        abi: REGISTRY_ABI,
        functionName: "agentOf",
        args: [BigInt(i)],
      })) as OnChainAgentTuple;
      const offset = (await args.client.readContract({
        address: args.registry,
        abi: REGISTRY_ABI,
        functionName: "islandOffsetOf",
        args: [BigInt(i)],
      })) as readonly [number, number];
      rows.push(tupleToRecord(tuple, offset));
    }
    return rows;
  };

  const getAgent = async (agentId: number): Promise<AgentRecord | null> => {
    const count = (await args.client.readContract({
      address: args.registry,
      abi: REGISTRY_ABI,
      functionName: "count",
    })) as bigint;
    if (BigInt(agentId) >= count) return null;
    const tuple = (await args.client.readContract({
      address: args.registry,
      abi: REGISTRY_ABI,
      functionName: "agentOf",
      args: [BigInt(agentId)],
    })) as OnChainAgentTuple;
    const offset = (await args.client.readContract({
      address: args.registry,
      abi: REGISTRY_ABI,
      functionName: "islandOffsetOf",
      args: [BigInt(agentId)],
    })) as readonly [number, number];
    return tupleToRecord(tuple, offset);
  };

  return { listAgents, getAgent };
}
