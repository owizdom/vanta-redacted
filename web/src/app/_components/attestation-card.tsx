"use client";

import { useEffect, useState } from "react";

interface AttestationDoc {
  readonly signing_pub_key?: string;
  readonly attestation_jwt?: string;
  readonly enclave_identity_hash?: string;
  readonly genesis_event_id?: string;
  readonly kms_anchor?: {
    readonly kind: string;
    readonly audience?: string;
    readonly kms_public_key_sha256?: string;
    readonly instance_id?: string;
  };
  readonly kms_pin?: {
    readonly app_id?: string | null;
    readonly public_key_sha256?: string | null;
  };
}

export function AttestationCard(): JSX.Element {
  const [doc, setDoc] = useState<AttestationDoc | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function pull(): Promise<void> {
      try {
        const r = await fetch("/.well-known/attestation", { cache: "no-store" });
        if (!r.ok) {
          setError(`runtime → HTTP ${String(r.status)}`);
          return;
        }
        const j = (await r.json()) as AttestationDoc;
        if (!cancelled) {
          setError(null);
          setDoc(j);
        }
      } catch {
        if (!cancelled) setError("runtime unreachable");
      }
    }
    void pull();
    const t = setInterval(() => void pull(), 8000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const live = doc !== null && error === null;

  return (
    <div className="mx-auto mt-16 w-full max-w-3xl">
      <div className="overflow-hidden rounded-2xl border border-ink-700 bg-ink-900/60 backdrop-blur">
        <div className="flex items-center justify-between gap-3 border-b border-ink-700/80 bg-ink-800/40 px-6 py-3">
          <div className="flex items-center gap-2">
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                live ? "animate-pulse-dot bg-signal-green" : "bg-signal-red"
              }`}
            />
            <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-chalk-400">
              {live ? "live · enclave-resident" : "runtime offline"}
            </span>
          </div>
          <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-chalk-400">
            /.well-known/attestation
          </span>
        </div>

        <div className="grid gap-px bg-ink-700 sm:grid-cols-2">
          <Cell
            k="signing pubkey"
            v={doc?.signing_pub_key ? truncMid(doc.signing_pub_key, 10, 8) : "—"}
            mono
          />
          <Cell
            k="kms anchor"
            v={doc?.kms_anchor?.kind ?? "—"}
            sub={
              doc?.kms_anchor?.kind === "kms-jwt"
                ? doc.kms_anchor.audience ?? null
                : doc?.kms_anchor?.instance_id ?? null
            }
          />
          <Cell
            k="enclave identity"
            v={doc?.enclave_identity_hash ? truncMid(doc.enclave_identity_hash, 10, 8) : "—"}
            mono
          />
          <Cell
            k="genesis event"
            v={doc?.genesis_event_id ? truncMid(doc.genesis_event_id, 10, 8) : "—"}
            mono
          />
        </div>

        <div className="border-t border-ink-700/80 bg-ink-800/30 px-6 py-3 text-center">
          <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-chalk-400">
            {live
              ? "ed25519 keypair generated in-enclave · never persisted · cleared on shutdown"
              : "start the local runtime with pnpm dev to populate"}
          </span>
        </div>
      </div>
    </div>
  );
}

function Cell({
  k,
  v,
  sub,
  mono,
}: {
  readonly k: string;
  readonly v: string;
  readonly sub?: string | null;
  readonly mono?: boolean;
}): JSX.Element {
  return (
    <div className="bg-ink-900 px-6 py-4">
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-chalk-400">
        {k}
      </p>
      <p
        className={`mt-1.5 text-sm text-chalk-50 ${mono === true ? "font-mono" : "font-display font-medium"}`}
      >
        {v}
      </p>
      {sub != null && sub.length > 0 && (
        <p className="mt-1 truncate font-mono text-[11px] text-chalk-400">{sub}</p>
      )}
    </div>
  );
}

function truncMid(s: string, head: number, tail: number): string {
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}
