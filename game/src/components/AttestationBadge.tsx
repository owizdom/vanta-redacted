import { useState } from "react";

import {
  fetchEvent,
  shortHash,
  type VantaEventSummary,
} from "../lib/runtime";

interface Props {
  readonly eventId?: string;
  readonly attestationHash?: string;
}

/**
 * TEE attestation chip. Clicking opens a small modal that fetches
 * /api/events/:id, renders the signed envelope, and lets the user
 * copy the canonical-JSON to verify externally.
 */
export function AttestationBadge({ eventId, attestationHash }: Props): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [event, setEvent] = useState<VantaEventSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!attestationHash && !eventId) return null;

  const onOpen = async (): Promise<void> => {
    setOpen(true);
    if (!eventId || event) return;
    setLoading(true);
    try {
      const ev = await fetchEvent(eventId);
      if (ev) setEvent(ev);
      else setErr("event not found");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "fetch failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <button
        onClick={() => void onOpen()}
        className="inline-flex items-center gap-2 rounded-[2px] border border-signal-green/50 bg-signal-green/10 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-signal-green hover:border-signal-green hover:bg-signal-green/20"
        title="Signed inside an EigenCloud TEE — click to verify the envelope"
      >
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-signal-green animate-pulseDot" />
        TEE-attested · Eigen
        {attestationHash ? (
          <span className="ml-1 text-chalk-400">{shortHash(attestationHash, 6, 4)}</span>
        ) : null}
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-ink-950/85 backdrop-blur-sm animate-fadeIn"
          onClick={() => setOpen(false)}
        >
          <div
            className="relative max-h-[80vh] w-full max-w-2xl overflow-auto rounded-[2px] border border-signal-green/60 bg-ink-900 p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="mb-4 flex items-center justify-between border-b border-ink-800 pb-3">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-signal-green">
                  signed envelope · TEE on EigenCloud
                </div>
                <div className="font-mono text-xs text-chalk-300">
                  {eventId ? shortHash(eventId, 8, 6) : "—"}
                </div>
                <div className="mt-1 font-mono text-[9px] text-chalk-500">
                  Ed25519 signed inside an EigenCompute enclave; the public key + KMS-anchored
                  attestation are part of every envelope. Verify externally via the canonical-JSON
                  bytes below.
                </div>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="font-mono text-xs uppercase tracking-[0.22em] text-chalk-400 hover:text-chalk-100"
              >
                close [esc]
              </button>
            </header>

            {loading ? (
              <div className="py-8 text-center font-mono text-xs text-chalk-400">
                fetching attestation…
              </div>
            ) : err ? (
              <div className="rounded-[2px] border border-signal-red/40 bg-signal-red/10 p-4 font-mono text-xs text-signal-red">
                {err}
              </div>
            ) : event ? (
              <pre className="whitespace-pre-wrap break-words rounded-[2px] bg-ink-950 p-3 font-mono text-[10px] leading-relaxed text-chalk-200">
                {JSON.stringify(event, null, 2)}
              </pre>
            ) : (
              <div className="py-8 text-center font-mono text-xs text-chalk-400">
                no event id supplied
              </div>
            )}

            {event ? (
              <button
                onClick={() => void navigator.clipboard.writeText(JSON.stringify(event, null, 2))}
                className="mt-3 rounded-[2px] border border-ink-700 bg-ink-800 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.22em] text-chalk-300 hover:text-chalk-100"
              >
                copy envelope
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
