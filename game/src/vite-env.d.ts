/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CHAIN_ENV?: "mainnet" | "testnet";
  readonly VITE_DEMO_MODE?: "1" | "0";
  readonly VITE_RUNTIME_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
