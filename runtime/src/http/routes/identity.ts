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
 * Read-only. Caches the chain reads via `agentState.snapshot()` (60s
 * TTL on the owner fields, 15s on the rest).
 */

import type { FastifyInstance } from "fastify";

// EigenCompute App ID — pinned in code rather than env so a misconfigured
// deploy can't quietly point the launcher at a different app. Updated
// whenever we redeploy the runtime image to a new ecloud app id.
const EIGEN_APP_ID = "0xaa4875Ff1514b8227Dc61466473c0B1E4C83CAf9" as const;

// VantaVault on Polygon Amoy — same `0xD9AF…f076` byte pattern as the
// Base-Sepolia LpVault but on a different chain. Surfaced as a "see also"
// link; not part of `all_match` since the runtime's publicClient is
// Base-Sepolia-only and we don't read its owner here. The address is
// pinned for the launcher's polygonscan link target.
const VANTA_VAULT_AMOY_ADDRESS = "0xD9AFC3abC151239B047F653e0493792ecEB0f076" as const;

// Production-deployed enclave EOA + contracts. Used to compute the
// local-vs-prod banner state — when SKIP_CONTRACT_CHECKS=1 + dev-seed
// derives a different address, the laptop demo is HONEST about being
// local instead of saying "on-chain owner reads pending" which sounds
// like the runtime is broken.
const PROD_TEE_ADDRESS = "0x8275001D7618263304B76Ed621150cE4193826e6" as const;
const PROD_LP_VAULT = "0xD9AFC3abC151239B047F653e0493792ecEB0f076" as const;
const PROD_LOAN_BOOK = "0xA6004cb25ce50baEDa38017B81577FA2419a876f" as const;

export async function registerIdentityRoute(app: FastifyInstance): Promise<void> {
  app.get("/api/identity-pin", async () => {
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
    // the banner can read "local enclave · 0x5B5E… · against anvil"
    // and link out to the production pins on Basescan.
    let mode: "production" | "production-mismatch" | "local" | "loading";
    if (lpOwner === null && lbOwner === null && snap.fetchedAt === 0) {
      mode = "loading";
    } else if (teeAddress === PROD_TEE_ADDRESS.toLowerCase()) {
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
      // Cross-chain reference; static. Polygonscan link target.
      vanta_vault_amoy_address: VANTA_VAULT_AMOY_ADDRESS,
      eigen_app_id: EIGEN_APP_ID,
      all_match: allMatch,
      mode,
      // Production pins — the deployed enclave's identity. The launcher
      // uses these so a local-mode banner can still show "production
      // lives at 0x8275… → verify on Basescan ↗" without ssh into cloud.
      prod: {
        tee_address: PROD_TEE_ADDRESS,
        lp_vault: PROD_LP_VAULT,
        loan_book: PROD_LOAN_BOOK,
        eigen_app_id: EIGEN_APP_ID,
      },
      fetched_at_unix_ms: snap.fetchedAt,
      stale: snap.stale,
    };
  });
}
