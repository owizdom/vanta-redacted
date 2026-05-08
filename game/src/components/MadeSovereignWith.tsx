/**
 * `<MadeSovereignWith>` — attribution chip + verifiable-artefacts modal.
 *
 * On click, a centred modal opens listing every on-chain + TEE
 * identity artefact that backs the agent's "sovereignty" claim:
 *   - Eigen app id with verify.eigencloud.xyz link
 *   - TEE signing pubkey, enclave identity hash, image digest,
 *     admin EOA — all live values from /api/tee
 *   - Deployed contracts (LpVault, LoanBook on Base; VantaVault,
 *     Polymarket CTF on Polygon) with explorer links
 *
 * Used on the world view, the landing menu footer, and the
 * marketplace hero. Displayed as a pill; the click target is the
 * whole pill.
 */

import { useEffect, useState } from "react";

import {
  extractImageDigestFromJwt,
  fetchTee,
  shortHash,
  type TeeIdentity,
} from "../lib/runtime";

const EIGEN_APP_ID = "0x95F2AB29fAa9A4C834B06B0514428d63C6e0E80d";
const EIGEN_VERIFY_URL = `https://verify.eigencloud.xyz/app/${EIGEN_APP_ID}`;

const LP_VAULT_BASE = "0xe2f93c448d9fc51155e2e06479b3b1e86f8ae45b";
const LOAN_BOOK_BASE = "0x7ed4e98d460bbd7e43854cd93fd96d8e11b71954";
const VANTA_VAULT_POLYGON = "0xe2f93c448d9fc51155e2e06479b3b1e86f8ae45b";
const POLYMARKET_CTF_POLYGON = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";

const basescan = (a: string): string => `https://basescan.org/address/${a}`;
const polygonscan = (a: string): string => `https://polygonscan.com/address/${a}`;

interface Props {
  /** Adjusts logo height + label size. Default `md`. */
  readonly size?: "sm" | "md";
  /** Tone of the label text. */
  readonly tone?: "muted" | "bright";
}

export function MadeSovereignWith({ size = "md", tone = "muted" }: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const [tee, setTee] = useState<TeeIdentity | null>(null);

  useEffect(() => {
    if (!open || tee !== null) return;
    void fetchTee().then((t) => {
      if (t !== null) setTee(t);
    });
  }, [open, tee]);

  useEffect(() => {
    if (!open) return;
    const handle = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [open]);

  const isSm = size === "sm";
  const labelClass = [
    "font-mono uppercase",
    isSm ? "text-[9px] tracking-[0.22em]" : "text-[11px] tracking-widest",
    tone === "bright" ? "text-chalk-100" : "text-chalk-400",
  ].join(" ");
  const logoH = isSm ? "h-4" : "h-5";
  const logoW = isSm ? "w-[36px]" : "w-[44px]";

  const imageDigest = tee?.identityAnchor?.jwt
    ? extractImageDigestFromJwt(tee.identityAnchor.jwt)
    : null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group inline-flex items-center gap-2 transition-opacity hover:opacity-80"
        aria-label="Show VANTA's verifiable on-chain attestation"
        title="Click to view contracts + TEE identity"
      >
        <span className={labelClass}>made sovereign with</span>
        <span
          role="img"
          aria-label="EigenCloud"
          className={[
            "block bg-chalk-100 transition-colors group-hover:bg-chalk-50",
            logoH,
            logoW,
          ].join(" ")}
          style={{
            WebkitMaskImage: "url(/eigencloud_logo.png)",
            maskImage: "url(/eigencloud_logo.png)",
            WebkitMaskSize: "contain",
            maskSize: "contain",
            WebkitMaskRepeat: "no-repeat",
            maskRepeat: "no-repeat",
            WebkitMaskPosition: "left center",
            maskPosition: "left center",
          }}
        />
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-ink-950/85 px-4 backdrop-blur-sm animate-fadeIn"
          onClick={() => setOpen(false)}
        >
          <div
            className="relative w-full max-w-xl rounded-[2px] border border-ink-700 bg-ink-900 shadow-[0_24px_48px_-12px_rgba(0,0,0,0.8)]"
            onClick={(e) => e.stopPropagation()}
          >
            {/* header */}
            <header className="flex items-start justify-between gap-3 border-b border-ink-700 px-5 py-4">
              <div className="min-w-0">
                <div className="font-mono text-[9px] uppercase tracking-[0.22em] text-chalk-500">
                  verifiable
                </div>
                <div className="mt-0.5 font-display text-lg font-semibold text-chalk-50">
                  made sovereign with EigenCloud
                </div>
                <div className="mt-1 text-[10.5px] leading-relaxed text-chalk-400">
                  every prompt, response, deposit, and loan is signed
                  inside an EigenCompute TEE and anchored on chain. click
                  any row to verify externally.
                </div>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="shrink-0 rounded-[2px] border border-ink-700 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.22em] text-chalk-400 hover:text-chalk-100"
              >
                close
              </button>
            </header>

            {/* body */}
            <div className="space-y-4 px-5 py-4">
              {/* TEE identity */}
              <section>
                <div className="mb-2 font-mono text-[9px] uppercase tracking-[0.22em] text-chalk-500">
                  tee · eigencompute mainnet-alpha
                </div>
                <div className="space-y-1.5 rounded-[2px] border border-ink-700 bg-ink-800/40 px-3 py-2.5 font-mono text-[10px]">
                  <RefRow
                    label="eigen app"
                    addr={EIGEN_APP_ID}
                    href={EIGEN_VERIFY_URL}
                    chain="verify.eigencloud.xyz"
                  />
                  <RefRow
                    label="signing key"
                    addr={tee?.signingPubKey ?? "—"}
                    chain="ed25519"
                  />
                  <RefRow
                    label="enclave id"
                    addr={tee?.enclaveIdentityHash ?? "—"}
                    chain="sha256"
                  />
                  <RefRow
                    label="image digest"
                    addr={imageDigest ?? "—"}
                    chain="kms-jwt"
                  />
                  <RefRow
                    label="admin EOA"
                    addr={tee?.originationAddress ?? "—"}
                    chain="hkdf-derived"
                  />
                </div>
              </section>

              {/* contracts */}
              <section>
                <div className="mb-2 font-mono text-[9px] uppercase tracking-[0.22em] text-chalk-500">
                  deployed contracts
                </div>
                <div className="space-y-1.5 rounded-[2px] border border-ink-700 bg-ink-800/40 px-3 py-2.5 font-mono text-[10px]">
                  <RefRow
                    label="LpVault"
                    addr={LP_VAULT_BASE}
                    href={basescan(LP_VAULT_BASE)}
                    chain="Base mainnet"
                  />
                  <RefRow
                    label="LoanBook"
                    addr={LOAN_BOOK_BASE}
                    href={basescan(LOAN_BOOK_BASE)}
                    chain="Base mainnet"
                  />
                  <RefRow
                    label="VantaVault"
                    addr={VANTA_VAULT_POLYGON}
                    href={polygonscan(VANTA_VAULT_POLYGON)}
                    chain="Polygon mainnet"
                  />
                  <RefRow
                    label="Polymarket CTF"
                    addr={POLYMARKET_CTF_POLYGON}
                    href={polygonscan(POLYMARKET_CTF_POLYGON)}
                    chain="Polygon mainnet"
                  />
                </div>
              </section>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

interface RefRowProps {
  readonly label: string;
  readonly addr: string;
  readonly chain: string;
  readonly href?: string;
}

function RefRow({ label, addr, chain, href }: RefRowProps): JSX.Element {
  const display =
    addr.length > 24 ? shortHash(addr.replace(/^0x/, ""), 10, 8) : addr;
  const Inner = (
    <>
      <span className="w-24 shrink-0 text-[9px] uppercase tracking-[0.22em] text-chalk-500">
        {label}
      </span>
      <span className="flex-1 truncate text-chalk-300">{display}</span>
      <span className="shrink-0 text-[9px] uppercase tracking-[0.22em] text-chalk-500">
        {chain}
        {href ? <span className="ml-1">↗</span> : null}
      </span>
    </>
  );
  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-2 hover:text-chalk-100"
        title={addr}
      >
        {Inner}
      </a>
    );
  }
  return (
    <div className="flex items-center gap-2" title={addr}>
      {Inner}
    </div>
  );
}
