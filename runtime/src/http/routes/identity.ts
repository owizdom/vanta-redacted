/**
 * `/api/identity-pin` — owner-banner data source.
 *
 * Returns four addresses + a single `all_match` boolean. The launcher
 * paints them across the header so the visitor sees in one glance:
 *
 *   this enclave's EOA  ≡  LpVault.owner()  ≡  LoanBook.owner()
 *
 * The credibility primitive: only an attested EigenCompute enclave can
 * derive a key whose ETH address matches the on-chain owners. If those
 * addresses ever drift, `all_match=false` and the launcher banner turns
 * red — better to scream than silently lie about the trust boundary.
 *
 * All chain-specific values (appId, expected admin, contract addresses,
 * cross-chain references) come from RuntimeConfig — no hardcoded
 * Sepolia/mainnet constants live in this file. Switching networks is a
 * `.env` flip + redeploy; this route follows automatically.
 *
 * Read-only. Caches the chain reads via `agentState.snapshot()` (60s
 * TTL on the owner fields, 15s on the rest).
 */

import type { FastifyInstance } from "fastify";

export async function registerIdentityRoute(app: FastifyInstance): Promise<void> {
  app.get("/api/identity-pin", async () => {
    const cfg = app.bootstrap.config;
    const snap = app.bootstrap.agentState.snapshot();
    const teeAddress = app.bootstrap.origination.address.toLowerCase();
    const lpOwner = snap.lpVaultOwner?.toLowerCase() ?? null;
    const lbOwner = snap.loanBookOwner?.toLowerCase() ?? null;

    const allMatch =
      lpOwner !== null &&
      lbOwner !== null &&
      lpOwner === teeAddress &&
      lbOwner === teeAddress;

    // Mode classification — laptop demos derive a dev-seed EOA that
    // CAN'T match the deployed contracts; rather than render "pending"
    // forever (which reads as "broken"), surface the mode honestly so
    // the banner can read "local enclave · 0x… · against anvil" and
    // link out to the production pins on Basescan.
    //
    // "production"          → live EOA equals EXPECTED_ADMIN AND owners match
    // "production-mismatch" → live EOA equals EXPECTED_ADMIN but owners drift
    // "local"               → live EOA differs from EXPECTED_ADMIN (dev-seed)
    // "loading"             → first request before agentState has fetched
    const expectedAdminLower = cfg.expectedAdmin?.toLowerCase() ?? null;
    let mode: "production" | "production-mismatch" | "local" | "loading";
    if (lpOwner === null && lbOwner === null && snap.fetchedAt === 0) {
      mode = "loading";
    } else if (
      expectedAdminLower !== null &&
      teeAddress === expectedAdminLower
    ) {
      mode = allMatch ? "production" : "production-mismatch";
    } else {
      mode = "local";
    }

    return {
      // The address that signs ETH txs from inside the enclave. Same
      // EOA that owns the contracts on-chain; that's the whole point.
      tee_address: app.bootstrap.origination.address,
      lp_vault_owner: snap.lpVaultOwner,
      loan_book_owner: snap.loanBookOwner,
      // Cross-chain reference; static. Polygonscan link target. Driven
      // from VANTA_VAULT_ADDRESS in config so this follows the deploy.
      vanta_vault_polygon_address: cfg.vantaVaultAddress,
      eigen_app_id: cfg.expectedAppId,
      all_match: allMatch,
      mode,
      // Production pins — the deployed enclave's identity. The launcher
      // uses these so a local-mode banner can still show "production
      // lives at … → verify on Basescan ↗" without ssh into cloud.
      // Source-of-truth is RuntimeConfig (env-driven); mainnet values
      // live in `.env` / `.env.example`.
      prod: {
        tee_address: cfg.expectedAdmin,
        lp_vault: cfg.lpVaultAddress,
        loan_book: cfg.loanBookAddress,
        eigen_app_id: cfg.expectedAppId,
      },
      fetched_at_unix_ms: snap.fetchedAt,
      stale: snap.stale,
    };
  });
}
