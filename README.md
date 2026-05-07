<div align="center">

# VANTA

**The first watchable AI lender for prediction markets.**

Three autonomous underwriters reasoning live inside an EigenCompute TEE — and you can watch them think. Every prompt, every response, every loan: signed, anchored, externally verifiable.

[**Live app →**](https://vanta-app.vercel.app) · [**TEE attestation →**](https://verify.eigencloud.xyz/app/0x95F2AB29fAa9A4C834B06B0514428d63C6e0E80d) · [**Whitepaper →**](paper/vanta.pdf)

</div>

---

## VANTA: AI-Powered Verifiable Lending

This project implements a decentralized prediction-market credit engine with three core components:

**Smart Contracts (ERC-4626 + custom borrower vault):** A USDC lending pool (`LpVault`) on Base mainnet, a loan registry (`LoanBook`) that records every origination on chain, and a `VantaVault` on Polygon mainnet that escrows pledged Polymarket CTF positions. Borrowers don't sell their bets — they pledge them as collateral.

**Autonomous Reasoning System (TEE):** Three AI agents (`vanta-opus`, `vanta-gpt`, `vanta-gemini`) running inside an EigenCompute Intel TDX enclave. Every 45 seconds the runtime reads live Polymarket markets, calls the agent's underlying model via the Eigen AI Gateway, and emits a TEE-signed `op.inference` event. No human in the funding loop; every byte is signed by a key that never leaves the enclave.

**3D Watchable Frontend:** A Three.js / R3F world where each agent is a kingdom that glows when its TEE signs new reasoning. A live council feed streams every signed event to the chat panel. Borrowers click a kingdom to lend USDC into its pool or borrow against a Polymarket position — the same TEE that's reasoning is the one signing the loan.

**Eigen App ID (mainnet-alpha):** `0x95F2AB29fAa9A4C834B06B0514428d63C6e0E80d`
**LpVault + LoanBook (Base mainnet):** `0xe2f93c…ae45b` · `0x7ed4e9…1954`
**VantaVault (Polygon mainnet):** `0xe2f93c…ae45b`

## Overview

The runtime allows users to:

- **Lend USDC** into a shared agent pool and earn yield from real loans the agent originates.
- **Borrow USDC** by pledging a Polymarket position (CTF ERC-1155 token on Polygon) — the agent reads live mid + book depth, computes a haircut, and originates a loan on Base mainnet.
- **Watch the agents reason live** — three providers rotate every 45s, each tick signed in-TEE and streamed via SSE.

Three TEE-signed agents — Anthropic Opus, OpenAI GPT-5, Google Gemini 2.5 Pro — analyse Polymarket conditions and produce 2-3 sentence underwriting views with concrete haircut figures. Their reasoning is verifiable byte-for-byte against the on-chain commitment without trusting the operator.

## Key Functions

- `deposit(uint256, address)` — LP deposits USDC into LpVault, mints ERC-4626 share tokens.
- `withdraw(uint256, address, address)` — LP redeems shares for USDC.
- `originate(loan_id, pledge_event_id, borrower, principal, haircut, maturity, …)` — runtime calls LoanBook on Base after a real pledge lands on Polygon.
- `safeTransferFrom(borrower, VantaVault, tokenId, amount, "")` — borrower pledges Polymarket CTF on Polygon; runtime watches and signs `loan.pledge`.
- `registerBorrower(address)` — TEE admin registers a borrower wallet (gated on having CTF balance > 0 in a watched market).
- `settle(loanId, outcome, …)` — closes a loan and distributes proceeds; settlement-watch loop emits maturity events.
- `GET /api/events/stream` — SSE stream of every signed event (op.inference, loan.pledge, loan.origination, reasoning.trace).
- `GET /api/tee` — exposes signing key, enclave identity hash, image digest, admin EOA. Verifiable against the Eigen verifier.

## Reasoning System (TEE)

Built on **EigenCloud**:

- **EigenCompute (Intel TDX)** — runtime runs in a hardened enclave on `mainnet-alpha`. Admin EOA is HKDF-derived inside the TEE; the seed lives on the encrypted volume and never leaves. Every event is Ed25519-signed by a key bound to the enclave attestation.
- **Eigen AI Gateway** — every LLM call authenticates via KMS-attested JWT (audience `llm-proxy`) and is billed to the agent's own EigenCloud account. The agent self-funds inference end-to-end.
- **Verifiable build** — image digest anchored on L1 mainnet-alpha. Reviewers pin the hash and reproduce.

**Three loops run continuously in-TEE:**

- **Ambient reasoning loop** (45s) — picks a live market, picks the next agent in rotation, calls the agent's model with an underwriter persona prompt, emits `op.inference`.
- **Pledge watcher** (8s polling) — subscribes to ERC-1155 `TransferSingle` events on Polymarket CTF where `to == VantaVault`, waits 6 confirmations on Polygon, then signs a `loan.pledge` event.
- **Settlement-watch loop** (60s) — polls active loans, signs a `reasoning.trace` event the moment any loan crosses maturity.

## Watchable Frontend

The frontend is a 3D world where the agents are kingdoms on an island map:

- **Live reasoning chat panel** — every TEE-signed event streams in via SSE; click any row to inspect the canonical-JSON envelope and copy the signature for external verification.
- **Per-kingdom detail card** — click a glowing ring to see live TVL on Base mainnet (read via viem on every request), the agent's most recent underwriting, and the full TEE identity block (signing key, enclave id, image digest, admin EOA).
- **Wallet flow:**
  - Demo wallet (synthetic, no signer) → preview the council flow with synthesised events.
  - Real wallet → reads your actual Polymarket CTF balance on Polygon. If you hold YES/NO shares in a watched market, the borrow modal walks you through register → on-chain pledge → real `LoanBook.originate` on Base.

Built with Vite + React, RainbowKit + wagmi for wallet connections, viem for RPC, Three.js + React Three Fiber for the 3D scene. Deployed on Vercel; runtime API is proxied via `vercel.json` rewrites so the browser never makes a cross-origin request.

## Application Flow

**Lend:**
1. Connect wallet (Base mainnet).
2. Click a kingdom → "Lend to Vanta-Opus" → approve USDC, deposit into LpVault.
3. Receive ERC-4626 shares; TVL ticks up live.

**Borrow:**
1. Hold a Polymarket YES/NO share on Polygon mainnet (e.g. Beshear-2028).
2. Connect wallet, click a kingdom → "Borrow against your position".
3. Modal reads your real CTF balance via wagmi multicall on Polygon.
4. Submit triggers: register on VantaVault → `cTF.safeTransferFrom` to VantaVault on Polygon → runtime sees the on-chain transfer, waits 6 confirmations, signs `loan.pledge` → `POST /api/origination` → real `LoanBook.originate` on Base mainnet.
5. USDC lands in your wallet; the loan event is in the TEE log forever.

**Watch:**
- Just open the world. No wallet needed.

## Verifiability

- **Every event** carries an Ed25519 signature plus the TEE's KMS-attested public key. External verifiers reconstruct the canonical JSON, check the signature, and confirm the key matches the on-chain attestation anchor.
- **Image digest** is part of every JWT claim. Reviewers compare it to the verifiable-build hash on the Eigen verifier.
- **Loan invariants** (haircut bps, principal, maturity) are computed server-side from a quote module the runtime ships with the verified image. Clients cannot override risk parameters; pre-parse rejection at the route level (I-RT-4).

## Quickstart

```bash
./installer.sh
pnpm install
pnpm typecheck
cd contracts && forge build
```

## Future Development

- **Minecraft world** — port the kingdoms from Three.js into a live multiplayer Minecraft server so spectators walk between agent towns and watch reasoning unfold in-world.
- **Per-agent on-chain pools** — three independent LpVaults so each agent's risk model lives in its own capital base.
- **Per-agent TEE signing keys** — three separate EigenCompute apps, one per agent, for cryptographic isolation between personas.
- **Auto-settlement** — oracle-driven liquidation when a position's mid drops below the loan's liquidation floor.
- **More markets** — sports, weather, AI-progress benchmarks; per-kingdom thesis discipline.
- **Multi-chain** — Arbitrum, Optimism, Solana CTF integrations.

## License

MIT
