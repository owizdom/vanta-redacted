"use client";

import { RainbowKitProvider } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { WagmiProvider } from "wagmi";
import { baseSepolia } from "wagmi/chains";

import { vantaTheme } from "@/lib/rainbowkit-theme";
import { wagmiConfig } from "@/lib/wagmi";
import { WalletProvider } from "@/lib/wallet";

export function Providers({
  children,
}: {
  readonly children: React.ReactNode;
}): JSX.Element {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={vantaTheme}
          modalSize="compact"
          initialChain={baseSepolia}
        >
          <WalletProvider>{children}</WalletProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
