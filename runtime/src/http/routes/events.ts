/**
 * `/api/events` — read-only event log surface.
 *
 *   GET /api/events            → list (newest-first, capped at `limit`)
 *   GET /api/events/:id        → single event by id
 *   GET /api/events/:id/parents → all (transitively reachable) parent ids
 *
 * The verifier CLI walks the chain via these endpoints; we keep the
 * shapes stable across releases.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { asSha256Hex } from "@vanta/tee";

const HEX64 = /^[0-9a-f]{64}$/;

export async function registerEventsRoutes(app: FastifyInstance): Promise<void> {
  // ----- SSE stream of newly-appended events -------------------------
  // Subscribers (the Paper plugin's animation pipeline, in-browser
  // dashboards, etc.) get one `data: <canonical-json>\n\n` chunk per
  // append. No backfill — clients walk /api/events for history.
  app.get("/api/events/stream", async (req, reply: FastifyReply) => {
    reply.raw.setHeader("content-type", "text/event-stream");
    reply.raw.setHeader("cache-control", "no-cache, no-transform");
    reply.raw.setHeader("connection", "keep-alive");
    reply.raw.setHeader("x-accel-buffering", "no");
    reply.raw.flushHeaders();
    reply.raw.write(": connected\n\n");

    const log = app.bootstrap.log;
    const unsub = log.onAppend((ev) => {
      try {
        reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
      } catch {
        /* socket closed; cleanup runs in 'close' below */
      }
    });

    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(": ping\n\n");
      } catch {
        /* fall through to close */
      }
    }, 20_000);

    req.raw.on("close", () => {
      clearInterval(heartbeat);
      unsub();
    });

    return reply;
  });

  app.get(
    "/api/events",
    {
      schema: {
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(500).default(100),
          type: z.string().min(1).max(64).optional(),
        }),
      },
    },
    async (req) => {
      const { limit, type } = req.query as { limit: number; type?: string };
      const out: unknown[] = [];
      for await (const ev of app.bootstrap.log.walkFromTip()) {
        if (type !== undefined && ev.type !== type) continue;
        out.push(ev);
        if (out.length >= limit) break;
      }
      return { count: out.length, events: out };
    },
  );

  app.get(
    "/api/events/:id",
    {
      schema: {
        params: z.object({
          id: z.string().regex(HEX64, "id must be 64-char lowercase hex"),
        }),
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const ev = app.bootstrap.log.getById(asSha256Hex(id));
      if (ev === undefined) {
        reply.status(404);
        return { error: "event_not_found", id };
      }
      return ev;
    },
  );

  // GET /api/events/:id/chain — walks parent_ids back to genesis and
  // returns the chain ordered tip→genesis. Powers the rail's "verify
  // chain ↗" CTA: visitors click any event and see the full lineage
  // back to the constitutional.genesis event with depth, types, and
  // signing key continuity. The single-click "this is the proof"
  // affordance the verify story has been missing.
  app.get(
    "/api/events/:id/chain",
    {
      schema: {
        params: z.object({
          id: z.string().regex(HEX64, "id must be 64-char lowercase hex"),
        }),
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const log = app.bootstrap.log;
      const start = log.getById(asSha256Hex(id));
      if (start === undefined) {
        reply.status(404);
        return { error: "event_not_found", id };
      }
      // BFS along parent_ids — events have at most a small number of
      // parents (genesis: 0; everything else: 1-2). Cap traversal at
      // 1000 nodes to defend against malformed loops; the real log
      // never approaches that bound.
      const seen = new Set<string>();
      const ordered: { id: string; type: string; timestamp: number; parent_ids: readonly string[]; lineage: string }[] = [];
      const queue: string[] = [start.id];
      let foundGenesis = false;
      while (queue.length > 0 && ordered.length < 1000) {
        const next = queue.shift();
        if (next === undefined || seen.has(next)) continue;
        seen.add(next);
        const ev = log.getById(asSha256Hex(next));
        if (ev === undefined) continue;
        ordered.push({
          id: ev.id,
          type: ev.type,
          timestamp: ev.timestamp,
          parent_ids: ev.parent_ids,
          lineage: ev.lineage,
        });
        if (ev.type === "constitutional.genesis") {
          foundGenesis = true;
          break;
        }
        for (const p of ev.parent_ids) {
          if (!seen.has(p)) queue.push(p);
        }
      }
      return {
        tip: start.id,
        depth: ordered.length,
        reaches_genesis: foundGenesis,
        chain: ordered,
      };
    },
  );
}
