/**
 * Per-VANTA detail page.
 *
 * /agent/[agentId] — full record + pool state + (placeholder for)
 * trade tape. The trade tape will SSE-subscribe to the runtime's
 * /api/events/stream?agentId=N filter once the SSE filter lands;
 * for now it shows the most recent trade.* / belief.* events from
 * the regular /api/events feed if available.
 */

import Link from "next/link";
import { notFound } from "next/navigation";

import {
  fetchAgent,
  fetchPoolState,
  formatSignedUsdc6,
  formatUsdc6,
} from "@/lib/runtime";

export const dynamic = "force-dynamic";

interface PageProps {
  readonly params: { readonly agentId: string };
}

export default async function AgentPage({ params }: PageProps): Promise<JSX.Element> {
  const agentId = parseAgentId(params.agentId);
  if (agentId === null) notFound();

  const [agent, pool] = await Promise.all([
    fetchAgent(agentId),
    fetchPoolState(agentId),
  ]);
  if (agent === null) notFound();

  return (
    <main className="relative min-h-screen bg-ink-950">
      <div className="grid-bg absolute inset-0" aria-hidden />

      <div className="relative z-10 mx-auto flex max-w-5xl flex-col gap-10 px-6 py-12">
        <Link href="/marketplace" className="self-start font-mono text-xs uppercase tracking-[0.22em] text-chalk-400 hover:text-chalk-200">
          ← marketplace
        </Link>

        <header className="flex flex-col gap-6 border-b border-ink-800 pb-8 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-5">
            <div
              className="h-16 w-16 shrink-0 rounded-2xl ring-1 ring-inset ring-ink-700"
              style={{ backgroundColor: agent.color_hex }}
              aria-hidden
            />
            <div>
              <div className="flex items-center gap-3">
                <h1 className="font-display text-3xl font-semibold text-chalk-50">
                  {agent.name}
                </h1>
                <span className="font-mono text-xs text-chalk-500">
                  id #{String(agent.agent_id)}
                </span>
                {agent.paused ? (
                  <span className="rounded-full bg-amber-900/60 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.22em] text-amber-200">
                    paused
                  </span>
                ) : null}
              </div>
              <p className="mt-2 max-w-xl text-base text-chalk-200">{agent.thesis}</p>
              <p className="mt-2 font-mono text-[10px] text-chalk-500">
                operator {agent.operator}
              </p>
            </div>
          </div>
          <div className="rounded-2xl border border-ink-800 bg-ink-900/60 p-4 text-right">
            <div className="font-mono text-[9px] uppercase tracking-[0.22em] text-chalk-500">
              island offset
            </div>
            <div className="mt-1 font-mono text-sm text-chalk-200">
              ({String(agent.island_offset.x)}, {String(agent.island_offset.z)})
            </div>
          </div>
        </header>

        <section className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat
            label="AUM"
            value={pool ? formatUsdc6(pool.nav_usdc6) : "—"}
          />
          <Stat
            label="AUM cap"
            value={pool ? formatUsdc6(pool.max_aum_usdc6) : "—"}
          />
          <Stat
            label="Open notional"
            value={pool ? formatUsdc6(pool.open_notional_usdc6) : "—"}
          />
          <Stat
            label="Realised PnL"
            value={pool ? formatSignedUsdc6(pool.realised_pnl_usdc6) : "—"}
            tone={
              pool && pool.realised_pnl_usdc6.startsWith("-")
                ? "neg"
                : pool && pool.realised_pnl_usdc6 !== "0"
                  ? "pos"
                  : "neutral"
            }
          />
        </section>

        <section className="grid gap-6 lg:grid-cols-2">
          <Panel title="Pool state">
            {pool === null ? (
              <p className="font-mono text-sm text-chalk-500">no pool reader wired</p>
            ) : (
              <dl className="grid grid-cols-2 gap-y-3 font-mono text-xs">
                <Row k="pool" v={pool.pool} />
                <Row k="position book" v={pool.position_book} />
                <Row k="total supply" v={pool.total_supply} />
                <Row
                  k="share price"
                  v={`${sharePriceDecimal(pool.share_price_e18)} USDC/share`}
                />
                <Row k="free USDC" v={formatUsdc6(pool.free_usdc6)} />
                <Row k="lifetime cost basis" v={formatUsdc6(pool.lifetime_cost_basis_usdc6)} />
                <Row k="lifetime proceeds" v={formatUsdc6(pool.lifetime_proceeds_usdc6)} />
              </dl>
            )}
          </Panel>

          <Panel title="Trade tape · placeholder">
            <p className="text-sm text-chalk-300">
              The live trade tape (SSE-subscribed, agent-filtered) ships
              with the SSE filter route. For now: every <code className="font-mono text-chalk-100">trade.executed</code>{" "}
              and <code className="font-mono text-chalk-100">trade.closed</code> event from this VANTA gets
              signed by its TEE EOA, written to the append-only event
              log, and is queryable via{" "}
              <code className="font-mono text-chalk-100">/api/events/:eventId</code>.
            </p>
            <p className="mt-3 text-sm text-chalk-300">
              Click any trade-tape line to expand the paired{" "}
              <code className="font-mono text-chalk-100">reasoning.trace</code> + the{" "}
              <code className="font-mono text-chalk-100">op.inference</code> the agent based the decision on.
            </p>
          </Panel>
        </section>
      </div>
    </main>
  );
}

function parseAgentId(s: string): number | null {
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

interface StatProps {
  readonly label: string;
  readonly value: string;
  readonly tone?: "pos" | "neg" | "neutral";
}

function Stat({ label, value, tone }: StatProps): JSX.Element {
  const cls =
    tone === "pos"
      ? "text-emerald-300"
      : tone === "neg"
        ? "text-rose-300"
        : "text-chalk-100";
  return (
    <div className="rounded-2xl border border-ink-800 bg-ink-900/60 p-4">
      <div className="font-mono text-[9px] uppercase tracking-[0.22em] text-chalk-500">
        {label}
      </div>
      <div className={`mt-2 font-display text-lg ${cls}`}>{value}</div>
    </div>
  );
}

interface PanelProps {
  readonly title: string;
  readonly children: React.ReactNode;
}

function Panel({ title, children }: PanelProps): JSX.Element {
  return (
    <div className="rounded-2xl border border-ink-800 bg-ink-900/60 p-6">
      <h3 className="font-display text-lg font-semibold text-chalk-100">{title}</h3>
      <div className="mt-4">{children}</div>
    </div>
  );
}

interface RowProps {
  readonly k: string;
  readonly v: string;
}

function Row({ k, v }: RowProps): JSX.Element {
  return (
    <>
      <dt className="text-chalk-500">{k}</dt>
      <dd className="break-all text-chalk-200">{v}</dd>
    </>
  );
}

function sharePriceDecimal(e18Str: string): string {
  const e18 = BigInt(e18Str);
  const whole = e18 / 1_000_000_000_000_000_000n;
  const frac = e18 % 1_000_000_000_000_000_000n;
  const fracStr = frac.toString().padStart(18, "0").slice(0, 6);
  return `${whole.toString()}.${fracStr}`;
}
