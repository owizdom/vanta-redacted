"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

interface EventRow {
  readonly id: string;
  readonly type: string;
  readonly timestamp: number;
  readonly parent_ids: readonly string[];
  readonly body?: Record<string, unknown>;
}

const TYPE_FILTERS: ReadonlyArray<{ key: string; label: string; match: (t: string) => boolean }> = [
  { key: "all", label: "All", match: () => true },
  { key: "loop", label: "Loops", match: (t) => t.startsWith("loop.") },
  { key: "trace", label: "Traces", match: (t) => t === "reasoning.trace" },
  { key: "loan", label: "Loans", match: (t) => t.startsWith("loan.") },
  { key: "op", label: "Ops", match: (t) => t.startsWith("op.") },
  { key: "treasury", label: "Treasury", match: (t) => t.startsWith("treasury.") },
];

export default function EventsPage(): JSX.Element {
  const [events, setEvents] = useState<readonly EventRow[]>([]);
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState<EventRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pulling, setPulling] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function pull(): Promise<void> {
      setPulling(true);
      try {
        const r = await fetch("/api/runtime/events", { cache: "no-store" });
        if (!r.ok) {
          setError(`runtime → HTTP ${String(r.status)}`);
          return;
        }
        const j = (await r.json()) as { events?: EventRow[] };
        if (cancelled) return;
        setError(null);
        setEvents([...(j.events ?? [])].reverse());
      } catch (e) {
        setError(`runtime unreachable — ${e instanceof Error ? e.message : "network"}`);
      } finally {
        setPulling(false);
      }
    }
    void pull();
    const t = setInterval(() => void pull(), 3000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const filtered = useMemo(() => {
    const f = TYPE_FILTERS.find((x) => x.key === filter) ?? TYPE_FILTERS[0]!;
    return events.filter((e) => f.match(e.type));
  }, [events, filter]);

  return (
    <main className="min-h-screen bg-ink-950">
      <header className="border-b border-ink-800/60 bg-ink-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2 font-display text-lg font-semibold">
            <span className="inline-block h-2 w-2 animate-pulse-dot rounded-full bg-signal-green" />
            VANTA
          </Link>
          <div className="flex items-center gap-3">
            <span
              className={`flex items-center gap-2 rounded-full border px-3 py-1 text-xs uppercase tracking-[0.16em] ${
                error
                  ? "border-signal-red/40 bg-signal-red/10 text-signal-red"
                  : "border-signal-green/40 bg-signal-green/10 text-signal-green"
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${error ? "bg-signal-red" : "bg-signal-green"} ${pulling ? "animate-pulse-dot" : ""}`} />
              {error ? "runtime down" : "live"}
            </span>
            <Link href="/" className="text-sm text-chalk-200 hover:text-chalk-50">
              ← back
            </Link>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-6 py-10">
        <div className="flex items-end justify-between gap-6">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-chalk-400">
              signed event log
            </p>
            <h1 className="mt-3 font-display text-4xl font-semibold tracking-tight sm:text-5xl">
              {error ? "—" : events.length} events
            </h1>
            <p className="mt-2 max-w-xl text-chalk-200">
              Append-only, RFC 8785 canonical, Ed25519-signed in-enclave. Each
              non-genesis event parents to its causal predecessor; verifier
              walks the graph back to genesis.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {TYPE_FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                className={`rounded-full border px-3 py-1.5 text-xs uppercase tracking-[0.14em] transition ${
                  filter === f.key
                    ? "border-chalk-50 bg-chalk-50 text-ink-950"
                    : "border-ink-700 bg-ink-900/40 text-chalk-200 hover:border-ink-600"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {error ? (
          <div className="mt-12 rounded-xl border border-signal-red/30 bg-signal-red/5 p-8">
            <p className="font-mono text-sm text-signal-red">{error}</p>
            <p className="mt-3 text-sm text-chalk-200">
              start the local stack with{" "}
              <code className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-xs">
                pnpm dev
              </code>{" "}
              from the repo root, then refresh.
            </p>
          </div>
        ) : (
          <div className="mt-10 grid gap-px overflow-hidden rounded-xl border border-ink-700 bg-ink-700 lg:grid-cols-[2fr_3fr]">
            <ul className="max-h-[70vh] overflow-y-auto bg-ink-900">
              {filtered.length === 0 && (
                <li className="px-6 py-16 text-center text-sm text-chalk-400">
                  no events match this filter yet
                </li>
              )}
              {filtered.map((e) => (
                <li key={e.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(e)}
                    className={`block w-full border-b border-ink-700 px-5 py-4 text-left font-mono text-xs transition last:border-b-0 ${
                      selected?.id === e.id ? "bg-ink-800" : "hover:bg-ink-800/50"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className={typeColor(e.type)}>{e.type}</span>
                      <span className="text-chalk-400">
                        {new Date(e.timestamp * 1000).toLocaleTimeString()}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-chalk-400">{e.id}</p>
                  </button>
                </li>
              ))}
            </ul>
            <div className="bg-ink-900 p-6">
              {selected === null ? (
                <p className="font-mono text-xs uppercase tracking-[0.18em] text-chalk-400">
                  select an event ↵
                </p>
              ) : (
                <EventDetail e={selected} />
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

function EventDetail({ e }: { readonly e: EventRow }): JSX.Element {
  return (
    <div>
      <p className="font-mono text-xs uppercase tracking-[0.18em] text-signal-green">
        {e.type}
      </p>
      <p className="mt-2 break-all font-mono text-xs text-chalk-400">{e.id}</p>
      <dl className="mt-6 grid grid-cols-2 gap-3 text-sm">
        <Field k="timestamp" v={new Date(e.timestamp * 1000).toISOString()} />
        <Field k="parents" v={String(e.parent_ids.length)} />
      </dl>
      <p className="mt-6 font-mono text-xs uppercase tracking-[0.18em] text-chalk-400">
        body
      </p>
      <pre className="mt-3 max-h-[40vh] overflow-auto rounded border border-ink-700 bg-ink-950/60 p-4 font-mono text-xs leading-relaxed text-chalk-200">
        {JSON.stringify(e.body ?? {}, null, 2)}
      </pre>
    </div>
  );
}

function Field({ k, v }: { readonly k: string; readonly v: string }): JSX.Element {
  return (
    <div>
      <dt className="font-mono text-[10px] uppercase tracking-[0.18em] text-chalk-400">
        {k}
      </dt>
      <dd className="mt-1 font-mono text-xs text-chalk-200">{v}</dd>
    </div>
  );
}

function typeColor(t: string): string {
  if (t === "reasoning.trace") return "text-chalk-400";
  if (t.startsWith("loop.")) return "text-signal-green";
  if (t.startsWith("op.")) return "text-signal-amber";
  if (t.startsWith("loan.")) return "text-chalk-50";
  if (t.startsWith("treasury.")) return "text-signal-amber";
  return "text-chalk-200";
}
