import Link from "next/link";

import { PaperViewer } from "./_components/paper-viewer";

export default function PaperPage(): JSX.Element {
  return (
    <main className="flex h-screen flex-col bg-ink-950 text-chalk-50">
      <header className="shrink-0 border-b border-ink-800 bg-ink-950">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4 px-6 py-3">
          <Link href="/" className="flex items-center gap-2">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-violet-500 font-display text-base font-semibold leading-none text-chalk-50">
              V
            </span>
            <span className="font-display text-base font-semibold tracking-tight">
              VANTA
            </span>
            <span className="ml-2 hidden font-mono text-[10px] uppercase tracking-[0.18em] text-chalk-400 sm:inline">
              paper · 18 pages
            </span>
          </Link>
          <div className="flex items-center gap-2">
            <Link
              href="/vanta.pdf"
              target="_blank"
              rel="noopener"
              className="inline-flex items-center gap-1.5 rounded-md border border-ink-800 bg-ink-900 px-3 py-1.5 text-sm text-chalk-200 transition hover:border-ink-700 hover:text-chalk-50"
            >
              <DownloadIcon /> Download
            </Link>
            <Link
              href="https://github.com/owizdom/vanta-redacted"
              target="_blank"
              rel="noopener"
              className="inline-flex items-center gap-1.5 rounded-md border border-ink-800 bg-ink-900 px-3 py-1.5 text-sm text-chalk-200 transition hover:border-ink-700 hover:text-chalk-50"
            >
              <GhIcon /> GitHub
            </Link>
            <Link
              href="/app"
              className="inline-flex items-center rounded-md bg-violet-500 px-3 py-1.5 text-sm font-medium text-chalk-50 transition hover:bg-violet"
            >
              Open the app →
            </Link>
          </div>
        </div>
      </header>

      <PaperViewer />
    </main>
  );
}

function DownloadIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 14 14" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M7 1v8m0 0L4 6m3 3 3-3M2 12h10" strokeLinecap="round" />
    </svg>
  );
}

function GhIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor">
      <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.5 2.87 8.32 6.84 9.66.5.1.68-.22.68-.49 0-.24-.01-.88-.01-1.74-2.78.62-3.37-1.36-3.37-1.36-.46-1.18-1.11-1.49-1.11-1.49-.91-.63.07-.62.07-.62 1 .07 1.53 1.05 1.53 1.05.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.36-2.22-.26-4.55-1.14-4.55-5.05 0-1.12.39-2.03 1.03-2.74-.1-.26-.45-1.3.1-2.7 0 0 .84-.27 2.75 1.05.8-.23 1.65-.34 2.5-.34.85 0 1.7.11 2.5.34 1.91-1.32 2.75-1.05 2.75-1.05.55 1.4.2 2.44.1 2.7.64.71 1.03 1.62 1.03 2.74 0 3.92-2.34 4.78-4.57 5.04.36.31.68.93.68 1.88 0 1.36-.01 2.45-.01 2.79 0 .27.18.59.69.49 3.97-1.34 6.83-5.16 6.83-9.66C22 6.58 17.52 2 12 2Z" />
    </svg>
  );
}
