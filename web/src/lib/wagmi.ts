import { http, createConfig } from "wagmi";
import { baseSepolia, polygonAmoy } from "wagmi/chains";
import { coinbaseWallet, injected } from "wagmi/connectors";

/**
 * wagmi config — Base Sepolia + Polygon Amoy (matches our deploy targets).
 *
 * Connectors:
 *   - injected (auto-detects MetaMask, Rabby, Phantom, etc. via EIP-6963)
 *   - coinbaseWallet (mobile + extension)
 *
 * WalletConnect is intentionally omitted: its SDK pulls in idb-keyval which
 * touches `indexedDB` at import-time, breaking SSR. Add it back behind a
 * dynamic import once we have a real `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`.
 */
export const wagmiConfig = createConfig({
  chains: [baseSepolia, polygonAmoy],
  ssr: true,
  connectors: [
    injected({ shimDisconnect: true }),
    coinbaseWallet({ appName: "VANTA" }),
  ],
  transports: {
    [baseSepolia.id]: http(),
    [polygonAmoy.id]: http(),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
