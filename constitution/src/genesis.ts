/**
 * `signGenesis` — assemble and sign the genesis payload.
 *
 * Single execution path from a validated body to a fully-signed
 * `ConstitutionalGenesisPayload` (spec §5). Called once at first
 * boot, after `initTEE()` returns `{active: true, signingPubKey}`.
 *
 * # Signing injection
 *
 * Per spec §3 "Signing injected where possible; genesis signing
 * consumes `tee.sign` directly — document." The caller is expected to
 * pass a bound reference to `@vanta/tee` `sign`. We cannot re-declare
 * the `SignFn` type from `@vanta/events` here (one-way dependency:
 * events depends on constitution, not the other way around), so we
 * accept a local function signature that matches the events
 * convention (`(preimage: Uint8Array) => Buffer | Promise<Buffer>`).
 * Making the function async-tolerant lets this module support both
 * the current synchronous `tee.sign` and a hypothetical async
 * threshold signer without breaking the contract.
 *
 * # Canonical preimage
 *
 * Per spec §5 step 5 and events synthesis §5, the preimage for the
 * steward signature is the JCS canonicalisation of the constitution
 * **body** prefixed by the domain tag — not the event envelope. The
 * signature we produce here binds the body, not the outer event.
 * `@vanta/events` will later build its own envelope around this
 * payload and compute its own envelope-level Ed25519 signature.
 *
 * This matches spec §5: "Compute constitution hash. `h = sha256(
 * CONSTITUTION_DOMAIN || jcs(body))`" — the steward signature is
 * produced over the same preimage that hashes to
 * `constitution_hash`. This keeps the external-verify recipe simple:
 * given the body alone, a third party can re-derive both the hash
 * and the signature preimage.
 */

import { asSha256Hex } from "@vanta/tee";
import type { SigningPubKeyHex } from "@vanta/tee";

import {
  CONSTITUTION_DOMAIN,
  constitutionHash,
  encodeCanonicalBody,
} from "./canonical.js";
import { ConstitutionError } from "./errors.js";
import type {
  ConstitutionalGenesisPayload,
  ConstitutionBody,
  StewardSignature,
} from "./schema.js";
import { CONSTITUTION_SCHEMA_VERSION } from "./schema.js";
import { validateSemantic } from "./semantic.js";

/**
 * The signing function contract. `@vanta/tee` `sign` matches this
 * shape (returns `Buffer` synchronously); future threshold signers
 * may return a promise. Both are acceptable here.
 */
export type GenesisSignFn = (
  preimage: Uint8Array,
) => Buffer | Promise<Buffer>;

export interface SignGenesisArgs {
  readonly body: ConstitutionBody;
  readonly sign: GenesisSignFn;
  readonly signingPubKey: SigningPubKeyHex;
}

/**
 * Hex-encode a Buffer as lowercase hex.
 */
function toLowerHex(buf: Buffer): string {
  return buf.toString("hex");
}

/**
 * Produce a `ConstitutionalGenesisPayload` from a validated body +
 * TEE signing surface. Throws `ConstitutionError` on precondition
 * failure; rethrows the underlying error (wrapped) if `sign` fails.
 *
 * Steps (spec §5):
 *
 * 1. Pubkey coherence (`GENESIS_PUBKEY_MISMATCH`).
 * 2. Defensive re-validation.
 * 3. Compute `constitution_hash = sha256(domain || jcs(body))`.
 * 4. Build the signature preimage (domain-tagged JCS of the body,
 *    identical byte sequence that produced `constitution_hash`).
 * 5. Sign. Result: 64-byte Ed25519 signature → 128-hex.
 * 6. Populate the single `StewardSignature` entry (spec §5 step 6):
 *    `signer_pubkey = body.agent_pk`, `signature = sigHex`,
 *    `signed_at_unix_ms = body.genesis_timestamp_unix`.
 * 7. Return the payload. `@vanta/events` wraps it into the event
 *    envelope.
 */
export async function signGenesis(
  args: SignGenesisArgs,
): Promise<ConstitutionalGenesisPayload> {
  // 1. Pubkey coherence — guards against a stale body being signed
  //    under a different boot's identity.
  if (args.body.agent_pk !== args.signingPubKey) {
    throw new ConstitutionError(
      "GENESIS_PUBKEY_MISMATCH",
      "body.agent_pk does not match the supplied signingPubKey",
      {
        bodyAgentPk: args.body.agent_pk,
        signingPubKey: args.signingPubKey,
      },
    );
  }

  // 2. Defensive re-validation. Public builder helpers run this
  //    already; a caller that constructed `ConstitutionBody` via a
  //    direct struct-literal would otherwise bypass.
  validateSemantic(args.body);

  // 3. Constitution hash (= domain || jcs(body) → sha256, branded
  //    Sha256Hex).
  const cHash = constitutionHash(args.body);

  // 4. Build the signature preimage. Identical to what hashes into
  //    `constitution_hash`: domain bytes || jcs(body). Using the
  //    same sequence means a verifier only needs the body + domain
  //    tag to re-derive the signable bytes.
  const jcsBytes = encodeCanonicalBody(args.body);
  const domainBytes = Buffer.from(CONSTITUTION_DOMAIN, "utf8");
  const preimage = Buffer.concat([domainBytes, Buffer.from(jcsBytes)]);

  // 5. Sign.
  let sigBuf: Buffer;
  try {
    const signed = await args.sign(preimage);
    // Normalise: `sign` might return a promise to a Buffer.
    sigBuf = signed;
  } catch (cause) {
    throw new ConstitutionError(
      "GENESIS_SIGNING_FAILED",
      "signing function threw during genesis signature",
      { cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }
  if (sigBuf.length !== 64) {
    throw new ConstitutionError(
      "GENESIS_SIGNING_FAILED",
      "Ed25519 signature MUST be 64 bytes",
      { length: sigBuf.length },
    );
  }
  const sigHex = toLowerHex(sigBuf);
  if (!/^[0-9a-f]{128}$/.test(sigHex)) {
    // Unreachable: Buffer.toString("hex") always lowercase.
    throw new ConstitutionError(
      "GENESIS_SIGNING_FAILED",
      "signature hex encoding failed sanity check",
      { length: sigHex.length },
    );
  }

  // 6. Populate the single StewardSignature. Under the sole-steward
  //    baseline the single steward IS the agent, so
  //    `signer_pubkey === body.agent_pk`. `signed_at_unix_ms` equals
  //    the body's genesis timestamp so the payload is temporally
  //    self-consistent — a verifier can reason about the signing
  //    window from the body alone.
  const signature: StewardSignature = {
    signer_pubkey: args.body.agent_pk,
    signature: sigHex,
    signed_at_unix_ms: args.body.genesis_timestamp_unix,
  };

  // 7. Return the payload. The `diff_summary` literal is fixed for
  //    genesis per spec §5 step 4.
  const payload: ConstitutionalGenesisPayload = {
    version: CONSTITUTION_SCHEMA_VERSION,
    body: args.body,
    constitution_hash: cHash,
    diff_summary: "genesis",
    signatures: [signature],
  };

  // Re-brand the hash through `asSha256Hex` to fail closed if an
  // upstream library dropped the brand — unreachable given the
  // type of `constitutionHash` but harmless as defence in depth.
  void asSha256Hex(payload.constitution_hash);

  return payload;
}

/**
 * Internal guard used by callers that receive an unsigned
 * `ConstitutionalGenesisPayload` from untrusted code and want to
 * assert the `signatures` array is empty before signing. Surfaces
 * `GENESIS_SIGNATURE_ARRAY_NONEMPTY` per spec §4.
 *
 * Exported for composability — not part of the §1 API surface, so
 * `index.ts` does NOT re-export it.
 */
export function assertUnsignedGenesisPayloadShape(
  candidate: Pick<ConstitutionalGenesisPayload, "signatures">,
): void {
  if (candidate.signatures.length !== 0) {
    throw new ConstitutionError(
      "GENESIS_SIGNATURE_ARRAY_NONEMPTY",
      "unsigned genesis payload must carry signatures: []",
      { length: candidate.signatures.length },
    );
  }
}
