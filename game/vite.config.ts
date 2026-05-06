import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Game frontend dev server. Mirrors /web's next.config.mjs proxy:
// - /api/runtime/*  →  http://127.0.0.1:8787/api/*
// - /healthz, /.well-known/*  →  the runtime root
//
// Keeps the API client (lib/runtime.ts) framework-agnostic — the
// only thing that changes between /web and /game is the proxy
// machinery, not the call sites.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3031,
    strictPort: true,
    proxy: {
      "/api/runtime": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/runtime/, "/api"),
      },
      "/healthz": "http://127.0.0.1:8787",
      "/.well-known": "http://127.0.0.1:8787",
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
