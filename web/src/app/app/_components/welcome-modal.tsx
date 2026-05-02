"use client";

import { useEffect, useState } from "react";

type Stage = "welcome" | "step-1" | "step-2" | "step-3" | "step-4" | "closed";

const STORAGE_KEY = "vanta:welcome:dismissed";
export const WELCOME_OPEN_EVENT = "vanta:welcome:open";

/** Trigger the welcome flow imperatively from anywhere in the app. */
export function openWelcomeModal(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(WELCOME_OPEN_EVENT));
}

export function WelcomeModal(): JSX.Element | null {
  const [stage, setStage] = useState<Stage>("closed");

  // Auto-open on first visit (per-browser).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const dismissed = window.localStorage.getItem(STORAGE_KEY) === "1";
    if (!dismissed) setStage("welcome");
  }, []);

  // Imperative re-open via window event (TopNav "How it works ?" pill).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onOpen = (): void => setStage("welcome");
    window.addEventListener(WELCOME_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(WELCOME_OPEN_EVENT, onOpen);
  }, []);

  function close(): void {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, "1");
    }
    setStage("closed");
  }

  if (stage === "closed") return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/80 backdrop-blur"
    >
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-ink-800 bg-ink-900 shadow-[0_20px_60px_-15px_rgba(0,0,0,0.7)]">
        {stage === "welcome" ? (
          <Welcome onStart={() => setStage("step-1")} onClose={close} />
        ) : (
          <Step
            stage={stage}
            onPrev={() => setStage(prevStage(stage))}
            onNext={() => {
              const n = nextStage(stage);
              if (n === "closed") close();
              else setStage(n);
            }}
            onClose={close}
          />
        )}
      </div>
    </div>
  );
}

function Welcome({
  onStart,
  onClose,
}: {
  readonly onStart: () => void;
  readonly onClose: () => void;
}): JSX.Element {
  return (
    <>
      <Banner />
      <div className="px-6 py-6">
        <div className="flex items-center gap-2">
          <span className="inline-block rounded-md bg-violet-500 px-2 py-0.5 font-display text-base font-semibold leading-none text-chalk-50">
            V
          </span>
          <h2 className="font-display text-2xl font-semibold tracking-tight">
            I'm VANTA.
          </h2>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-chalk-200">
          I'm an autonomous risk agent running inside an Intel TDX enclave on
          EigenCloud. I lend USDC against your Polymarket positions — without
          you having to sell them. I price the loan, ship the dollars, watch
          the position every 60 seconds, and settle when it resolves. Every
          decision I make is signed and verifiable.
        </p>

        <div className="mt-6 flex gap-2">
          <button
            type="button"
            onClick={onStart}
            className="rounded-lg bg-chalk-50 px-4 py-2 text-sm font-medium text-ink-950 hover:bg-chalk-200"
          >
            Get started
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-ink-700 px-4 py-2 text-sm font-medium text-chalk-200 hover:border-ink-600"
          >
            Skip
          </button>
        </div>
      </div>
    </>
  );
}

const STEPS = {
  "step-1": {
    title: "You pledge a position to me",
    body:
      "Send me your YES or NO shares — they go into VantaVault on Polygon Amoy. You don't sell, and I can't move them outside the vault. The custody contract enforces that, not me.",
    sample: { question: "Will the USA win the 2026 FIFA World Cup?", price: "13¢", side: "Long YES", chip: "Pledged" },
  },
  "step-2": {
    title: "I price the loan",
    body:
      "Seven hard gates check the market first — depth, dispute history, age, volatility, text clarity, template fit, tag novelty. Every one must pass. Then I reason about the rest. Your max loan is V = p × (1 − h) × N — the haircut formula does the math.",
    sample: { question: "Max loan: $124,500 USDC", price: "47% LTV", side: "h ≈ 0.170", chip: "Approved" },
  },
  "step-3": {
    title: "I ship USDC on-chain",
    body:
      "I broadcast LoanBook.originate on Base Sepolia myself — my origination key is HKDF-derived in the enclave. Once it confirms with depth ≥ 2, I sign a loan.origination event into the log. Funds hit your wallet.",
    sample: { question: "loan.origination · 0xa6004c…", price: "+$124,500", side: "Base Sepolia", chip: "Signed" },
  },
  "step-4": {
    title: "I watch every 60 seconds",
    body:
      "My credit loop checks your position once a minute. Repay before maturity and I close the loan. Cross 77% LTV and the contract liquidates without me. Either way, every step is a signed event you can replay back to genesis.",
    sample: { question: "loan.settlement · 0xa6004c…", price: "Closed", side: "Vault returned", chip: "Done" },
  },
} as const satisfies Record<Exclude<Stage, "welcome" | "closed">, unknown>;

function Step({
  stage,
  onPrev,
  onNext,
  onClose,
}: {
  readonly stage: Exclude<Stage, "welcome" | "closed">;
  readonly onPrev: () => void;
  readonly onNext: () => void;
  readonly onClose: () => void;
}): JSX.Element {
  const idx = ["step-1", "step-2", "step-3", "step-4"].indexOf(stage);
  const isLast = stage === "step-4";
  const s = STEPS[stage];

  return (
    <div className="px-6 py-6">
      <SamplePreviewCard {...s.sample} />

      <h3 className="mt-6 font-display text-xl font-semibold tracking-tight">
        {s.title}
      </h3>
      <p className="mt-2 text-sm leading-relaxed text-chalk-200">{s.body}</p>

      <div className="mt-6 flex items-center gap-1.5">
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className={`h-1 flex-1 rounded-full transition ${
              i <= idx ? "bg-chalk-50" : "bg-ink-700"
            }`}
          />
        ))}
      </div>

      <div className="mt-5 flex items-center gap-2">
        <button
          type="button"
          onClick={isLast ? onClose : onNext}
          className="rounded-lg bg-chalk-50 px-4 py-2 text-sm font-medium text-ink-950 hover:bg-chalk-200"
        >
          {isLast ? "Open the app" : "Continue"}
        </button>
        {idx > 0 && (
          <button
            type="button"
            onClick={onPrev}
            className="rounded-lg border border-ink-700 px-4 py-2 text-sm font-medium text-chalk-200 hover:border-ink-600"
          >
            Back
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="ml-auto text-xs text-chalk-400 hover:text-chalk-200"
        >
          Skip
        </button>
      </div>
    </div>
  );
}

function SamplePreviewCard({
  question,
  price,
  side,
  chip,
}: {
  readonly question: string;
  readonly price: string;
  readonly side: string;
  readonly chip: string;
}): JSX.Element {
  const positive =
    chip.startsWith("+") ||
    chip === "Approved" ||
    chip === "Confirmed" ||
    chip === "Signed" ||
    chip === "Pledged" ||
    chip === "Done";
  return (
    <div className="rounded-xl border border-ink-700 bg-ink-950 p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-chalk-50">{question}</p>
        <span
          className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] ${
            positive
              ? "border-signal-green/40 bg-signal-green/10 text-signal-green"
              : "border-ink-700 text-chalk-200"
          }`}
        >
          {chip}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="rounded-md bg-ink-900 px-3 py-2 text-center">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-chalk-400">
            {side}
          </p>
        </div>
        <div className="rounded-md bg-ink-900 px-3 py-2 text-center">
          <p className="font-display text-base font-semibold">{price}</p>
        </div>
      </div>
    </div>
  );
}

function Banner(): JSX.Element {
  return (
    <div
      aria-hidden
      className="h-32 w-full"
      style={{
        backgroundImage:
          "linear-gradient(135deg, #d6f24a 0%, #d6f24a 35%, #b6acff 35%, #b6acff 65%, #d6f24a 65%)",
        backgroundSize: "16px 16px, auto",
      }}
    >
      <div
        className="flex h-full w-full items-center justify-center"
        style={{
          backgroundImage:
            "repeating-linear-gradient(0deg, rgba(255,255,255,0.0) 0px, rgba(255,255,255,0.0) 14px, rgba(8,9,11,0.08) 14px, rgba(8,9,11,0.08) 16px), repeating-linear-gradient(90deg, rgba(255,255,255,0.0) 0px, rgba(255,255,255,0.0) 14px, rgba(8,9,11,0.08) 14px, rgba(8,9,11,0.08) 16px)",
        }}
      >
        <span className="flex items-center gap-2">
          <span className="inline-block rounded-md bg-ink-950 px-2 py-1 font-display text-2xl font-semibold leading-none text-chalk-50">
            V
          </span>
          <span className="font-display text-3xl font-semibold tracking-tight text-ink-950">
            VANTA
          </span>
        </span>
      </div>
    </div>
  );
}

function nextStage(s: Stage): Stage {
  if (s === "welcome") return "step-1";
  if (s === "step-1") return "step-2";
  if (s === "step-2") return "step-3";
  if (s === "step-3") return "step-4";
  return "closed";
}
function prevStage(s: Stage): Stage {
  if (s === "step-2") return "step-1";
  if (s === "step-3") return "step-2";
  if (s === "step-4") return "step-3";
  return "welcome";
}
