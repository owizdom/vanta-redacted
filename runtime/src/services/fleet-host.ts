/**
 * Fleet host — spawns one credit loop per registered VANTA, each
 * with its own NPC council in lender mode. Per-VANTA isolation:
 * each loop pulls its loans from its own LoanBook reader, observes
 * its own market data, runs its own council pass.
 *
 * Boot flow (`main.ts`):
 *   1. AgentRegistry reader yields N agents
 *   2. For each agent, host builds:
 *        - a credit loop wired to the agent's loan registry + observer
 *        - an NPC council (lending mode) sharing the runtime's signed
 *          event sink + the agent_id
 *   3. host.start() boots all loops in parallel
 *   4. host.stop() awaits a graceful shutdown of every loop
 *
 * The host doesn't own the *content* of those loops — it just
 * composes them. Production wiring supplies real `loansFor` /
 * `observeFor` adapters that hit Base Sepolia + Polymarket; dev
 * supplies fixtures.
 */

import type { Sha256Hex } from "@vanta/tee";

import type {
  ActiveLoanView,
  CreditObservation,
} from "../loops/credit.js";
import { createCreditLoop } from "../loops/credit.js";
import type { LoopContext, ReasoningLoop } from "../loops/types.js";

import type { AgentRegistryReader } from "./agent-registry-reader.js";
import { createNpcCouncil, type CouncilInferenceFn } from "./npc-council.js";

export interface FleetHostArgs {
  /** Registry reader (fixture or viem). */
  readonly registry: AgentRegistryReader;
  /** Shared loop context — events sink, clock, genesis id. */
  readonly ctx: LoopContext;
  /** Per-agent active-loan list. Returns empty array if the VANTA has no loans. */
  readonly loansFor: (agentId: number) => Promise<readonly ActiveLoanView[]>;
  /** Per-agent observation. Production hits Polymarket + UMA. */
  readonly observeFor: (
    agentId: number,
    loan: ActiveLoanView,
  ) => Promise<CreditObservation>;
  /**
   * Per-agent council inference function. Returns `null` to disable
   * the council for that agent (e.g. during paper-only smoke runs).
   */
  readonly councilInferenceFor: (
    agentId: number,
  ) => CouncilInferenceFn | null;
  /** Tick cadence per loop. Default 60s. */
  readonly tickSeconds?: number;
  /** Council cooldown per (agent, market). Default 90s. */
  readonly councilCooldownMs?: number;
  /** NPCs sampled per council pass. Default 2. */
  readonly councilSampleSize?: number;
}

export interface FleetHost {
  /** Boot every per-VANTA credit loop. Idempotent — safe to call once at startup. */
  readonly start: () => Promise<void>;
  /** Graceful shutdown — awaits every loop's stop(). */
  readonly stop: () => Promise<void>;
  /** Snapshot of the current per-agent loop refs (for HTTP introspection). */
  readonly loops: () => ReadonlyArray<{
    readonly agent_id: number;
    readonly loop: ReasoningLoop;
  }>;
}

export function createFleetHost(args: FleetHostArgs): FleetHost {
  let started = false;
  const builtLoops: Array<{ agent_id: number; loop: ReasoningLoop }> = [];

  const start = async (): Promise<void> => {
    if (started) return;
    started = true;

    const agents = await args.registry.listAgents();
    for (const agent of agents) {
      if (agent.paused) continue;

      const inferenceFn = args.councilInferenceFor(agent.agent_id);
      const council =
        inferenceFn === null
          ? undefined
          : createNpcCouncil({
              agent_id: agent.agent_id,
              events: args.ctx.events,
              genesis_id: args.ctx.genesisId,
              runInference: inferenceFn,
              mode: "lending",
              ...(args.councilCooldownMs !== undefined
                ? { cooldownMs: args.councilCooldownMs }
                : {}),
              ...(args.councilSampleSize !== undefined
                ? { sampleSize: args.councilSampleSize }
                : {}),
            });

      const loopArgs: Parameters<typeof createCreditLoop>[0] = {
        ctx: args.ctx,
        listActiveLoans: () => args.loansFor(agent.agent_id),
        observe: (loan) => args.observeFor(agent.agent_id, loan),
        agent_id: agent.agent_id,
        ...(args.tickSeconds !== undefined
          ? { tickSeconds: args.tickSeconds }
          : {}),
        ...(council !== undefined ? { council } : {}),
      };
      const loop = createCreditLoop(loopArgs);
      loop.start();
      builtLoops.push({ agent_id: agent.agent_id, loop });
    }
  };

  const stop = async (): Promise<void> => {
    await Promise.allSettled(builtLoops.map((b) => b.loop.stop()));
  };

  const loops = (): ReadonlyArray<{
    readonly agent_id: number;
    readonly loop: ReasoningLoop;
  }> => builtLoops.slice();

  return { start, stop, loops };
}

/** Suppress council per-agent — useful for offline smoke runs. */
export function noCouncilInference(): (
  agentId: number,
) => CouncilInferenceFn | null {
  return () => null;
}

/** Re-export the genesis-id helper so smoke tests can stamp deterministic ids. */
export type { Sha256Hex };
