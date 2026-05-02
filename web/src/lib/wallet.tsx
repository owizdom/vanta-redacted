"use client";

import { useConnectModal } from "@rainbow-me/rainbowkit";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useAccount, useDisconnect } from "wagmi";

import { setDemoBridge, DEMO_ADDRESS } from "./wallets/demo-bridge";

export type WalletMode = "real" | "demo";

export interface DemoPosition {
  readonly conditionId: string;
  readonly question: string;
  readonly side: "YES" | "NO";
  readonly entryCents: number;
  readonly notionalUsdc: number;
  readonly principalUsdc: number;
  readonly haircutBps: number;
  readonly originatedAt: number;
}

/**
 * Public wallet API consumed across the app. Both real (wagmi) and
 * synthetic (demo) sessions resolve into the same shape.
 *
 * Invariant: any future `useAccount()` / `useBalance()` consumer must
 * gate on `connector?.id !== 'vanta-demo'` before assuming a provider
 * exists — the demo connector returns no provider and never RPCs.
 */
export interface WalletApi {
  readonly connected: boolean;
  readonly mode: WalletMode | null;
  readonly address: string | null;
  /** Whole USDC available in the user's wallet (synthetic in demo). */
  readonly balanceUsdc: number;
  /** USDC pledged into open positions. */
  readonly pledgedUsdc: number;
  /** USDC borrowed (active loan principal). */
  readonly borrowedUsdc: number;
  /** Synthetic positions for demo mode; empty for real (real ones come from on-chain). */
  readonly positions: readonly DemoPosition[];
  /** Open the RainbowKit connect modal. */
  readonly openConnect: () => void;
  /** Activate the synthetic demo wallet (also fired by the demo connector). */
  readonly enterDemo: () => void;
  /** Disconnect both real + demo. */
  readonly disconnect: () => void;
  /** Demo-only mutator: append a position after a "pledge". */
  readonly addDemoPledge: (p: Omit<DemoPosition, "originatedAt">) => void;
}

interface DemoState {
  readonly balanceUsdc: number;
  readonly pledgedUsdc: number;
  readonly borrowedUsdc: number;
  readonly positions: readonly DemoPosition[];
}

const DEMO_INIT: DemoState = {
  balanceUsdc: 5_000,
  pledgedUsdc: 0,
  borrowedUsdc: 0,
  positions: [],
};

const STORAGE_KEY = "vanta-demo-v1";
const DEMO_CONNECTOR_ID = "vanta-demo";

function readDemo(): DemoState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    return JSON.parse(raw) as DemoState;
  } catch {
    return null;
  }
}

function writeDemo(s: DemoState | null): void {
  if (typeof window === "undefined") return;
  if (s === null) {
    window.localStorage.removeItem(STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

const Ctx = createContext<WalletApi | null>(null);

export function WalletProvider({
  children,
}: {
  readonly children: React.ReactNode;
}): JSX.Element {
  const wagmi = useAccount();
  const { disconnect: wagmiDisconnect } = useDisconnect();
  const { openConnectModal } = useConnectModal();

  const [demo, setDemo] = useState<DemoState | null>(null);

  // Hydrate demo from localStorage once.
  useEffect(() => {
    const persisted = readDemo();
    if (persisted !== null) setDemo(persisted);
  }, []);

  // Persist demo on change.
  useEffect(() => {
    writeDemo(demo);
  }, [demo]);

  // The demo connector is registered with wagmi/RainbowKit, so when a
  // user clicks "Demo account" in the picker, wagmi reports it as
  // connected with the synthetic address. Exclude it from
  // `realConnected` so demo state doesn't masquerade as a real wallet.
  const realConnected =
    wagmi.isConnected &&
    wagmi.address !== undefined &&
    wagmi.connector?.id !== DEMO_CONNECTOR_ID;

  const demoActive = demo !== null && !realConnected;

  const enterDemo = useCallback((): void => {
    setDemo(DEMO_INIT);
  }, []);

  const disconnect = useCallback((): void => {
    // Tear down whichever connector is active (covers both the real
    // wallet and the demo connector — wagmi's `disconnect` no-ops if
    // there's no active connection).
    wagmiDisconnect();
    setDemo(null);
  }, [wagmiDisconnect]);

  // Bridge: the demo connector lives outside React, so it can't call
  // into context. Register the trigger callbacks for the lifetime of
  // this provider instance.
  useEffect(() => {
    setDemoBridge({ enterDemo, disconnectDemo: () => setDemo(null) });
    return () => setDemoBridge(null);
  }, [enterDemo]);

  const openConnect = useCallback((): void => {
    openConnectModal?.();
  }, [openConnectModal]);

  const addDemoPledge = useCallback(
    (p: Omit<DemoPosition, "originatedAt">): void => {
      setDemo((prev) => {
        if (prev === null) return prev;
        const pos: DemoPosition = { ...p, originatedAt: Date.now() };
        return {
          balanceUsdc: prev.balanceUsdc + p.principalUsdc,
          pledgedUsdc: prev.pledgedUsdc + p.notionalUsdc,
          borrowedUsdc: prev.borrowedUsdc + p.principalUsdc,
          positions: [...prev.positions, pos],
        };
      });
    },
    [],
  );

  const api = useMemo<WalletApi>(() => {
    if (realConnected) {
      return {
        connected: true,
        mode: "real",
        address: wagmi.address ?? null,
        balanceUsdc: 0, // real balance comes from useBalance() in callsites
        pledgedUsdc: 0,
        borrowedUsdc: 0,
        positions: [],
        openConnect,
        enterDemo,
        disconnect,
        addDemoPledge,
      };
    }
    if (demoActive && demo !== null) {
      return {
        connected: true,
        mode: "demo",
        address: DEMO_ADDRESS,
        balanceUsdc: demo.balanceUsdc,
        pledgedUsdc: demo.pledgedUsdc,
        borrowedUsdc: demo.borrowedUsdc,
        positions: demo.positions,
        openConnect,
        enterDemo,
        disconnect,
        addDemoPledge,
      };
    }
    return {
      connected: false,
      mode: null,
      address: null,
      balanceUsdc: 0,
      pledgedUsdc: 0,
      borrowedUsdc: 0,
      positions: [],
      openConnect,
      enterDemo,
      disconnect,
      addDemoPledge,
    };
  }, [
    realConnected,
    wagmi.address,
    demoActive,
    demo,
    openConnect,
    enterDemo,
    disconnect,
    addDemoPledge,
  ]);

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletApi {
  const v = useContext(Ctx);
  if (v === null) {
    throw new Error("useWallet must be used inside <WalletProvider>");
  }
  return v;
}

export function shortAddress(addr: string | null): string {
  if (addr === null) return "—";
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function fmtUsdc(n: number): string {
  if (n === 0) return "$0";
  if (n >= 1000) return `$${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}
