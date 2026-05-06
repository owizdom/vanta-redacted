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
import { base, baseSepolia, polygon, polygonAmoy } from "wagmi/chains";

import { demoWallet } from "./wallets/demo-wallet";

/**
 * wagmi config — testnet (Base Sepolia + Polygon Amoy) by default,
 * mainnet (Base + Polygon) when VITE_CHAIN_ENV=mainnet. Vite is SPA
 * so no `ssr: true` flag here (unlike /web).
 *
 * The demo connector group (anvil-keyed wallet, localhost RPC) is
 * only registered when VITE_DEMO_MODE=1. Production Vercel builds
 * leave VITE_DEMO_MODE unset → demoWallet is excluded from the
 * connector list entirely.
 */

const IS_MAINNET = import.meta.env.VITE_CHAIN_ENV === "mainnet";
const IS_DEMO = import.meta.env.VITE_DEMO_MODE === "1";

const walletGroups: Parameters<typeof connectorsForWallets>[0] = [
  {
    groupName: "Popular",
    wallets: [metaMaskWallet, coinbaseWallet, rainbowWallet, injectedWallet],
  },
];
if (IS_DEMO) {
  walletGroups.push({
    groupName: "Demo",
    wallets: [demoWallet],
  });
}

const connectors = connectorsForWallets(walletGroups, {
  appName: "VANTA",
  projectId: "VANTA_LOCAL",
});

const baseRpc = IS_MAINNET
  ? "https://mainnet.base.org"
  : "http://127.0.0.1:8545";
const polygonRpc = IS_MAINNET
  ? "https://polygon-rpc.com"
  : "http://127.0.0.1:8546";

export const wagmiConfig = IS_MAINNET
  ? createConfig({
      chains: [base, polygon],
      connectors,
      transports: {
        [base.id]: http(baseRpc),
        [polygon.id]: http(polygonRpc),
      },
    })
  : createConfig({
      chains: [baseSepolia, polygonAmoy],
      connectors,
      transports: {
        [baseSepolia.id]: http(baseRpc),
        [polygonAmoy.id]: http(polygonRpc),
      },
    });
