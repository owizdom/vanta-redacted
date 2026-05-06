/**
 * Curated Polymarket markets per kingdom — same content as
 * `scripts/demo/markets.ts`, mirrored client-side so the borrower
 * flow's market dropdown can render without a runtime fetch.
 *
 * Keep this file in sync if `scripts/demo/markets.ts` changes —
 * there is no automation, but the demo only ships against the same
 * 12 markets so drift is unlikely.
 */

export type DemoKingdom = "opus" | "gpt" | "gemini";

export interface DemoMarket {
  readonly conditionIdHex: string;
  readonly tokenId: string;
  readonly side: "YES" | "NO";
  readonly question: string;
  readonly shortName: string;
  readonly currentMid: number;
  readonly timeToResolutionSeconds: number;
  readonly kingdom: DemoKingdom;
}

const DAYS_30 = 30 * 86_400;
const DAYS_60 = 60 * 86_400;
const DAYS_90 = 90 * 86_400;
const DAYS_180 = 180 * 86_400;
const DAYS_365 = 365 * 86_400;

export const DEMO_MARKETS: readonly DemoMarket[] = [
  // ===== gemini — politics =====
  {
    conditionIdHex: "1d519b87999e3d4e90e1e8f57b5eee73a0ba488ff3fdb70867f294733aba84a9",
    tokenId: "26468656392978559668331516709623917078428425933265692717836103090220693717685",
    side: "YES",
    question: "Will Andy Beshear win the 2028 Democratic presidential nomination?",
    shortName: "Beshear-2028",
    currentMid: 0.21,
    timeToResolutionSeconds: DAYS_365,
    kingdom: "gemini",
  },
  {
    conditionIdHex: "4c325469d9b516ef4e6b8f73a81a12607dec075e3c2fd454f91765aaeafc4760",
    tokenId: "91031279171981959197361710127213577102576826515163085396576756946418341946256",
    side: "YES",
    question: "Will Pete Buttigieg win the 2028 Democratic presidential nomination?",
    shortName: "Buttigieg-2028",
    currentMid: 0.13,
    timeToResolutionSeconds: DAYS_365,
    kingdom: "gemini",
  },
  {
    conditionIdHex: "74dba1ce1ae9dd535414e85f2d9ab5ea32c0fb1acc9b7130b67e6d91217e24e1",
    tokenId: "70071592420137476676935286377781779672157004436137616627487590484756055232944",
    side: "YES",
    question: "Will Jon Ossoff win the 2028 Democratic presidential nomination?",
    shortName: "Ossoff-2028",
    currentMid: 0.07,
    timeToResolutionSeconds: DAYS_365,
    kingdom: "gemini",
  },
  {
    conditionIdHex: "9f7e2a3c5d1b4e8a6f0c2d4b6e8a0c2d4f6b8a0c2d4f6e8a0c2d4f6e8a0c2d4f",
    tokenId: "12345678901234567890123456789012345678901234567890123456789012345678",
    side: "YES",
    question: "Will Gavin Newsom win the 2028 Democratic presidential nomination?",
    shortName: "Newsom-2028",
    currentMid: 0.18,
    timeToResolutionSeconds: DAYS_365,
    kingdom: "gemini",
  },
  // ===== gpt — sports / culture =====
  {
    conditionIdHex: "cdb1f0400949238a63d3e88243d2ada08cd9c2a71985ced9f0cfd5e66354cf90",
    tokenId: "94603648636330087039501304492699481091005420017442244191603206509188088089447",
    side: "YES",
    question: "Will USA win the 2026 FIFA World Cup?",
    shortName: "USA-WC2026",
    currentMid: 0.04,
    timeToResolutionSeconds: DAYS_180,
    kingdom: "gpt",
  },
  {
    conditionIdHex: "db4b2f370c3d0e996fbb32213c87aa5402936e3d4882432b6738e2f5661b79a6",
    tokenId: "57880090995762041847706075076337915070476459103836011898392946953962001410644",
    side: "NO",
    question: "Will Curaçao win the 2026 FIFA World Cup?",
    shortName: "Curacao-WC2026",
    currentMid: 0.99,
    timeToResolutionSeconds: DAYS_180,
    kingdom: "gpt",
  },
  {
    conditionIdHex: "0c4cd2055d6ea89354ffddc55d6dbcef9355748112ea952fc925f3db6a5c457f",
    tokenId: "18812649149814341758733697580460697418474693998558159483117100240528657629879",
    side: "YES",
    question: "Will Argentina win the 2026 FIFA World Cup?",
    shortName: "Argentina-WC2026",
    currentMid: 0.16,
    timeToResolutionSeconds: DAYS_180,
    kingdom: "gpt",
  },
  {
    conditionIdHex: "30d55d8124ee1e12dabe89201badc45669b81dff69e4ce44d961f32878ec178a",
    tokenId: "27576533317283401577758999384642760405921738493660383550832555714312627457443",
    side: "YES",
    question: "Will Brazil win the 2026 FIFA World Cup?",
    shortName: "Brazil-WC2026",
    currentMid: 0.20,
    timeToResolutionSeconds: DAYS_180,
    kingdom: "gpt",
  },
  // ===== opus — macro =====
  {
    conditionIdHex: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
    tokenId: "98765432109876543210987654321098765432109876543210987654321098765432",
    side: "YES",
    question: "Will the Fed cut rates by 25bp at the June 2026 FOMC meeting?",
    shortName: "Fed-Cut-Jun26",
    currentMid: 0.42,
    timeToResolutionSeconds: DAYS_30,
    kingdom: "opus",
  },
  {
    conditionIdHex: "b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3",
    tokenId: "11111111111111111111111111111111111111111111111111111111111111111111",
    side: "YES",
    question: "Will Bitcoin close above $200,000 by end of 2026?",
    shortName: "BTC-200k-EOY26",
    currentMid: 0.28,
    timeToResolutionSeconds: DAYS_180,
    kingdom: "opus",
  },
  {
    conditionIdHex: "c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4",
    tokenId: "22222222222222222222222222222222222222222222222222222222222222222222",
    side: "NO",
    question: "Will the ECB cut rates by 50bp in Q3 2026?",
    shortName: "ECB-50bp-Q3",
    currentMid: 0.78,
    timeToResolutionSeconds: DAYS_90,
    kingdom: "opus",
  },
  {
    conditionIdHex: "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5",
    tokenId: "33333333333333333333333333333333333333333333333333333333333333333333",
    side: "YES",
    question: "Will Congress pass federal AI safety legislation in 2026?",
    shortName: "AI-Safety-Bill-26",
    currentMid: 0.31,
    timeToResolutionSeconds: DAYS_180,
    kingdom: "opus",
  },
];

export function kingdomKeyForAgentId(agentId: number): DemoKingdom | null {
  if (agentId === 0) return "opus";
  if (agentId === 1) return "gpt";
  if (agentId === 2) return "gemini";
  return null;
}

export function marketsForAgent(agentId: number): readonly DemoMarket[] {
  const k = kingdomKeyForAgentId(agentId);
  if (k === null) return [];
  return DEMO_MARKETS.filter((m) => m.kingdom === k);
}
