# VANTA

Autonomous risk engine for prediction-market credit. Where Gondor's curator sits.

The whitepaper is at [`paper/vanta.pdf`](paper/vanta.pdf) (source: [`paper/vanta.tex`](paper/vanta.tex)).

## Stack

- pnpm workspace (Node 20.11.0, pnpm 9.12.0) — 11 TS packages + a `scripts` workspace
- Foundry v1.0.0 — `contracts/`
- EigenCompute Intel TDX — `ecloud.toml`
- Mineflayer + prismarine-viewer — `npcs/`, `viewer/` (Phase 10)
- Gradle/Kotlin Paper plugin — `bridge-plugin/` (Phase 10)

## Phases

| Phase | Scope |
|---|---|
| 0 | Scaffold (current) |
| 1 | `tee` + `events` — HKDF identity, signed event log |
| 2 | Foundry contracts — `LpVault`, `LoanBook`, `VantaVault`, `AnchorRegistry`, `OnboardingRegistry` |
| 3 | `haircut`, `treasury`, `constitution` |
| 4 | `venue-poly`, `mark` — Polymarket CLOB + UMA reads |
| 5 | `pledge`, `origination` — two-signature post-image flow |
| 6 | `verify` — third-party CLI verifier |
| 7 | `runtime` — fastify HTTP server, three loops |
| 8 | Onboarding gates + safety floor (paper §5) |
| 9 | Attestation-liveness exit (Invariant 5) |
| 10 | Watchable layer (`viewer`, `npcs`, `bridge-plugin`) |
| 11 | Image audit + mainnet |

## Quickstart

```bash
./installer.sh
pnpm install
pnpm typecheck
cd contracts && forge build
```
