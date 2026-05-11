import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Dev-only middleware: POST /api/voice → ElevenLabs TTS.
// The key is loaded from .env.local (gitignored) at vite startup
// and lives ONLY in the Node process — never reaches the client
// bundle. The browser sees only this proxy endpoint.
function voiceProxyPlugin(): Plugin {
  return {
    name: "vanta-voice-proxy",
    configureServer(server) {
      // .env.local is loaded by vite for client-side import.meta.env.VITE_*
      // but we want the raw key (no VITE_ prefix) only in Node. Read it
      // again here without the prefix filter.
      const env = loadEnv("development", process.cwd(), "");
      const apiKey = env["ELEVENLABS_API_KEY"] ?? "";

      server.middlewares.use("/api/voice", async (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end("method not allowed");
          return;
        }
        if (apiKey.length === 0) {
          res.statusCode = 503;
          res.end("ELEVENLABS_API_KEY not set in .env.local");
          return;
        }
        // Read JSON body manually (no body parser bound).
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        let body: { voiceId?: string; text?: string };
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          res.statusCode = 400;
          res.end("invalid json");
          return;
        }
        const { voiceId, text } = body;
        if (typeof voiceId !== "string" || typeof text !== "string") {
          res.statusCode = 400;
          res.end("voiceId + text required");
          return;
        }
        const upstream = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
          {
            method: "POST",
            headers: {
              "xi-api-key": apiKey,
              "content-type": "application/json",
              accept: "audio/mpeg",
            },
            body: JSON.stringify({
              text,
              model_id: "eleven_turbo_v2_5",
              voice_settings: { stability: 0.45, similarity_boost: 0.7 },
            }),
          },
        );
        if (!upstream.ok) {
          res.statusCode = upstream.status;
          res.end(await upstream.text());
          return;
        }
        const buf = Buffer.from(await upstream.arrayBuffer());
        res.setHeader("content-type", "audio/mpeg");
        res.setHeader("content-length", String(buf.length));
        res.end(buf);
      });
    },
  };
}

// Game frontend dev server. Mirrors /web's next.config.mjs proxy:
// - /api/runtime/*  →  http://127.0.0.1:8787/api/*
// - /healthz, /.well-known/*  →  the runtime root
// - /api/voice      →  in-process middleware (ElevenLabs TTS proxy)
//
// Keeps the API client (lib/runtime.ts) framework-agnostic — the
// only thing that changes between /web and /game is the proxy
// machinery, not the call sites.
export default defineConfig({
  plugins: [react(), voiceProxyPlugin()],
  server: {
    port: 3031,
    strictPort: true,
    proxy: {
      "/api/runtime": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/runtime/, "/api"),
      },
      // Demo-only admin surface — the borrower flow POSTs to
      // /admin/demo/borrow on the runtime when the user submits.
      "/admin": "http://127.0.0.1:8787",
      "/healthz": "http://127.0.0.1:8787",
      "/.well-known": "http://127.0.0.1:8787",
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
