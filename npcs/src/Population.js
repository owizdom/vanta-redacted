/**
 * VANTA — population bots (v0.1, ambient layer).
 *
 * Two mineflayer bots — Ada and Ren — that wander between landmarks and
 * speak occasional canned lines pulled from the runtime's /bridge/town/:bot
 * endpoint. They exist to give the world a sense of life, not to exercise
 * any real bridge surface; v0.2's visit mode is when bots become
 * ambassadors for real on-chain action.
 *
 * Wizard-first invariant: bots wait for the wizard's `/bridge/wizard/online`
 * to flip true before connecting, so the visitor sees the wizard's tower
 * open before the population fills in.
 *
 * Each "cycle" per bot:
 *   1. Pick a landmark different from the current one
 *   2. Walk there
 *   3. Pull a canned line from /bridge/town/:bot
 *   4. Speak it (bot.chat)
 *   5. Idle 8-15s before the next cycle
 */

import mineflayer from "mineflayer";

const PAPER_HOST = process.env.PAPER_HOST || "paper";
const PAPER_PORT = Number.parseInt(process.env.PAPER_PORT || "25565", 10);
const RUNTIME_URL = process.env.RUNTIME_URL || "http://runtime:8787";
const VERSION = process.env.MINECRAFT_VERSION || "1.21.4";

// World anchors — match WorldBuilder.kt landmark positions.
const LANDMARKS = {
  pledge_altar:   { x:  25, y: 64, z:   0 },
  mark_belfry:    { x:   0, y: 64, z: -40 },
  verifier_altar: { x: -25, y: 64, z:   0 },
  graveyard:      { x:   0, y: 64, z:  35 },
};
const LANDMARK_NAMES = Object.keys(LANDMARKS);

const ROSTER = [
  { name: "Ada", spawnDelayMs: 4000 },
  { name: "Ren", spawnDelayMs: 9000 },
];

const log = (name, msg) => console.log(`[vanta-pop:${name}] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function vec(bot, x, y, z) {
  const Vec3 = bot.entity.position.constructor;
  return new Vec3(x, y, z);
}

async function walkToward(bot, target, opts = {}) {
  const arriveDist = opts.arriveDist ?? 2.5;
  const maxMs = opts.maxMs ?? 16000;
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
    if (Math.random() < 0.12) {
      bot.setControlState("jump", true);
      setTimeout(() => {
        try { bot.setControlState("jump", false); } catch (_) {}
      }, 400);
    }
    await sleep(180);
  }
  bot.setControlState("forward", false);
}

async function waitForWizardOnline() {
  while (true) {
    try {
      const res = await fetch(`${RUNTIME_URL}/bridge/wizard/online`);
      if (res.ok) {
        const json = await res.json();
        if (json.online === true) return;
      }
    } catch (_) {
      // runtime not up yet — keep polling
    }
    await sleep(3000);
  }
}

async function fetchTownLine(name) {
  try {
    const res = await fetch(`${RUNTIME_URL}/bridge/town/${name.toLowerCase()}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ context: "ambient" }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return typeof json.say === "string" && json.say.length > 0 ? json.say : null;
  } catch (_) {
    return null;
  }
}

async function botLoop(bot, name) {
  let currentLandmark = LANDMARK_NAMES[0];
  // Walk once to a starting landmark
  log(name, `starting ambient loop`);

  while (bot.entity) {
    // Pick next landmark — anything but current
    const choices = LANDMARK_NAMES.filter((n) => n !== currentLandmark);
    const next = choices[Math.floor(Math.random() * choices.length)];
    currentLandmark = next;
    log(name, `walking to ${next}`);

    try {
      await walkToward(bot, LANDMARKS[next], { arriveDist: 2.5, maxMs: 18000 });
    } catch (err) {
      log(name, `walk failed: ${err.message}`);
    }

    // 50% chance to chat a line at the destination
    if (Math.random() < 0.5) {
      const line = await fetchTownLine(name);
      if (line) {
        try {
          bot.chat(line);
          log(name, `said: ${line}`);
        } catch (_) {}
      }
    }

    // Idle 8-15s, occasionally look around
    const idleMs = 8000 + Math.floor(Math.random() * 7000);
    const lookEnd = Date.now() + idleMs;
    while (Date.now() < lookEnd && bot.entity) {
      const yaw = (Math.random() - 0.5) * Math.PI;
      const pitch = (Math.random() - 0.5) * 0.3;
      try { await bot.look(yaw, pitch, true); } catch (_) {}
      await sleep(900 + Math.random() * 1500);
    }
  }
}

function spawnBot(spec) {
  const { name, spawnDelayMs } = spec;
  log(name, `connecting to ${PAPER_HOST}:${PAPER_PORT}`);
  const bot = mineflayer.createBot({
    host: PAPER_HOST,
    port: PAPER_PORT,
    username: name,
    version: VERSION,
    auth: "offline",
  });

  bot.once("spawn", () => {
    log(name, `spawned at ${bot.entity.position.toString()}`);
    setTimeout(() => {
      botLoop(bot, name).catch((e) => log(name, `loop crashed: ${e.message}`));
    }, spawnDelayMs);
  });

  bot.on("kicked", (reason) => log(name, `kicked: ${reason}`));
  bot.on("error", (err) => log(name, `error: ${err.message}`));
  bot.on("end", (reason) => {
    const delay = 8000 + Math.floor(Math.random() * 4000);
    log(name, `disconnected: ${reason}; reconnecting in ${Math.round(delay / 1000)}s`);
    setTimeout(() => spawnBot(spec), delay);
  });
}

(async () => {
  console.log("[vanta-pop] waiting for wizard online…");
  await waitForWizardOnline();
  console.log("[vanta-pop] wizard online — spawning ambient bots");
  for (const spec of ROSTER) {
    setTimeout(() => spawnBot(spec), spec.spawnDelayMs);
  }
})();
