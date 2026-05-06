/**
 * Kingdom registry — the three v3.0 launch agents and their visual
 * identity. Color is sacred per the spec: opus=purple, gpt=green,
 * gemini=blue. Never mix, never reassign.
 */

export type KingdomKey = "opus" | "gpt" | "gemini";

export interface Kingdom {
  readonly key: KingdomKey;
  readonly agentId: number;
  readonly displayName: string;
  readonly thesis: string;
  readonly color: string;
  readonly glow: string;
  readonly compassDirection: "south" | "northeast" | "northwest";
  readonly biome: "stone" | "grass" | "sand";
  readonly summary: string;
}

export const KINGDOMS: Record<KingdomKey, Kingdom> = {
  opus: {
    key: "opus",
    agentId: 0,
    displayName: "vanta-opus",
    thesis: "macro lending · rates · geopolitics",
    color: "#9b6bff",
    glow: "#c5a8ff",
    compassDirection: "south",
    biome: "stone",
    summary: "Conservative scholar. Long horizons, tight haircuts.",
  },
  gpt: {
    key: "gpt",
    agentId: 1,
    displayName: "vanta-gpt",
    thesis: "sports · culture · event-driven loans",
    color: "#4fae5a",
    glow: "#9ad5a3",
    compassDirection: "northeast",
    biome: "grass",
    summary: "High-frequency underwriter. Short horizons, tactical loans.",
  },
  gemini: {
    key: "gemini",
    agentId: 2,
    displayName: "vanta-gemini",
    thesis: "politics · policy · elections lending",
    color: "#4287f5",
    glow: "#90b6f9",
    compassDirection: "northwest",
    biome: "sand",
    summary: "Politics-savvy underwriter. Policy-shock loans.",
  },
};

export const KINGDOM_LIST: readonly Kingdom[] = [
  KINGDOMS.opus,
  KINGDOMS.gpt,
  KINGDOMS.gemini,
];

/** Map a runtime V3 agent_id → kingdom key. */
export function kingdomForAgentId(agentId: number): Kingdom | null {
  for (const k of KINGDOM_LIST) {
    if (k.agentId === agentId) return k;
  }
  return null;
}
