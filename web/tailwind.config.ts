import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#1a1a1a",
          900: "#202020",
          800: "#2a2a2a",
          700: "#363636",
          600: "#4a4a4a",
        },
        chalk: {
          50: "#f6f7f9",
          200: "#c8cdd6",
          400: "#7e8694",
          600: "#4a5160",
        },
        violet: {
          DEFAULT: "#5b46f0",
          500: "#6c54ff",
          400: "#8a78ff",
          300: "#b6acff",
          glow: "rgba(108, 84, 255, 0.45)",
        },
        accent: {
          lime: "#d6f24a",
          orange: "#ff5b2e",
          lavender: "#c8b9ff",
          mint: "#a8f4d4",
        },
        signal: {
          green: "#43e08c",
          amber: "#ffb547",
          red: "#ff5f6d",
        },
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
        display: ["Inter Tight", "Inter", "sans-serif"],
      },
      keyframes: {
        pulseDot: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.45" },
        },
        marquee: {
          "0%": { transform: "translateX(0%)" },
          "100%": { transform: "translateX(-50%)" },
        },
      },
      animation: {
        "pulse-dot": "pulseDot 1.6s ease-in-out infinite",
        marquee: "marquee 36s linear infinite",
      },
    },
  },
  plugins: [],
};
export default config;
