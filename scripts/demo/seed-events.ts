/**
 * Demo seed — populate the runtime's event log with realistic
 * historical activity so the chat panel + detail card render lived-in
 * state from the moment the runtime starts.
 *
 * This is a one-shot, run-before-runtime script. It:
 *   1. Generates an ephemeral Ed25519 keypair (treated by auditors as
 *      a "previous TEE boot" — every signature on the seeded events
 *      verifies against the pubkey carried on the event itself; the
 *      runtime's later events use a different keypair, which is fine
 *      since each event is self-verifying).
 *   2. Wipes (or appends to) `<dataDir>/events.log`.
 *   3. Builds + signs a constitutional.genesis.
 *   4. Builds + signs ~120-150 historical events spanning the last
 *      30 days, denser in the most recent 24 hours: pool deposits,
 *      pledges, full origination chains (pledge → 2× inference + 2×
 *      thought → 1× inference + 1× synthesis → trace → origination),
 *      credit ticks, settlements, withdraws.
 *   5. Appends them in chronological order to events.log so the
 *      runtime's index rebuild orders them correctly on first boot.
 *
 * Every event is:
 *   - A real signed VantaEvent envelope (buildAndSign pipeline).
 *   - Schema-valid (strict zod parse on Step 6).
 *   - Replayable byte-for-byte via the verifier walker.
 *
 * The "scripted" part is only the LLM text, identical to the live
 * `DEMO_LLM=0` path the runner uses — not invented data.
 *
 * Usage:
 *   pnpm tsx scripts/demo/seed-events.ts             # append to log
 *   pnpm tsx scripts/demo/seed-events.ts --reset     # wipe + reseed
 */

import { generateKeyPairSync, createHash, sign as nodeSign, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync, fdatasyncSync, closeSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildAndSign,
  canonicalJsonBytes,
  type VantaEvent,
  type SignFn,
} from "@vanta/events";
import {
  asSha256Hex,
  type EthAddressHex,
  type Sha256Hex,
} from "@vanta/tee";

import { sampleNpcs, type NpcPersona } from "../../runtime/src/services/npc-personas.ts";

import { kingdomForAgentId, marketsForKingdom, type DemoMarket } from "./markets.ts";
import { pickThought } from "./personas-script.ts";


// ---------------------------------------------------------------------------
// constants + tunables
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..");
const VANTA_DATA = process.env["VANTA_DATA_DIR"] ?? resolve(REPO_ROOT, ".vanta");
const LOG_PATH = resolve(VANTA_DATA, "events.log");
const IDX_PATH = resolve(VANTA_DATA, "events.idx.json");

const NOW_S = Math.floor(Date.now() / 1000);
const NOW_MS = Date.now();
const HISTORY_DAYS = 30;
const ZERO_HEX_64 = "0".repeat(64);

// Distribution (totals to ~120 events plus the 1 genesis):
const N_DEPOSITS = 12; // 4 per agent
const N_LOAN_CHAINS = 9; // 3 per agent — each emits 8 events
const N_STANDALONE_PLEDGES = 4; // 1-2 per kingdom — older revoked or bridging-only pledges
const N_CREDIT_TICKS = 18; // 2 ticks per active loan, last 24h
const N_SETTLEMENTS = 2;
const N_WITHDRAWS = 3;

// Fixture LP wallets (anvil-style), used as historical depositors. Real
// addresses; the demo never moves money to them so it doesn't matter
// whose keys these are — they're just plausible-looking 20-byte hex.
const FIXTURE_LP_WALLETS: readonly EthAddressHex[] = [
  "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266" as EthAddressHex,
  "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" as EthAddressHex,
  "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc" as EthAddressHex,
  "0x90f79bf6eb2c4f870365e785982e1f101e93b906" as EthAddressHex,
  "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65" as EthAddressHex,
];

const FIXTURE_BORROWERS: readonly EthAddressHex[] = [
  "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc" as EthAddressHex,
  "0x976ea74026e726554db657fa54763abd0c3a0aa9" as EthAddressHex,
  "0x14dc79964da2c08b23698b3d3cc7ca32193d9955" as EthAddressHex,
  "0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f" as EthAddressHex,
];

// LpVault (per-agent ERC-4626) addresses. For the demo, vanta-opus is
// the only one with a real on-chain stack; vanta-gpt + vanta-gemini are
// fixture-only. We give all three a plausible-looking vault address so
// the chat panel renders consistent metadata.
const FIXTURE_VAULT_BY_AGENT: Readonly<Record<number, EthAddressHex>> = {
  0: "0x5e92e21c6dba03c8f8e2f2b1c1c0d8e8f8a0b0c0" as EthAddressHex,
  1: "0x5e92e21c6dba03c8f8e2f2b1c1c0d8e8f8a0b0c1" as EthAddressHex,
  2: "0x5e92e21c6dba03c8f8e2f2b1c1c0d8e8f8a0b0c2" as EthAddressHex,
};

// ---------------------------------------------------------------------------
// Ephemeral signing keypair
// ---------------------------------------------------------------------------

interface SeedTeeIdentity {
  readonly signingPubKeyHex: string;
  readonly kmsKeyHash: Sha256Hex;
  readonly attestationJwtHash: Sha256Hex;
  readonly bootedAtMs: number;
  readonly sign: SignFn;
}

function makeEphemeralIdentity(): SeedTeeIdentity {
  const pair = generateKeyPairSync("ed25519");
  const privateKey: KeyObject = pair.privateKey;
  const jwk = pair.publicKey.export({ format: "jwk" });
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    throw new Error("seed: generated keypair did not export as Ed25519 OKP JWK");
  }
  const raw = Buffer.from(jwk.x, "base64url");
  if (raw.length !== 32) throw new Error("seed: pubkey did not decode to 32 bytes");
  const pubHex = raw.toString("hex");

  const sign: SignFn = (preimage) =>
    Buffer.from(nodeSign(null, Buffer.from(preimage), privateKey));

  return {
    signingPubKeyHex: pubHex,
    // Stable demo placeholders; the runtime carries the same strings
    // through the chain on its later events (it copies kmsKeyHash from
    // genesis). 64 zero-hex matches the runtime's own dev-mode default.
    kmsKeyHash: asSha256Hex(ZERO_HEX_64),
    attestationJwtHash: asSha256Hex(ZERO_HEX_64),
    bootedAtMs: NOW_MS - HISTORY_DAYS * 86_400_000,
    sign,
  };
}

// ---------------------------------------------------------------------------
// Hash + id helpers
// ---------------------------------------------------------------------------

function sha256Hex(input: string | Uint8Array): Sha256Hex {
  return asSha256Hex(createHash("sha256").update(input).digest("hex"));
}

let counter = 0;
/** A deterministic-yet-unique 64-hex id keyed off a label. */
function fakeIdHex(label: string): Sha256Hex {
  counter += 1;
  return sha256Hex(`${label}::${String(counter)}::${String(NOW_MS)}`);
}

function fakeAddrHex(label: string): EthAddressHex {
  const h = createHash("sha256").update(`addr::${label}::${String(counter)}`).digest("hex");
  return `0x${h.slice(0, 40)}` as EthAddressHex;
}

function pickFrom<T>(arr: readonly T[], i: number): T {
  return arr[i % arr.length]!;
}

// ---------------------------------------------------------------------------
// Event sink wrapper
// ---------------------------------------------------------------------------

interface EmitArgs {
  readonly type: VantaEvent["type"];
  readonly body: Record<string, unknown>;
  readonly parentIds: readonly Sha256Hex[];
  /** Unix seconds — backdated for historical events. */
  readonly atUnix: number;
}

function appendLine(line: string): void {
  const fd = openSync(LOG_PATH, "a");
  try {
    const buf = Buffer.from(line + "\n", "utf8");
    const written = writeSync(fd, buf, 0, buf.length);
    if (written !== buf.length) throw new Error(`short write: ${String(written)}/${String(buf.length)}`);
    fdatasyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function makeEmit(identity: SeedTeeIdentity, instance: string, lineage: string): (args: EmitArgs) => Sha256Hex {
  return (args) => {
    let event: VantaEvent;
    try {
      event = buildAndSign({
        type: args.type,
        parent_ids: args.parentIds,
        lineage,
        timestamp: args.atUnix,
        epoch: Math.floor(identity.bootedAtMs / 1000),
        tee: {
          signingPubKey: identity.signingPubKeyHex,
          kmsKeyHash: identity.kmsKeyHash,
          tdxQuoteHash: null,
          attestationJwtHash: identity.attestationJwtHash,
        },
        instance,
        body: args.body as VantaEvent["body"],
        sign: identity.sign,
      });
    } catch (err: unknown) {
      console.error(`\nseed-events: buildAndSign FAILED for type=${args.type}`);
      console.error("  body:", JSON.stringify(args.body, null, 2));
      console.error("  parent_ids count:", args.parentIds.length);
      if (err instanceof Error) {
        console.error("  error:", err.message);
        const ctx = (err as Error & { context?: unknown }).context;
        if (ctx) console.error("  context:", JSON.stringify(ctx, null, 2));
      }
      throw err;
    }
    const bytes = canonicalJsonBytes(event);
    appendLine(Buffer.from(bytes).toString("utf8"));
    return event.id;
  };
}

// ---------------------------------------------------------------------------
// Genesis
// ---------------------------------------------------------------------------

function buildGenesis(identity: SeedTeeIdentity, emit: ReturnType<typeof makeEmit>): Sha256Hex {
  const constitutionHash = sha256Hex("vanta-demo-constitution-v1");
  const stewardAddrs: readonly EthAddressHex[] = [
    "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266" as EthAddressHex,
  ];
  return emit({
    type: "constitutional.genesis",
    parentIds: [],
    atUnix: Math.floor(identity.bootedAtMs / 1000),
    body: {
      constitutionHash,
      constitutionUri: "vanta://constitution/v1",
      stewardAddrs,
      quorum: 1,
    },
  });
}

// ---------------------------------------------------------------------------
// pool.deposit — historical
// ---------------------------------------------------------------------------

interface DepositPlan {
  readonly atUnix: number;
  readonly agentId: number;
  readonly depositor: EthAddressHex;
  readonly usdc6: bigint;
  readonly sharePriceE18: bigint;
}

function planDeposits(): readonly DepositPlan[] {
  const plans: DepositPlan[] = [];
  // Distribute deposits across the 30-day window with rising share price
  // (so the agent looks like it's earning interest over time).
  for (let i = 0; i < N_DEPOSITS; ++i) {
    const ageS = Math.floor((HISTORY_DAYS - 1) * 86_400 * (1 - i / N_DEPOSITS));
    const agentId = i % 3;
    const usdc = BigInt(20_000_000_000 + (i % 5) * 5_000_000_000); // $20k..$45k
    const dayProgress = ageS / (HISTORY_DAYS * 86_400); // 1 = oldest, 0 = newest
    const sharePriceE18 = BigInt(Math.round((1 + 0.047 * (1 - dayProgress)) * 1e18));
    plans.push({
      atUnix: NOW_S - ageS,
      agentId,
      depositor: pickFrom(FIXTURE_LP_WALLETS, i),
      usdc6: usdc,
      sharePriceE18,
    });
  }
  return plans.sort((a, b) => a.atUnix - b.atUnix);
}

function emitDeposit(emit: ReturnType<typeof makeEmit>, genesisId: Sha256Hex, plan: DepositPlan): Sha256Hex {
  const sharesMinted = (plan.usdc6 * 10n ** 18n) / plan.sharePriceE18;
  return emit({
    type: "pool.deposit",
    parentIds: [genesisId],
    atUnix: plan.atUnix,
    body: {
      agent_id: plan.agentId,
      depositor_addr: plan.depositor,
      usdc6_amount: plan.usdc6.toString(),
      shares_minted: sharesMinted.toString(),
      share_price_usdc6_per_share_e18: plan.sharePriceE18.toString(),
      tx_hash: fakeIdHex(`deposit-tx::${String(plan.agentId)}::${String(plan.atUnix)}`),
      block_number: 1_000_000 + Math.floor((NOW_S - plan.atUnix) / 12),
    },
  });
}

// ---------------------------------------------------------------------------
// pool.withdraw — historical
// ---------------------------------------------------------------------------

function emitWithdraw(emit: ReturnType<typeof makeEmit>, genesisId: Sha256Hex, agentId: number, atUnix: number): Sha256Hex {
  const shares = BigInt(8_000_000_000_000_000_000_000n); // ~8k shares
  const sharePriceE18 = BigInt(Math.round(1.041 * 1e18));
  const usdc6 = (shares * sharePriceE18) / 10n ** 18n;
  return emit({
    type: "pool.withdraw",
    parentIds: [genesisId],
    atUnix,
    body: {
      agent_id: agentId,
      withdrawer_addr: pickFrom(FIXTURE_LP_WALLETS, agentId + 2),
      shares_redeemed: shares.toString(),
      usdc6_returned: usdc6.toString(),
      share_price_usdc6_per_share_e18: sharePriceE18.toString(),
      tx_hash: fakeIdHex(`withdraw-tx::${String(agentId)}::${String(atUnix)}`),
      block_number: 1_500_000 + Math.floor((NOW_S - atUnix) / 12),
    },
  });
}

// ---------------------------------------------------------------------------
// loan.pledge (standalone — no origination follows)
// ---------------------------------------------------------------------------

function emitPledge(
  emit: ReturnType<typeof makeEmit>,
  genesisId: Sha256Hex,
  args: {
    readonly atUnix: number;
    readonly agentId: number;
    readonly market: DemoMarket;
    readonly principalUsdc6: bigint;
  },
): { readonly pledgeId: Sha256Hex; readonly loanId: Sha256Hex } {
  const loanId = fakeIdHex(`loan::${String(args.agentId)}::${args.market.shortName}::${String(args.atUnix)}`);
  const pledgeId = emit({
    type: "loan.pledge",
    parentIds: [genesisId],
    atUnix: args.atUnix,
    body: {
      loan_id: loanId,
      borrower_proxy: pickFrom(FIXTURE_BORROWERS, args.agentId * 3 + (args.atUnix % 3)),
      position_id: args.market.tokenId,
      amount: (args.principalUsdc6 * 2n).toString(), // pledge ~2x principal in CTF tokens
      vault_address: FIXTURE_VAULT_BY_AGENT[args.agentId]!,
      tx_hash: fakeIdHex(`pledge-tx::${String(args.atUnix)}`),
      block_number: 2_000_000 + Math.floor((NOW_S - args.atUnix) / 12),
      block_hash: fakeIdHex(`pledge-block::${String(args.atUnix)}`),
      log_index: 0,
      confirmation_depth: 12,
      condition_id: asSha256Hex(args.market.conditionIdHex),
    },
  });
  return { pledgeId, loanId };
}

// ---------------------------------------------------------------------------
// origination chain — pledge → council → trace → origination
// ---------------------------------------------------------------------------

interface CouncilArtefacts {
  readonly synthesisId: Sha256Hex;
  readonly thoughtIds: readonly Sha256Hex[];
  readonly synthesisedBeliefCentibps: number;
  readonly priorBeliefCentibps: number;
  readonly synthesisedConfidenceBps: number;
  readonly rationale: string;
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

function emitCouncilPass(
  emit: ReturnType<typeof makeEmit>,
  genesisId: Sha256Hex,
  args: {
    readonly atUnix: number;
    readonly agentId: number;
    readonly market: DemoMarket;
    readonly priorLoanHealth: number;
    readonly priorConfidence: number;
    readonly priorBeliefEventId: Sha256Hex;
  },
): CouncilArtefacts {
  const personas = sampleNpcs(args.agentId, 2, `${args.market.conditionIdHex}::seed::${String(args.atUnix)}`);
  const thoughtIds: Sha256Hex[] = [];
  const votes: Array<{ persona: NpcPersona; belief: number; confidence: number; thought: string }> = [];

  // Each persona: 1 op.inference + 1 npc.thought
  for (let i = 0; i < personas.length; ++i) {
    const persona = personas[i]!;
    const tpl = pickThought(persona.personaSlug, args.market.conditionIdHex);
    const offset = biasToOffset(tpl.bias);
    const belief = clampUnit(args.priorLoanHealth + offset);
    const confidence = biasToConfidence(tpl.bias);
    const responseText = JSON.stringify({
      thought: tpl.text,
      belief,
      confidence,
    });
    const reqHash = sha256Hex(`req::thought::${persona.personaSlug}::${args.market.conditionIdHex}::${String(args.atUnix)}`);
    const resHash = sha256Hex(responseText);

    const inferenceId = emit({
      type: "op.inference",
      parentIds: [genesisId],
      atUnix: args.atUnix - 30 + i * 10,
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
        latency_ms: 240 + (i * 40),
        started_at_unix_ms: (args.atUnix - 30 + i * 10) * 1000,
      },
    });

    const thoughtId = emit({
      type: "npc.thought",
      parentIds: [genesisId, args.priorBeliefEventId, inferenceId],
      atUnix: args.atUnix - 25 + i * 10,
      body: {
        agent_id: args.agentId,
        npc_id: persona.npcId,
        npc_persona: persona.personaSlug,
        npc_display_name: persona.displayName,
        market_id: asSha256Hex(args.market.conditionIdHex),
        thought: tpl.text,
        belief_centibps: probToCentibps(belief),
        confidence_bps: probToBps(confidence),
        inference_event_id: inferenceId,
      },
    });

    thoughtIds.push(thoughtId);
    votes.push({ persona, belief, confidence, thought: tpl.text });
  }

  // Synthesis: confidence-weighted average
  let num = args.priorLoanHealth * 0.5;
  let den = 0.5;
  let confSum = 0;
  for (const v of votes) {
    const w = Math.max(0.1, v.confidence);
    num += v.belief * w;
    den += w;
    confSum += v.confidence;
  }
  const synthBelief = clampUnit(num / den);
  const synthConfidence = Math.max(0.5, Math.min(0.92, args.priorConfidence * 0.4 + (confSum / votes.length) * 0.6));

  const top = [...votes].sort((a, b) => b.confidence - a.confidence);
  const direction = synthBelief > args.priorLoanHealth ? "up" : synthBelief < args.priorLoanHealth ? "down" : "flat";
  const cite =
    top.length >= 2
      ? `${top[0]!.persona.displayName.split(" ")[0]} flagged "${top[0]!.thought.slice(0, 80)}", and ${top[1]!.persona.displayName.split(" ")[0]} added "${top[1]!.thought.slice(0, 80)}".`
      : `${top[0]!.persona.displayName.split(" ")[0]} noted: "${top[0]!.thought.slice(0, 120)}".`;
  const rationale =
    direction === "flat"
      ? `Net of the divergent voices, the committee held the prior. ${cite}`
      : `${top.map((v) => v.persona.displayName.split(" ")[0]).join(" and ")} pulled the loan-health ${direction}. ${cite}`;

  // synthesis op.inference + council.synthesised
  const synthResponseText = JSON.stringify({ belief: synthBelief, confidence: synthConfidence, rationale });
  const synthReqHash = sha256Hex(`req::synthesis::${args.market.conditionIdHex}::${String(args.atUnix)}`);
  const synthResHash = sha256Hex(synthResponseText);

  const synthInferenceId = emit({
    type: "op.inference",
    parentIds: [genesisId],
    atUnix: args.atUnix - 5,
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
      started_at_unix_ms: (args.atUnix - 5) * 1000,
    },
  });

  const priorCentibps = probToCentibps(args.priorLoanHealth);
  const synthCentibps = probToCentibps(synthBelief);

  const synthesisId = emit({
    type: "council.synthesised",
    parentIds: [genesisId, args.priorBeliefEventId, synthInferenceId, ...thoughtIds],
    atUnix: args.atUnix,
    body: {
      agent_id: args.agentId,
      market_id: asSha256Hex(args.market.conditionIdHex),
      npc_thought_event_ids: thoughtIds,
      prior_belief_centibps: priorCentibps,
      synthesised_belief_centibps: synthCentibps,
      delta_centibps: synthCentibps - priorCentibps,
      synthesised_confidence_bps: probToBps(synthConfidence),
      rationale,
      inference_event_id: synthInferenceId,
    },
  });

  return {
    synthesisId,
    thoughtIds,
    synthesisedBeliefCentibps: synthCentibps,
    priorBeliefCentibps: priorCentibps,
    synthesisedConfidenceBps: probToBps(synthConfidence),
    rationale,
  };
}

interface OriginationOutcome {
  readonly loanId: Sha256Hex;
  readonly originationId: Sha256Hex;
  readonly atUnix: number;
  readonly principalUsdc6: bigint;
  readonly maturityTsUnix: number;
  readonly market: DemoMarket;
  readonly agentId: number;
}

function emitOriginationChain(
  emit: ReturnType<typeof makeEmit>,
  genesisId: Sha256Hex,
  args: {
    readonly atUnix: number;
    readonly agentId: number;
    readonly market: DemoMarket;
    readonly principalUsdc6: bigint;
  },
): OriginationOutcome {
  const { pledgeId, loanId } = emitPledge(emit, genesisId, args);

  // Council deliberates on loan-health; prior comes from haircut math
  // (treated as if the credit loop computed it).
  const priorLoanHealth = 0.74; // ~74% safe-repay probability — typical fresh loan
  const council = emitCouncilPass(emit, genesisId, {
    atUnix: args.atUnix + 60,
    agentId: args.agentId,
    market: args.market,
    priorLoanHealth,
    priorConfidence: 0.65,
    priorBeliefEventId: pledgeId,
  });

  // reasoning.trace summarising the underwriting decision
  const traceId = emit({
    type: "reasoning.trace",
    parentIds: [genesisId, pledgeId, council.synthesisId],
    atUnix: args.atUnix + 70,
    body: {
      subject_event_id: ZERO_HEX_64 as unknown as Sha256Hex, // back-stamped by orig
      subject_event_type: "loan.origination",
      inputs_summary: {
        market: args.market.shortName,
        agent_id: args.agentId,
        principal_usdc: (args.principalUsdc6 / 10n ** 6n).toString(),
        haircut_bps: 6_500,
        prior_health_bps: probToBps(priorLoanHealth),
        synth_health_bps: council.synthesisedBeliefCentibps,
      },
      intermediate_scores: {
        ltv_bps: 6_500,
        time_to_resolution_days: Math.floor(args.market.timeToResolutionSeconds / 86_400),
        depth_5pct_usdc_thousands: 50,
      },
      decision_rationale: council.rationale,
      dissenting_considerations: "",
      model_id: "claude-sonnet-4-6-scripted",
      prompt_hash: sha256Hex(`prompt::orig::${String(args.atUnix)}`),
    },
  });

  // Maturity around the market's resolution time
  const maturityTsUnix = args.atUnix + Math.min(args.market.timeToResolutionSeconds, 60 * 86_400);
  const txHash = fakeIdHex(`orig-tx::${String(args.atUnix)}`);
  const blockHash = fakeIdHex(`orig-block::${String(args.atUnix)}`);
  const paramsHash = sha256Hex(
    `params::${args.market.conditionIdHex}::${args.principalUsdc6.toString()}::${String(maturityTsUnix)}`,
  );

  const originationId = emit({
    type: "loan.origination",
    parentIds: [genesisId, pledgeId, traceId, council.synthesisId],
    atUnix: args.atUnix + 80,
    body: {
      loan_id: loanId,
      borrower: pickFrom(FIXTURE_BORROWERS, args.agentId + (args.atUnix % 4)),
      principal: args.principalUsdc6.toString(),
      haircut_bps: 6_500,
      maturity_ts_unix: maturityTsUnix,
      attestation_hash: traceId,
      tx_hash: txHash,
      block_number: 2_500_000 + Math.floor((NOW_S - args.atUnix) / 12),
      block_hash: blockHash,
      params_hash: paramsHash,
    },
  });

  return {
    loanId,
    originationId,
    atUnix: args.atUnix + 80,
    principalUsdc6: args.principalUsdc6,
    maturityTsUnix,
    market: args.market,
    agentId: args.agentId,
  };
}

// ---------------------------------------------------------------------------
// loop.credit_tick — for active loans, last 24h
// ---------------------------------------------------------------------------

function emitCreditTick(
  emit: ReturnType<typeof makeEmit>,
  genesisId: Sha256Hex,
  loan: OriginationOutcome,
  atUnix: number,
  ltvBps: number,
): Sha256Hex {
  const trace = emit({
    type: "reasoning.trace",
    parentIds: [genesisId, loan.originationId],
    atUnix: atUnix - 1,
    body: {
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
      prompt_hash: sha256Hex(`tick-prompt::${loan.loanId}::${String(atUnix)}`),
    },
  });

  // collateral_value derived from haircut math
  const collateralUsdc6 = (loan.principalUsdc6 * 10_000n) / BigInt(ltvBps);
  return emit({
    type: "loop.credit_tick",
    parentIds: [genesisId, loan.originationId, trace],
    atUnix,
    body: {
      loan_id: loan.loanId,
      collateral_value_usdc: collateralUsdc6.toString(),
      ltv_current_bps: ltvBps,
      trace_hash: trace,
      flag: ltvBps < 8_000 ? "ok" : ltvBps < 9_500 ? "watch" : "freeze_request",
      best_bid: loan.market.currentMid.toFixed(4),
      twap_30min: (loan.market.currentMid + 0.005).toFixed(4),
      depth_5pct_usdc: "50000000000",
      time_to_resolution_seconds: Math.max(0, loan.maturityTsUnix - atUnix),
      dispute_30d_count: 0,
    },
  });
}

// ---------------------------------------------------------------------------
// loan.settlement
// ---------------------------------------------------------------------------

function emitSettlement(
  emit: ReturnType<typeof makeEmit>,
  genesisId: Sha256Hex,
  loan: OriginationOutcome,
  atUnix: number,
): Sha256Hex {
  return emit({
    type: "loan.settlement",
    parentIds: [genesisId, loan.originationId],
    atUnix,
    body: {
      loanId: loan.loanId,
      // borrower repays principal + 4% interest
      amount: (loan.principalUsdc6 + (loan.principalUsdc6 * 4n) / 100n).toString(),
      borrowerAddr: pickFrom(FIXTURE_BORROWERS, loan.agentId + 1),
    },
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function step(label: string, fn: () => void): void {
  process.stdout.write(`vanta/seed-events: ${label}… `);
  try {
    fn();
    process.stdout.write("ok\n");
  } catch (err: unknown) {
    process.stdout.write("FAILED\n");
    throw err;
  }
}

function main(): void {
  const reset = process.argv.includes("--reset");

  console.log("=== VANTA demo seed (event log) ===");
  console.log(`data dir: ${VANTA_DATA}`);
  console.log(`mode: ${reset ? "RESET (wipe + reseed)" : "append"}\n`);

  step("preparing data dir", () => {
    mkdirSync(VANTA_DATA, { recursive: true });
    if (reset) {
      writeFileSync(LOG_PATH, "");
      // Delete the index entirely so the runtime's bootstrap rebuilds
      // from the log on next boot. (Writing `{"entries":{}}` would
      // make the bootstrap trust an empty index and skip rebuild.)
      if (existsSync(IDX_PATH)) unlinkSync(IDX_PATH);
    } else if (!existsSync(LOG_PATH)) {
      writeFileSync(LOG_PATH, "");
    }
  });

  if (!reset && existsSync(LOG_PATH) && readFileSync(LOG_PATH, "utf8").length > 0) {
    console.log("\nseed-events: existing events.log detected; pass --reset to overwrite.");
    console.log("Aborting (no events appended).");
    return;
  }

  const identity = makeEphemeralIdentity();
  const emit = makeEmit(identity, "vanta-runtime-demo-seed", "vanta-demo-seed");

  let genesisId: Sha256Hex = ZERO_HEX_64 as Sha256Hex;
  step("signing genesis", () => {
    genesisId = buildGenesis(identity, emit);
    console.log(`\n  genesis_id=${genesisId.slice(0, 12)}…`);
  });

  // Track active loans for credit ticks + settlement
  const allLoans: OriginationOutcome[] = [];
  let eventCount = 1; // genesis

  step("emitting deposits", () => {
    const plans = planDeposits();
    for (const p of plans) {
      emitDeposit(emit, genesisId, p);
      eventCount += 1;
    }
  });

  step("emitting standalone pledges (older revoked / bridging-only)", () => {
    for (let i = 0; i < N_STANDALONE_PLEDGES; ++i) {
      const agentId = i % 3;
      const kingdom = kingdomForAgentId(agentId)!;
      const market = pickFrom(marketsForKingdom(kingdom), i);
      const ageS = Math.floor((HISTORY_DAYS - 5) * 86_400 * (1 - i / N_STANDALONE_PLEDGES));
      const principal = BigInt(8_000_000_000 + (i % 3) * 4_000_000_000);
      emitPledge(emit, genesisId, {
        atUnix: NOW_S - ageS,
        agentId,
        market,
        principalUsdc6: principal,
      });
      eventCount += 1;
    }
  });

  step("emitting origination chains (8 events each)", () => {
    for (let i = 0; i < N_LOAN_CHAINS; ++i) {
      const agentId = i % 3;
      const kingdom = kingdomForAgentId(agentId)!;
      const market = pickFrom(marketsForKingdom(kingdom), Math.floor(i / 3));
      // Spread originations across last 14 days, bias to recent
      const ageS = Math.floor(14 * 86_400 * Math.pow((N_LOAN_CHAINS - i) / N_LOAN_CHAINS, 1.5));
      const principal = BigInt(15_000_000_000 + (i % 4) * 5_000_000_000); // $15k..$30k
      const outcome = emitOriginationChain(emit, genesisId, {
        atUnix: NOW_S - ageS,
        agentId,
        market,
        principalUsdc6: principal,
      });
      allLoans.push(outcome);
      eventCount += 8;
    }
  });

  // Pick the first 6 loans (oldest ones) to settle / liquidate
  const settledLoans = allLoans.slice(0, N_SETTLEMENTS);
  const activeLoans = allLoans.slice(N_SETTLEMENTS);

  step("emitting credit ticks for active loans", () => {
    let ticksLeft = N_CREDIT_TICKS;
    let pass = 0;
    while (ticksLeft > 0) {
      pass += 1;
      for (const loan of activeLoans) {
        if (ticksLeft <= 0) break;
        const ageS = Math.floor((24 / pass) * 3_600); // newer ticks for later passes
        const tickAtUnix = NOW_S - ageS;
        if (tickAtUnix <= loan.atUnix) continue;
        // Random-walk LTV around 65-78%
        const drift = (loan.atUnix % 7) - 3;
        const ltvBps = Math.max(4_000, Math.min(9_500, 6_500 + drift * 200 + pass * 100));
        emitCreditTick(emit, genesisId, loan, tickAtUnix, ltvBps);
        eventCount += 2; // trace + tick
        ticksLeft -= 1;
      }
      if (pass > 6) break;
    }
  });

  step("emitting settlements", () => {
    for (const loan of settledLoans) {
      const settleAt = Math.min(NOW_S - 6 * 3_600, loan.atUnix + 7 * 86_400);
      emitSettlement(emit, genesisId, loan, settleAt);
      eventCount += 1;
    }
  });

  step("emitting withdraws", () => {
    for (let i = 0; i < N_WITHDRAWS; ++i) {
      const agentId = i % 3;
      const ageS = Math.floor(48 * 3_600 * (i + 1) / N_WITHDRAWS);
      emitWithdraw(emit, genesisId, agentId, NOW_S - ageS);
      eventCount += 1;
    }
  });

  // Summary
  console.log("\n=== seed-events complete ===");
  console.log(`  events written: ${String(eventCount)}`);
  console.log(`  log file:       ${LOG_PATH}`);
  console.log(`  log size:       ${String(readFileSync(LOG_PATH).length)} bytes`);
  console.log(`  loans:          ${String(allLoans.length)} originated, ${String(settledLoans.length)} settled, ${String(activeLoans.length)} active`);
  console.log("\nNext: start the runtime; on first boot it will index these events.");
  console.log("Then open the game frontend — chat panel + detail card render lived-in.");
}

try {
  main();
} catch (err: unknown) {
  console.error("vanta/seed-events: FAILED");
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
}
