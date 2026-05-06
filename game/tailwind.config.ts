import type { Config } from "tailwindcss";

// Palette ported from /web/tailwind.config.ts so the game's chrome
// matches the marketing site exactly. Three agent colours
// (opus/gpt/gemini) sit alongside the dark "ink" base + chalk text.
const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
        display: ["Inter Tight", "Inter", "sans-serif"],
        pixel: ['"Press Start 2P"', "monospace"],
      },
      colors: {
        ink: {
          950: "#0b0b0e",
          900: "#121218",
          800: "#1a1a22",
          700: "#23232d",
          600: "#2e2e3a",
        },
        chalk: {
          50: "#f8f7f2",
          100: "#eeece5",
          200: "#d6d4cb",
          300: "#a8a59a",
          400: "#7c7a6f",
          500: "#605e54",
          600: "#42413a",
        },
        opus: {
          DEFAULT: "#9b6bff",
          glow: "#c5a8ff",
        },
        gpt: {
          DEFAULT: "#4fae5a",
          glow: "#9ad5a3",
        },
        gemini: {
          DEFAULT: "#4287f5",
          glow: "#90b6f9",
        },
        signal: {
          green: "#43e08c",
          amber: "#f6b73c",
          red: "#ff5e5b",
        },
      },
      keyframes: {
        pulseDot: {
          "0%, 100%": { opacity: "0.4" },
          "50%": { opacity: "1" },
        },
        slideInRight: {
          "0%": { transform: "translateX(100%)", opacity: "0" },
          "100%": { transform: "translateX(0)", opacity: "1" },
        },
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
      },
      animation: {
        pulseDot: "pulseDot 1.6s ease-in-out infinite",
        slideInRight: "slideInRight 280ms cubic-bezier(0.22, 1, 0.36, 1)",
        fadeIn: "fadeIn 240ms ease-out",
      },
    },
  },
  plugins: [],
};
export default config;
