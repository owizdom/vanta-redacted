import Link from "next/link";

export default function Home(): JSX.Element {
  return (
    <main className="relative min-h-screen overflow-hidden bg-ink-950">
      <div className="grid-bg absolute inset-0" aria-hidden />
      <AccentTiles />

      <div className="relative z-10 flex min-h-screen flex-col">
        <Wordmark />

        <section className="flex flex-1 items-center justify-center px-6 py-16 sm:py-24">
          <div className="w-full max-w-4xl text-center">
            <h1 className="font-display text-[44px] font-semibold leading-[1.05] tracking-tight text-chalk-50 sm:text-[92px] sm:leading-[1.02]">
              Don't sell your bet.
              <br />
              Borrow against it.
            </h1>

            <p className="mx-auto mt-10 max-w-2xl text-lg text-chalk-200 sm:text-2xl sm:leading-snug">
              Pledge $1,000 of Polymarket shares. Get $500 USDC instantly.
              Keep up to $5,000+ in payout if your bet hits.
            </p>

            <div className="mt-14 flex justify-center">
              <Link
                href="/app"
                className="group inline-flex items-center justify-center gap-2 rounded-2xl bg-violet-500 px-12 py-4 text-lg font-medium text-chalk-50 shadow-[0_20px_60px_-15px_rgba(108,84,255,0.7)] transition hover:bg-violet active:translate-y-px"
              >
                Open the app
              </Link>
            </div>

            <div className="mt-10 flex justify-center">
              <span className="inline-flex items-center gap-2 rounded-full border border-ink-800 bg-ink-900/60 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.22em] text-chalk-400">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-violet-500" />
                Built on EigenCloud
              </span>
            </div>
          </div>
        </section>

        <Footer />
      </div>
    </main>
  );
}

function Wordmark(): JSX.Element {
  return (
    <div className="relative z-10 flex justify-center pt-12 sm:pt-16">
      <Link href="/" className="flex items-center gap-2.5">
        <span aria-hidden className="font-display text-2xl font-semibold tracking-tight text-chalk-50">
          <span className="inline-block rounded-md bg-violet-500 px-2 py-0.5 leading-none text-chalk-50">V</span>
        </span>
        <span className="font-display text-2xl font-semibold tracking-tight text-chalk-50">
          VANTA
        </span>
      </Link>
    </div>
  );
}

function Footer(): JSX.Element {
  return (
    <footer className="relative z-10 pb-10">
      <nav className="flex justify-center gap-3 text-base text-chalk-400">
        <Link href="/paper" className="px-3 hover:text-chalk-50">
          Paper
        </Link>
        <span aria-hidden className="text-ink-600">·</span>
        <Link href="https://github.com/owizdom/vanta-redacted" className="px-3 hover:text-chalk-50">
          GitHub
        </Link>
        <span aria-hidden className="text-ink-600">·</span>
        <Link href="https://x.com/owizdom" className="px-3 hover:text-chalk-50">
          X
        </Link>
      </nav>
    </footer>
  );
}

/**
 * Solid-color accent squares in the four corners. Replaces the
 * celebrity-photo collage in the reference with VANTA-appropriate
 * silent color blocks pinned to the grid cells.
 */
function AccentTiles(): JSX.Element {
  return (
    <>
      <div
        aria-hidden
        className="absolute left-0 top-[18%] h-24 w-2 bg-accent-orange sm:h-[8rem] sm:w-3"
      />
      <div
        aria-hidden
        className="absolute right-[12%] top-[42%] h-24 w-24 bg-violet sm:h-[7rem] sm:w-[7rem]"
      />
      <div
        aria-hidden
        className="absolute left-[8%] top-[68%] hidden h-24 w-24 bg-accent-lavender sm:block sm:h-[6rem] sm:w-[6rem]"
      />
      <div
        aria-hidden
        className="absolute right-0 bottom-[10%] h-32 w-2 bg-accent-orange sm:h-[10rem] sm:w-3"
      />
    </>
  );
}
