/**
 * "Try the demo" wallet — one-click connect with a synthetic address
 * so visitors can run the borrow flow without bringing a wallet.
 *
 * Two modes:
 *
 *   1. Mainnet (VITE_CHAIN_ENV=mainnet) — connects with a fixed
 *      synthetic address on Base mainnet, NO embedded private key
 *      and NO custom RPC transport. The demo wallet cannot sign any
 *      transaction. The borrow modal still works because the demo
 *      borrow path posts to `/admin/demo/borrow`, which signs in
 *      the runtime's TEE; deposits/withdrawals are intentionally
 *      unavailable in this mode.
 *
 *   2. Local dev — connects to anvil on 127.0.0.1:8545 with the
 *      first prefunded test key (publicly known, safe locally).
 *      This is the original "demo account" used during the local
 *      stack demo where a real on-chain deposit is desirable.
 *
 * Mode is decided at module-eval time from `VITE_CHAIN_ENV`. The
 * mainnet branch never imports `privateKeyToAccount` so the anvil
 * key cannot leak into a production bundle.
 */

import type { Wallet, WalletDetailsParams } from "@rainbow-me/rainbowkit";
import { createWalletClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createConnector } from "wagmi";
import { base, baseSepolia } from "wagmi/chains";

const IS_MAINNET = import.meta.env.VITE_CHAIN_ENV === "mainnet";

const ANVIL_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const ANVIL_RPC = "http://127.0.0.1:8545";

const SYNTHETIC_DEMO_ADDRESS: Address =
  "0x0000000000000000000000000000000000000d3a";

const ACTIVE_CHAIN = IS_MAINNET ? base : baseSepolia;
const DEMO_ADDRESS: Address = IS_MAINNET
  ? SYNTHETIC_DEMO_ADDRESS
  : privateKeyToAccount(ANVIL_PRIVATE_KEY).address;

export { DEMO_ADDRESS };

const ICON_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28">
  <rect width="28" height="28" rx="6" fill="#6c54ff"/>
  <path d="M7 8.5h3.6L14 18.1l3.4-9.6H21l-5.5 14H12.5L7 8.5Z" fill="#f6f7f9"/>
</svg>
`.trim();
const ICON_DATA_URL =
  "data:image/svg+xml;utf8," + encodeURIComponent(ICON_SVG);

const STORAGE_KEY = "vanta-game-demo-wallet";

export const demoWallet = (): Wallet => ({
  id: "vanta-demo",
  name: IS_MAINNET ? "Try the demo (no funds needed)" : "Demo account (anvil)",
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
      name: "Demo",
      type: "demo" as const,

      async setup() {},

      async connect({ chainId } = {}) {
        const cid = chainId ?? ACTIVE_CHAIN.id;
        if (typeof window !== "undefined") {
          window.localStorage.setItem(STORAGE_KEY, "1");
        }
        config.emitter.emit("connect", {
          accounts: [DEMO_ADDRESS],
          chainId: cid,
        });
        return { accounts: [DEMO_ADDRESS], chainId: cid };
      },

      async disconnect() {
        if (typeof window !== "undefined") {
          window.localStorage.removeItem(STORAGE_KEY);
        }
        config.emitter.emit("disconnect");
      },

      async getAccounts() {
        return [DEMO_ADDRESS];
      },

      async getChainId() {
        return ACTIVE_CHAIN.id;
      },

      async isAuthorized() {
        if (typeof window === "undefined") return false;
        return window.localStorage.getItem(STORAGE_KEY) !== null;
      },

      async switchChain({ chainId }) {
        const next =
          chainId === ACTIVE_CHAIN.id
            ? ACTIVE_CHAIN
            : { ...ACTIVE_CHAIN, id: chainId };
        config.emitter.emit("change", { chainId });
        return next;
      },

      async getProvider() {
        if (IS_MAINNET) {
          // Read-only provider on a public RPC. The demo wallet has
          // no private key on mainnet — any `useWriteContract` will
          // throw, which is the desired behavior. The borrow demo
          // bypasses wagmi entirely and posts to the runtime.
          return createWalletClient({
            chain: base,
            transport: http("https://mainnet.base.org"),
          });
        }
        return createWalletClient({
          account: privateKeyToAccount(ANVIL_PRIVATE_KEY),
          chain: baseSepolia,
          transport: http(ANVIL_RPC),
        });
      },

      onAccountsChanged() {},
      onChainChanged() {},
      onDisconnect() {
        if (typeof window !== "undefined") {
          window.localStorage.removeItem(STORAGE_KEY);
        }
        config.emitter.emit("disconnect");
      },
    })),
});
