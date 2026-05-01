/**
 * Polymarket markets the runtime watches.
 *
 * Each entry is a real market on the mainnet CLOB (data-api.polymarket.com /
 * clob.polymarket.com), hand-picked at deploy time from
 * gamma-api.polymarket.com top-volume politics + sports tags.
 *
 * Polymarket retires + reindexes markets regularly — the list MUST be
 * re-validated before every demo / mainnet cut. To refresh:
 *
 *   curl 'https://gamma-api.polymarket.com/events?limit=20&active=true&closed=false&order=volume24hr&ascending=false' \
 *     | jq '.[].markets[] | {conditionId, question, outcomes: (.outcomes | fromjson), clobTokenIds: (.clobTokenIds | fromjson), slug}'
 *
 * v1 carried population-bot bindings here (Mineflayer NPCs each held one
 * position). v2 drops the watchable layer; the stable `label` strings are
 * retained only as opaque identifiers for the rail panel + reasoning trace
 * surfaces.
 */

import type { Sha256Hex } from "@vanta/tee";

export interface WatchedMarket {
  /** Stable market label — opaque to the runtime, used for trace surfaces. */
  readonly label: string;
  /** Polymarket conditionId, lowercased 64-hex with 0x prefix. */
  readonly conditionId: `0x${string}`;
  /** Just the 64-hex sans 0x — what `@vanta/mark.fetchMarket` wants. */
  readonly conditionIdHex: Sha256Hex;
  /** CTF uint256 token id for the side this label tracks. Used for fetchMidpoint. */
  readonly tokenId: string;
  readonly side: "YES" | "NO";
  /** USDC 6-dec wei sized by the synthetic position the runtime tracks. */
  readonly sizeUsdc6: bigint;
  /** polymarket.com/event/{slug} link target. */
  readonly polymarketSlug: string;
  /** Short label for the rail chyron. */
  readonly shortName: string;
}

const cidNoPrefix = (cid: `0x${string}`): Sha256Hex =>
  cid.slice(2).toLowerCase() as Sha256Hex;

// --- Polymarket markets ----------------------------------------------------
// Hand-picked 2026-04-29 from gamma-api.polymarket.com top-volume politics +
// sports tags. Validated for accepting_orders=true at time of pull.

const ANDY_BESHEAR_2028 = {
  conditionId: "0x1d519b87999e3d4e90e1e8f57b5eee73a0ba488ff3fdb70867f294733aba84a9",
  yesTokenId: "26468656392978559668331516709623917078428425933265692717836103090220693717685",
  noTokenId:  "26335362363448644358593284423242327477307616743233875606762153873424287882825",
  slug: "will-andy-beshear-win-the-2028-democratic-presidential-nomination-832",
  shortName: "Beshear-2028",
} as const;

const PETE_BUTTIGIEG_2028 = {
  conditionId: "0x4c325469d9b516ef4e6b8f73a81a12607dec075e3c2fd454f91765aaeafc4760",
  yesTokenId: "91031279171981959197361710127213577102576826515163085396576756946418341946256",
  noTokenId:  "18494065527924073750217237765784380365430319396356251245973222791140100738948",
  slug: "will-pete-buttigieg-win-the-2028-democratic-presidential-nomination-687",
  shortName: "Buttigieg-2028",
} as const;

const USA_WORLD_CUP = {
  conditionId: "0xcdb1f0400949238a63d3e88243d2ada08cd9c2a71985ced9f0cfd5e66354cf90",
  yesTokenId: "94603648636330087039501304492699481091005420017442244191603206509188088089447",
  noTokenId:  "45270201343463663182019040935560267543606888663369415494551943549463253748361",
  slug: "will-usa-win-the-2026-fifa-world-cup-467",
  shortName: "USA-WC2026",
} as const;

const CURACAO_WORLD_CUP = {
  conditionId: "0xdb4b2f370c3d0e996fbb32213c87aa5402936e3d4882432b6738e2f5661b79a6",
  yesTokenId: "69020832226510184384177497367584971770730339593583713190288186699694495509961",
  noTokenId:  "57880090995762041847706075076337915070476459103836011898392946953962001410644",
  slug: "will-curaao-win-the-2026-fifa-world-cup",
  shortName: "Curacao-WC2026",
} as const;

const ARGENTINA_WORLD_CUP = {
  conditionId: "0x0c4cd2055d6ea89354ffddc55d6dbcef9355748112ea952fc925f3db6a5c457f",
  yesTokenId: "18812649149814341758733697580460697418474693998558159483117100240528657629879",
  noTokenId:  "115428153746996892211798999366308897078723117634059783423375188043903703749062",
  slug: "will-argentina-win-the-2026-fifa-world-cup-245",
  shortName: "Argentina-WC2026",
} as const;

const JON_OSSOFF_2028 = {
  conditionId: "0x74dba1ce1ae9dd535414e85f2d9ab5ea32c0fb1acc9b7130b67e6d91217e24e1",
  yesTokenId: "70071592420137476676935286377781779672157004436137616627487590484756055232944",
  noTokenId:  "107829893465244243112531790315844862173967342141753896250561816305880797209350",
  slug: "will-jon-ossoff-win-the-2028-democratic-presidential-nomination-885",
  shortName: "Ossoff-2028",
} as const;

const BRAZIL_WORLD_CUP = {
  conditionId: "0x30d55d8124ee1e12dabe89201badc45669b81dff69e4ce44d961f32878ec178a",
  yesTokenId: "27576533317283401577758999384642760405921738493660383550832555714312627457443",
  noTokenId:  "52986718774908357330412653486471347449818893503063830313445318937088822580057",
  slug: "will-brazil-win-the-2026-fifa-world-cup-183",
  shortName: "Brazil-WC2026",
} as const;

// --- Watched market list ---------------------------------------------------
// Labels are stable identifiers — they appear in /api/markets/watched
// payloads and reasoning-trace surfaces but are otherwise opaque.

export const WATCHED_MARKETS: ReadonlyArray<WatchedMarket> = [
  {
    label: "beshear-2028",
    conditionId: ANDY_BESHEAR_2028.conditionId,
    conditionIdHex: cidNoPrefix(ANDY_BESHEAR_2028.conditionId),
    tokenId: ANDY_BESHEAR_2028.yesTokenId,
    side: "YES",
    sizeUsdc6: 80_000_000_000n,
    polymarketSlug: ANDY_BESHEAR_2028.slug,
    shortName: ANDY_BESHEAR_2028.shortName,
  },
  {
    label: "usa-wc2026",
    conditionId: USA_WORLD_CUP.conditionId,
    conditionIdHex: cidNoPrefix(USA_WORLD_CUP.conditionId),
    tokenId: USA_WORLD_CUP.noTokenId,
    side: "NO",
    sizeUsdc6: 12_000_000_000n,
    polymarketSlug: USA_WORLD_CUP.slug,
    shortName: USA_WORLD_CUP.shortName,
  },
  {
    label: "curacao-wc2026",
    conditionId: CURACAO_WORLD_CUP.conditionId,
    conditionIdHex: cidNoPrefix(CURACAO_WORLD_CUP.conditionId),
    tokenId: CURACAO_WORLD_CUP.noTokenId,
    side: "NO",
    sizeUsdc6: 35_000_000_000n,
    polymarketSlug: CURACAO_WORLD_CUP.slug,
    shortName: CURACAO_WORLD_CUP.shortName,
  },
  {
    label: "buttigieg-2028",
    conditionId: PETE_BUTTIGIEG_2028.conditionId,
    conditionIdHex: cidNoPrefix(PETE_BUTTIGIEG_2028.conditionId),
    tokenId: PETE_BUTTIGIEG_2028.yesTokenId,
    side: "YES",
    sizeUsdc6: 25_000_000_000n,
    polymarketSlug: PETE_BUTTIGIEG_2028.slug,
    shortName: PETE_BUTTIGIEG_2028.shortName,
  },
  {
    label: "argentina-wc2026",
    conditionId: ARGENTINA_WORLD_CUP.conditionId,
    conditionIdHex: cidNoPrefix(ARGENTINA_WORLD_CUP.conditionId),
    tokenId: ARGENTINA_WORLD_CUP.yesTokenId,
    side: "YES",
    sizeUsdc6: 250_000_000n,
    polymarketSlug: ARGENTINA_WORLD_CUP.slug,
    shortName: ARGENTINA_WORLD_CUP.shortName,
  },
];

/**
 * Watched-only — vanta tracks them but no synthetic position is held.
 * Surfaced in the rail's "markets vanta is watching" panel for visual
 * density when the active list is short.
 */
export const WATCHED_ONLY_MARKETS = [
  {
    conditionId: JON_OSSOFF_2028.conditionId,
    conditionIdHex: cidNoPrefix(JON_OSSOFF_2028.conditionId),
    yesTokenId: JON_OSSOFF_2028.yesTokenId,
    noTokenId: JON_OSSOFF_2028.noTokenId,
    polymarketSlug: JON_OSSOFF_2028.slug,
    shortName: JON_OSSOFF_2028.shortName,
  },
  {
    conditionId: BRAZIL_WORLD_CUP.conditionId,
    conditionIdHex: cidNoPrefix(BRAZIL_WORLD_CUP.conditionId),
    yesTokenId: BRAZIL_WORLD_CUP.yesTokenId,
    noTokenId: BRAZIL_WORLD_CUP.noTokenId,
    polymarketSlug: BRAZIL_WORLD_CUP.slug,
    shortName: BRAZIL_WORLD_CUP.shortName,
  },
] as const;

/** All conditionIds (held + watched) the runtime polls for market metadata. */
export function allWatchedConditionIds(): readonly Sha256Hex[] {
  const ids = new Set<Sha256Hex>();
  for (const m of WATCHED_MARKETS) ids.add(m.conditionIdHex);
  for (const w of WATCHED_ONLY_MARKETS) ids.add(w.conditionIdHex);
  return Array.from(ids);
}

/** Token IDs to poll midpoints for — the side relevant to the held position. */
export function watchedTokenSides(): readonly { tokenId: string; side: "YES" | "NO"; conditionIdHex: Sha256Hex }[] {
  const out: { tokenId: string; side: "YES" | "NO"; conditionIdHex: Sha256Hex }[] = [];
  for (const m of WATCHED_MARKETS) {
    out.push({ tokenId: m.tokenId, side: m.side, conditionIdHex: m.conditionIdHex });
  }
  for (const w of WATCHED_ONLY_MARKETS) {
    out.push({ tokenId: w.yesTokenId, side: "YES", conditionIdHex: w.conditionIdHex });
  }
  return out;
}

export function lookupByLabel(label: string): WatchedMarket | null {
  for (const m of WATCHED_MARKETS) {
    if (m.label === label) return m;
  }
  return null;
}

export function lookupBySlug(slug: string): WatchedMarket | null {
  for (const m of WATCHED_MARKETS) {
    if (m.polymarketSlug === slug) return m;
  }
  return null;
}

export function polymarketUrl(slug: string): string {
  return `https://polymarket.com/market/${slug}`;
}
