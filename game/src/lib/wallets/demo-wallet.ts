/**
 * One-click "demo account" wallet for the local demo.
 *
 * Why this exists: during a 10-minute demo we cannot ask the
 * presenter to install MetaMask, add the localhost network, import a
 * private key, and bridge USDC. One click → connected → everything
 * downstream (deposit form, borrower flow) works against the locally
 * deployed v2 lender stack on anvil.
 *
 * Implementation: a wagmi connector backed by `privateKeyToAccount`
 * over anvil's first prefunded EOA (private key
 * `0xac0974…f80`, address `0xf39Fd…2266`). That account already has
 * 10000 ETH from anvil's defaults; `seed-onchain.ts` separately
 * mints USDC into the same address via `anvil_setStorageAt` so the
 * deposit modal renders a real $5,000 USDC balance.
 *
 * UNLIKE the synthetic demo wallet at /web, this connector reaches a
 * real RPC (localhost:8545). All transactions clear on-chain and the
 * lender's TVL ticks up by the actual deposit amount.
 *
 * Production note: this wallet is only useful when an anvil fork is
 * up locally. Pointing it at any non-anvil RPC will leak ETH out of
 * the prefunded test address (which is publicly known). Never bundle
 * this in a production build with a non-localhost transport.
 */

import type { Wallet, WalletDetailsParams } from "@rainbow-me/rainbowkit";
import { createWalletClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createConnector } from "wagmi";
import { baseSepolia } from "wagmi/chains";

/**
 * Anvil's first prefunded test account. Public knowledge — published in
 * Foundry's quickstart guide and on every developer's machine running
 * the default Anvil chain. Safe to embed in client code for a local
 * demo; never publish a build using this against a public RPC.
 */
const DEMO_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const DEMO_ACCOUNT = privateKeyToAccount(DEMO_PRIVATE_KEY);
export const DEMO_ADDRESS: Address = DEMO_ACCOUNT.address;

const ANVIL_RPC = "http://127.0.0.1:8545";

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
        // No-op
      },

      async connect({ chainId } = {}) {
        const cid = chainId ?? baseSepolia.id;
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
        return baseSepolia.id;
      },

      async isAuthorized() {
        if (typeof window === "undefined") return false;
        return window.localStorage.getItem(STORAGE_KEY) !== null;
      },

      async switchChain({ chainId }) {
        const next =
          chainId === baseSepolia.id
            ? baseSepolia
            : { ...baseSepolia, id: chainId };
        config.emitter.emit("change", { chainId });
        return next;
      },

      async getProvider() {
        // Return a wallet client backed by the local anvil RPC + the
        // anvil test private key. Wagmi's `useWriteContract` /
        // `useSendTransaction` resolve through this exact provider.
        return createWalletClient({
          account: DEMO_ACCOUNT,
          chain: baseSepolia,
          transport: http(ANVIL_RPC),
        });
      },

      onAccountsChanged() {
        // single-account, never changes
      },

      onChainChanged() {
        // single-chain
      },

      onDisconnect() {
        if (typeof window !== "undefined") {
          window.localStorage.removeItem(STORAGE_KEY);
        }
        config.emitter.emit("disconnect");
      },
    })),
});
