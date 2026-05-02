"use client";

import { useEffect, useRef, useState } from "react";

const SECTIONS: ReadonlyArray<readonly [string, string, number]> = [
  ["§1", "What VANTA is, and what it isn't", 1],
  ["§2", "The mid-tier borrower", 2],
  ["§3", "Six invariants", 3],
  ["§4", "Resolution-aware haircut", 5],
  ["§5", "Origination: two signatures, post-image", 7],
  ["§6", "Onboarding: gates as floor, reasoning above", 9],
  ["§7", "Continuous reasoning loops", 11],
  ["§8", "Comparative landscape", 13],
  ["§9", "Threat model", 14],
  ["§10", "What we don't claim", 15],
  ["§11", "Risks and mitigations", 16],
  ["§12", "What's shipped", 17],
  ["§13", "Roadmap", 18],
];

const PARAMS = "view=FitH&toolbar=1&navpanes=0";

export function PaperViewer(): JSX.Element {
  const [page, setPage] = useState<number>(1);
  const [tick, setTick] = useState<number>(0); // forces iframe remount on click
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Re-anchor by mutating contentWindow.location.hash when possible
  // (no reload), and falling back to a remount otherwise.
  useEffect(() => {
    const f = iframeRef.current;
    if (f === null) return;
    try {
      const win = f.contentWindow;
      if (win !== null) {
        // First, try fragment update (instant, no reload).
        const target = `#page=${String(page)}&${PARAMS}`;
        if (win.location.hash !== target) {
          win.location.hash = target;
        }
      }
    } catch {
      // Cross-origin or content not yet loaded — fall back to remount.
    }
  }, [page, tick]);

  function go(p: number): void {
    setPage(p);
    // Bump tick so the iframe key changes — this forces a remount, which
    // is the only thing some Chrome builds reliably honor for #page=N.
    setTick((t) => t + 1);
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 gap-4 overflow-hidden px-6 py-4">
      <aside className="hidden w-64 shrink-0 overflow-y-auto rounded-2xl border border-ink-800 bg-ink-900/40 px-4 py-4 lg:block">
        <p className="px-2 font-mono text-[10px] uppercase tracking-[0.18em] text-chalk-500">
          Contents
        </p>
        <ul className="mt-2 space-y-0.5">
          {SECTIONS.map(([k, title, p]) => {
            const active = page === p;
            return (
              <li key={k}>
                <button
                  type="button"
                  onClick={() => go(p)}
                  className={`group flex w-full items-baseline gap-3 rounded-md px-2 py-1.5 text-left text-sm transition ${
                    active
                      ? "bg-violet-500/10 text-chalk-50 ring-1 ring-inset ring-violet-500/40"
                      : "text-chalk-300 hover:bg-ink-800/60 hover:text-chalk-50"
                  }`}
                >
                  <span
                    className={`w-8 shrink-0 font-mono text-[11px] ${
                      active ? "text-violet-300" : "text-chalk-500 group-hover:text-chalk-400"
                    }`}
                  >
                    {k}
                  </span>
                  <span className="leading-snug">{title}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="mt-6 border-t border-ink-800 pt-4">
          <p className="px-2 text-[11px] leading-relaxed text-chalk-400">
            The PDF renders here via the browser's native viewer. If a section
            doesn't jump cleanly, Chrome's viewer is being sticky — click the
            section once more or use{" "}
            <a
              href="/vanta.pdf"
              target="_blank"
              rel="noopener"
              className="text-chalk-200 underline-offset-2 hover:underline"
            >
              Download
            </a>
            .
          </p>
        </div>
      </aside>

      <div className="relative min-w-0 flex-1 overflow-hidden rounded-2xl border border-ink-800 bg-[#1f1f1f]">
        <iframe
          key={tick}
          ref={iframeRef}
          src={`/vanta.pdf#page=${String(page)}&${PARAMS}`}
          title="VANTA paper"
          className="h-full w-full"
        />
      </div>
    </div>
  );
}
