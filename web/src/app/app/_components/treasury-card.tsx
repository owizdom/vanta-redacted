"use client";

export function TreasuryCard(): JSX.Element {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-ink-800 bg-ink-950 p-5">
      <PixelHistogram />
      <div className="relative">
        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-chalk-400">
          Genesis lender pool
        </p>
        <h3 className="mt-2 font-display text-3xl font-semibold leading-tight">
          $1.24M
        </h3>
        <p className="mt-1 text-sm text-chalk-400">
          Earn yield by lending USDC against pledged Polymarket positions.
        </p>

        <dl className="mt-5 grid grid-cols-2 gap-3 text-left">
          <Stat k="7-day APR" v="12.4%" />
          <Stat k="Utilization" v="68%" />
        </dl>

        <button
          type="button"
          className="mt-5 w-full rounded-md bg-violet-500 px-4 py-2 text-sm font-medium hover:bg-violet"
        >
          Become a lender
        </button>
      </div>
    </div>
  );
}

function Stat({ k, v }: { readonly k: string; readonly v: string }): JSX.Element {
  return (
    <div className="rounded-md border border-ink-800 bg-ink-900/60 px-3 py-2">
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-chalk-400">
        {k}
      </p>
      <p className="mt-1 font-display text-base font-semibold text-chalk-50">{v}</p>
    </div>
  );
}

function PixelHistogram(): JSX.Element {
  const heights = [
    1, 2, 1, 3, 4, 2, 5, 6, 4, 7, 8, 6, 9, 7, 10,
    9, 7, 6, 4, 5, 3, 2,
  ];
  return (
    <div
      aria-hidden
      className="absolute inset-0 flex items-end justify-end overflow-hidden opacity-80"
    >
      <div className="flex h-full w-2/3 items-end gap-[3px] pr-3 pb-3">
        {heights.map((h, i) => {
          const tone = i < 15 ? "bg-violet-500" : "bg-accent-orange";
          return (
            <span
              key={i}
              className={`block w-1.5 rounded-sm ${tone}`}
              style={{ height: `${h * 8}px`, opacity: 0.45 + (h / 12) * 0.4 }}
            />
          );
        })}
      </div>
    </div>
  );
}
