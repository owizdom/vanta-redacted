/**
 * Smoke test for the onboarding cycle (paper §6).
 *
 * Runs four candidates through `createOnboardingLoop` and asserts the
 * expected (decision, gate-floor) outcomes:
 *
 *   1. Healthy candidate, fully clear text → onboard
 *   2. Healthy candidate, ambiguous text   → reject (text_score gate fails)
 *   3. Healthy text but thin depth         → reject (depth gate fails)
 *   4. Healthy candidate but cluster-saturated → flag_for_human_review
 *
 * Run with: pnpm --filter @vanta/runtime smoke:onboarding
 */

import { createHash } from "node:crypto";

import { asSha256Hex, type Sha256Hex } from "@vanta/tee";

import { createOnboardingLoop } from "./onboard.js";
import type { CandidateInputs, OnboardDecisionBody } from "./types.js";
import type { ExposureSnapshot } from "./reasoning.js";
import type { EventSink, LoopClock, LoopContext } from "../loops/types.js";

interface CapturedEvent {
  readonly type: string;
  readonly body: object;
  readonly parentIds: readonly Sha256Hex[];
  readonly id: Sha256Hex;
}

function makeInMemorySink(): { sink: EventSink; events: CapturedEvent[] } {
  const events: CapturedEvent[] = [];
  let counter = 0;
  const sink: EventSink = {
    async emit({ type, body, parentIds }) {
      counter += 1;
      const seed = `${String(counter)}|${type}|${JSON.stringify(body)}`;
      const id = asSha256Hex(createHash("sha256").update(seed).digest("hex"));
      events.push({ type, body, parentIds, id });
      return id;
    },
  };
  return { sink, events };
}

const NOW_MS = Date.UTC(2026, 4, 1);
const GENESIS_ID = asSha256Hex("0".repeat(64));

function makeCtx(sink: EventSink): LoopContext {
  const stub = {} as unknown as LoopContext["base"];
  const clock: LoopClock = { nowMs: () => NOW_MS };
  return { base: stub, amoy: stub, events: sink, clock, genesisId: GENESIS_ID };
}

function templateHash(text: string): Sha256Hex {
  return asSha256Hex(createHash("sha256").update(text).digest("hex"));
}

const TEMPLATE = "<<EVENT>> resolves YES if <<CONDITION>> by <<DATE>> per <<SOURCE>>.";
const TEMPLATE_HASH = templateHash(TEMPLATE);

function makeCandidate(args: {
  readonly id: string;
  readonly text: string;
  readonly depth: bigint;
  readonly tags: readonly string[];
  readonly templateMatch?: boolean;
  readonly hammingFromTemplate?: number;
}): CandidateInputs {
  const candidate: CandidateInputs = {
    market_id: asSha256Hex(createHash("sha256").update(args.id).digest("hex")),
    depth_5pct_usdc: args.depth.toString(),
    dispute_30d_count: 0,
    age_days: 30,
    vol_7d: 0.15,
    text_hash: asSha256Hex(createHash("sha256").update(args.text).digest("hex")),
    text: args.text,
    tags: args.tags,
    resolver_address: "0x1234567890abcdef1234567890abcdef12345678",
    nearest_template_hash: args.templateMatch === false ? null : TEMPLATE_HASH,
    text_template_hamming: args.hammingFromTemplate ?? 12,
    depth_history_30d: Array(30).fill(args.depth.toString()),
  };
  return candidate;
}

async function main(): Promise<void> {
  console.log("--- onboarding cycle ---");

  const candidates: CandidateInputs[] = [
    // 1. Clean candidate, tag with no existing exposure → should onboard.
    makeCandidate({
      id: "geopolitics-russia-treaty",
      text: "Resolves YES if a formal cease-fire treaty between Russia and Ukraine is signed and announced by Reuters, AP, or Bloomberg before January 20, 2027.",
      depth: 300_000n * 10n ** 6n,
      tags: ["geopolitics"],
    }),
    // 2. Ambiguous text — text_score gate fails.
    makeCandidate({
      id: "ambiguous-wins",
      text: "Resolves YES if Trump wins.",
      depth: 300_000n * 10n ** 6n,
      tags: ["us-elections-2028"],
    }),
    // 3. Healthy text, thin depth — depth gate fails.
    makeCandidate({
      id: "fomc-thin-depth",
      text: "Resolves YES if the Federal Reserve cuts the federal funds rate by 25 bps or more at the FOMC meeting in December 2026, per the official FOMC statement.",
      depth: 50_000n * 10n ** 6n,
      tags: ["fomc-2026"],
    }),
    // 4. Healthy candidate, cluster-saturated tag → flag_for_human_review
    //    OR onboard with sharply-reduced cap vs candidate 1.
    makeCandidate({
      id: "2028-fl-senate",
      text: "Resolves YES if the Republican candidate for U.S. Senate in Florida is certified the winner of the 2028 general election by January 6, 2029, per AP coverage.",
      depth: 300_000n * 10n ** 6n,
      tags: ["us-elections-2028"],
    }),
  ];

  // Pre-existing exposure heavily concentrated in us-elections-2028 — the
  // 4th candidate's cluster factor should drop significantly.
  const exposure: ExposureSnapshot = {
    per_tag_usdc: new Map([
      ["us-elections-2028", 800_000n * 10n ** 6n],
      ["fomc-2026", 100_000n * 10n ** 6n],
    ]),
    open_market_ids: new Set(),
  };

  const { sink, events } = makeInMemorySink();
  const ctx = makeCtx(sink);

  const loop = createOnboardingLoop({
    ctx,
    fetchCandidates: () => Promise.resolve(candidates),
    fetchExposure: () => Promise.resolve(exposure),
  });

  await loop.runTick();

  console.log(`emitted ${String(events.length)} events:\n`);
  const decisions = events.filter(
    (e): e is CapturedEvent & { body: OnboardDecisionBody } =>
      e.type === "loop.onboard_decision",
  );
  for (const e of decisions) {
    const failedGates = e.body.gate_results.filter((g) => !g.pass).map((g) => g.gate);
    console.log(
      `  ${e.body.market_id.slice(0, 12)}… → ${e.body.decision}${failedGates.length > 0 ? ` (failed: ${failedGates.join(",")})` : ""} cap=${(Number(BigInt(e.body.cap_initial_usdc)) / 1e6).toFixed(0)} USDC ltv=${String(e.body.ltv_max_bps)}bps`,
    );
  }

  const traceCount = events.filter((e) => e.type === "reasoning.trace").length;
  if (traceCount !== candidates.length) {
    throw new Error(`expected ${String(candidates.length)} traces, got ${String(traceCount)}`);
  }
  if (decisions.length !== candidates.length) {
    throw new Error(`expected ${String(candidates.length)} decisions, got ${String(decisions.length)}`);
  }

  // Assertions (smoke-level):
  const [d1, d2, d3, d4] = decisions;
  if (!d1 || d1.body.decision !== "onboard") {
    throw new Error(`candidate 1 expected onboard, got ${d1?.body.decision}`);
  }
  if (!d2 || d2.body.decision !== "reject") {
    throw new Error(`candidate 2 expected reject, got ${d2?.body.decision}`);
  }
  if (!d3 || d3.body.decision !== "reject") {
    throw new Error(`candidate 3 expected reject, got ${d3?.body.decision}`);
  }
  if (!d4 || (d4.body.decision !== "onboard" && d4.body.decision !== "flag_for_human_review")) {
    throw new Error(`candidate 4 expected onboard|flag_for_human_review, got ${d4?.body.decision}`);
  }
  // Cluster saturation should pull candidate 4's cap below candidate 1's.
  if (BigInt(d4.body.cap_initial_usdc) >= BigInt(d1.body.cap_initial_usdc)) {
    throw new Error(
      `cluster-saturated candidate 4 cap (${d4.body.cap_initial_usdc}) should be < clean candidate 1 cap (${d1.body.cap_initial_usdc})`,
    );
  }

  console.log("\nonboarding smoke test passed.");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
