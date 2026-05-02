"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { WagmiProvider } from "wagmi";

import { wagmiConfig } from "@/lib/wagmi";
import { WalletProvider } from "@/lib/wallet";

import { ConnectModal } from "./connect-modal";

export function Providers({
  children,
}: {
  readonly children: React.ReactNode;
}): JSX.Element {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <WalletProvider>
          {children}
          <ConnectModal />
        </WalletProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
