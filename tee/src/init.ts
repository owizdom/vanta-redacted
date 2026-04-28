/**
 * `initTEE` orchestrator.
 *
 * Order (spec §1.6):
 *   1. readMnemonic — the env var is consumed lazily by kdf.deriveKey;
 *      init.ts asserts configuration via Node-version check and delegates
 *      the actual read to the first HKDF derivation.
 *   2. generateSigningKeypair — fresh Ed25519 in enclave RAM.
 *   3. fetchAttestation — canonical KMS JWT via ecloud-sdk.
 *   4. compute enclaveIdentityHash — bind pubkey to anchor.
 *   5. construct and return TeeState.
 *
 * Degraded-mode fallback (spec §6): if (3) exhausts retries AND
 * `EIGENCOMPUTE_INSTANCE_ID` is set, `IdentityAnchor.kind =
 * "eigencompute-instance"` with `degraded: true`. Never log
 * "hardware-enforced" in degraded mode (R3 §4).
 *
 * Both fail → `no_identity_anchor`. Caller decides how to exit.
 *
 * Second call → `signing_already_initialized` bubbles from signer.ts.
 *
 * Post-boot cleanup:
 *   - zero the cached MNEMONIC Buffer
 *   - delete process.env.MNEMONIC
 */

import { TeeError } from "./errors.js";
import { zeroAndDropMnemonicEnv } from "./mnemonic.js";
import { takeIkmForZeroization } from "./kdf.js";
import { generateSigningKeypair, signingPubKey } from "./signer.js";
import { fetchAttestation, __recordDegradedKmsPem } from "./attest.js";
import { computeEnclaveIdentityHash } from "./identity.js";
import type {
  AttestationJwt,
  IdentityAnchor,
  TeeState,
} from "./types.js";

const MIN_NODE_MAJOR = 20;

function assertNodeVersion(): void {
  const [majorStr] = process.versions.node.split(".");
  const major = Number.parseInt(majorStr ?? "0", 10);
  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    throw new TeeError(
      "env_not_configured",
      `Node ${MIN_NODE_MAJOR}+ required, running ${process.versions.node}`,
      { nodeVersion: process.versions.node },
    );
  }
}

/**
 * Initialize the TEE module. Synchronous-at-boot (spec §D4). Second await
 * throws `signing_already_initialized` via signer.ts; no silent return.
 */
export async function initTEE(): Promise<TeeState> {
  assertNodeVersion();

  // Step 2: signing keypair. Throws on double-init.
  generateSigningKeypair();
  const pubkey = signingPubKey();

  // Step 3: attestation — transient retries, terminal throws.
  let jwt: AttestationJwt | null = null;
  let kmsPem: string | null = null;
  let audience: string | null = null;
  let attestErr: TeeError | null = null;
  try {
    const bundle = await fetchAttestation();
    jwt = bundle.jwt;
    kmsPem = bundle.kmsPublicKeyPem;
    audience = bundle.audience;
  } catch (err: unknown) {
    if (err instanceof TeeError) {
      const terminal =
        err.code === "attestation_signature_mismatch" ||
        err.code === "attestation_decrypt_failed";
      if (terminal) {
        // Terminal errors are never degraded-over (T20).
        throw err;
      }
      attestErr = err;
    } else {
      attestErr = new TeeError(
        "attestation_unavailable",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Step 4 + 5: anchor + identity hash + state.
  let anchor: IdentityAnchor;
  if (jwt !== null && kmsPem !== null && audience !== null) {
    anchor = {
      kind: "kms-jwt",
      jwt,
      kmsPublicKeyPem: kmsPem,
      audience,
    };
  } else {
    const instanceId = process.env["EIGENCOMPUTE_INSTANCE_ID"];
    if (typeof instanceId !== "string" || instanceId.length === 0) {
      throw new TeeError(
        "no_identity_anchor",
        "attestation failed and EIGENCOMPUTE_INSTANCE_ID is not set",
        attestErr === null ? {} : { attestCode: attestErr.code },
      );
    }
    const degradedPem = process.env["KMS_PUBLIC_KEY"] ?? null;
    anchor = {
      kind: "eigencompute-instance",
      instanceId,
      kmsPublicKeyPem: degradedPem,
      degraded: true,
    };
    __recordDegradedKmsPem(degradedPem);
    // Explicit operational warning — never call this "hardware-enforced".
    console.warn(
      `vanta/tee: running in degraded mode, attestation unavailable (code=${attestErr?.code ?? "unknown"})`,
    );
  }

  const identityHash = computeEnclaveIdentityHash(pubkey, anchor);

  const state: TeeState = {
    active: true,
    signingPubKey: pubkey,
    attestationJwt: jwt,
    identityAnchor: anchor,
    tdxQuoteHash: null, // literal null always; spec §2, R1 §2, R3 §4
    enclaveIdentityHash: identityHash,
    bootedAt: Date.now(),
  };

  // Post-boot cleanup. Zero the IKM Buffer (if any derivation happened)
  // and remove MNEMONIC from the process environment.
  try {
    const ikm = takeIkmForZeroization();
    if (ikm !== null) {
      zeroAndDropMnemonicEnv(ikm);
    } else if (process.env["MNEMONIC"] !== undefined) {
      // No deriveKey ran during boot, but MNEMONIC is sitting in env.
      // Drop the env entry; the interned string is unreachable from here.
      delete process.env["MNEMONIC"];
    }
  } catch (err: unknown) {
    // Cleanup must not mask a successful boot. Log and continue.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`vanta/tee: post-boot MNEMONIC cleanup failed: ${msg}`);
  }

  return state;
}
