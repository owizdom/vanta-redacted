"use client";

/**
 * `<MadeSovereignWith>` — top-nav attribution chip.
 *
 *   MADE SOVEREIGN WITH  [EigenCloud logo →]
 *   Saturday, May 2, 2026 · 07:40:36 AM
 *
 * The whole row is a link to VANTA's deployed-app attestation page
 * on the EigenCloud Sepolia verifier. Identity values (image hash,
 * genesis, KMS, etc.) live on the AgentBand's bottom meta strip on
 * /app — this chip is just the trust handoff to a third-party
 * verifier.
 *
 * Hidden below `md` so the top nav doesn't get crammed.
 */

import { useEffect, useState } from "react";

const VERIFY_URL =
  "https://verify-sepolia.eigencloud.xyz/app/0x98Ff56d84B31F44DacB4688828Dc19CD85393033";

export function MadeSovereignWith(): JSX.Element {
  // Empty on first paint to avoid an SSR/client hydration mismatch on
  // the time string; populated once after mount and re-formatted every
  // 1s so the seconds field actually moves.
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const dayLabel = now === null
    ? ""
    : now.toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      });
  const timeLabel = now === null
    ? ""
    : now.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });

  return (
    <div className="hidden flex-col items-end gap-1 md:flex">
      <a
        href={VERIFY_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="group flex items-center gap-2 transition-opacity"
        aria-label="Verify VANTA's attestation on EigenCloud"
      >
        <span className="font-mono text-[11px] font-medium uppercase tracking-widest text-chalk-200">
          Made sovereign with
        </span>
        {/*
          The PNG is dark-on-light by default; using it as an alpha mask
          on a violet block lets us re-color the mark to the brand
          accent without baking a separate asset. mask-size:contain pins
          to the element height; aspect ratio of the logo is ~2.1:1.
        */}
        <span
          role="img"
          aria-label="EigenCloud"
          className="block h-6 w-[52px] bg-violet-300 transition-colors group-hover:bg-violet-200"
          style={{
            WebkitMaskImage: "url(/eigencloud_logo.png)",
            maskImage: "url(/eigencloud_logo.png)",
            WebkitMaskSize: "contain",
            maskSize: "contain",
            WebkitMaskRepeat: "no-repeat",
            maskRepeat: "no-repeat",
            WebkitMaskPosition: "left center",
            maskPosition: "left center",
          }}
        />
      </a>
      <span
        suppressHydrationWarning
        className="font-mono text-[11px] font-medium uppercase tracking-wider text-chalk-400"
      >
        {now === null ? "" : `${dayLabel} · ${timeLabel}`}
      </span>
    </div>
  );
}
