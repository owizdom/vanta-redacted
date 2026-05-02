"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useAccount, useDisconnect } from "wagmi";

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
  /** Modal control. */
  readonly connectModalOpen: boolean;
  readonly openConnect: () => void;
  readonly closeConnect: () => void;
  /** Activate the synthetic demo wallet. */
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

const DEMO_ADDRESS = "0xDEM00000c0a8AeD1dc9aC1bA2a31eD8DEM00DEAD" as const;
const DEMO_INIT: DemoState = {
  balanceUsdc: 5_000,
  pledgedUsdc: 0,
  borrowedUsdc: 0,
  positions: [],
};

const STORAGE_KEY = "vanta-demo-v1";

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

  const [demo, setDemo] = useState<DemoState | null>(null);
  const [connectModalOpen, setConnectModalOpen] = useState(false);

  // Hydrate demo from localStorage once.
  useEffect(() => {
    const persisted = readDemo();
    if (persisted !== null) setDemo(persisted);
  }, []);

  // Persist demo on change.
  useEffect(() => {
    writeDemo(demo);
  }, [demo]);

  // Real-wallet connection wins; demo is only "active" if wagmi isn't connected.
  const realConnected = wagmi.isConnected && wagmi.address !== undefined;
  const demoActive = demo !== null && !realConnected;

  const enterDemo = useCallback((): void => {
    setDemo(DEMO_INIT);
    setConnectModalOpen(false);
  }, []);

  const disconnect = useCallback((): void => {
    if (realConnected) wagmiDisconnect();
    setDemo(null);
  }, [realConnected, wagmiDisconnect]);

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
        connectModalOpen,
        openConnect: () => setConnectModalOpen(true),
        closeConnect: () => setConnectModalOpen(false),
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
        connectModalOpen,
        openConnect: () => setConnectModalOpen(true),
        closeConnect: () => setConnectModalOpen(false),
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
      connectModalOpen,
      openConnect: () => setConnectModalOpen(true),
      closeConnect: () => setConnectModalOpen(false),
      enterDemo,
      disconnect,
      addDemoPledge,
    };
  }, [
    realConnected,
    wagmi.address,
    demoActive,
    demo,
    connectModalOpen,
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
