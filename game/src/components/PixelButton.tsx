import { type ButtonHTMLAttributes, forwardRef } from "react";

/**
 * Pixel-art button styled to match the Kenney UI pack — wood/stone
 * bevel via box-shadow, pixelated edge rendering. Used for the main
 * landing menu (PLAY / CONNECT WALLET / ABOUT).
 *
 * Variants tint the bevel: `neutral` is the default stone, `primary`
 * is the violet "play" CTA.
 */
type Variant = "neutral" | "primary" | "danger";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: Variant;
  readonly size?: "md" | "lg";
}

const VARIANT: Record<Variant, { bg: string; bevel: string; text: string }> = {
  neutral: {
    bg: "bg-ink-800",
    bevel: "shadow-[inset_0_-4px_0_0_#0b0b0e,inset_0_2px_0_0_#3b3b48]",
    text: "text-chalk-100",
  },
  primary: {
    bg: "bg-opus",
    bevel:
      "shadow-[inset_0_-4px_0_0_#5a3fb0,inset_0_2px_0_0_#c5a8ff,0_0_24px_-4px_#9b6bff]",
    text: "text-ink-950",
  },
  danger: {
    bg: "bg-signal-red",
    bevel: "shadow-[inset_0_-4px_0_0_#a83a37,inset_0_2px_0_0_#ff8a87]",
    text: "text-ink-950",
  },
};

export const PixelButton = forwardRef<HTMLButtonElement, Props>(
  function PixelButton(
    { variant = "neutral", size = "md", className = "", children, ...rest },
    ref,
  ) {
    const v = VARIANT[variant];
    const padding = size === "lg" ? "px-8 py-4 text-sm" : "px-6 py-3 text-xs";
    return (
      <button
        ref={ref}
        className={[
          "group relative inline-flex items-center justify-center gap-2",
          "font-mono uppercase tracking-[0.22em] font-medium",
          "border border-black/40 rounded-[2px]",
          "transition-transform duration-150 active:translate-y-[2px]",
          "hover:brightness-110 disabled:opacity-50 disabled:hover:brightness-100",
          padding,
          v.bg,
          v.bevel,
          v.text,
          className,
        ].join(" ")}
        {...rest}
      >
        {children}
      </button>
    );
  },
);
