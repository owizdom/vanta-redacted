/**
 * Demo runner — long-running heartbeat for the 10-minute demo.
 *
 * Connects to the runtime over HTTP and POSTs fresh signed events
 * every minute (origination chains) and every 30s (credit ticks).
 * The runtime accepts each event at `/admin/demo/append-event`,
 * appends it to the event log, and fires SSE listeners — so the game
 * frontend's chat panel renders new activity continuously.
 *
 * Architecture:
 *   - The runner generates an ephemeral Ed25519 keypair (one per
 *     process). Every event it builds is signed with that key, so
 *     auditors can verify each event's signature against the pubkey
 *     it carries — same property as the seed events.
 *   - It pulls the seeded genesis id + recent loan ids from the
 *     runtime's `/api/events` endpoint, then signs new events that
 *     parent off them.
 *   - Council deliberation uses the scripted-inference function
 *     (offline-safe). When `DEMO_LLM=1` is set the runner attempts
 *     the live `adaptInferenceClient` instead — TODO: not wired in
 *     this revision; the offline path is sufficient for the demo.
 *
 * Cadence:
 *   - Every 60s — pick agent (round-robin), pick market (round-robin
 *     by kingdom), emit one full origination chain (8 events).
 *   - Every 30s — pick the most recent active loan, emit one
 *     credit-tick chain (reasoning.trace + loop.credit_tick).
 *
 * Stop with CTRL+C — the runner closes its keypair handle and exits.
 *
 * Usage:
 *   pnpm tsx scripts/demo/demo-runner.ts
 *
 * Env:
 *   VANTA_RUNTIME_URL    base URL (default http://localhost:8787)
 *   VANTA_DEMO_ADMIN     must be `1` on the *runtime* side to enable
 *                        the append-event admin route
 */

import { createHash, generateKeyPairSync, sign as nodeSign, type KeyObject } from "node:crypto";

import {
  buildAndSign,
  canonicalJsonBytes,
  type SignFn,
  type VantaEvent,
} from "@vanta/events";
import { asSha256Hex, type EthAddressHex, type Sha256Hex } from "@vanta/tee";

import { sampleNpcs, type NpcPersona } from "../../runtime/src/services/npc-personas.ts";

import { kingdomForAgentId, marketsForKingdom, type DemoMarket } from "./markets.ts";
import { pickThought } from "./personas-script.ts";

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const RUNTIME_URL = process.env["VANTA_RUNTIME_URL"] ?? "http://localhost:8787";
const ORIGINATION_PERIOD_MS = 60_000;
const CREDIT_TICK_PERIOD_MS = 30_000;
const ZERO_HEX_64 = "0".repeat(64);

const FIXTURE_BORROWERS: readonly EthAddressHex[] = [
  "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc" as EthAddressHex,
  "0x976ea74026e726554db657fa54763abd0c3a0aa9" as EthAddressHex,
  "0x14dc79964da2c08b23698b3d3cc7ca32193d9955" as EthAddressHex,
  "0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f" as EthAddressHex,
];

const FIXTURE_VAULT_BY_AGENT: Readonly<Record<number, EthAddressHex>> = {
  0: "0x5e92e21c6dba03c8f8e2f2b1c1c0d8e8f8a0b0c0" as EthAddressHex,
  1: "0x5e92e21c6dba03c8f8e2f2b1c1c0d8e8f8a0b0c1" as EthAddressHex,
  2: "0x5e92e21c6dba03c8f8e2f2b1c1c0d8e8f8a0b0c2" as EthAddressHex,
};

// ---------------------------------------------------------------------------
// keypair
// ---------------------------------------------------------------------------

interface RunnerIdentity {
  readonly signingPubKeyHex: string;
  readonly kmsKeyHash: Sha256Hex;
  readonly attestationJwtHash: Sha256Hex;
  readonly bootedAtMs: number;
  readonly sign: SignFn;
}

function makeRunnerIdentity(): RunnerIdentity {
  const pair = generateKeyPairSync("ed25519");
  const privateKey: KeyObject = pair.privateKey;
  const jwk = pair.publicKey.export({ format: "jwk" });
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    throw new Error("runner: generated keypair did not export as Ed25519 OKP JWK");
  }
  const raw = Buffer.from(jwk.x, "base64url");
  if (raw.length !== 32) throw new Error("runner: pubkey did not decode to 32 bytes");
  const sign: SignFn = (preimage) =>
    Buffer.from(nodeSign(null, Buffer.from(preimage), privateKey));
  return {
    signingPubKeyHex: raw.toString("hex"),
    kmsKeyHash: asSha256Hex(ZERO_HEX_64),
    attestationJwtHash: asSha256Hex(ZERO_HEX_64),
    bootedAtMs: Date.now(),
    sign,
  };
}

// ---------------------------------------------------------------------------
// hash helpers
// ---------------------------------------------------------------------------

function sha256Hex(s: string | Uint8Array): Sha256Hex {
  return asSha256Hex(createHash("sha256").update(s).digest("hex"));
}

let counter = 0;
function nonceHex(label: string): Sha256Hex {
  counter += 1;
  return sha256Hex(`${label}::${String(counter)}::${String(Date.now())}::${String(Math.random())}`);
}

function probToCentibps(p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1_000_000;
  return Math.round(p * 1_000_000);
}

function probToBps(p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 10_000;
  return Math.round(p * 10_000);
}

function biasToOffset(bias: number): number {
  return Math.max(-0.18, Math.min(0.18, bias * 0.06));
}

function biasToConfidence(bias: number): number {
  return Math.max(0.5, Math.min(0.85, 0.55 + Math.abs(bias) * 0.1));
}

function clampUnit(x: number): number {
  return Math.max(0.02, Math.min(0.98, x));
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function fetchGenesis(): Promise<Sha256Hex> {
  const r = await fetch(`${RUNTIME_URL}/api/events?type=constitutional.genesis&limit=1`);
  if (!r.ok) throw new Error(`fetch genesis: ${String(r.status)}`);
  const body = (await r.json()) as { events: ReadonlyArray<{ id: string }> };
  if (body.events.length === 0) throw new Error("no genesis event found in runtime log");
  return asSha256Hex(body.events[0]!.id);
}

interface RuntimeLoanRef {
  readonly originationId: Sha256Hex;
  readonly loanId: Sha256Hex;
  readonly market: DemoMarket;
  readonly principalUsdc6: bigint;
  readonly maturityTsUnix: number;
  readonly agentId: number;
}

async function fetchRecentOriginations(limit: number): Promise<readonly RuntimeLoanRef[]> {
  const r = await fetch(`${RUNTIME_URL}/api/events?type=loan.origination&limit=${String(limit)}`);
  if (!r.ok) return [];
  const body = (await r.json()) as {
    events: ReadonlyArray<{
      id: string;
      timestamp: number;
      body: { loan_id: string; principal: string; maturity_ts_unix: number };
    }>;
  };
  // We don't have agent_id or market on loan.origination directly, so we
  // pick a kingdom by hashing the loan_id. The tick purpose is just to
  // animate — chat panel renders fine with synthetic kingdom mapping.
  const out: RuntimeLoanRef[] = [];
  for (const ev of body.events) {
    const seed = ev.body.loan_id.charCodeAt(0) + ev.body.loan_id.charCodeAt(7);
    const agentId = seed % 3;
    const kingdom = kingdomForAgentId(agentId);
    if (kingdom === null) continue;
    const markets = marketsForKingdom(kingdom);
    const market = markets[(seed * 7) % markets.length]!;
    out.push({
      originationId: asSha256Hex(ev.id),
      loanId: asSha256Hex(ev.body.loan_id),
      principalUsdc6: BigInt(ev.body.principal),
      maturityTsUnix: ev.body.maturity_ts_unix,
      market,
      agentId,
    });
  }
  return out;
}

async function postSignedEvent(event: VantaEvent): Promise<void> {
  const r = await fetch(`${RUNTIME_URL}/admin/demo/append-event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: Buffer.from(canonicalJsonBytes(event)).toString("utf8"),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`append-event ${String(r.status)}: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// event builders (mirror seed-events.ts shapes)
// ---------------------------------------------------------------------------

interface SignedSinkArgs {
  readonly identity: RunnerIdentity;
  readonly genesisId: Sha256Hex;
}

function signEvent(
  args: SignedSinkArgs,
  type: VantaEvent["type"],
  body: Record<string, unknown>,
  parentIds: readonly Sha256Hex[],
  atUnix: number,
): VantaEvent {
  return buildAndSign({
    type,
    parent_ids: parentIds,
    lineage: "vanta-demo-runner",
    timestamp: atUnix,
    epoch: Math.floor(args.identity.bootedAtMs / 1000),
    tee: {
      signingPubKey: args.identity.signingPubKeyHex,
      kmsKeyHash: args.identity.kmsKeyHash,
      tdxQuoteHash: null,
      attestationJwtHash: args.identity.attestationJwtHash,
    },
    instance: "vanta-runtime-demo-runner",
    body: body as VantaEvent["body"],
    sign: args.identity.sign,
  });
}

function pickFrom<T>(arr: readonly T[], i: number): T {
  return arr[i % arr.length]!;
}

interface CouncilArtefacts {
  readonly synthesisId: Sha256Hex;
  readonly thoughtIds: readonly Sha256Hex[];
  readonly priorBeliefCentibps: number;
  readonly synthBeliefCentibps: number;
  readonly synthConfidenceBps: number;
  readonly rationale: string;
  readonly emitted: readonly VantaEvent[];
}

function buildCouncilPass(
  args: SignedSinkArgs,
  ctx: {
    readonly atUnix: number;
    readonly agentId: number;
    readonly market: DemoMarket;
    readonly priorLoanHealth: number;
    readonly priorConfidence: number;
    readonly priorBeliefEventId: Sha256Hex;
  },
): CouncilArtefacts {
  const personas = sampleNpcs(ctx.agentId, 2, `${ctx.market.conditionIdHex}::runner::${String(ctx.atUnix)}::${String(counter)}`);
  const emitted: VantaEvent[] = [];
  const thoughtIds: Sha256Hex[] = [];
  const votes: Array<{ persona: NpcPersona; belief: number; confidence: number; thought: string }> = [];

  for (let i = 0; i < personas.length; ++i) {
    const persona = personas[i]!;
    const tpl = pickThought(persona.personaSlug, `${ctx.market.conditionIdHex}::${String(ctx.atUnix)}`);
    const offset = biasToOffset(tpl.bias);
    const belief = clampUnit(ctx.priorLoanHealth + offset);
    const confidence = biasToConfidence(tpl.bias);
    const responseText = JSON.stringify({ thought: tpl.text, belief, confidence });
    const reqHash = sha256Hex(`req::thought::${persona.personaSlug}::${ctx.market.conditionIdHex}::${String(ctx.atUnix)}::${String(counter)}`);
    const resHash = sha256Hex(`${responseText}::${nonceHex("nonce")}`);

    const inferenceEv = signEvent(
      args,
      "op.inference",
      {
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
        started_at_unix_ms: (ctx.atUnix - 30 + i * 10) * 1000,
      },
      [args.genesisId],
      ctx.atUnix - 30 + i * 10,
    );
    emitted.push(inferenceEv);

    const thoughtEv = signEvent(
      args,
      "npc.thought",
      {
        agent_id: ctx.agentId,
        npc_id: persona.npcId,
        npc_persona: persona.personaSlug,
        npc_display_name: persona.displayName,
        market_id: asSha256Hex(ctx.market.conditionIdHex),
        thought: tpl.text,
        belief_centibps: probToCentibps(belief),
        confidence_bps: probToBps(confidence),
        inference_event_id: inferenceEv.id,
      },
      [args.genesisId, ctx.priorBeliefEventId, inferenceEv.id],
      ctx.atUnix - 25 + i * 10,
    );
    emitted.push(thoughtEv);
    thoughtIds.push(thoughtEv.id);
    votes.push({ persona, belief, confidence, thought: tpl.text });
  }

  // synthesis
  let num = ctx.priorLoanHealth * 0.5;
  let den = 0.5;
  let confSum = 0;
  for (const v of votes) {
    const w = Math.max(0.1, v.confidence);
    num += v.belief * w;
    den += w;
    confSum += v.confidence;
  }
  const synthBelief = clampUnit(num / den);
  const synthConfidence = Math.max(0.5, Math.min(0.92, ctx.priorConfidence * 0.4 + (confSum / votes.length) * 0.6));

  const top = [...votes].sort((a, b) => b.confidence - a.confidence);
  const direction = synthBelief > ctx.priorLoanHealth ? "up" : synthBelief < ctx.priorLoanHealth ? "down" : "flat";
  const cite =
    top.length >= 2
      ? `${top[0]!.persona.displayName.split(" ")[0]} flagged "${top[0]!.thought.slice(0, 80)}", and ${top[1]!.persona.displayName.split(" ")[0]} added "${top[1]!.thought.slice(0, 80)}".`
      : `${top[0]!.persona.displayName.split(" ")[0]} noted: "${top[0]!.thought.slice(0, 120)}".`;
  const rationale =
    direction === "flat"
      ? `Net of the divergent voices, the committee held the prior. ${cite}`
      : `${top.map((v) => v.persona.displayName.split(" ")[0]).join(" and ")} pulled the loan-health ${direction}. ${cite}`;

  const synthResponseText = JSON.stringify({ belief: synthBelief, confidence: synthConfidence, rationale });
  const synthReqHash = sha256Hex(`req::synthesis::${ctx.market.conditionIdHex}::${String(ctx.atUnix)}::${String(counter)}`);
  const synthResHash = sha256Hex(`${synthResponseText}::${nonceHex("synthnonce")}`);

  const synthInferenceEv = signEvent(
    args,
    "op.inference",
    {
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
      started_at_unix_ms: (ctx.atUnix - 5) * 1000,
    },
    [args.genesisId],
    ctx.atUnix - 5,
  );
  emitted.push(synthInferenceEv);

  const priorCentibps = probToCentibps(ctx.priorLoanHealth);
  const synthCentibps = probToCentibps(synthBelief);

  const synthEv = signEvent(
    args,
    "council.synthesised",
    {
      agent_id: ctx.agentId,
      market_id: asSha256Hex(ctx.market.conditionIdHex),
      npc_thought_event_ids: thoughtIds,
      prior_belief_centibps: priorCentibps,
      synthesised_belief_centibps: synthCentibps,
      delta_centibps: synthCentibps - priorCentibps,
      synthesised_confidence_bps: probToBps(synthConfidence),
      rationale,
      inference_event_id: synthInferenceEv.id,
    },
    [args.genesisId, ctx.priorBeliefEventId, synthInferenceEv.id, ...thoughtIds],
    ctx.atUnix,
  );
  emitted.push(synthEv);

  return {
    synthesisId: synthEv.id,
    thoughtIds,
    priorBeliefCentibps: priorCentibps,
    synthBeliefCentibps: synthCentibps,
    synthConfidenceBps: probToBps(synthConfidence),
    rationale,
    emitted,
  };
}

interface OriginationOutcome {
  readonly events: readonly VantaEvent[];
  readonly originationId: Sha256Hex;
  readonly loanId: Sha256Hex;
  readonly market: DemoMarket;
  readonly agentId: number;
}

function buildOriginationChain(args: SignedSinkArgs, agentId: number, marketIdx: number): OriginationOutcome {
  const kingdom = kingdomForAgentId(agentId);
  if (kingdom === null) throw new Error(`no kingdom for agent ${String(agentId)}`);
  const markets = marketsForKingdom(kingdom);
  const market = pickFrom(markets, marketIdx);

  const events: VantaEvent[] = [];
  const atUnix = Math.floor(Date.now() / 1000);
  const principalUsdc6 = BigInt(15_000_000_000 + (counter % 4) * 5_000_000_000);
  const loanId = nonceHex(`loan::${String(agentId)}::${market.shortName}`);
  const borrower = pickFrom(FIXTURE_BORROWERS, counter);

  const pledgeEv = signEvent(
    args,
    "loan.pledge",
    {
      loan_id: loanId,
      borrower_proxy: borrower,
      position_id: market.tokenId,
      amount: (principalUsdc6 * 2n).toString(),
      vault_address: FIXTURE_VAULT_BY_AGENT[agentId]!,
      tx_hash: nonceHex("pledge-tx"),
      block_number: 3_000_000 + counter,
      block_hash: nonceHex("pledge-block"),
      log_index: 0,
      confirmation_depth: 12,
      condition_id: asSha256Hex(market.conditionIdHex),
    },
    [args.genesisId],
    atUnix - 60,
  );
  events.push(pledgeEv);

  const council = buildCouncilPass(args, {
    atUnix,
    agentId,
    market,
    priorLoanHealth: 0.74,
    priorConfidence: 0.65,
    priorBeliefEventId: pledgeEv.id,
  });
  events.push(...council.emitted);

  const traceEv = signEvent(
    args,
    "reasoning.trace",
    {
      subject_event_id: ZERO_HEX_64 as unknown as Sha256Hex,
      subject_event_type: "loan.origination",
      inputs_summary: {
        market: market.shortName,
        agent_id: agentId,
        principal_usdc: (principalUsdc6 / 10n ** 6n).toString(),
        haircut_bps: 6_500,
        prior_health_bps: probToBps(0.74),
        synth_health_bps: council.synthBeliefCentibps,
      },
      intermediate_scores: {
        ltv_bps: 6_500,
        time_to_resolution_days: Math.floor(market.timeToResolutionSeconds / 86_400),
        depth_5pct_usdc_thousands: 50,
      },
      decision_rationale: council.rationale,
      dissenting_considerations: "",
      model_id: "claude-sonnet-4-6-scripted",
      prompt_hash: sha256Hex(`runner-prompt::orig::${String(atUnix)}::${String(counter)}`),
    },
    [args.genesisId, pledgeEv.id, council.synthesisId],
    atUnix + 5,
  );
  events.push(traceEv);

  const maturityTsUnix = atUnix + Math.min(market.timeToResolutionSeconds, 60 * 86_400);
  const txHash = nonceHex("orig-tx");
  const blockHash = nonceHex("orig-block");
  const paramsHash = sha256Hex(`params::${market.conditionIdHex}::${principalUsdc6.toString()}::${String(maturityTsUnix)}::${String(counter)}`);

  const originationEv = signEvent(
    args,
    "loan.origination",
    {
      loan_id: loanId,
      borrower,
      principal: principalUsdc6.toString(),
      haircut_bps: 6_500,
      maturity_ts_unix: maturityTsUnix,
      attestation_hash: traceEv.id,
      tx_hash: txHash,
      block_number: 3_500_000 + counter,
      block_hash: blockHash,
      params_hash: paramsHash,
    },
    [args.genesisId, pledgeEv.id, traceEv.id, council.synthesisId],
    atUnix + 10,
  );
  events.push(originationEv);

  return { events, originationId: originationEv.id, loanId, market, agentId };
}

function buildCreditTickChain(args: SignedSinkArgs, loan: RuntimeLoanRef): readonly VantaEvent[] {
  const atUnix = Math.floor(Date.now() / 1000);
  // Random-walk LTV around 65-78%
  const ltvBps = Math.max(4_000, Math.min(9_500, 6_500 + ((counter % 7) - 3) * 200));
  const collateralUsdc6 = (loan.principalUsdc6 * 10_000n) / BigInt(ltvBps);

  const traceEv = signEvent(
    args,
    "reasoning.trace",
    {
      subject_event_id: ZERO_HEX_64 as unknown as Sha256Hex,
      subject_event_type: "loop.credit_tick",
      inputs_summary: {
        market: loan.market.shortName,
        loan_id: loan.loanId.slice(0, 12),
        principal_usdc: (loan.principalUsdc6 / 10n ** 6n).toString(),
        ltv_bps: ltvBps,
      },
      intermediate_scores: {
        ltv_bps: ltvBps,
        time_remaining_days: Math.max(0, Math.floor((loan.maturityTsUnix - atUnix) / 86_400)),
      },
      decision_rationale:
        ltvBps < 8_000
          ? "Loan is comfortably under the freeze threshold; no action."
          : ltvBps < 9_500
            ? "Within the watch band — monitoring closely."
            : "Approaching freeze threshold; prepared to mark and call.",
      dissenting_considerations: "",
      model_id: "credit-loop-v1",
      prompt_hash: sha256Hex(`runner-tick::${loan.loanId}::${String(atUnix)}::${String(counter)}`),
    },
    [args.genesisId, loan.originationId],
    atUnix - 1,
  );

  const tickEv = signEvent(
    args,
    "loop.credit_tick",
    {
      loan_id: loan.loanId,
      collateral_value_usdc: collateralUsdc6.toString(),
      ltv_current_bps: ltvBps,
      trace_hash: traceEv.id,
      flag: ltvBps < 8_000 ? "ok" : ltvBps < 9_500 ? "watch" : "freeze_request",
      best_bid: loan.market.currentMid.toFixed(4),
      twap_30min: (loan.market.currentMid + 0.005).toFixed(4),
      depth_5pct_usdc: "50000000000",
      time_to_resolution_seconds: Math.max(0, loan.maturityTsUnix - atUnix),
      dispute_30d_count: 0,
    },
    [args.genesisId, loan.originationId, traceEv.id],
    atUnix,
  );

  return [traceEv, tickEv];
}

// ---------------------------------------------------------------------------
// main loop
// ---------------------------------------------------------------------------

interface RunnerState {
  readonly identity: RunnerIdentity;
  readonly genesisId: Sha256Hex;
  agentRoundRobin: number;
  marketRoundRobin: number;
  recentLoans: RuntimeLoanRef[];
}

async function originationTick(state: RunnerState): Promise<void> {
  const agentId = state.agentRoundRobin % 3;
  state.agentRoundRobin += 1;
  const marketIdx = state.marketRoundRobin;
  state.marketRoundRobin += 1;

  let outcome: OriginationOutcome;
  try {
    outcome = buildOriginationChain({ identity: state.identity, genesisId: state.genesisId }, agentId, marketIdx);
  } catch (err) {
    console.error(`runner: build origination FAILED:`, err);
    return;
  }
  for (const ev of outcome.events) {
    try {
      await postSignedEvent(ev);
    } catch (err) {
      console.error(`runner: post ${ev.type} FAILED:`, err);
      return;
    }
  }
  state.recentLoans.unshift({
    originationId: outcome.originationId,
    loanId: outcome.loanId,
    market: outcome.market,
    principalUsdc6: BigInt(outcome.events[outcome.events.length - 1]!.body["principal"] as string),
    maturityTsUnix: outcome.events[outcome.events.length - 1]!.body["maturity_ts_unix"] as number,
    agentId: outcome.agentId,
  });
  if (state.recentLoans.length > 12) state.recentLoans.length = 12;
  const ts = new Date().toISOString().slice(11, 19);
  console.log(
    `[${ts}] runner: emitted origination chain — agent=${String(outcome.agentId)} market=${outcome.market.shortName} (8 events)`,
  );
}

async function creditTickStep(state: RunnerState): Promise<void> {
  const loan = state.recentLoans[counter % Math.max(1, state.recentLoans.length)];
  if (loan === undefined) return;
  const events = buildCreditTickChain({ identity: state.identity, genesisId: state.genesisId }, loan);
  for (const ev of events) {
    try {
      await postSignedEvent(ev);
    } catch (err) {
      console.error(`runner: post ${ev.type} FAILED:`, err);
      return;
    }
  }
  const ts = new Date().toISOString().slice(11, 19);
  console.log(
    `[${ts}] runner: emitted credit-tick — loan=${loan.loanId.slice(0, 8)} (${loan.market.shortName}, agent=${String(loan.agentId)})`,
  );
}

async function main(): Promise<void> {
  console.log("=== VANTA demo runner ===");
  console.log(`runtime URL: ${RUNTIME_URL}`);

  const identity = makeRunnerIdentity();
  console.log(`signing pubkey: ${identity.signingPubKeyHex.slice(0, 16)}…`);

  let genesisId: Sha256Hex;
  try {
    genesisId = await fetchGenesis();
  } catch (err) {
    console.error("runner: failed to fetch genesis from runtime", err);
    process.exit(1);
  }
  console.log(`genesis_id: ${genesisId.slice(0, 12)}…`);

  const recentLoans = await fetchRecentOriginations(12);
  console.log(`bootstrapped recent loans: ${String(recentLoans.length)}`);

  const state: RunnerState = {
    identity,
    genesisId,
    agentRoundRobin: 0,
    marketRoundRobin: 0,
    recentLoans: [...recentLoans],
  };

  console.log(
    `\nrunner active. origination cadence ${String(ORIGINATION_PERIOD_MS / 1000)}s, credit-tick cadence ${String(CREDIT_TICK_PERIOD_MS / 1000)}s.`,
  );
  console.log("Press CTRL+C to stop.\n");

  // Kick the origination immediately, then tick.
  void originationTick(state);

  const origTimer = setInterval(() => {
    void originationTick(state);
  }, ORIGINATION_PERIOD_MS);

  const tickTimer = setInterval(() => {
    void creditTickStep(state);
  }, CREDIT_TICK_PERIOD_MS);

  const onSignal = (sig: string): void => {
    console.log(`\nrunner: received ${sig}, shutting down.`);
    clearInterval(origTimer);
    clearInterval(tickTimer);
    process.exit(0);
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
}

main().catch((err) => {
  console.error("runner: fatal", err);
  process.exit(1);
});
