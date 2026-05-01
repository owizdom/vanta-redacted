/**
 * `/.well-known/attestation` — third-party verifier surface (paper §10).
 *
 * Returns a self-contained JSON document anyone can fetch, parse, and
 * use to verify the running enclave's identity:
 *
 *   - `signing_pub_key` — the agent's Ed25519 pubkey (the canonical id).
 *   - `attestation_jwt` — the encrypted KMS-signed JWT from
 *     `@layr-labs/ecloud-sdk` AttestClient. Empty when degraded; the
 *     verifier rejects empty in any non-development context.
 *   - `kms_anchor` — the `KMS_PUBLIC_KEY` env or `EIGENCOMPUTE_INSTANCE_ID`
 *     fallback (defensive probe). The encrypted JWT is the load-bearing
 *     evidence; the anchor is for sanity cross-check only.
 *   - `enclave_identity_hash` — SHA-256 binding the signing pubkey to
 *     the identity anchor; lets the verifier confirm the enclave didn't
 *     swap pubkey mid-flight.
 *   - `genesis_event_id` — head of the constitutional chain. Verifier
 *     can pull `/api/events/{id}` and walk to genesis from there.
 *   - `kms_pin` — the appId + KMS public-key SHA-256 the runtime was
 *     deployed against (from `versions.json`). Mismatch with the live
 *     `kms_anchor` is a deployment red flag.
 *
 * Cacheable for 60s. No auth — this is the verifier's primary handle.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { FastifyInstance } from "fastify";

interface KmsPin {
  readonly appId: string | null;
  readonly publicKeySha256: string | null;
}

let cachedKmsPin: KmsPin | null = null;

function loadKmsPin(): KmsPin {
  if (cachedKmsPin !== null) return cachedKmsPin;
  const candidates = [
    resolve(process.cwd(), "versions.json"),
    resolve(process.cwd(), "..", "versions.json"),
  ];
  for (const p of candidates) {
    try {
      const raw = readFileSync(p, "utf8");
      const parsed = JSON.parse(raw) as { kms?: { appId?: unknown; publicKeySha256?: unknown } };
      const kms = parsed.kms;
      cachedKmsPin = {
        appId: typeof kms?.appId === "string" ? kms.appId : null,
        publicKeySha256:
          typeof kms?.publicKeySha256 === "string" ? kms.publicKeySha256 : null,
      };
      return cachedKmsPin;
    } catch {
      // try next candidate
    }
  }
  cachedKmsPin = { appId: null, publicKeySha256: null };
  return cachedKmsPin;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export async function registerAttestationRoute(app: FastifyInstance): Promise<void> {
  app.get("/.well-known/attestation", async (_req, reply) => {
    const t = app.bootstrap.tee;
    const genesis = app.bootstrap.genesis;
    const pin = loadKmsPin();

    const anchor =
      t.identityAnchor?.kind === "kms-jwt"
        ? {
            kind: "kms-jwt" as const,
            audience: t.identityAnchor.audience,
            kms_public_key_pem: t.identityAnchor.kmsPublicKeyPem,
            kms_public_key_sha256: sha256Hex(t.identityAnchor.kmsPublicKeyPem),
          }
        : t.identityAnchor?.kind === "eigencompute-instance"
          ? {
              kind: "eigencompute-instance" as const,
              instance_id: t.identityAnchor.instanceId,
              kms_public_key_pem: t.identityAnchor.kmsPublicKeyPem ?? "",
              kms_public_key_sha256:
                t.identityAnchor.kmsPublicKeyPem === null
                  ? ""
                  : sha256Hex(t.identityAnchor.kmsPublicKeyPem),
              degraded: true as const,
            }
          : { kind: "absent" as const };

    void reply.header("cache-control", "public, max-age=60");
    return {
      version: "v1",
      active: t.active,
      degraded: t.attestationJwt === null,
      signing_pub_key: t.signingPubKey,
      attestation_jwt: t.attestationJwt ?? "",
      enclave_identity_hash: t.enclaveIdentityHash,
      tdx_quote_hash: t.tdxQuoteHash,
      booted_at_unix_ms: t.bootedAt,
      kms_anchor: anchor,
      kms_pin: {
        app_id: pin.appId,
        public_key_sha256: pin.publicKeySha256,
      },
      genesis_event_id: genesis.id,
      genesis_constitution_hash:
        genesis.type === "constitutional.genesis" ? genesis.body.constitutionHash : "",
    };
  });
}
