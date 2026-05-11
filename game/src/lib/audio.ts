/**
 * Audio engine for the watchable world.
 *
 * Two surfaces:
 *   1. `playEventSfx(type)` — discrete SFX tied to a signed-event type.
 *      The chat panel scrolls; the audio cue makes you look.
 *   2. `startAmbient()` / `stopAmbient()` — looping nature bed.
 *
 * Both are gated by a single mute toggle. The toggle persists in
 * localStorage. Default is muted-on-load (browsers block autoplay
 * without a user gesture).
 *
 * Implementation notes:
 *  - Clips are HTMLAudioElements, lazily constructed on first use,
 *    cloned per play to allow overlap.
 *  - A 200ms global gate prevents a council-thought burst from
 *    cacophonying the SFX channel.
 *  - The ambient element is a long-lived single instance.
 */

const SFX_VOLUME: Record<string, number> = {
  inference: 0.18,
  "npc-thought": 0.22,
  council: 0.35,
  pledge: 0.45,
  origination: 0.55,
  inflow: 0.32,
  settlement: 0.4,
  liquidation: 0.45,
};

const STACK_GATE_MS = 200;
const AMBIENT_VOLUME = 0.18;
const SFX_MASTER_VOLUME = 0.7;

const MUTE_KEY = "vanta:audio:muted";
const AMBIENT_PATH = "/sfx/ambient-bed.mp3"; // chiptune RPG loop; engine no-ops if missing

let muted: boolean = (() => {
  if (typeof window === "undefined") return true;
  const v = window.localStorage.getItem(MUTE_KEY);
  return v === null ? true : v === "1";
})();

const muteListeners = new Set<(muted: boolean) => void>();

function notifyMute(): void {
  for (const fn of muteListeners) fn(muted);
}

export function isMuted(): boolean {
  return muted;
}

export function setMuted(next: boolean): void {
  muted = next;
  if (typeof window !== "undefined") {
    window.localStorage.setItem(MUTE_KEY, next ? "1" : "0");
  }
  if (next) {
    if (ambientEl !== null) ambientEl.pause();
  } else {
    void ensureAmbient();
  }
  notifyMute();
}

export function subscribeMute(fn: (muted: boolean) => void): () => void {
  muteListeners.add(fn);
  return () => muteListeners.delete(fn);
}

// ---------- SFX ----------

const sfxCache = new Map<string, HTMLAudioElement>();
let lastSfxAt = 0;

function loadSfx(name: string): HTMLAudioElement {
  let cached = sfxCache.get(name);
  if (cached !== undefined) return cached;
  cached = new Audio(`/sfx/${name}.ogg`);
  cached.preload = "auto";
  sfxCache.set(name, cached);
  return cached;
}

export type SfxName = keyof typeof SFX_VOLUME;

/** Play a one-shot SFX. No-op when muted, gated to ≥200ms apart. */
export function playSfx(name: SfxName): void {
  if (muted) return;
  const now = Date.now();
  if (now - lastSfxAt < STACK_GATE_MS) return;
  lastSfxAt = now;
  const base = loadSfx(name);
  // Clone so back-to-back plays don't cut each other off.
  const inst = base.cloneNode(true) as HTMLAudioElement;
  inst.volume = (SFX_VOLUME[name] ?? 0.3) * SFX_MASTER_VOLUME;
  inst.play().catch(() => {
    // Autoplay block or asset missing — silent failure.
  });
}

/**
 * Map an SSE event type to its SFX. Returns the matched name or null.
 * The dispatcher in routes/World.tsx calls this and forwards to playSfx.
 */
export function sfxForEventType(type: string): SfxName | null {
  switch (type) {
    case "op.inference":
      return "inference";
    case "npc.thought":
      return "npc-thought";
    case "council.synthesised":
      return "council";
    case "loan.pledge":
      return "pledge";
    case "loan.origination":
      return "origination";
    case "treasury.inflow":
      return "inflow";
    case "loan.settlement":
      return "settlement";
    case "loan.liquidation":
      return "liquidation";
    default:
      return null;
  }
}

// ---------- Ambient bed ----------

let ambientEl: HTMLAudioElement | null = null;
let ambientAttempted = false;

async function ensureAmbient(): Promise<void> {
  if (muted) return;
  if (ambientAttempted && ambientEl === null) return; // no asset shipped
  if (ambientEl !== null) {
    ambientEl.volume = AMBIENT_VOLUME;
    if (ambientEl.paused) {
      try {
        await ambientEl.play();
      } catch {
        // autoplay block; will retry on next user-driven setMuted(false)
      }
    }
    return;
  }
  ambientAttempted = true;
  // Probe for the file — if 404, just skip silently.
  try {
    const res = await fetch(AMBIENT_PATH, { method: "HEAD" });
    if (!res.ok) return;
    ambientEl = new Audio(AMBIENT_PATH);
    ambientEl.loop = true;
    ambientEl.volume = AMBIENT_VOLUME;
    await ambientEl.play();
  } catch {
    ambientEl = null;
  }
}

/**
 * Call once after the first user gesture (e.g. unmute click). Safe
 * to call repeatedly. Silently no-ops if the ambient asset isn't
 * shipped.
 */
export function primeAmbient(): void {
  void ensureAmbient();
}
