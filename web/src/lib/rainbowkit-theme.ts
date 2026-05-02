/**
 * RainbowKit theme tuned to VANTA's brand tokens (ink-* / chalk-* /
 * violet-*). RainbowKit uses CSS-in-JS, so Tailwind classes don't
 * pierce its tree — these values are the only knob.
 */

import { darkTheme, type Theme } from "@rainbow-me/rainbowkit";

const base = darkTheme({
  accentColor: "#6c54ff", // violet-500
  accentColorForeground: "#f6f7f9", // chalk-50
  borderRadius: "medium",
  fontStack: "system",
  overlayBlur: "small",
});

export const vantaTheme: Theme = {
  ...base,
  colors: {
    ...base.colors,
    accentColor: "#6c54ff",
    accentColorForeground: "#f6f7f9",
    modalBackground: "#1a1a1a", // ink-950
    modalBorder: "#2a2a2a",     // ink-800
    modalText: "#f6f7f9",
    modalTextDim: "#7e8694",    // chalk-400
    modalTextSecondary: "#7e8694",
    menuItemBackground: "#202020", // ink-900
    actionButtonBorder: "#2a2a2a",
    actionButtonBorderMobile: "#2a2a2a",
    actionButtonSecondaryBackground: "#202020",
    connectButtonBackground: "#6c54ff",
    connectButtonBackgroundError: "#ff5f6d", // signal-red
    connectButtonInnerBackground: "#202020",
    connectButtonText: "#f6f7f9",
    connectButtonTextError: "#f6f7f9",
    closeButton: "#7e8694",
    closeButtonBackground: "#202020",
    profileAction: "#202020",
    profileActionHover: "#363636", // ink-700
    profileForeground: "#1a1a1a",
    selectedOptionBorder: "#6c54ff",
    standby: "#7e8694",
    generalBorder: "#2a2a2a",
    generalBorderDim: "#202020",
  },
  fonts: {
    ...base.fonts,
    body: "Inter, ui-sans-serif, system-ui, sans-serif",
  },
};
