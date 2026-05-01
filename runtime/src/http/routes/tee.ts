/**
 * `/api/tee` — structured TEE state for the verifier + observer feeds.
 *
 * Exposes only what's already in `TeeState`. Never the private key, the
 * MNEMONIC, the HKDF outputs, or the origination EOA's private key.
 * The pub-key is the agent's canonical identifier and is intended to be
 * public (R2 §2 + spec §1.3).
 */

import type { FastifyInstance } from "fastify";

export async function registerTeeRoute(app: FastifyInstance): Promise<void> {
  app.get("/api/tee", async () => {
    const t = app.bootstrap.tee;
    // The @vanta/verify CLI expects `attestationJwt` to always be a
    // string. In degraded mode (no real KMS), return an empty string
    // rather than null so external verifiers don't fail shape parse.
    return {
      active: t.active,
      signingPubKey: t.signingPubKey,
      attestationJwt: t.attestationJwt ?? "",
      identityAnchor: t.identityAnchor,
      tdxQuoteHash: t.tdxQuoteHash,
      enclaveIdentityHash: t.enclaveIdentityHash,
      bootedAt: t.bootedAt,
      originationAddress: app.bootstrap.origination.address,
    };
  });
}
