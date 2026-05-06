import { useEffect } from "react";

import { MadeSovereignWith } from "./MadeSovereignWith";
import { PixelButton } from "./PixelButton";

interface Props {
  readonly open: boolean;
  readonly onClose: () => void;
}

export function AboutModal({ open, onClose }: Props): JSX.Element | null {
  useEffect(() => {
    if (!open) return;
    const handle = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/80 backdrop-blur-sm animate-fadeIn"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-2xl rounded-[2px] border border-ink-700 bg-ink-900 p-8 shadow-[0_24px_48px_-12px_rgba(0,0,0,0.8)]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-6 flex items-baseline justify-between border-b border-ink-700 pb-4">
          <h2 className="font-display text-2xl font-semibold text-chalk-50">
            what is vanta?
          </h2>
          <button
            onClick={onClose}
            className="font-mono text-xs uppercase tracking-[0.22em] text-chalk-400 hover:text-chalk-100"
            aria-label="close"
          >
            close [esc]
          </button>
        </header>

        <div className="space-y-4 text-sm leading-relaxed text-chalk-200">
          <p>
            <span className="font-mono text-opus">vanta</span> is a fleet of
            verifiable AI lenders for prediction-market positions. Own a{" "}
            <span className="font-mono">polymarket</span> bet, don't want to
            sell, need cash now? VANTA lends you USDC against it.
          </p>
          <p>
            The agent runs autonomously — reads the market, runs an
            underwriting council, decides whether to lend you money and at
            what rate, runs the loan from start to finish. Every prompt the
            agent sees and every response it produces is{" "}
            <span className="text-chalk-50">signed by a TEE</span> and
            queryable on chain. You can audit the exact reasoning behind any
            loan decision.
          </p>
          <p>
            Three lenders launch in v3.5:{" "}
            <span className="text-opus">vanta-opus</span> (macro · south),{" "}
            <span className="text-gpt">vanta-gpt</span> (sports · NE), and{" "}
            <span className="text-gemini">vanta-gemini</span> (politics · NW).
            Each kingdom on the map is one lender — pick which one to lend
            into, or which one to borrow from.
          </p>
          <p className="font-mono text-xs leading-relaxed text-chalk-400">
            LP: deposit USDC → ERC-4626 share token → earn interest from
            loans the agent originates. Borrower: pledge a Polymarket
            position → council deliberates live → approve+rate or denial+
            reason. Weekly on-chain spend cap. No leverage. No human in the
            funding loop.
          </p>

          <div className="mt-2 rounded-[2px] border border-ink-700 bg-ink-950/60 p-3 font-mono text-[10px] leading-relaxed text-chalk-300">
            <div className="mb-2">
              <MadeSovereignWith size="sm" tone="bright" />
            </div>
            Each agent runs inside an EigenCompute TEE. The signing key,
            inference calls, and every event in the audit chain are
            attested by KMS-anchored quotes — verifiable byte-for-byte
            against the on-chain commitment without trusting the
            operator. Click any{" "}
            <span className="text-signal-green">tee-attested</span>{" "}
            badge to inspect the signed envelope yourself.
          </div>
        </div>

        <footer className="mt-8 flex items-center justify-end gap-3">
          <PixelButton onClick={onClose} variant="neutral">
            got it
          </PixelButton>
        </footer>
      </div>
    </div>
  );
}
