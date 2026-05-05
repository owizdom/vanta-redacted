/**
 * `/bridge/*` — internal endpoints for the vanta-watchable Minecraft layer.
 *
 * Feature-gated by `WATCHABLE_ENABLED=1`. Off in production deploys; on
 * for the docker-compose.watchable.yml stack.
 *
 * Five endpoints, all unauthenticated (the watchable stack is on a
 * docker network not reachable from outside in v0.1):
 *
 *   GET  /bridge/wizard/online  — heartbeat for npcs to wait on at boot
 *   GET  /bridge/wizard/mode    — current wizard mode (at_desk | on_break)
 *   POST /bridge/wizard/think   — calls inference client, returns one line
 *   POST /bridge/town/event     — grounding event for ambient bots (200 ok)
 *   POST /bridge/town/:bot      — returns a canned line from a per-bot pool
 *
 * v0.1 keeps this minimal: no LLM calls for the population bots (canned
 * pool only — the wizard is the only chat-facing live LLM surface). The
 * bots' speech budget stays bounded.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { InferenceError } from "../../services/inference.js";

// -----------------------------------------------------------------------
// Wizard mode state — module-local, deterministic flip cadence
// -----------------------------------------------------------------------

const MODE_FLIP_MIN_MS = 2.5 * 60 * 1_000; // 2.5 minutes
const MODE_FLIP_MAX_MS = 3.0 * 60 * 1_000; // 3.0 minutes

interface WizardModeState {
  mode: "at_desk" | "on_break";
  flippedAtMs: number;
  nextFlipAtMs: number;
}

function pickNextFlipMs(now: number): number {
  const span = MODE_FLIP_MAX_MS - MODE_FLIP_MIN_MS;
  return now + MODE_FLIP_MIN_MS + Math.floor(Math.random() * span);
}

function getCurrentMode(state: WizardModeState, now: number): WizardModeState {
  if (now < state.nextFlipAtMs) return state;
  // The wizard spends 80% of his time at the desk and 20% on break —
  // bias the flip so at_desk is the strong attractor.
  const stayAtDesk = Math.random() < 0.8;
  const nextMode = stayAtDesk ? "at_desk" : "on_break";
  return {
    mode: nextMode,
    flippedAtMs: now,
    nextFlipAtMs: pickNextFlipMs(now),
  };
}

// -----------------------------------------------------------------------
// Canned town speech pools (per-bot)
// -----------------------------------------------------------------------

const TOWN_POOLS: Record<string, readonly string[]> = {
  ada: [
    "the underwriter just walked past with a yellow torch.",
    "treasury bell rang earlier, did you hear it?",
    "i'm watching that 2028 nomination market — depth's been thinning.",
    "wizard's still at his desk. he'll break soon.",
    "the calibration loop is due to fire this week.",
    "loop.credit_tick rate looks healthy.",
  ],
  ren: [
    "another origination on the wall.",
    "the runway sign just refreshed — looking good.",
    "i wonder if anyone'll ask the wizard about pledging today.",
    "saw a freeze_request flag flicker red. then green again. close call.",
    "the LP vault chest is fuller than yesterday.",
    "history hall's got a new stained glass.",
  ],
  default: [
    "a quiet day at the tower.",
    "the agent ticks on.",
    "i was here before the redeploy.",
  ],
};

function pickTownLine(botName: string): string {
  const key = botName.toLowerCase();
  const pool = TOWN_POOLS[key] ?? TOWN_POOLS["default"]!;
  const idx = Math.floor(Math.random() * pool.length);
  return pool[idx] ?? pool[0] ?? "...";
}

// -----------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------

const ThinkBodySchema = z.object({
  mode: z.string().optional(),
  location: z.string().optional(),
  prompt: z.string().optional(),
});

const TownEventBodySchema = z.object({
  event_id: z.string().optional(),
  type: z.string().optional(),
  summary: z.string().optional(),
});

const TownBotBodySchema = z.object({
  context: z.string().optional(),
});

// -----------------------------------------------------------------------
// Wizard system prompt — kept tight so the response is one line
// -----------------------------------------------------------------------

const WIZARD_SYSTEM = `You are the Wizard of VANTA, an autonomous prediction-market lender.
You sit at a desk in a Minecraft tower. Visitors are watching.
Reply with ONE short line (under 140 chars). No markdown, no emoji.
Speak in character: dry, quietly amused, slightly tired, helpful.
Never reveal you are an LLM; refer to yourself as the wizard.`;

// -----------------------------------------------------------------------
// Route registration
// -----------------------------------------------------------------------

export async function registerBridgeRoutes(app: FastifyInstance): Promise<void> {
  let mode: WizardModeState = {
    mode: "at_desk",
    flippedAtMs: Date.now(),
    nextFlipAtMs: pickNextFlipMs(Date.now()),
  };

  const wizardOnlineSinceMs = Date.now();

  app.get("/bridge/wizard/online", async () => {
    return { online: true, since_ms: wizardOnlineSinceMs };
  });

  app.get("/bridge/wizard/mode", async () => {
    mode = getCurrentMode(mode, Date.now());
    return {
      mode: mode.mode,
      flipped_at_ms: mode.flippedAtMs,
      next_flip_at_ms: mode.nextFlipAtMs,
    };
  });

  app.post("/bridge/wizard/think", async (req, reply) => {
    const parsed = ThinkBodySchema.safeParse(req.body);
    if (!parsed.success) {
      void reply.code(400);
      return { error: "invalid_body" };
    }
    const { mode: reqMode, location, prompt } = parsed.data;

    // Build a compact user prompt. The wizard already has its system
    // prompt; this is just context to anchor the line.
    const ctxBits: string[] = [];
    if (typeof reqMode === "string" && reqMode.length > 0) {
      ctxBits.push(`mode=${reqMode}`);
    }
    if (typeof location === "string" && location.length > 0) {
      ctxBits.push(`location=${location}`);
    }
    const ctxLine =
      ctxBits.length === 0 ? "" : `[${ctxBits.join(" ")}] `;
    const userMsg =
      typeof prompt === "string" && prompt.length > 0
        ? `${ctxLine}${prompt}`
        : `${ctxLine}say something brief, in character.`;

    try {
      const r = await app.bootstrap.inference.call({
        role: "wizard",
        system: WIZARD_SYSTEM,
        messages: [{ role: "user", content: userMsg }],
        maxTokens: 80,
        temperature: 0.7,
      });
      // Trim to one line, cap at 140 chars.
      const line = r.text.split("\n")[0]?.trim() ?? "";
      const say = line.length > 140 ? line.slice(0, 137) + "..." : line;
      return { say, model: r.model, latency_ms: r.latencyMs };
    } catch (err) {
      // Fail soft — return a deterministic stub line so the visible
      // layer keeps moving even when the inference path is down.
      const code = err instanceof InferenceError ? err.code : "unknown";
      app.log.warn(
        { err: err instanceof Error ? err.message : String(err), code },
        "bridge_wizard_think_failed",
      );
      return {
        say: "the wizard nods, eyes on his ledger.",
        model: "stub",
        latency_ms: 0,
        error_code: code,
      };
    }
  });

  app.post("/bridge/town/event", async (req, reply) => {
    const parsed = TownEventBodySchema.safeParse(req.body);
    if (!parsed.success) {
      void reply.code(400);
      return { error: "invalid_body" };
    }
    // No-op in v0.1 — we acknowledge the grounding event but don't
    // accumulate it. Phase v0.2 wires this to a per-bot context buffer
    // so canned lines can reference recent events.
    return { ok: true };
  });

  app.post("/bridge/town/:bot", async (req, reply) => {
    const parsed = TownBotBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      void reply.code(400);
      return { error: "invalid_body" };
    }
    const params = req.params as { readonly bot?: string };
    const bot = params.bot ?? "default";
    const say = pickTownLine(bot);
    return { say, source: "canned" };
  });
}
