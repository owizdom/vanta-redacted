/**
 * Append-only file-backed event log.
 *
 * Single-writer assumption: the runtime is the only process that mutates
 * `events.log` + `events.idx.json`. Concurrent readers are fine — we
 * write the line + fdatasync before updating the index file.
 *
 * Format:
 *   - `events.log` is a NDJSON file. Each line is one canonical event
 *     (already passed through `canonicalJsonBytes`). The newline is the
 *     record terminator; raw `\n` inside a line is impossible because
 *     JCS encodes them as `
`.
 *   - `events.idx.json` is a JSON map `{ eventId → { offset, length } }`
 *     so `getById` is O(1) without a full re-scan. The index is
 *     re-derivable from the log; it exists for read latency only.
 *
 * Concurrency: a single in-process serializer (chained promise) makes
 * `append` atomic from the runtime's perspective. The on-disk write is
 * `O_APPEND` so even an unexpected concurrent writer would not corrupt
 * line boundaries; only the in-process index would drift, which a
 * subsequent `replay` would heal.
 */

import {
  closeSync,
  createReadStream,
  existsSync,
  fdatasyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync as nodeReadSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import { canonicalJsonBytes, type Sha256Hex, type VantaEvent } from "@vanta/events";

interface IndexEntry {
  readonly offset: number;
  readonly length: number;
}

interface FileIndex {
  readonly entries: Record<string, IndexEntry>;
}

type AppendListener = (event: VantaEvent) => void;

export class FileEventLog {
  private readonly dir: string;
  private readonly logPath: string;
  private readonly idxPath: string;
  private index: Map<Sha256Hex, IndexEntry>;
  private writeChain: Promise<void>;
  private size: number;
  private appendListeners: Set<AppendListener> = new Set();

  public constructor(dir: string) {
    this.dir = resolve(dir);
    this.logPath = resolve(this.dir, "events.log");
    this.idxPath = resolve(this.dir, "events.idx.json");
    this.index = new Map();
    this.writeChain = Promise.resolve();
    this.size = 0;

    mkdirSync(this.dir, { recursive: true });
    this.bootstrap();
  }

  /**
   * Subscribe to append events for live SSE / animation pipelines.
   * The callback is invoked synchronously after the disk write
   * completes; throwing in a listener does NOT roll back the append
   * (the log is the system of record).
   */
  public onAppend(listener: AppendListener): () => void {
    this.appendListeners.add(listener);
    return () => this.appendListeners.delete(listener);
  }

  /**
   * Boot from disk. If the log exists but the index is missing or
   * stale, rebuild the index by streaming the log. Cheap (O(N events)
   * once at boot).
   */
  private bootstrap(): void {
    if (existsSync(this.logPath)) {
      this.size = statSync(this.logPath).size;
    } else {
      writeFileSync(this.logPath, "");
      this.size = 0;
    }

    if (existsSync(this.idxPath)) {
      try {
        const raw = readFileSync(this.idxPath, "utf8");
        const parsed = JSON.parse(raw) as FileIndex;
        for (const [k, v] of Object.entries(parsed.entries)) {
          this.index.set(k as Sha256Hex, v);
        }
        return;
      } catch {
        // Fallthrough: rebuild from the log.
      }
    }

    this.rebuildIndex();
  }

  private rebuildIndex(): void {
    const buf = readFileSync(this.logPath);
    let offset = 0;
    let lineStart = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a) {
        const length = i - lineStart;
        if (length > 0) {
          const line = buf.slice(lineStart, i).toString("utf8");
          try {
            const parsed = JSON.parse(line) as { id?: string };
            if (typeof parsed.id === "string" && parsed.id.length > 0) {
              this.index.set(parsed.id as Sha256Hex, { offset: lineStart, length });
            }
          } catch {
            // Skip malformed line; rebuild keeps going.
          }
        }
        lineStart = i + 1;
      }
      offset = i;
    }
    void offset; // suppress unused
    this.persistIndex();
  }

  private persistIndex(): void {
    const out: FileIndex = {
      entries: Object.fromEntries(this.index.entries()),
    };
    writeFileSync(this.idxPath, JSON.stringify(out));
  }

  /**
   * Append a fully-signed event. Idempotent on `event.id` — a second
   * append of the same id is a no-op (the original record wins).
   */
  public async append(event: VantaEvent): Promise<void> {
    const op = async (): Promise<void> => {
      if (this.index.has(event.id)) return;

      const bytes = canonicalJsonBytes(event);
      const line = Buffer.concat([Buffer.from(bytes), Buffer.from("\n", "utf8")]);

      const fd = openSync(this.logPath, "a");
      try {
        const written = writeSync(fd, line, 0, line.length);
        if (written !== line.length) {
          throw new Error(`short write: ${String(written)}/${String(line.length)}`);
        }
        fdatasyncSync(fd);
      } finally {
        closeSync(fd);
      }

      const entry: IndexEntry = { offset: this.size, length: bytes.byteLength };
      this.index.set(event.id, entry);
      this.size += line.length;
      this.persistIndex();

      for (const cb of this.appendListeners) {
        try {
          cb(event);
        } catch {
          // Append-listener failures must NEVER block ingestion
          // (paper invariant I5 — fire-and-forget).
        }
      }
    };

    this.writeChain = this.writeChain.then(op, op);
    return this.writeChain;
  }

  /** Synchronous lookup. Returns `undefined` if the id is unknown. */
  public getById(id: Sha256Hex): VantaEvent | undefined {
    const entry = this.index.get(id);
    if (entry === undefined) return undefined;

    const fd = openSync(this.logPath, "r");
    try {
      const buf = Buffer.alloc(entry.length);
      const { bytesRead } = readSync(fd, buf, 0, entry.length, entry.offset);
      if (bytesRead !== entry.length) return undefined;
      const parsed = JSON.parse(buf.toString("utf8")) as VantaEvent;
      return parsed;
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Walk the log from the tail backwards. Useful for the verifier
   * walker and for `loadEvent` lookups where the most recent events
   * are most likely. Lazy: yields parsed events one at a time.
   */
  public async *walkFromTip(): AsyncIterable<VantaEvent> {
    const lines: VantaEvent[] = [];
    if (!existsSync(this.logPath)) return;

    const stream = createReadStream(this.logPath, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
    for await (const line of rl) {
      if (line.trim().length === 0) continue;
      try {
        lines.push(JSON.parse(line) as VantaEvent);
      } catch {
        // skip malformed
      }
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      const ev = lines[i];
      if (ev !== undefined) yield ev;
    }
  }

  /** Walk forward. */
  public async *walkFromHead(): AsyncIterable<VantaEvent> {
    if (!existsSync(this.logPath)) return;
    const stream = createReadStream(this.logPath, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
    for await (const line of rl) {
      if (line.trim().length === 0) continue;
      try {
        yield JSON.parse(line) as VantaEvent;
      } catch {
        // skip malformed
      }
    }
  }

  /** Cheap. Returns the in-memory index size. */
  public count(): number {
    return this.index.size;
  }

  /** Path to the underlying log file. */
  public path(): string {
    return this.logPath;
  }
}

function readSync(
  fd: number,
  buf: Buffer,
  offset: number,
  length: number,
  position: number,
): { bytesRead: number } {
  const bytesRead = nodeReadSync(fd, buf, offset, length, position);
  return { bytesRead };
}
