import {
  connectorsForWallets,
} from "@rainbow-me/rainbowkit";
import {
  coinbaseWallet,
  injectedWallet,
  metaMaskWallet,
  rainbowWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { fallback, http, createConfig } from "wagmi";
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

// Polygon mainnet has been flaky on `polygon-rpc.com` — Polygon Labs
// gates the public endpoint behind a Tenant API key and silently
// returns 401 to anonymous browsers, which breaks every read
// (multicall, balanceOf for CTF positions, etc.). Fallback list of
// public RPCs that actually serve unauthenticated traffic at time of
// writing; viem rotates on failure.
const polygonRpcs = IS_MAINNET
  ? [
      "https://polygon.drpc.org",
      "https://polygon-bor-rpc.publicnode.com",
      "https://1rpc.io/matic",
    ]
  : ["http://127.0.0.1:8546"];

const polygonTransport = fallback(polygonRpcs.map((url) => http(url)));
const polygonAmoyTransport = http("http://127.0.0.1:8546");

export const wagmiConfig = IS_MAINNET
  ? createConfig({
      chains: [base, polygon],
      connectors,
      transports: {
        [base.id]: http(baseRpc),
        [polygon.id]: polygonTransport,
      },
    })
  : createConfig({
      chains: [baseSepolia, polygonAmoy],
      connectors,
      transports: {
        [baseSepolia.id]: http(baseRpc),
        [polygonAmoy.id]: polygonAmoyTransport,
      },
    });
