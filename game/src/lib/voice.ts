/**
 * ElevenLabs voice integration — one voice per kingdom, on
 * `council.synthesised` only.
 *
 * Calls a SERVER-SIDE proxy (`POST /api/voice`) that holds the
 * ElevenLabs API key. The bundle ships to every visitor; the key
 * never reaches the client. Proxy lives in `vite.config.ts` for dev
 * and `api/voice.ts` (Vercel serverless) for prod; both read
 * `ELEVENLABS_API_KEY` from server env.
 *
 * Throttled per-voice (12s) and single-channel so a flurry doesn't
 * overlap. Cached by text hash so HMR + duplicate events don't
 * double-bill.
 */

import { isMuted } from "./audio";

// Stock ElevenLabs library voices accessible on the free tier.
const VOICE_DANIEL = "onwK4e9ZLuTAKqWW03F9"; // middle-aged authoritative male
const VOICE_ADAM = "pNInz6obpgDQGcFmaJgB"; // deep decisive male
const VOICE_BELLA = "EXAVITQu4vr4xnSDxMaL"; // warm articulate female
const VOICE_ANTONI = "ErXwobaYiN019PkySvjV"; // warm announcer male (narrator)

// Kingdom voice for council.synthesised — one per persona.
const VOICE_BY_AGENT: Record<number, string> = {
  0: VOICE_DANIEL, // Opus  — scholarly
  1: VOICE_ADAM,   // GPT   — tactical
  2: VOICE_BELLA,  // Gemini — warm
};

const PER_VOICE_COOLDOWN_MS = 12_000;
const MAX_TEXT_LEN = 280;

// Narrator — color-commentary voice that overlays the world. Speaks
// templated lines about live events. Gap randomised in [MIN, MAX]
// so cadence feels human, not metronome.
const NARRATOR_MIN_GAP_MS = 25_000;
const NARRATOR_MAX_GAP_MS = 40_000;
let narratorReadyAt = 0;

const lastByVoice = new Map<string, number>();
const cache = new Map<string, ArrayBuffer>(); // hashKey → audio bytes
let nowPlaying: HTMLAudioElement | null = null;

function hashKey(voiceId: string, text: string): string {
  const head = text.slice(0, 40);
  const tail = text.slice(-20);
  return `${voiceId}|${String(text.length)}|${head}|${tail}`;
}

function trimForTts(text: string): string {
  if (text.length <= MAX_TEXT_LEN) return text;
  const cap = text.slice(0, MAX_TEXT_LEN);
  const lastEnd = Math.max(
    cap.lastIndexOf("."),
    cap.lastIndexOf("!"),
    cap.lastIndexOf("?"),
  );
  return lastEnd > 40 ? cap.slice(0, lastEnd + 1) : cap;
}

async function fetchTts(
  voiceId: string,
  text: string,
): Promise<ArrayBuffer | null> {
  const k = hashKey(voiceId, text);
  const cached = cache.get(k);
  if (cached !== undefined) return cached;

  try {
    const res = await fetch("/api/voice", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ voiceId, text }),
    });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    cache.set(k, buf);
    return buf;
  } catch {
    return null;
  }
}

async function playArrayBuffer(buf: ArrayBuffer): Promise<void> {
  const blob = new Blob([buf], { type: "audio/mpeg" });
  const url = URL.createObjectURL(blob);
  const a = new Audio(url);
  a.volume = 0.7;
  nowPlaying = a;
  const cleanup = (): void => {
    URL.revokeObjectURL(url);
    if (nowPlaying === a) nowPlaying = null;
  };
  a.addEventListener("ended", cleanup, { once: true });
  a.addEventListener("error", cleanup, { once: true });
  try {
    await a.play();
  } catch {
    cleanup();
  }
}

async function speakWith(voiceId: string, text: string): Promise<void> {
  if (isMuted()) return;
  if (nowPlaying !== null) return; // single channel; drop overlap
  const trimmed = trimForTts(text).trim();
  if (trimmed.length === 0) return;
  const last = lastByVoice.get(voiceId) ?? 0;
  const now = Date.now();
  if (now - last < PER_VOICE_COOLDOWN_MS) return;
  lastByVoice.set(voiceId, now);
  const buf = await fetchTts(voiceId, trimmed);
  if (buf === null) return;
  await playArrayBuffer(buf);
}

/** Council synthesis — kingdom voice speaks the rationale. */
export async function speakCouncil(agentId: number, text: string): Promise<void> {
  const voice = VOICE_BY_AGENT[agentId];
  if (voice === undefined) return;
  await speakWith(voice, text);
}

/**
 * Narrator — Antoni voice gives ambient color commentary on world
 * events. Lines come from `lib/narrator.ts` templates. Most calls
 * are dropped on the random 25-40s cooldown; that's the design.
 */
export async function speakNarrator(text: string): Promise<void> {
  if (isMuted()) return;
  if (nowPlaying !== null) return;
  const now = Date.now();
  if (now < narratorReadyAt) return;
  // Set the next ready-time before awaiting so back-to-back calls
  // don't slip through the gate.
  const gap =
    NARRATOR_MIN_GAP_MS +
    Math.random() * (NARRATOR_MAX_GAP_MS - NARRATOR_MIN_GAP_MS);
  narratorReadyAt = now + gap;
  await speakWith(VOICE_ANTONI, text);
}
