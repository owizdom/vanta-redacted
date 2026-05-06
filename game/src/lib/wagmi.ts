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

import { demoWallet } from "./wallets/demo-wallet";

/**
 * wagmi config — Base Sepolia + Polygon Amoy (matches our deploy
 * targets). Vite is SPA so no `ssr: true` flag here (unlike /web).
 *
 * baseSepolia transport is pinned to localhost:8545 (anvil fork) so
 * the demo wallet's transactions actually clear on the local chain
 * we deployed against. Real Base Sepolia testing should swap this
 * to the public RPC.
 */
const connectors = connectorsForWallets(
  [
    {
      groupName: "Popular",
      wallets: [metaMaskWallet, coinbaseWallet, rainbowWallet, injectedWallet],
    },
    {
      groupName: "Demo",
      wallets: [demoWallet],
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
    [baseSepolia.id]: http("http://127.0.0.1:8545"),
    [polygonAmoy.id]: http("http://127.0.0.1:8546"),
  },
});
