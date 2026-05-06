import {
  connectorsForWallets,
} from "@rainbow-me/rainbowkit";
import {
  coinbaseWallet,
  injectedWallet,
  metaMaskWallet,
  rainbowWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { http, createConfig } from "wagmi";
import { baseSepolia, polygonAmoy } from "wagmi/chains";

/**
 * wagmi config — Base Sepolia + Polygon Amoy (matches our deploy
 * targets). Vite is SPA so no `ssr: true` flag here (unlike /web).
 */
const connectors = connectorsForWallets(
  [
    {
      groupName: "Popular",
      wallets: [metaMaskWallet, coinbaseWallet, rainbowWallet, injectedWallet],
    },
  ],
  {
    appName: "VANTA",
    projectId: "VANTA_LOCAL",
  },
);

export const wagmiConfig = createConfig({
  chains: [baseSepolia, polygonAmoy],
  connectors,
  transports: {
    [baseSepolia.id]: http(),
    [polygonAmoy.id]: http(),
  },
});
