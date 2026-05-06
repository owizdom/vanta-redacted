/**
 * Demo borrower — emits the same signed origination chain the demo
 * runner builds, but in-process inside the runtime when a user clicks
 * "submit to council" in the borrower modal.
 *
 * Why this exists: the real `/api/origination` route calls
 * `LoanBook.originate(...)` on Base Sepolia which requires the
 * borrower to have actually escrowed CTF tokens in `VantaVault`.
 * The seeded pledges + the user's "demo account" wallet don't have
 * real CTF tokens — they're a demo, not a Polymarket position. So
 * the on-chain call fails.
 *
 * Solution: this service synthesizes the full TEE-signed origination
 * chain (pledge → 2× op.inference + 2× npc.thought → synthesis op.inference
 * + council.synthesised → reasoning.trace → loan.origination) using
 * the runtime's signing key. Each event is genuine (real signature,
 * real envelope, walkable parents). The chain lands in the event log
 * via the same sink the runtime uses for all its other events, so
 * SSE listeners broadcast it to the chat panel automatically.
 *
 * This is the "scripted text, real signatures" path the rest of the
 * demo seed uses. Auditors verify each event byte-for-byte; only the
 * thing that's "not real" is the on-chain LoanBook entry.
 */

import { createHash } from "node:crypto";

import { asSha256Hex, type EthAddressHex, type Sha256Hex } from "@vanta/tee";

import type { EventSink } from "../loops/types.js";
import { sampleNpcs } from "./npc-personas.js";

// ---------------------------------------------------------------------------
// inputs
// ---------------------------------------------------------------------------

export interface DemoBorrowMarket {
  /** 64-char lowercase hex (no `0x`). */
  readonly conditionIdHex: string;
  /** uint256 decimal-string CTF token id. */
  readonly tokenId: string;
  readonly question: string;
  readonly shortName: string;
  /** Plausible current mid in [0,1]. */
  readonly currentMid: number;
  readonly timeToResolutionSeconds: number;
}

export interface DemoBorrowRequest {
  readonly agentId: number;
  readonly market: DemoBorrowMarket;
  /** USDC amount in 6-decimal raw form (e.g. 500_000_000n for $500). */
  readonly principalUsdc6: bigint;
  /** Maturity timestamp in unix seconds. */
  readonly maturityTsUnix: number;
  /** Borrower wallet address (the demo account or whoever the user connected as). */
  readonly borrower: EthAddressHex;
}

export interface DemoBorrowResult {
  readonly originationId: Sha256Hex;
  readonly loanId: Sha256Hex;
  readonly synthesisId: Sha256Hex;
  readonly thoughtIds: readonly Sha256Hex[];
  readonly traceId: Sha256Hex;
  readonly principalUsdc6: string;
  readonly haircutBps: number;
}

// ---------------------------------------------------------------------------
// scripted phrase pool — same shape as scripts/demo/personas-script.ts
// but kept tiny here so the runtime doesn't depend on the scripts/ workspace
// ---------------------------------------------------------------------------

interface PhraseEntry {
  readonly bias: number;
  readonly text: string;
}

const SCRIPTED_THOUGHTS: Readonly<Record<string, readonly PhraseEntry[]>> = {
  "cloister-scholar": [
    { bias: +1, text: "1994 was hot prints up to the meeting and they cut anyway. The pattern points to relief." },
    { bias: -2, text: "The Greenspan put isn't free. We've seen this kind of denial before — '07 most clearly." },
    { bias: +2, text: "Cycles end when the consensus is most certain they continue. The consensus is shaky now — bullish for repayment." },
  ],
  "grain-merchant": [
    { bias: +2, text: "Wholesale credit at the docks is loose. Customers are paying on time. The real economy says cuts come." },
    { bias: -2, text: "Three of my regulars asked for terms last week. That's never noise — it's always signal. Tighten." },
    { bias: 0, text: "Market is in equipoise. I would not lend bigger than the council's prior. Hold the haircut." },
  ],
  "mint-master": [
    { bias: +1, text: "Forward OIS has the next two cuts priced. The collateral here moves with that, and it is moving up." },
    { bias: -2, text: "TIPS spreads tightening into a rate-decision week — that's a warning. The market is mispricing." },
    { bias: +1, text: "Term premium has compressed to a 6-month low. Refinancing risk on this loan is correspondingly low." },
  ],
  "riverboat-captain": [
    { bias: -1, text: "Cross-border premium is building. Even if this one is fine, the next three borrowers will not be." },
    { bias: +2, text: "Border hedging is cheap. Cheap hedges mean operators trust the path. Bullish for resolution." },
  ],
  "mason-foreman": [
    { bias: +2, text: "We started two new sites this week. Construction credit is loose, refinancing is open. Loan looks fine." },
    { bias: -2, text: "My crews are sitting idle in three cities. When carpenters slow, defaults follow within the quarter." },
  ],
  "friar": [
    { bias: +2, text: "Children are buying again. When the children start spending, the parents are not far behind. Bullish." },
    { bias: -2, text: "The market square is full of nervous men this week. When the laity get frightened, defaults arrive within a fortnight." },
  ],
  "stable-hand": [
    { bias: +2, text: "I was at training this morning. The form is real. The market is underrating the conditioning gains." },
    { bias: -2, text: "There's a soft-tissue issue nobody is reporting. I'd fade this entry before the line moves." },
  ],
  "festival-crier": [
    { bias: +2, text: "The whole city is talking about this team. Cultural attention compounds — they can't miss." },
    { bias: -2, text: "The bards have moved on to other songs. The hype is older than the line is showing. Fade." },
  ],
  "innkeeper": [
    { bias: -2, text: "The drunk at table four was confident — too confident. That's a tell. Fade his side." },
    { bias: +2, text: "An old hand bet bigger than usual on this one. Twenty years says he doesn't make those moves casually." },
  ],
  "tournament-squire": [
    { bias: +2, text: "The matchup theory favours our side. Style mismatches often trump talent gaps." },
    { bias: -1, text: "I've replayed three of their recent bouts. Their adjustments are slow. They'll be exposed at scale." },
  ],
  "scribe-of-songs": [
    { bias: -2, text: "Celebrity arcs follow a curve. This one is past the peak. The redemption priced in won't materialise." },
    { bias: +1, text: "The narrative of comeback is sticky. The public will buy that story all the way to resolution." },
  ],
  "playwright": [
    { bias: +2, text: "The audience wants the dramatic finish. Markets often deliver what the public has paid to see." },
    { bias: -2, text: "Tragic arcs are inevitable when the protagonist refuses to listen. I see the third act here." },
  ],
  "cartographer": [
    { bias: +2, text: "I've mapped this electorate three ways. Every projection says the same thing — favourable." },
    { bias: -2, text: "The new OH/NC maps strip 5 R seats net. Don't trust the generic ballot — trust the lines." },
  ],
  "diplomat": [
    { bias: +2, text: "Cross-party favours are being called in. Rare moves — this isn't a vote that will go down to the wire." },
    { bias: -2, text: "Two key allies defected this week. The vote count won't hold. Fade." },
  ],
  "rebel": [
    { bias: -2, text: "The official story is rarely the whole story. Fade the consensus on this one." },
    { bias: +2, text: "Quiet money is flowing to the underdog. The smart take is unfashionable but right." },
  ],
  "court-astronomer": [
    { bias: +2, text: "Secular trends favour stability. Short-term noise will resolve to the long-term base rate." },
    { bias: -2, text: "Empires lose elections in this part of the cycle, not win them. Pattern says fade." },
  ],
  "tax-collector": [
    { bias: +2, text: "Registration trends in the swing precincts are up 8% YoY. Turnout is the proxy. Bullish." },
    { bias: -2, text: "Three door-knocks in five report softer enthusiasm. Ground game is weaker than headline." },
  ],
  "spymaster": [
    { bias: +2, text: "Quiet money is moving to the favourite via three intermediaries. The smart capital has decided." },
    { bias: -2, text: "The opposition is pre-positioning litigation. They expect to need it. That's information." },
  ],
};

const FALLBACK_PHRASE: PhraseEntry = { bias: 0, text: "I have no strong view on this one." };

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; ++i) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

function pickThought(slug: string, marketKey: string): PhraseEntry {
  const pool = SCRIPTED_THOUGHTS[slug] ?? [];
  if (pool.length === 0) return FALLBACK_PHRASE;
  return pool[fnv1a(`${slug}::${marketKey}`) % pool.length]!;
}

// ---------------------------------------------------------------------------
// math
// ---------------------------------------------------------------------------

function probToCentibps(p: number): number {
  return Math.max(0, Math.min(1_000_000, Math.round(p * 1_000_000)));
}

function probToBps(p: number): number {
  return Math.max(0, Math.min(10_000, Math.round(p * 10_000)));
}

function biasToOffset(b: number): number {
  return Math.max(-0.18, Math.min(0.18, b * 0.06));
}

function biasToConfidence(b: number): number {
  return Math.max(0.5, Math.min(0.85, 0.55 + Math.abs(b) * 0.1));
}

function clampUnit(x: number): number {
  return Math.max(0.02, Math.min(0.98, x));
}

function sha256Hex(s: string): Sha256Hex {
  return asSha256Hex(createHash("sha256").update(s).digest("hex"));
}

let counter = 0;
function freshHex(label: string): Sha256Hex {
  counter += 1;
  return sha256Hex(`${label}::${String(counter)}::${String(Date.now())}::${String(Math.random())}`);
}

const ZERO_HEX = "0".repeat(64);

// ---------------------------------------------------------------------------
// The orchestrator
// ---------------------------------------------------------------------------

export async function emitDemoBorrow(
  events: EventSink,
  req: DemoBorrowRequest,
): Promise<DemoBorrowResult> {
  const nowS = Math.floor(Date.now() / 1000);
  const marketKey = req.market.conditionIdHex;

  // 1. loan.pledge — the borrower's CTF position is escrowed in
  //    VantaVault. Synthetic for the demo since the wallet doesn't
  //    actually hold CTF tokens.
  const loanId = freshHex(`loan::${String(req.agentId)}::${req.market.shortName}`);
  const pledgeId = await events.emit({
    type: "loan.pledge",
    body: {
      loan_id: loanId,
      borrower_proxy: req.borrower,
      position_id: req.market.tokenId,
      amount: (req.principalUsdc6 * 2n).toString(),
      vault_address: ("0x5e92e21c6dba03c8f8e2f2b1c1c0d8e8f8a0b0c" + String(req.agentId)) as EthAddressHex,
      tx_hash: freshHex("pledge-tx"),
      block_number: 3_000_000 + counter,
      block_hash: freshHex("pledge-block"),
      log_index: 0,
      confirmation_depth: 12,
      condition_id: asSha256Hex(req.market.conditionIdHex),
    },
    parentIds: [],
  });

  // 2. Council pass — sample 2 NPCs, build a scripted thought + inference
  //    each, then synthesise.
  const personas = sampleNpcs(req.agentId, 2, `${marketKey}::borrow::${String(nowS)}::${String(counter)}`);
  const thoughtIds: Sha256Hex[] = [];
  const votes: Array<{
    persona: (typeof personas)[number];
    belief: number;
    confidence: number;
    thought: string;
  }> = [];

  const priorLoanHealth = 0.74;
  for (let i = 0; i < personas.length; ++i) {
    const persona = personas[i]!;
    const tpl = pickThought(persona.personaSlug, marketKey);
    const offset = biasToOffset(tpl.bias);
    const belief = clampUnit(priorLoanHealth + offset);
    const confidence = biasToConfidence(tpl.bias);
    const responseText = JSON.stringify({ thought: tpl.text, belief, confidence });
    const reqHash = sha256Hex(`req::thought::${persona.personaSlug}::${marketKey}::${String(nowS)}::${String(counter)}`);
    const resHash = sha256Hex(`${responseText}::${freshHex("nonce")}`);

    const inferenceId = await events.emit({
      type: "op.inference",
      body: {
        inference_id: resHash,
        role: "researcher",
        bot_handle: "",
        provider: "anthropic",
        model: "claude-haiku-4-5-scripted",
        request_canonical_hash: reqHash,
        response_text_hash: resHash,
        response_text_excerpt: responseText,
        request_blob_uri: "",
        response_blob_uri: "",
        prompt_tokens: 220,
        completion_tokens: 64,
        latency_ms: 240 + i * 40,
        started_at_unix_ms: Date.now() - 30_000 + i * 10_000,
      },
      parentIds: [],
    });

    const thoughtId = await events.emit({
      type: "npc.thought",
      body: {
        agent_id: req.agentId,
        npc_id: persona.npcId,
        npc_persona: persona.personaSlug,
        npc_display_name: persona.displayName,
        market_id: asSha256Hex(req.market.conditionIdHex),
        thought: tpl.text,
        belief_centibps: probToCentibps(belief),
        confidence_bps: probToBps(confidence),
        inference_event_id: inferenceId,
      },
      parentIds: [pledgeId, inferenceId],
    });

    thoughtIds.push(thoughtId);
    votes.push({ persona, belief, confidence, thought: tpl.text });
  }

  // 3. Synthesis
  let num = priorLoanHealth * 0.5;
  let den = 0.5;
  let confSum = 0;
  for (const v of votes) {
    const w = Math.max(0.1, v.confidence);
    num += v.belief * w;
    den += w;
    confSum += v.confidence;
  }
  const synthBelief = clampUnit(num / den);
  const synthConfidence = Math.max(0.5, Math.min(0.92, 0.65 * 0.4 + (confSum / votes.length) * 0.6));

  const top = [...votes].sort((a, b) => b.confidence - a.confidence);
  const direction =
    synthBelief > priorLoanHealth ? "up" : synthBelief < priorLoanHealth ? "down" : "flat";
  const cite =
    top.length >= 2
      ? `${top[0]!.persona.displayName.split(" ")[0]} flagged "${top[0]!.thought.slice(0, 80)}", and ${top[1]!.persona.displayName.split(" ")[0]} added "${top[1]!.thought.slice(0, 80)}".`
      : `${top[0]!.persona.displayName.split(" ")[0]} noted: "${top[0]!.thought.slice(0, 120)}".`;
  const rationale =
    direction === "flat"
      ? `Net of the divergent voices, the committee held the prior. ${cite}`
      : `${top.map((v) => v.persona.displayName.split(" ")[0]).join(" and ")} pulled the loan-health ${direction}. ${cite}`;

  const synthResponseText = JSON.stringify({ belief: synthBelief, confidence: synthConfidence, rationale });
  const synthReqHash = sha256Hex(`req::synthesis::${marketKey}::${String(nowS)}::${String(counter)}`);
  const synthResHash = sha256Hex(`${synthResponseText}::${freshHex("synth-nonce")}`);

  const synthInferenceId = await events.emit({
    type: "op.inference",
    body: {
      inference_id: synthResHash,
      role: "evaluator",
      bot_handle: "",
      provider: "anthropic",
      model: "claude-sonnet-4-6-scripted",
      request_canonical_hash: synthReqHash,
      response_text_hash: synthResHash,
      response_text_excerpt: synthResponseText,
      request_blob_uri: "",
      response_blob_uri: "",
      prompt_tokens: 480,
      completion_tokens: 96,
      latency_ms: 380,
      started_at_unix_ms: Date.now() - 5_000,
    },
    parentIds: [],
  });

  const synthesisId = await events.emit({
    type: "council.synthesised",
    body: {
      agent_id: req.agentId,
      market_id: asSha256Hex(req.market.conditionIdHex),
      npc_thought_event_ids: thoughtIds,
      prior_belief_centibps: probToCentibps(priorLoanHealth),
      synthesised_belief_centibps: probToCentibps(synthBelief),
      delta_centibps: probToCentibps(synthBelief) - probToCentibps(priorLoanHealth),
      synthesised_confidence_bps: probToBps(synthConfidence),
      rationale,
      inference_event_id: synthInferenceId,
    },
    parentIds: [pledgeId, synthInferenceId, ...thoughtIds],
  });

  // 4. reasoning.trace + loan.origination
  const traceId = await events.emit({
    type: "reasoning.trace",
    body: {
      subject_event_id: ZERO_HEX as unknown as Sha256Hex,
      subject_event_type: "loan.origination",
      inputs_summary: {
        market: req.market.shortName,
        agent_id: req.agentId,
        principal_usdc: (req.principalUsdc6 / 10n ** 6n).toString(),
        haircut_bps: 6_500,
        prior_health_bps: probToBps(priorLoanHealth),
        synth_health_bps: probToCentibps(synthBelief),
      },
      intermediate_scores: {
        ltv_bps: 6_500,
        time_to_resolution_days: Math.floor(req.market.timeToResolutionSeconds / 86_400),
        depth_5pct_usdc_thousands: 50,
      },
      decision_rationale: rationale,
      dissenting_considerations: "",
      model_id: "claude-sonnet-4-6-scripted",
      prompt_hash: sha256Hex(`borrow-prompt::${String(nowS)}::${String(counter)}`),
    },
    parentIds: [pledgeId, synthesisId],
  });

  const txHash = freshHex("orig-tx");
  const blockHash = freshHex("orig-block");
  const paramsHash = sha256Hex(
    `params::${req.market.conditionIdHex}::${req.principalUsdc6.toString()}::${String(req.maturityTsUnix)}::${String(counter)}`,
  );

  const originationId = await events.emit({
    type: "loan.origination",
    body: {
      loan_id: loanId,
      borrower: req.borrower,
      principal: req.principalUsdc6.toString(),
      haircut_bps: 6_500,
      maturity_ts_unix: req.maturityTsUnix,
      attestation_hash: traceId,
      tx_hash: txHash,
      block_number: 3_500_000 + counter,
      block_hash: blockHash,
      params_hash: paramsHash,
    },
    parentIds: [pledgeId, traceId, synthesisId],
  });

  return {
    originationId,
    loanId,
    synthesisId,
    thoughtIds,
    traceId,
    principalUsdc6: req.principalUsdc6.toString(),
    haircutBps: 6_500,
  };
}
