import { RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Outlet } from "react-router-dom";
import { WagmiProvider } from "wagmi";

import { ErrorBoundary } from "./components/ErrorBoundary";
import { wagmiConfig } from "./lib/wagmi";

// One query client for the lifetime of the app. Fresh + cache windows
// are short — agent state changes per-second, no need for long TTLs.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5_000, gcTime: 60_000 },
  },
});

const rainbowTheme = darkTheme({
  accentColor: "#9b6bff",
  accentColorForeground: "#0b0b0e",
  borderRadius: "small",
  fontStack: "system",
  overlayBlur: "small",
});

export function App(): JSX.Element {
  return (
    <ErrorBoundary>
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <RainbowKitProvider theme={rainbowTheme} modalSize="compact">
            <Outlet />
          </RainbowKitProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </ErrorBoundary>
  );
}
