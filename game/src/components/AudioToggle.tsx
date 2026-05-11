/**
 * Mute/unmute toggle for the world soundtrack.
 *
 * Default state is muted (browser autoplay policy + courtesy). The
 * first click flips the global audio engine on AND primes the
 * ambient bed. Sits in the top-right chrome of /world.
 */

import { useEffect, useState } from "react";

import { isMuted, primeAmbient, setMuted, subscribeMute } from "../lib/audio";

export function AudioToggle(): JSX.Element {
  const [m, setM] = useState<boolean>(isMuted());

  useEffect(() => subscribeMute(setM), []);

  const onClick = (): void => {
    const next = !m;
    setMuted(next);
    if (!next) primeAmbient();
  };

  return (
    <button
      type="button"
      onClick={onClick}
      title={m ? "Unmute world audio" : "Mute world audio"}
      className="pointer-events-auto rounded-[2px] border border-ink-700 bg-ink-900/85 px-3 py-1.5 font-mono text-xs uppercase tracking-[0.22em] text-chalk-300 hover:text-chalk-50"
    >
      {m ? "audio · off" : "audio · on"}
    </button>
  );
}
