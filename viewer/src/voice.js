// VANTA browser voice client. Same-origin /api/tts/:hash + a tiny
// playback queue. Plays vanta's chat lines aloud using an ElevenLabs
// voice when:
//   1. the viewer container has ELEVENLABS_API_KEY set (server gate)
//   2. AND the visitor has clicked the speaker icon at least once
//      (autoplay policy — browsers require a user gesture before
//      Audio.play() resolves; we persist the user's choice in
//      localStorage so it sticks across reloads).
//
// Pattern modelled after owizdom/LetAliceLead's runtime audio hook,
// adapted to per-line on-demand TTS instead of pre-generated MP3s
// since wizard lines come from the LLM and aren't enumerable.

const STORAGE_KEY = 'vanta-voice-enabled';
const MAX_QUEUE = 6;

let serverEnabled = false;
let userEnabled = false;
let lastSpokenTs = 0;
const queue = [];
const recentlyPlayed = new Set(); // last 50 ts:text keys for dedup
let currentAudio = null;
let playing = false;

export async function initVoice() {
  try {
    const r = await fetch('/api/voice/status', { cache: 'no-store' });
    if (r.ok) {
      const d = await r.json();
      serverEnabled = !!d.enabled;
    }
  } catch (_) { /* viewer offline; voice off */ }
  try {
    userEnabled = localStorage.getItem(STORAGE_KEY) === '1';
  } catch (_) { userEnabled = false; }
  return serverEnabled;
}

export function voiceCanRender() { return serverEnabled; }
export function voiceEnabled() { return serverEnabled && userEnabled; }

export function setVoiceEnabled(v) {
  userEnabled = !!v;
  try {
    localStorage.setItem(STORAGE_KEY, userEnabled ? '1' : '0');
  } catch (_) { /* private mode? ignore */ }
  if (!userEnabled) stopAndClear();
}

/**
 * Inspect the current `messages[]` ring buffer (same shape returned
 * by /messages) and enqueue any new vanta lines for playback.
 * Idempotent — calling repeatedly with the same buffer is a no-op.
 */
export function flushNew(messages) {
  if (!voiceEnabled()) return;
  if (!Array.isArray(messages) || messages.length === 0) return;
  // First call: skip the entire backlog so visitors arriving mid-
  // session don't get bombarded.
  if (lastSpokenTs === 0) {
    lastSpokenTs = messages[messages.length - 1].ts;
    return;
  }
  for (const m of messages) {
    if (m.ts <= lastSpokenTs) continue;
    if (m.source === 'system') continue;
    const speaker = (m.username || '').toLowerCase();
    // For v1, only the agent's voice. Bots stay silent.
    if (speaker !== 'vanta' && speaker !== 'wizard') continue;
    const key = m.ts + ':' + m.text;
    if (recentlyPlayed.has(key)) continue;
    recentlyPlayed.add(key);
    if (recentlyPlayed.size > 50) {
      // Drop oldest (Set preserves insertion order).
      const first = recentlyPlayed.values().next().value;
      recentlyPlayed.delete(first);
    }
    enqueue(m.text);
    lastSpokenTs = m.ts;
  }
}

function enqueue(text) {
  if (!text || typeof text !== 'string') return;
  if (queue.length >= MAX_QUEUE) queue.shift();
  queue.push(text);
  if (!playing) tick();
}

async function tick() {
  if (!voiceEnabled()) { stopAndClear(); return; }
  const text = queue.shift();
  if (!text) { playing = false; return; }
  playing = true;
  let hash;
  try {
    hash = await sha256Hex(text);
  } catch (_) {
    playing = false;
    return;
  }
  const url = '/api/tts/' + hash + '?text=' + b64url(text);
  const audio = new Audio(url);
  currentAudio = audio;
  const advance = () => { currentAudio = null; tick(); };
  audio.onended = advance;
  audio.onerror = advance;
  try {
    await audio.play();
  } catch (_err) {
    // Autoplay blocked; re-queue and bail. Next user gesture retries.
    queue.unshift(text);
    playing = false;
  }
}

function stopAndClear() {
  queue.length = 0;
  if (currentAudio) {
    try { currentAudio.pause(); } catch (_) {}
  }
  currentAudio = null;
  playing = false;
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function b64url(s) {
  return btoa(unescape(encodeURIComponent(s)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
