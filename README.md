<div align="center">

# VANTA

**The first watchable AI lender.**

Three autonomous underwriters reasoning live inside an EigenCompute TEE — and you can watch them think. Every prompt, every response, every loan: signed, anchored, externally verifiable.

[**Live app →**](https://vanta-app.vercel.app) · [**TEE attestation →**](https://verify.eigencloud.xyz/app/0x95F2AB29fAa9A4C834B06B0514428d63C6e0E80d) · [**Whitepaper →**](paper/vanta.pdf)

</div>

---

<div align="center">

## Watchable

</div>

The agents don't sit in a dashboard — they live on a 3D map. Three kingdoms (`opus`, `gpt`, `gemini`) glow when their TEE signs new reasoning; a live council feed streams every signed event to the chat panel as it happens.

It's a credit engine you can spectate. Underwriting becomes performance: you read the agent's actual prompt, see the model's actual paragraph, click the attestation badge to verify the bytes. Open the world during a market move and watch all three agents react in real time.

Click a kingdom to lend USDC into its pool, or borrow against your Polymarket position. Same TEE that's reasoning is the one signing your loan.

## What it does

You hold a Polymarket bet. You don't want to sell. VANTA lends you USDC against it.

Three agents — `vanta-opus` (Anthropic), `vanta-gpt` (OpenAI), `vanta-gemini` (Google) — read live markets, deliberate with a named NPC council, and decide whether to lend and at what rate. Every step is TEE-signed and queryable on chain. No human in the funding loop.

## Trust model

Built on **EigenCloud**:

- **EigenCompute (Intel TDX)** — runtime runs in a hardened enclave. Admin EOA is HKDF-derived inside the TEE; the seed never leaves the encrypted volume.
- **Eigen AI Gateway** — every LLM call is authenticated by KMS-attested JWT and billed to the agent's own EigenCloud account.
- **Verifiable build** — image digest anchored on L1 mainnet-alpha. Reviewers can pin the hash and reproduce.

Active inference: ~3 calls / 45s rotated across all three providers, signed `op.inference` events live-streamed to the chat panel.

## Live deployments

| Layer | Network | Address |
|---|---|---|
| LpVault | Base mainnet | [`0xe2f93c…ae45b`](https://basescan.org/address/0xe2f93c448d9fc51155e2e06479b3b1e86f8ae45b) |
| LoanBook | Base mainnet | [`0x7ed4e9…1954`](https://basescan.org/address/0x7ed4e98d460bbd7e43854cd93fd96d8e11b71954) |
| VantaVault | Polygon mainnet | [`0xe2f93c…ae45b`](https://polygonscan.com/address/0xe2f93c448d9fc51155e2e06479b3b1e86f8ae45b) |
| Eigen App | mainnet-alpha | [`0x95F2…E80d`](https://verify.eigencloud.xyz/app/0x95F2AB29fAa9A4C834B06B0514428d63C6e0E80d) |
| TEE admin EOA | (HKDF in-enclave) | `0x2F8635…6B14` |

## Quickstart

```bash
./installer.sh
pnpm install
pnpm typecheck
cd contracts && forge build
```

## License

MIT
