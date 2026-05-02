"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

export function AppFooter(): JSX.Element {
  const [online, setOnline] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function pull(): Promise<void> {
      try {
        const r = await fetch("/.well-known/attestation", { cache: "no-store" });
        if (!cancelled) setOnline(r.ok);
      } catch {
        if (!cancelled) setOnline(false);
      }
    }
    void pull();
    const t = setInterval(() => void pull(), 8000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  return (
    <footer className="mt-16 border-t border-ink-800 bg-ink-950">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-3 text-xs text-chalk-400">
        <div className="flex items-center gap-2">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              online ? "animate-pulse-dot bg-signal-green" : "bg-signal-red"
            }`}
          />
          <span className="font-mono uppercase tracking-[0.16em]">
            {online ? "online" : "runtime offline"}
          </span>
        </div>
        <div className="flex items-center gap-5">
          <Link
            href="https://github.com/owizdom/vanta-redacted/issues"
            className="hover:text-chalk-200"
          >
            Report a bug
          </Link>
          <Link href="/paper" className="hover:text-chalk-200">
            Terms
          </Link>
          <Link href="/paper" className="hover:text-chalk-200">
            Privacy
          </Link>
          <Link
            href="https://x.com/owizdom"
            aria-label="X"
            className="hover:text-chalk-200"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor">
              <path d="M18.244 2H21l-6.523 7.46L22 22h-6.828l-4.77-6.236L4.8 22H2.04l6.99-7.987L2 2h6.999l4.317 5.701L18.244 2Zm-1.196 18.077h1.508L7.05 3.835H5.43l11.618 16.242Z" />
            </svg>
          </Link>
          <Link
            href="https://github.com/owizdom/vanta-redacted"
            aria-label="GitHub"
            className="hover:text-chalk-200"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.5 2.87 8.32 6.84 9.66.5.1.68-.22.68-.49 0-.24-.01-.88-.01-1.74-2.78.62-3.37-1.36-3.37-1.36-.46-1.18-1.11-1.49-1.11-1.49-.91-.63.07-.62.07-.62 1 .07 1.53 1.05 1.53 1.05.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.36-2.22-.26-4.55-1.14-4.55-5.05 0-1.12.39-2.03 1.03-2.74-.1-.26-.45-1.3.1-2.7 0 0 .84-.27 2.75 1.05.8-.23 1.65-.34 2.5-.34.85 0 1.7.11 2.5.34 1.91-1.32 2.75-1.05 2.75-1.05.55 1.4.2 2.44.1 2.7.64.71 1.03 1.62 1.03 2.74 0 3.92-2.34 4.78-4.57 5.04.36.31.68.93.68 1.88 0 1.36-.01 2.45-.01 2.79 0 .27.18.59.69.49 3.97-1.34 6.83-5.16 6.83-9.66C22 6.58 17.52 2 12 2Z" />
            </svg>
          </Link>
        </div>
      </div>
    </footer>
  );
}
