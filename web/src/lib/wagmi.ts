import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  coinbaseWallet,
  injectedWallet,
  metaMaskWallet,
  rainbowWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { http, createConfig } from "wagmi";
import { base, polygon } from "wagmi/chains";

import { demoWallet } from "./wallets/demo-wallet";

/**
 * wagmi config — Base mainnet + Polygon mainnet (matches our deploy targets).
 *
 * Connectors are built via RainbowKit's `connectorsForWallets` so the
 * UI wallet picker matches the wagmi config 1:1.
 *
 *   group "Popular":  MetaMask, Coinbase, Rainbow, Browser Wallet
 *   group "Demo":     synthetic VANTA demo (uses demo-bridge to flip
 *                     WalletProvider state; never RPCs)
 *
 * WalletConnect is intentionally omitted: its SDK pulls in idb-keyval
 * which touches `indexedDB` at import-time, breaking SSR. Re-enable
 * once `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` is wired through env;
 * the placeholder `projectId` below is required by RainbowKit types
 * but never reaches a real WC relay.
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
  chains: [base, polygon],
  ssr: true,
  connectors,
  transports: {
    [base.id]: http(),
    [polygon.id]: http(),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
