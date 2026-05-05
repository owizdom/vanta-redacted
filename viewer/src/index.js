/**
 * VANTA browser-spectator viewer.
 *
 * §1.6. A headless `mineflayer` "camera bot" joins our PaperMC server
 * over the standard Java protocol (offline-mode), and `prismarine-viewer`
 * renders the chunks the bot can see to a WebGL canvas served at
 * http://localhost:8080. Visitors open the URL, walk around inside the
 * VANTA town in a browser — no Java license, no Minecraft install,
 * no Mojang auth.
 *
 * One bot per viewer container today. Multi-user spectator (one camera
 * bot per browser session) lands when we wire the prismarine-web-client
 * websocket proxy.
 */

import http from "node:http";
import { readFileSync, existsSync, mkdirSync, writeFileSync, createReadStream } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import express from "express";
import mineflayer from "mineflayer";
import prismarineViewer from "prismarine-viewer";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PAPER_HOST = process.env.PAPER_HOST || "paper";
const PAPER_PORT = Number.parseInt(process.env.PAPER_PORT || "25565", 10);
const VIEWER_PORT = Number.parseInt(process.env.VIEWER_PORT || "8080", 10);
const CHAT_PORT = Number.parseInt(process.env.CHAT_PORT || "8081", 10);
const USERNAME = process.env.VIEWER_USERNAME || "CameraBot";
const MINECRAFT_VERSION = process.env.MINECRAFT_VERSION || "1.21.4";
const RUNTIME_URL = process.env.VANTA_RUNTIME_URL || "http://runtime:8787";

// Voice (ElevenLabs) — pattern lifted from owizdom/LetAliceLead but
// shifted to per-line on-demand generation with a sha256(text) cache.
// Default voice id is Adam (male, narrator/wise — fits VANTA's wizard).
// The whole subsystem is opt-in: if ELEVENLABS_API_KEY is empty (the
// default), the /api/tts route returns 503 and the browser hides the
// mute toggle — no audio, no errors.
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "pNInz6obpgDQGcFmaJgB";
const ELEVENLABS_BASE_URL = process.env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io";
const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2";
const VOICE_CACHE_DIR = process.env.VOICE_CACHE_DIR || resolve(__dirname, "..", ".voice-cache");
const VOICE_ENABLED = ELEVENLABS_API_KEY.length > 0;
if (VOICE_ENABLED) {
  mkdirSync(VOICE_CACHE_DIR, { recursive: true });
  console.log(`[vanta-voice] enabled (voice=${ELEVENLABS_VOICE_ID}, cache=${VOICE_CACHE_DIR})`);
} else {
  console.log("[vanta-voice] disabled (set ELEVENLABS_API_KEY to enable)");
}

// Start the launcher / chat panel immediately so the UI is reachable
// even before the camera bot has joined paper (paper boots slowly,
// and the launcher screens — title, mode, about, the spawn wizard —
// don't depend on the bot at all).
const chatPanel = startChatPanel();

let viewerStarted = false;
let reconnectTimer = null;

function spawnCameraBot() {
  console.log(
    `[vanta-viewer] connecting camera bot ${USERNAME} → ${PAPER_HOST}:${PAPER_PORT} (mc ${MINECRAFT_VERSION})`,
  );
  const bot = mineflayer.createBot({
    host: PAPER_HOST,
    port: PAPER_PORT,
    username: USERNAME,
    version: MINECRAFT_VERSION,
    auth: "offline",
  });

  bot.on("error", (err) => {
    console.error("[vanta-viewer] bot error:", err.message);
  });
  bot.on("kicked", (reason) => {
    console.error("[vanta-viewer] kicked:", reason);
  });
  bot.on("end", (reason) => {
    console.log("[vanta-viewer] bot disconnected:", reason);
    // Reconnect after 3s. The launcher itself stays up the whole
    // time; only the world iframe at :8080 cares whether the bot
    // is alive.
    if (reconnectTimer === null) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        spawnCameraBot();
      }, 3000);
    }
  });

  bot.once("spawn", () => {
    console.log(
      `[vanta-viewer] bot spawned at ${bot.entity.position.toString()}`,
    );
    if (!viewerStarted) {
      const { mineflayer: viewerForBot } = prismarineViewer;
      viewerForBot(bot, {
        port: VIEWER_PORT,
        firstPerson: false,
        viewDistance: 6,
      });
      viewerStarted = true;
      console.log(`[vanta-viewer] world canvas at http://localhost:${VIEWER_PORT}`);
    }
    bot.lookAt(bot.entity.position.offset(0, 1, 0));
    chatPanel.attachBot(bot);
  });
}

spawnCameraBot();

// ---------------------------------------------------------------------
// Chat panel — http://localhost:8081
// ---------------------------------------------------------------------
//
// The browser viewer at :8080 renders the world but doesn't show
// in-game chat. This second tiny server hooks the camera bot's
// `chat` events and exposes them to a self-refreshing HTML page so
// the audience can watch the wizard speak in real time, separate
// tab from the WebGL view.

function startChatPanel() {
  const messages = []; // ring buffer, latest at the end
  const MAX = 200;

  const recordMessage = (username, text, source = "chat") => {
    if (!text) return;
    messages.push({
      ts: Date.now(),
      iso: new Date().toISOString(),
      username: username || "system",
      text,
      source,
    });
    while (messages.length > MAX) messages.shift();
  };

  function attachBot(bot) {
    // Player chat (real "say" lines from NPCs and human players)
    bot.on("chat", (username, message) => {
      if (username === bot.username) return; // ignore our own (none expected)
      recordMessage(username, message, "chat");
      console.log(`[vanta-chat] <${username}> ${message}`);
    });

    // Captures /msg, /tell, system ("X joined the game"), etc.
    bot.on("message", (jsonMsg) => {
      const text = typeof jsonMsg.toString === "function"
        ? jsonMsg.toString()
        : String(jsonMsg);
      // Player chat already captured above; skip the duplicate
      if (text.startsWith("<") && text.includes("> ")) return;
      if (!text) return;
      recordMessage("system", text, "system");
    });
  }

  const app = express();
  app.disable("x-powered-by");

  app.get("/messages", (_req, res) => {
    res.json({ messages });
  });

  // Same-origin proxy → runtime SSE. The browser can't reach
  // `runtime:8787` directly from a user laptop; we re-stream the
  // server-sent events through this server so the EventSource on
  // the console page can subscribe locally.
  app.get("/events-stream", (req, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders?.();
    res.write(": connected\n\n");

    const url = new URL(`${RUNTIME_URL}/api/events/stream`);
    const upstream = http.get({
      host: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      headers: { accept: "text/event-stream" },
    }, (upRes) => {
      if (upRes.statusCode !== 200) {
        res.write(`: upstream ${upRes.statusCode}\n\n`);
        upRes.resume();
        return;
      }
      upRes.setEncoding("utf8");
      upRes.on("data", (chunk) => {
        try { res.write(chunk); } catch { /* client gone */ }
      });
      upRes.on("end", () => {
        try { res.end(); } catch { /* */ }
      });
    });
    upstream.on("error", (err) => {
      try { res.write(`: upstream-error ${err.message}\n\n`); } catch { /* */ }
    });

    req.on("close", () => {
      try { upstream.destroy(); } catch { /* */ }
    });
  });

  // -------- POST /api/verify-payment ---------------------------------
  // Launcher's "Pay" step calls this to confirm the user's pasted
  // txHash matches a `treasury.inflow` event in the runtime log.
  app.post("/api/verify-payment", express.json(), (req, res) => {
    const txHash = typeof req.body?.txHash === "string" ? req.body.txHash : "";
    if (!/^0x[0-9a-f]{64}$/.test(txHash)) {
      res.status(400).json({ ok: false, error: "tx_hash_invalid" });
      return;
    }
    proxyJson(req, res, "GET", `/open/payment/${txHash}`, null);
  });

  // -------- POST /api/spawn -----------------------------------------
  // Launcher's "Play" step. Forwards body verbatim to the runtime so
  // the runtime is the authority on plot allocation + idempotency.
  app.post("/api/spawn", express.json(), (req, res) => {
    proxyJson(req, res, "POST", "/open/spawn-demo", req.body, {
      // Pass the launcher's internal-secret header through so local-
      // anvil demos can spawn without a real Base Sepolia payment.
      "x-vanta-internal": req.headers["x-vanta-internal"] ?? "",
    });
  });

  // -------- GET /api/town/state -------------------------------------
  app.get("/api/town/state", (req, res) => {
    proxyJson(req, res, "GET", "/open/town/state", null);
  });

  // -------- GET /api/vault/state ------------------------------------
  // Hero card on the title screen polls this every 8s. Runtime caches
  // the chain reads (LpVault.totalAssets, LoanBook.outstandingPrincipal)
  // for 15s so the underlying chain calls don't fan out.
  app.get("/api/vault/state", (req, res) => {
    proxyJson(req, res, "GET", "/bridge/vault/state", null);
  });

  // -------- GET /api/identity-pin -----------------------------------
  // Owner banner on the launcher header + console rail polls this every
  // 30s. Runtime caches the owner() reads for 60s; the response also
  // carries the TEE-derived ETH address so the banner can prove the
  // three identities are the same in one glance.
  app.get("/api/identity-pin", (req, res) => {
    proxyJson(req, res, "GET", "/api/identity-pin", null);
  });

  // -------- GET /api/health/components --------------------------------
  // Aggregated component health (polymarket, chain, inference, log).
  // Powers the launcher's health-chips row. Polled every 10s.
  app.get("/api/health/components", (req, res) => {
    proxyJson(req, res, "GET", "/api/health/components", null);
  });

  // -------- POST /api/drill/liquidate --------------------------------
  // Admin-gated demo drill. The launcher's drill button forwards
  // `x-vanta-internal` from the same internal-secret header that
  // unblocks /api/spawn locally. On prod the secret comes from env;
  // the button does nothing if the operator hasn't set it.
  app.post("/api/drill/liquidate", express.json(), (req, res) => {
    proxyJson(req, res, "POST", "/api/drill/liquidate", req.body, {
      "x-vanta-internal": req.headers["x-vanta-internal"] ?? "",
    });
  });

  // -------- POST /api/lend -------------------------------------------
  // Browser-side lender widget. Visitor types an amount in USDC whole
  // dollars, the runtime either does a real on-chain LpVault.deposit
  // (if its lender-wallet env is configured) or accumulates a demo
  // balance. Either way the chest renderer fills proportionally so
  // the visible→productive loop is closed in the browser.
  app.post("/api/lend", express.json(), (req, res) => {
    proxyJson(req, res, "POST", "/bridge/town/lend", req.body);
  });

  // -------- POST /api/erc8004/register -------------------------------
  // Admin-gated second-sovereign-agent registration. Forwards the
  // internal-secret. Closes "town has one tenant" gap.
  app.post("/api/erc8004/register", express.json(), (req, res) => {
    proxyJson(req, res, "POST", "/open/erc8004/register", req.body, {
      "x-vanta-internal": req.headers["x-vanta-internal"] ?? "",
    });
  });

  // -------- POST /api/quote ------------------------------------------
  // Browser-side quote widget. Visitor types or picks a Polymarket
  // conditionId, the runtime returns a signed haircut + max loan with
  // an `op.inference` event id so they can click-to-verify the wizard's
  // explanation against the signed log. Spectator → protagonist.
  app.post("/api/quote", express.json(), (req, res) => {
    proxyJson(req, res, "POST", "/bridge/quote", req.body);
  });

  // -------- GET /bridge/town/events ----------------------------------
  // Origination ticker (Ship 3) reads this every 5s. Returns the last 12
  // entries from the runtime's town-events ring buffer, including the
  // structured kind/cid/side fields populated by population bots.
  app.get("/bridge/town/events", (req, res) => {
    proxyJson(req, res, "GET", "/bridge/town/events", null);
  });

  // -------- Polymarket-visible surfaces ------------------------------
  // The "markets vanta is watching" rail panel + bot reveal cards poll
  // these. Same proxy pattern as everywhere else; the runtime owns the
  // 30s/60s cadence against clob.polymarket.com.
  app.get("/api/markets/watched", (req, res) => {
    proxyJson(req, res, "GET", "/api/markets/watched", null);
  });
  app.get("/api/bots/positions", (req, res) => {
    proxyJson(req, res, "GET", "/api/bots/positions", null);
  });
  app.get("/api/bots/:name", (req, res) => {
    const name = String(req.params.name || "");
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(name)) {
      res.status(400).json({ error: "name_invalid" });
      return;
    }
    proxyJson(req, res, "GET", `/api/bots/${encodeURIComponent(name)}`, null);
  });

  // -------- GET /api/events ------------------------------------------
  // Proxy to runtime /api/events. Supports `?limit=N&type=…` so the
  // console rail can backfill history and the verifier can filter by
  // kind. Read-only; no body.
  app.get("/api/events", (req, res) => {
    const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    proxyJson(req, res, "GET", "/api/events" + qs, null);
  });

  // -------- GET /api/state -------------------------------------------
  // Aggregator (positions, treasury balance, runway, last_decision,
  // loop freshness). Used by the launcher-style menu's hero stats.
  app.get("/api/state", (req, res) => {
    proxyJson(req, res, "GET", "/api/state", null);
  });

  // -------- GET /api/events/:id --------------------------------------
  // Single event by id (full canonical form: parent_ids, tee, body,
  // signature). Powers the console rail's click-to-expand and lets a
  // verifier independently re-fetch any event by id.
  app.get("/api/events/:id", (req, res) => {
    const id = String(req.params.id || "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(id)) {
      res.status(400).json({ error: "id_invalid" });
      return;
    }
    proxyJson(req, res, "GET", "/api/events/" + id, null);
  });

  // -------- GET /api/events/:id/chain --------------------------------
  // Walks parent_ids back to constitutional.genesis. Powers the rail's
  // "verify chain ↗" affordance — one-click proof from any event to
  // the root of the signed log.
  app.get("/api/events/:id/chain", (req, res) => {
    const id = String(req.params.id || "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(id)) {
      res.status(400).json({ error: "id_invalid" });
      return;
    }
    proxyJson(req, res, "GET", "/api/events/" + id + "/chain", null);
  });

  // -------- GET /api/x402-info ---------------------------------------
  // Discovery doc for the launcher's receipt card (issuer pubkey, the
  // X402 receiver address, current prices). Cached for 5 min so the
  // launcher boot doesn't pound the runtime — pubkey only changes on
  // a TEE restart anyway.
  let cachedX402 = null;
  let cachedX402At = 0;
  const X402_TTL_MS = 5 * 60_000;
  app.get("/api/x402-info", (req, res) => {
    const now = Date.now();
    if (cachedX402 !== null && now - cachedX402At < X402_TTL_MS) {
      res.set("content-type", "application/json");
      res.send(cachedX402);
      return;
    }
    proxyJson(req, res, "GET", "/.well-known/x402", null, {}, (body) => {
      cachedX402 = body;
      cachedX402At = now;
    });
  });

  // -------- GET /api/attestation ------------------------------------
  // Receipt screen + about tiles fetch this. Mirrors x402-info caching
  // pattern at 30s TTL since attestation_jwt rotates regularly. The
  // signing_pub_key field is what receipts surface as "enclave".
  let cachedAttest = null;
  let cachedAttestAt = 0;
  const ATTEST_TTL_MS = 30_000;
  app.get("/api/attestation", (req, res) => {
    const now = Date.now();
    if (cachedAttest !== null && now - cachedAttestAt < ATTEST_TTL_MS) {
      res.set("content-type", "application/json");
      res.send(cachedAttest);
      return;
    }
    proxyJson(req, res, "GET", "/.well-known/attestation", null, {}, (body) => {
      cachedAttest = body;
      cachedAttestAt = now;
    });
  });

  // -------- GET /api/voice/status -----------------------------------
  // Browser asks at boot whether voice is available (i.e. is the
  // ELEVENLABS_API_KEY set on the viewer). If not, the launcher hides
  // the mute toggle entirely so users don't see a useless button.
  app.get("/api/voice/status", (_req, res) => {
    res.json({ enabled: VOICE_ENABLED, voiceId: VOICE_ENABLED ? ELEVENLABS_VOICE_ID : null });
  });

  // -------- GET /api/tts/:hash --------------------------------------
  // Browser computes sha256(text), passes the line as `?text=<base64url>`
  // and the hash as the path. Server checks cache → returns the MP3
  // if it exists; otherwise calls ElevenLabs once, writes to cache,
  // and pipes the result. Concurrent requests for the same hash share
  // a single in-flight job. Cache lives forever (per the demo plan;
  // wizard line pool is small).
  const inflightTts = new Map();
  app.get("/api/tts/:hash", async (req, res) => {
    if (!VOICE_ENABLED) { res.status(503).end(); return; }
    const hash = String(req.params.hash || "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) { res.status(400).end(); return; }
    const cachedPath = resolve(VOICE_CACHE_DIR, `${hash}.mp3`);
    if (existsSync(cachedPath)) {
      res.set("content-type", "audio/mpeg");
      res.set("cache-control", "public, max-age=31536000, immutable");
      createReadStream(cachedPath).pipe(res);
      return;
    }
    const textParam = req.query.text;
    if (typeof textParam !== "string" || textParam.length === 0) {
      res.status(404).json({ error: "not_cached_no_text" });
      return;
    }
    let text;
    try {
      text = Buffer.from(textParam, "base64url").toString("utf8");
    } catch {
      res.status(400).json({ error: "text_decode_failed" });
      return;
    }
    if (text.length === 0 || text.length > 280) {
      res.status(400).json({ error: "text_length_out_of_range" });
      return;
    }
    // Server-side verification: hash MUST match the text the client claims.
    const computed = createHash("sha256").update(text, "utf8").digest("hex");
    if (computed !== hash) {
      res.status(400).json({ error: "hash_mismatch" });
      return;
    }
    // Concurrency: dedupe in-flight requests for the same hash.
    let job = inflightTts.get(hash);
    if (job === undefined) {
      job = generateTtsClip(hash, text, cachedPath).finally(() => {
        inflightTts.delete(hash);
      });
      inflightTts.set(hash, job);
    }
    try {
      await job;
      res.set("content-type", "audio/mpeg");
      res.set("cache-control", "public, max-age=31536000, immutable");
      createReadStream(cachedPath).pipe(res);
    } catch (err) {
      console.error(`[vanta-voice] gen failed for ${hash.slice(0, 8)}: ${err.message}`);
      res.status(502).json({ error: "tts_generation_failed", message: err.message });
    }
  });

  // -------- GET /paper.pdf ------------------------------------------
  // About-screen link. The viewer container does not mount the paper
  // PDF; redirect to the GitHub raw URL.
  app.get("/paper.pdf", (_req, res) => {
    res.redirect(302, "https://github.com/owizdom/vanta/raw/main/paper/vanta.pdf");
  });

  // -------- Static files (HTML/CSS/JS/SVG/PNG) ----------------------
  // Everything under viewer/src/ is reachable at the same URL path.
  // Order matters: this runs AFTER the /api routes above so /api/* is
  // never shadowed by an accidentally-named static file.
  app.use(express.static(__dirname));

  // -------- Page routes ---------------------------------------------
  // v0.1 layering: `/` lands on the two-door menu (Spectate / Visit);
  // `/spectate` is the existing live world launcher; `/visit-soon` is
  // the v0.2 stub for the x402 + avatar mint flow. `/console` is the
  // legacy bare console for power users + screencasts.
  app.get("/", (_req, res) => {
    res.set("content-type", "text/html; charset=utf-8");
    res.send(MENU_HTML);
  });
  app.get("/spectate", (_req, res) => {
    res.set("content-type", "text/html; charset=utf-8");
    res.send(LAUNCHER_HTML);
  });
  app.get("/visit-soon", (_req, res) => {
    res.set("content-type", "text/html; charset=utf-8");
    res.send(VISIT_SOON_HTML);
  });
  app.get("/console", (_req, res) => {
    res.set("content-type", "text/html; charset=utf-8");
    res.send(CONSOLE_HTML);
  });

  app.listen(CHAT_PORT, "0.0.0.0", () => {
    console.log(`[vanta-chat] panel at http://localhost:${CHAT_PORT}`);
  });

  return { attachBot };
}

/**
 * Tiny same-origin proxy used by /api/* routes. Forwards the JSON
 * body (or pulls one from URL params) to RUNTIME_URL and mirrors the
 * upstream status + body back to the browser.
 */
function proxyJson(req, res, method, path, body, extraHeaders = {}, onBody = null) {
  const url = new URL(`${RUNTIME_URL}${path}`);
  const payload = body == null ? null : Buffer.from(JSON.stringify(body), "utf8");
  const headers = {
    accept: "application/json",
    ...extraHeaders,
  };
  if (payload !== null) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(payload.byteLength);
  }
  const upstream = http.request(
    {
      host: url.hostname,
      port: url.port || 80,
      path: url.pathname + url.search,
      method,
      headers,
    },
    (upRes) => {
      let chunks = "";
      upRes.setEncoding("utf8");
      upRes.on("data", (c) => { chunks += c; });
      upRes.on("end", () => {
        res.status(upRes.statusCode || 502);
        res.set("content-type", upRes.headers["content-type"] ?? "application/json");
        if (onBody !== null && (upRes.statusCode ?? 0) === 200) {
          try { onBody(chunks); } catch { /* cache failure is non-fatal */ }
        }
        res.send(chunks);
      });
    },
  );
  upstream.on("error", (err) => {
    if (!res.headersSent) {
      res.status(502).json({ ok: false, error: "runtime_unreachable", message: err.message });
    }
  });
  if (payload !== null) upstream.write(payload);
  upstream.end();
}

/**
 * Call ElevenLabs text-to-speech and write the MP3 to `outPath`.
 * One-shot per unique line; cache lives forever. Wizard pool is
 * small so total chars stay well under the free-tier 10k/mo cap.
 */
async function generateTtsClip(hash, text, outPath) {
  const url = `${ELEVENLABS_BASE_URL}/v1/text-to-speech/${ELEVENLABS_VOICE_ID}?output_format=mp3_44100_128`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVENLABS_API_KEY,
      "content-type": "application/json",
      accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: ELEVENLABS_MODEL_ID,
      voice_settings: {
        stability: 0.55,
        similarity_boost: 0.8,
        style: 0.3,
        use_speaker_boost: true,
      },
    }),
  });
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 200);
    throw new Error(`elevenlabs ${r.status}: ${detail}`);
  }
  const buf = Buffer.from(await r.arrayBuffer());
  writeFileSync(outPath, buf);
  console.log(`[vanta-voice] cached ${hash.slice(0, 8)} (${buf.length}B, "${text.slice(0, 40)}…")`);
}

// HTML pages are loaded from disk at startup so the launcher and
// console live as plain static files (viewer/src/{launcher,console}.html).
// CSS/JS/SVG/skin assets are served by the express.static mount above.
const LAUNCHER_HTML = readFileSync(resolve(__dirname, "launcher.html"), "utf8");
const CONSOLE_HTML = readFileSync(resolve(__dirname, "console.html"), "utf8");
const MENU_HTML = readFileSync(resolve(__dirname, "menu.html"), "utf8");
const VISIT_SOON_HTML = readFileSync(resolve(__dirname, "visit-soon.html"), "utf8");
