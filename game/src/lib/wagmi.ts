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
 * wagmi config — mainnet (Base + Polygon) by default; testnet
 * (Base Sepolia + Polygon Amoy) when `VITE_CHAIN_ENV=testnet`. Vite
 * is SPA so no `ssr: true` flag here (unlike /web).
 *
 * The demo connector group is always shown. On mainnet it has no
 * private key (read-only address; borrow flow uses the runtime's
 * signer). On testnet/local it uses anvil's prefunded test account.
 */

const IS_MAINNET = import.meta.env.VITE_CHAIN_ENV !== "testnet";

// The demo wallet is always shown. On mainnet it has no private key
// (read-only address; borrow flow uses the runtime's signer). On
// testnet/local it uses anvil's prefunded test account.
const walletGroups: Parameters<typeof connectorsForWallets>[0] = [
  {
    groupName: "Try the demo",
    wallets: [demoWallet],
  },
  {
    groupName: "Popular",
    wallets: [metaMaskWallet, coinbaseWallet, rainbowWallet, injectedWallet],
  },
];

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
