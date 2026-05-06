/**
 * Persona phrase library for the scripted-LLM demo path.
 *
 * Each NPC from `runtime/src/services/npc-personas.ts` has 6-10
 * thought templates here. Each template is a complete one-line
 * opinion in the persona's voice, plus a `bias` integer in
 * `[-3..+3]` describing whether the line leans pessimistic (-3) or
 * optimistic (+3) on loan-health.
 *
 * The scripted inference picks a template deterministically from
 * `(persona_slug, market_question)` so the same NPC sounds different
 * across markets but consistent within one market across re-runs.
 *
 * In-character. Length-constrained (≤200 chars). Two values per
 * persona biased on either side of 0 so the demo doesn't always read
 * as "all six NPCs say YES."
 */

export interface PersonaThought {
  /** -3 (pessimistic on loan health) ... +3 (optimistic). */
  readonly bias: number;
  readonly text: string;
}

/**
 * `personaSlug` here matches the `npc-personas.ts` slug field
 * verbatim (e.g. "cloister-scholar", "grain-merchant"). Adding a
 * persona to npc-personas.ts without adding entries here will fall
 * back to a generic "no comment" line.
 */
export const PERSONA_THOUGHTS: Readonly<Record<string, readonly PersonaThought[]>> = {
  // ===== opus — macro / rates / geopolitics =====
  "cloister-scholar": [
    { bias: +1, text: "1994 was hot prints up to the meeting and they cut anyway. The pattern points to relief." },
    { bias: +2, text: "Volcker '79 taught us — when conviction breaks, it breaks fast. I see early signs." },
    { bias: -2, text: "The Greenspan put isn't free. We've seen this kind of denial before — '07 most clearly." },
    { bias: -1, text: "Empires extend credit to their friends until the friends' friends start defaulting. Watch the chain." },
    { bias: +1, text: "ECB '11 vs Fed '12 — the divergence then maps closely to the divergence now. Fade the fear." },
    { bias: -3, text: "I have read three cycles of these archives. The current rhyme is 1929, not 1995." },
    { bias: +2, text: "Cycles end when the consensus is most certain they continue. The consensus is shaky now — bullish for repayment." },
    { bias: -1, text: "Each generation thinks the rules don't apply. They do. I would tighten the haircut by 200bp." },
  ],

  "grain-merchant": [
    { bias: +2, text: "Wholesale credit at the docks is loose. Customers are paying on time. The real economy says cuts come." },
    { bias: -2, text: "Three of my regulars asked for terms last week. That's never noise — it's always signal. Tighten." },
    { bias: -1, text: "Freight is moving but margins are thin. Borrowers like this one are the first to crack when the cycle turns." },
    { bias: +1, text: "Granaries are full. Demand is steady. This loan should clear without drama." },
    { bias: -3, text: "I've been a merchant 30 years. When the dock-hands stop tipping, the loan books are about to be hurt." },
    { bias: +2, text: "Spot prices are firm. The collateral has more cushion than the haircut suggests." },
    { bias: -1, text: "The borrower is overconfident — same look I saw before three other dock-house liquidations. Watch closely." },
    { bias: 0, text: "Market is in equipoise. I would not lend bigger than the council's prior. Hold the haircut." },
  ],

  "mint-master": [
    { bias: +1, text: "The breakeven curve has flattened. Real yields say the path is more dovish than the headline price." },
    { bias: -2, text: "TIPS spreads tightening into a rate-decision week — that's a warning. The market is mispricing." },
    { bias: +2, text: "Forward OIS has the next two cuts priced. The collateral here moves with that, and it is moving up." },
    { bias: -1, text: "Volatility regime shifted last fortnight. I would size this loan smaller until the new vol regime stabilises." },
    { bias: 0, text: "Curve is in equilibrium. No edge here either way. Take the council's prior at face value." },
    { bias: -3, text: "5y5y inflation is creeping. If that breaks 2.7% the entire rate path inverts and this loan is at risk." },
    { bias: +1, text: "Term premium has compressed to a 6-month low. Refinancing risk on this loan is correspondingly low." },
  ],

  "riverboat-captain": [
    { bias: -2, text: "Capital is leaving across the river quietly. I see it in the manifests. This isn't priced in yet." },
    { bias: +2, text: "Trade flows are healthier than the politicians are letting on. The loan should resolve clean." },
    { bias: -1, text: "Cross-border premium is building. Even if this one is fine, the next three borrowers will not be." },
    { bias: +1, text: "The dollar's strength is overstated upstream. Rates of return on collateral like this are firming." },
    { bias: -3, text: "I have watched three currencies fail. The current move is the same shape. Liquidate while you can." },
    { bias: 0, text: "Capital is patient right now. Neither flight nor flood. No edge to call this loan strongly." },
    { bias: +2, text: "Border hedging is cheap. Cheap hedges mean operators trust the path. Bullish for resolution." },
  ],

  "mason-foreman": [
    { bias: -2, text: "My crews are sitting idle in three cities. When carpenters slow, defaults follow within the quarter." },
    { bias: +2, text: "We started two new sites this week. Construction credit is loose, refinancing is open. Loan looks fine." },
    { bias: -3, text: "Materials credit just tightened on three suppliers I work with. We've seen this script before — it ends in a default cluster." },
    { bias: +1, text: "Permits are flowing again. The cycle is turning up. This loan rides into the upturn." },
    { bias: -1, text: "Hiring freeze rumours from two general contractors. I'd tighten by 100bp on this one." },
    { bias: +2, text: "Wages are firm, deposits are growing on the union side. Repayment math holds up." },
    { bias: 0, text: "Construction is in the middle of the cycle. No strong call. Trust the haircut math." },
  ],

  "friar": [
    { bias: -2, text: "The market square is full of nervous men this week. When the laity get frightened, defaults arrive within a fortnight." },
    { bias: +1, text: "People in the square are calmer than they were a month ago. Sentiment is unwinding the panic." },
    { bias: -1, text: "I overheard three borrowers from neighbouring kingdoms whispering about extensions. Sentiment is fragile." },
    { bias: +2, text: "Children are buying again. When the children start spending, the parents are not far behind. Bullish." },
    { bias: -3, text: "I confessed two merchants this week who should have been confident men. They were not. The mood has rotted." },
    { bias: 0, text: "The square is quiet — not panicked, not exuberant. The loan should be priced from data, not mood." },
    { bias: +1, text: "Festival attendance is up two-fold from last year. Positive sentiment compounds. Bullish for collateral." },
  ],

  // ===== gpt — sports / culture / event-driven =====
  "stable-hand": [
    { bias: +2, text: "I was at training this morning. The form is real. The market is underrating the conditioning gains." },
    { bias: -2, text: "There's a soft-tissue issue nobody is reporting. I'd fade this entry before the line moves." },
    { bias: -3, text: "The handler changed three weeks ago and it shows. Discount the favourite — they're not the same animal." },
    { bias: +3, text: "This one is peaking exactly on schedule. The market hasn't caught up to the recent gallops yet." },
    { bias: 0, text: "Form is steady. No sharp reads either way. Trust the line." },
    { bias: +1, text: "The field is weaker than the betting suggests. Mild edge to the favourite." },
    { bias: -1, text: "Travel and surface change in the next race make me cautious. Tighter haircut, smaller principal." },
  ],

  "festival-crier": [
    { bias: +2, text: "The whole city is talking about this team. Cultural attention compounds — they can't miss." },
    { bias: -2, text: "The bards have moved on to other songs. The hype is older than the line is showing. Fade." },
    { bias: -1, text: "I see this one trending in only three taverns now, used to be ten. Attention has decayed." },
    { bias: +1, text: "Posters are still going up in the markets. Public investment is sticky. The narrative will hold." },
    { bias: -3, text: "Two competing storylines are stealing the oxygen. This one will not get the public's love when it counts." },
    { bias: 0, text: "The story is neither hot nor cold. The market reflects that fairly. No edge." },
  ],

  "innkeeper": [
    { bias: -3, text: "Half the room was on the favourite last night. Bet against the crowd, my friend. They're always wrong." },
    { bias: +1, text: "The smart money has rotated quietly to YES. Watch what they do, not what they say." },
    { bias: -2, text: "The drunk at table four was confident — too confident. That's a tell. Fade his side." },
    { bias: +2, text: "An old hand bet bigger than usual on this one. Twenty years says he doesn't make those moves casually." },
    { bias: -1, text: "Public money is leaning hard one way. Contrarian bias says lean the other. Tighten the loan." },
    { bias: +3, text: "The line moved against the public action. That means the books know something. Bullish for resolution." },
    { bias: 0, text: "No imbalance in the room tonight. Mixed crowd, mixed bets. Take the line at face value." },
  ],

  "tournament-squire": [
    { bias: +2, text: "The matchup theory favours our side. Style mismatches often trump talent gaps." },
    { bias: -2, text: "On paper the match is even but the meta has shifted. The favourite is now playing into a counter." },
    { bias: -1, text: "I've replayed three of their recent bouts. Their adjustments are slow. They'll be exposed at scale." },
    { bias: +1, text: "Process over outcome — the underdog has been winning the small battles. They'll close the gap." },
    { bias: -3, text: "Every objective metric says one thing, the line says another. The line is right; the model is wrong." },
    { bias: +2, text: "Clutch performance under pressure has trended up six straight matches. That isn't noise. Bullish." },
  ],

  "scribe-of-songs": [
    { bias: -2, text: "Celebrity arcs follow a curve. This one is past the peak. The redemption priced in won't materialise." },
    { bias: +1, text: "The narrative of comeback is sticky. The public will buy that story all the way to resolution." },
    { bias: -1, text: "Three rising bards are stealing the headline. The favourite will not get the cultural moment they need." },
    { bias: +3, text: "I've seen this exact arc before — the comeback story always closes stronger than the line implies." },
    { bias: 0, text: "The narrative is balanced. The market reflects it. No mispricing here." },
    { bias: -3, text: "The fall from grace is structural, not cyclical. The line hasn't repriced yet but it will." },
  ],

  "playwright": [
    { bias: +2, text: "The audience wants the dramatic finish. Markets often deliver what the public has paid to see." },
    { bias: -2, text: "Tragic arcs are inevitable when the protagonist refuses to listen. I see the third act here." },
    { bias: -1, text: "The story has a satisfying ending only if the rules don't change. They are changing." },
    { bias: +1, text: "Narrative momentum favours the underdog. Markets follow narrative more often than they admit." },
    { bias: 0, text: "Either ending fits the play. The market won't pick a side; neither should we." },
    { bias: -3, text: "Every storyline has a deus ex machina hidden in it. This one's machina is creditor patience, and it's running out." },
  ],

  // ===== gemini — politics / policy / elections =====
  "cartographer": [
    { bias: -2, text: "The new OH/NC maps strip 5 R seats net. Don't trust the generic ballot — trust the lines." },
    { bias: +1, text: "Suburban turnout is up in three target counties. Demographics are still destiny here." },
    { bias: +2, text: "I've mapped this electorate three ways. Every projection says the same thing — favourable." },
    { bias: -1, text: "The county-level shift is smaller than the headline polls suggest. Mild fade." },
    { bias: -3, text: "Voter rolls are being purged in two states. The line hasn't priced this in. Significant downside." },
    { bias: +2, text: "Ground-game intensity in the swing districts is the highest I've measured in a cycle. Bullish." },
    { bias: 0, text: "Demographics balance out. No structural edge. Take the polling average at face value." },
  ],

  "diplomat": [
    { bias: +1, text: "Three coalitions are quietly aligned. The whip count is more comfortable than the floor speeches imply." },
    { bias: -2, text: "Two key allies defected this week. The vote count won't hold. Fade." },
    { bias: -1, text: "Faction leaders are buying time, not votes. The deal won't close on schedule." },
    { bias: +2, text: "Cross-party favours are being called in. Rare moves — this isn't a vote that will go down to the wire." },
    { bias: -3, text: "I've seen this kind of public denial before — followed by collapse. The coalition isn't real." },
    { bias: 0, text: "The factions are balanced. The vote could go either way. Neutral." },
    { bias: +2, text: "The whip's mood today is the calmest I've seen in months. He has the votes." },
  ],

  "rebel": [
    { bias: -2, text: "The official story is rarely the whole story. Fade the consensus on this one." },
    { bias: +3, text: "The underdog is structurally underweighted. The line is mispricing the upset by 20%." },
    { bias: -3, text: "Establishment confidence is at a peak. That's the contrarian's bell. The polls will move sharply." },
    { bias: +1, text: "Quiet money is flowing to the underdog. The smart take is unfashionable but right." },
    { bias: -1, text: "Mainstream press is hedging. They sense something the line hasn't picked up yet." },
    { bias: +2, text: "The court astronomer's probabilities are off by 8%. Always are. Lean the other way." },
  ],

  "court-astronomer": [
    { bias: -1, text: "The current cycle resembles 1968 more than 2008. The pattern says bigger downside than the line suggests." },
    { bias: +1, text: "Generational turnover favours this outcome. Long-cycle indicators are aligned." },
    { bias: -2, text: "Empires lose elections in this part of the cycle, not win them. Pattern says fade." },
    { bias: +2, text: "Secular trends favour stability. Short-term noise will resolve to the long-term base rate." },
    { bias: 0, text: "The cycle is in transition. Neither pattern is clearly dominant. Patience." },
    { bias: -3, text: "Three indicators I track haven't aligned this way since 1932. The downside risk is real." },
  ],

  "tax-collector": [
    { bias: +2, text: "Registration trends in the swing precincts are up 8% YoY. Turnout is the proxy. Bullish." },
    { bias: -2, text: "Three door-knocks in five report softer enthusiasm. Ground game is weaker than headline." },
    { bias: -1, text: "The roll has more inactive voters than last cycle. Turnout will disappoint." },
    { bias: +1, text: "Early-voting patterns mirror the favourable 2020 cycle. The model holds." },
    { bias: -3, text: "Weather forecast for election day is bad in two key counties. The model has not adjusted." },
    { bias: 0, text: "Turnout indicators are mixed. No edge in either direction." },
  ],

  "spymaster": [
    { bias: -2, text: "The opposition is pre-positioning litigation. They expect to need it. That's information." },
    { bias: +2, text: "Quiet money is moving to the favourite via three intermediaries. The smart capital has decided." },
    { bias: -3, text: "I have intelligence on a coordinated push that hasn't surfaced publicly. The line will move sharply when it does." },
    { bias: +1, text: "The opposition's confidence is staged. Their internal data isn't matching what they're saying in public." },
    { bias: -1, text: "Three foreign actors are intervening at the margins. Adds variance. Tighter haircut prudent." },
    { bias: 0, text: "Both sides are playing standard moves. No surprise alpha here. Trust the line." },
    { bias: +3, text: "The opposition's leadership is reading their own internal numbers. They are quietly resigned. Bullish for the favourite." },
  ],
};

/**
 * Pick a thought for a given persona keyed off market context.
 * Same persona + same market_id ⇒ same line every time the demo
 * re-runs (good for screenshots + reproducibility).
 */
export function pickThought(personaSlug: string, marketKey: string): PersonaThought {
  const pool = PERSONA_THOUGHTS[personaSlug] ?? FALLBACK;
  if (pool.length === 0) return FALLBACK[0]!;
  const seed = fnv1a(`${personaSlug}::${marketKey}`);
  return pool[seed % pool.length]!;
}

const FALLBACK: readonly PersonaThought[] = [
  { bias: 0, text: "I have no strong view on this one. The council should weigh others more heavily." },
];

/** Tiny deterministic hash. Not cryptographic — just stable. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; ++i) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}
