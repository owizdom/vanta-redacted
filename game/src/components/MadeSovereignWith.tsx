/**
 * `<MadeSovereignWith>` — attribution chip used on the world view, the
 * landing menu footer, and the marketplace hero.
 *
 *   MADE SOVEREIGN WITH  [EigenCloud logo →]
 *
 * The whole row links to VANTA's deployed-app attestation page on the
 * EigenCloud Sepolia verifier — the trust handoff to a third-party
 * verifier you can use to confirm the agent is the binary it claims
 * to be. Ported from /web/src/app/app/_components/made-sovereign-with.tsx
 * with light styling tweaks for the game's pixel/dark theme.
 */

const VERIFY_URL =
  "https://verify-sepolia.eigencloud.xyz/app/0x98Ff56d84B31F44DacB4688828Dc19CD85393033";

interface Props {
  /** Adjusts logo height + label size. Default `md`. */
  readonly size?: "sm" | "md";
  /** Tone of the label text. */
  readonly tone?: "muted" | "bright";
}

export function MadeSovereignWith({ size = "md", tone = "muted" }: Props): JSX.Element {
  const isSm = size === "sm";
  const labelClass = [
    "font-mono uppercase",
    isSm ? "text-[9px] tracking-[0.22em]" : "text-[11px] tracking-widest",
    tone === "bright" ? "text-chalk-100" : "text-chalk-400",
  ].join(" ");
  const logoH = isSm ? "h-4" : "h-5";
  const logoW = isSm ? "w-[36px]" : "w-[44px]";

  return (
    <a
      href={VERIFY_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="group inline-flex items-center gap-2 transition-opacity hover:opacity-80"
      aria-label="Verify VANTA's attestation on EigenCloud"
      title="Verify on the EigenCloud Sepolia attestation page"
    >
      <span className={labelClass}>made sovereign with</span>
      <span
        role="img"
        aria-label="EigenCloud"
        className={[
          "block bg-chalk-100 transition-colors group-hover:bg-chalk-50",
          logoH,
          logoW,
        ].join(" ")}
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
  );
}
