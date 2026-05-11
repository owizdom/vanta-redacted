/**
 * HowItWorksModal — 5-panel walkthrough of the borrower flow. Lives
 * behind the "?" button in /world's top-right chrome.
 *
 * The thesis the modal speaks to is the README's: VANTA is a fleet of
 * verifiable AI lenders for prediction-market positions. The five
 * panels narrate the user-facing flow end-to-end — pledge → council →
 * USDC out → audit. No multi-agent trading framing here; the agents
 * are underwriters, not autonomous traders.
 *
 * Esc closes; ← / → step.
 */

import { useEffect, useState } from "react";

import { PixelButton } from "./PixelButton";

interface Props {
  readonly open: boolean;
  readonly onClose: () => void;
}

interface Panel {
  readonly title: string;
  readonly body: JSX.Element;
}

const PANELS: readonly Panel[] = [
  {
    title: "you hold a polymarket bet",
    body: (
      <div className="space-y-3 text-sm leading-relaxed text-chalk-200">
        <p>
          You bought into a Polymarket position you still believe in.
          The market hasn't resolved yet — selling now means giving up
          conviction at the wrong price. But you'd like the cash.
        </p>
        <p className="font-mono text-xs text-chalk-400">
          Examples: a YES on a long-dated political market, a NO on a
          sports event months away, a CTF position you still think
          mispriced.
        </p>
      </div>
    ),
  },
  {
    title: "pledge it to a kingdom",
    body: (
      <div className="space-y-3 text-sm leading-relaxed text-chalk-200">
        <p>
          Pick a kingdom on the map and click its glowing ring.
          Connect a wallet, transfer your CTF position to{" "}
          <span className="font-mono text-chalk-50">VantaVault</span>{" "}
          on Polygon — the on-chain escrow that holds the collateral
          while your loan is live.
        </p>
        <p>
          Three lenders launch:{" "}
          <span className="text-opus">vanta-opus</span> (macro),{" "}
          <span className="text-gpt">vanta-gpt</span> (sports), and{" "}
          <span className="text-gemini">vanta-gemini</span> (politics).
          Pick whichever fits your bet's thesis.
        </p>
      </div>
    ),
  },
  {
    title: "the council deliberates",
    body: (
      <div className="space-y-3 text-sm leading-relaxed text-chalk-200">
        <p>
          The agent runs a council pass: two NPCs sample the market,
          form independent beliefs, and argue out loud. The agent
          synthesises their thoughts into a final haircut against the
          current mid.
        </p>
        <p className="font-mono text-xs text-chalk-400">
          Every prompt and response in the council is recorded as a
          signed event in the audit chain. You see the reasoning
          stream live in the right-hand panel.
        </p>
      </div>
    ),
  },
  {
    title: "usdc out, immediately",
    body: (
      <div className="space-y-3 text-sm leading-relaxed text-chalk-200">
        <p>
          When the council approves, the agent calls{" "}
          <span className="font-mono text-chalk-50">LoanBook.originate</span>{" "}
          on Base. USDC flows from the shared LpVault to your wallet
          — no committee, no human approver, no settlement delay.
        </p>
        <p className="font-mono text-xs text-chalk-400">
          At maturity (or earlier, if you want), repay the principal +
          interest. VantaVault releases your CTF position back. If you
          don't repay, the position settles at resolution and the
          vault keeps the proceeds.
        </p>
      </div>
    ),
  },
  {
    title: "every signature is verifiable",
    body: (
      <div className="space-y-3 text-sm leading-relaxed text-chalk-200">
        <p>
          The agent runs inside an EigenCompute TEE. Its signing key,
          every inference call, every council vote, every loan
          origination is attested to a KMS-anchored quote published
          on Ethereum (App ID{" "}
          <span className="font-mono text-chalk-50">0x95F2AB29…</span>).
        </p>
        <p>
          Click any{" "}
          <span className="font-mono text-signal-green">tee-attested</span>{" "}
          badge in the chat to inspect the signed envelope. The agent
          can't lie about why it lent — the reasoning is
          cryptographically bound to the loan.
        </p>
      </div>
    ),
  },
];

export function HowItWorksModal({ open, onClose }: Props): JSX.Element | null {
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (!open) {
      setStep(0);
      return;
    }
    const handle = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight")
        setStep((s) => Math.min(PANELS.length - 1, s + 1));
      else if (e.key === "ArrowLeft") setStep((s) => Math.max(0, s - 1));
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [open, onClose]);

  if (!open) return null;

  const panel = PANELS[step]!;
  const isFirst = step === 0;
  const isLast = step === PANELS.length - 1;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/80 backdrop-blur-sm animate-fadeIn"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-xl rounded-[2px] border border-ink-700 bg-ink-900 p-7 shadow-[0_24px_48px_-12px_rgba(0,0,0,0.8)]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-4 flex items-baseline justify-between border-b border-ink-700 pb-3">
          <div className="flex items-baseline gap-3">
            <h2 className="font-display text-xl font-semibold text-chalk-50">
              how vanta works
            </h2>
            <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-chalk-500">
              step {step + 1} of {PANELS.length}
            </span>
          </div>
          <button
            onClick={onClose}
            className="font-mono text-[10px] uppercase tracking-[0.22em] text-chalk-400 hover:text-chalk-100"
            aria-label="close"
          >
            close [esc]
          </button>
        </header>

        <h3 className="mb-3 font-display text-lg text-chalk-100">
          {panel.title}
        </h3>

        <div className="min-h-[180px]">{panel.body}</div>

        <footer className="mt-6 flex items-center justify-between border-t border-ink-700 pt-4">
          <div className="flex items-center gap-1.5">
            {PANELS.map((_, i) => (
              <button
                key={i}
                onClick={() => setStep(i)}
                aria-label={`go to step ${i + 1}`}
                className={[
                  "h-1.5 w-6 rounded-full transition-colors",
                  i === step ? "bg-chalk-50" : "bg-ink-700 hover:bg-ink-600",
                ].join(" ")}
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            <PixelButton
              variant="neutral"
              onClick={() => setStep((s) => Math.max(0, s - 1))}
              disabled={isFirst}
            >
              back
            </PixelButton>
            {isLast ? (
              <PixelButton variant="primary" onClick={onClose}>
                got it
              </PixelButton>
            ) : (
              <PixelButton
                variant="primary"
                onClick={() => setStep((s) => Math.min(PANELS.length - 1, s + 1))}
              >
                next →
              </PixelButton>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
