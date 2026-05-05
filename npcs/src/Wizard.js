/**
 * VANTA — Wizard NPC (autonomous agent with at_desk default + breaks).
 *
 * §1.3 Phase 3.
 *
 * Two modes drive the agent loop:
 *
 *   at_desk (default):
 *     The wizard stands behind the lectern at world origin. Every
 *     cycle calls /bridge/wizard/think with mode=at_desk; the LLM is
 *     constrained by the system prompt to ONLY pick `say` or
 *     `look_around` (no walking). He turns his head, occasionally
 *     speaks. No long pauses. Every ~5 minutes (with ±90s jitter)
 *     a break starts.
 *
 *   on_break (every ~5 min, ~30 s):
 *     Wizard picks one landmark (pledge_altar / mark_belfry /
 *     verifier_altar / graveyard) via the LLM, walks there,
 *     speaks one in-character line, walks back to the desk. Mode
 *     resets to at_desk.
 *
 * Mode transitions are broadcast to /bridge/wizard/mode so the
 * population bots (Phase 4) can see whether to queue at the lectern.
 */

import mineflayer from "mineflayer";

const PAPER_HOST = process.env.PAPER_HOST || "paper";
const PAPER_PORT = Number.parseInt(process.env.PAPER_PORT || "25565", 10);
const RUNTIME_URL = process.env.RUNTIME_URL || "http://runtime:8787";
const VERSION = process.env.MINECRAFT_VERSION || "1.21.4";
const USERNAME = process.env.WIZARD_USERNAME || "vanta";

// Desk position — north of lectern, behind it, on top of the polished-
// blackstone dais. Lectern is at (0, 65, 0); wizard stands at (0, 65, -1)
// so the lectern is between him and any visitor approaching from the
// south. Y=65 is the dais top.
const DESK_POS = { x: 0.5, y: 65, z: -0.5 };

const LANDMARKS = {
  desk:           { x: 0.5,  y: 65, z: -0.5 },
  pledge_altar:   { x: 25,   y: 64, z:   0 },
  mark_belfry:    { x:  0,   y: 64, z: -40 },
  verifier_altar: { x: -25,  y: 64, z:   0 },
  graveyard:      { x:  0,   y: 64, z:  35 },
};

// Break cadence — paper §7.3 ("8-10 minutes before returning"), tuned
// down for demo-pace so visitors actually see a transition without
// waiting forever. Desk window matches user-stated 2.5 min idle, and
// the break is a multi-landmark patrol of ~5 minutes where the wizard
// walks, jumps, looks around, and speaks at each stop.
const BREAK_INTERVAL_MS = 150 * 1000;          // 2.5 minutes at desk
const BREAK_JITTER_MS   = 30 * 1000;           // ±30 seconds
const BREAK_DURATION_MS = 5 * 60 * 1000;       // 5-minute walking patrol
const PATROL_STOP_DURATION_MS = 18 * 1000;     // dwell at each landmark
const PATROL_STOP_LOOK_MS = 6000;              // head-turn time at the stop

const log = (msg) => console.log(`[vanta-wizard] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function vec(bot, x, y, z) {
  const Vec3 = bot.entity.position.constructor;
  return new Vec3(x, y, z);
}

async function walkToward(bot, target, opts = {}) {
  const arriveDist = opts.arriveDist ?? 2.5;
  const maxMs = opts.maxMs ?? 14000;
  const jumpRate = opts.jumpRate ?? 0.1;
  const goal = vec(bot, target.x, target.y, target.z);
  const start = Date.now();
  try { await bot.lookAt(goal, true); } catch (_) {}
  bot.setControlState("forward", true);
  let lastReaim = Date.now();
  while (Date.now() - start < maxMs) {
    const here = bot.entity.position;
    if (here.distanceTo(goal) <= arriveDist) break;
    if (Date.now() - lastReaim > 1200) {
      try { await bot.lookAt(goal, true); } catch (_) {}
      lastReaim = Date.now();
    }
    if (Math.random() < jumpRate) {
      bot.setControlState("jump", true);
      setTimeout(() => {
        try { bot.setControlState("jump", false); } catch (_) {}
      }, 400);
    }
    await sleep(180);
  }
  bot.setControlState("forward", false);
}

async function lookAroundFor(bot, totalMs) {
  const end = Date.now() + totalMs;
  while (Date.now() < end && bot.entity != null) {
    const yaw = (Math.random() - 0.5) * Math.PI; // ±90°, look forward-ish
    const pitch = (Math.random() - 0.5) * 0.4;
    try { await bot.look(yaw, pitch, true); } catch (_) {}
    await sleep(900 + Math.random() * 1100);
  }
}

async function think(observation) {
  // v0.1 contract: the runtime's /bridge/wizard/think returns just
  // `{say: <one-line text>}` from the inference client. Older v1 paths
  // returned a structured `{action: {action, message}}` for richer agency
  // — we collapse that here to a single chat line. v0.2 may bring the
  // structured action loop back once the visit-mode chat surface lands.
  const res = await fetch(`${RUNTIME_URL}/bridge/wizard/think`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(observation),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`runtime ${res.status}: ${txt.slice(0, 120)}`);
  }
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  const say = (json.say || "").toString();
  return say.length > 0 ? { action: "say", message: say } : { action: "look_around" };
}

// v0.1 — runtime's /bridge/wizard/{mode,online} are runtime-owned (GET
// only). The wizard NPC no longer broadcasts; these helpers are kept as
// no-ops so the rest of the loop reads cleanly without conditional
// scaffolding. v0.2 may reintroduce two-way mode handshake when
// population queue logic returns.
async function broadcastMode(_mode, _untilTs = 0) {
  /* no-op in v0.1 */
}

async function broadcastOnline(_online) {
  /* no-op in v0.1 */
}

function nextBreakDelay() {
  const jitter = (Math.random() * 2 - 1) * BREAK_JITTER_MS;
  return Math.max(60_000, BREAK_INTERVAL_MS + jitter);
}

async function runDeskCycle(bot, state) {
  const action = await think({
    mode: "at_desk",
    location: "desk",
    recent_actions: state.recentActions,
    recent_says: state.recentSays,
    cycles_since_say: state.cyclesSinceSay,
  });
  log(`@desk thought: ${JSON.stringify(action)}`);
  if (action.action === "say") {
    const msg = (action.message || "").toString().slice(0, 200);
    if (msg) {
      bot.chat(msg);
      log(`said: ${msg}`);
      state.recentSays.push(msg);
      if (state.recentSays.length > 10) state.recentSays.shift();
      state.recentActions.push(`say "${msg.slice(0, 80)}"`);
      state.cyclesSinceSay = 0;
    }
  } else if (action.action === "look_around") {
    await lookAroundFor(bot, 3500 + Math.random() * 2000);
    state.recentActions.push("look_around");
    state.cyclesSinceSay += 1;
  } else {
    // walk_to at the desk → reject; turn into a look_around.
    log(`@desk dropped illegal walk_to ${JSON.stringify(action)}`);
    await lookAroundFor(bot, 3000);
    state.recentActions.push("look_around (forced)");
    state.cyclesSinceSay += 1;
  }
  if (state.recentActions.length > 10) state.recentActions.shift();

  // Pause between desk cycles
  await sleep(8000 + Math.random() * 5000);
}

/** Pick a fresh patrol order — every landmark visited once, random sequence. */
function planPatrol() {
  const all = ["pledge_altar", "mark_belfry", "verifier_altar", "graveyard"];
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all;
}

/** Speak one in-character line at a landmark (LLM if up, scripted if down). */
async function speakAt(bot, state, location) {
  try {
    const action = await think({
      mode: "on_break",
      location,
      recent_actions: state.recentActions,
      recent_says: state.recentSays,
      cycles_since_say: state.cyclesSinceSay,
    });
    if (action.action === "say") {
      const msg = (action.message || "").toString().slice(0, 200);
      if (msg) {
        bot.chat(msg);
        log(`said@${location}: ${msg}`);
        state.recentSays.push(msg);
        if (state.recentSays.length > 10) state.recentSays.shift();
        state.recentActions.push(`say@${location} "${msg.slice(0, 60)}"`);
        state.cyclesSinceSay = 0;
        return;
      }
    }
  } catch (err) {
    log(`speak@${location} failed: ${err.message}`);
  }
}

async function runBreakSequence(bot, state) {
  const breakUntil = Date.now() + BREAK_DURATION_MS;
  await broadcastMode("on_break", breakUntil);
  bot.chat("(stepping out for a walk around town)");

  // Walk-around patrol: pick a randomized order over all four landmarks
  // and visit as many as the break window allows. At each stop the
  // wizard pauses, looks around, jumps a bit, speaks one line, then
  // moves to the next.
  const route = planPatrol();
  log(`patrol route: ${route.join(" → ")}`);

  for (const stop of route) {
    if (Date.now() >= breakUntil - 25_000) break; // leave time to walk back
    log(`patrol: walking to ${stop}`);
    state.recentActions.push(`walk_to ${stop}`);

    // Higher jump rate on the patrol — paper §7.3 calls for the wandering
    // wizard to read as visibly alive, not a sleepwalking pawn.
    await walkToward(bot, LANDMARKS[stop], {
      arriveDist: 2.0,
      maxMs: 18_000,
      jumpRate: 0.22,
    });

    // Dwell: head-turn, hop a couple times, speak one line.
    const dwellEnd = Date.now() + PATROL_STOP_DURATION_MS;
    bot.setControlState("jump", true);
    setTimeout(() => { try { bot.setControlState("jump", false); } catch (_) {} }, 380);

    await lookAroundFor(bot, PATROL_STOP_LOOK_MS);
    await speakAt(bot, state, stop);
    // small celebratory hop after speaking
    bot.setControlState("jump", true);
    setTimeout(() => { try { bot.setControlState("jump", false); } catch (_) {} }, 380);

    const dwellRemaining = dwellEnd - Date.now();
    if (dwellRemaining > 0) await sleep(dwellRemaining);
  }

  // Walk back to desk
  log("patrol over: returning to desk");
  state.recentActions.push("walk_to desk");
  await walkToward(bot, DESK_POS, { arriveDist: 1.5, maxMs: 18_000, jumpRate: 0.05 });

  await broadcastMode("at_desk", 0);
  bot.chat("(back at the desk)");
}

async function agentLoop(bot) {
  const state = {
    recentActions: [],
    recentSays: [],
    cyclesSinceSay: 99,
  };

  // First: walk to the desk, regardless of where we spawned
  log("walking to desk for the first time");
  await walkToward(bot, DESK_POS, { arriveDist: 1.5, maxMs: 18_000 });
  // Face south (toward visitors) — yaw 0 in Minecraft = +Z = south
  try { await bot.look(0, 0, true); } catch (_) {}
  await broadcastMode("at_desk", 0);
  // Open the town: only now do the population bots get to spawn.
  await broadcastOnline(true);
  bot.chat("the desk is open. the town may begin.");

  let nextBreakAt = Date.now() + nextBreakDelay();
  log(`first break scheduled in ${Math.round((nextBreakAt - Date.now()) / 1000)}s`);

  while (bot.entity) {
    if (Date.now() >= nextBreakAt) {
      try {
        await runBreakSequence(bot, state);
      } catch (err) {
        log(`break sequence crashed: ${err.message}`);
        await broadcastMode("at_desk", 0);
        try { await walkToward(bot, DESK_POS, { arriveDist: 1.5, maxMs: 12000 }); } catch (_) {}
      }
      nextBreakAt = Date.now() + nextBreakDelay();
      log(`next break in ${Math.round((nextBreakAt - Date.now()) / 1000)}s`);
      continue;
    }
    try {
      await runDeskCycle(bot, state);
    } catch (err) {
      log(`desk cycle failed: ${err.message}`);
      await sleep(15_000);
    }
  }
}

function connect() {
  log(`connecting to ${PAPER_HOST}:${PAPER_PORT} (mc ${VERSION})`);
  const bot = mineflayer.createBot({
    host: PAPER_HOST,
    port: PAPER_PORT,
    username: USERNAME,
    version: VERSION,
    auth: "offline",
  });

  bot.once("spawn", () => {
    log(`spawned at ${bot.entity.position.toString()}`);
    setTimeout(() => {
      agentLoop(bot).catch((e) => log(`agent loop crashed: ${e.message}`));
    }, 4000);
  });

  bot.on("kicked", (reason) => log(`kicked: ${reason}`));
  bot.on("error", (err) => log(`bot error: ${err.message}`));
  bot.on("end", (reason) => {
    // Tell the runtime the wizard is offline so population bots stop
    // until he's back.
    void broadcastOnline(false);
    // Wider reconnect window than the population bots so we don't
    // dogpile the paper login queue if everyone died at once.
    const delay = 12_000 + Math.floor(Math.random() * 4000);
    log(`disconnected: ${reason}; reconnecting in ${Math.round(delay / 1000)}s`);
    setTimeout(connect, delay);
  });
}

connect();
