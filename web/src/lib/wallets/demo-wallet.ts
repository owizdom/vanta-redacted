/**
 * Custom RainbowKit wallet entry — "Demo account".
 *
 * Renders as the only entry under the `Demo` group in the wallet
 * picker. Selecting it never opens a real wallet; instead the
 * connector's `connect()` calls `triggerDemoConnect()` which the
 * WalletProvider listens for and flips the synthetic demo state
 * ($5,000 USDC seed, persisted in `vanta-demo-v1` localStorage).
 *
 * The connector is UI-only: it never reaches an RPC. Any consumer
 * that calls `useBalance()` / `useReadContract()` MUST gate on
 * `connector?.id !== 'vanta-demo'` before assuming a provider exists.
 */

import type { Wallet, WalletDetailsParams } from "@rainbow-me/rainbowkit";
import { createConnector } from "@wagmi/core";
import { baseSepolia } from "wagmi/chains";

import {
  DEMO_ADDRESS,
  triggerDemoConnect,
  triggerDemoDisconnect,
} from "./demo-bridge";

// Inline SVG icon — encoded once at module load. Renders the violet
// VANTA "V" so the wallet picker entry visually ties to the brand.
const ICON_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28">
  <rect width="28" height="28" rx="6" fill="#6c54ff"/>
  <path d="M7 8.5h3.6L14 18.1l3.4-9.6H21l-5.5 14H12.5L7 8.5Z" fill="#f6f7f9"/>
</svg>
`.trim();

const ICON_DATA_URL =
  "data:image/svg+xml;utf8," + encodeURIComponent(ICON_SVG);

export const demoWallet = (): Wallet => ({
  id: "vanta-demo",
  name: "Demo account",
  shortName: "Demo",
  iconUrl: async () => ICON_DATA_URL,
  iconBackground: "#6c54ff",
  iconAccent: "#6c54ff",
  installed: true,
  downloadUrls: {},
  createConnector: (walletDetails: WalletDetailsParams) =>
    createConnector((config) => ({
      ...walletDetails,
      id: "vanta-demo",
      name: "Demo account",
      type: "demo" as const,

      async setup() {
        // No-op: there's nothing to install or detect.
      },

      async connect({ chainId } = {}) {
        const accounts = [DEMO_ADDRESS] as readonly `0x${string}`[];
        const cid = chainId ?? baseSepolia.id;
        triggerDemoConnect();
        config.emitter.emit("connect", {
          accounts: accounts as `0x${string}`[],
          chainId: cid,
        });
        return { accounts: accounts as `0x${string}`[], chainId: cid };
      },

      async disconnect() {
        triggerDemoDisconnect();
        config.emitter.emit("disconnect");
      },

      async getAccounts() {
        return [DEMO_ADDRESS];
      },

      async getChainId() {
        return baseSepolia.id;
      },

      async isAuthorized() {
        if (typeof window === "undefined") return false;
        return window.localStorage.getItem("vanta-demo-v1") !== null;
      },

      async switchChain({ chainId }) {
        // Demo is single-chain; report the requested chain back so
        // RainbowKit's chain switcher closes cleanly. No real switch.
        const next =
          chainId === baseSepolia.id
            ? baseSepolia
            : { ...baseSepolia, id: chainId };
        config.emitter.emit("change", { chainId });
        return next;
      },

      async getProvider() {
        // Never returns a real provider. Anyone calling getProvider()
        // on the demo connector should not exist (see file header).
        return undefined as never;
      },

      onAccountsChanged() {
        // Demo never changes account.
      },

      onChainChanged() {
        // Demo never changes chain.
      },

      onDisconnect() {
        triggerDemoDisconnect();
        config.emitter.emit("disconnect");
      },
    })),
});
