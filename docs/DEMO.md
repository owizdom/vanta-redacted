# VANTA — 10-minute demo runbook

One command brings the entire local stack up:

```bash
pnpm demo
```

That single command:

1. starts two anvil forks — Base Sepolia on `:8545` and Polygon Amoy on `:8546`
2. deploys the v2 lender stack (LpVault + LoanBook + VantaVault + VendorPayment) and writes `.vanta/demo-pools.json` with realistic per-agent fixture pool state
3. mints **$5,000 test USDC** to the local demo wallet (anvil's first account, `0xf39Fd…2266`) by writing the FiatToken `_balances` slot directly via `anvil_setStorageAt`
4. wipes `.vanta/events.log` and writes ~130 signed historical events spanning the last 30 days (deposits, pledges, full origination chains with NPC council passes, credit ticks, settlements, withdraws)
5. boots the runtime on `:8787` with `VANTA_DEMO_ADMIN=1` so the demo runner can append events
6. boots the game frontend on `:3031`
7. starts the demo runner — emits one fresh origination chain per minute and credit ticks every 30s, all signed and posted through the runtime so SSE listeners broadcast to the chat panel

Press **CTRL+C** to stop everything cleanly.

Open: <http://localhost:3031>

---

## The 10-minute beats

| time | beat | what to say |
|---|---|---|
| 0:00 – 0:30 | hit ▶ play. world renders. three kingdoms, one VANTA per kingdom | "three lenders. each one underwrites loans against Polymarket positions. each one has its own kingdom — a different cognitive thesis: macro, sports, politics" |
| 0:30 – 2:00 | click the **purple ring** floating over vanta-opus | TVL $312k. interest YTD $14.8k. 5 active loans. the ring pulses faster + brighter as activity comes in. |
| 2:00 – 3:30 | open the chat panel. scroll to a recent council pass. expand a `npc.thought` entry — read Brother Tomás verbatim. expand the `council.synthesised` after | "this is the agent's actual deliberation. these aren't UI bubbles. they're TEE-signed events. click the badge — that's the signed envelope, byte-for-byte verifiable." |
| 3:30 – 5:30 | open the wallet picker → choose **Demo account** under the "Demo" group → connected. lend **$500 USDC** into vanta-opus. watch share token mint | "no MetaMask popup, no network switch, no key import. one click — connected with a pre-funded wallet on local anvil." |
| 5:30 – 7:30 | click "borrow against your position". walk through the modal — point at the seeded loan that just landed in the chat panel from the runner | "every minute, the runner emits a fresh origination chain. that one — pledge → 2 NPCs reason → council synthesises → trace → origination — all parented, all signed, all walkable." |
| 7:30 – 8:30 | marketplace route. three cards. sort by interest YTD. click "Back this VANTA" → routes to /world?agent=N | |
| 8:30 – 10:00 | pick any `loan.origination` event id. `curl http://localhost:8787/api/events/<id>/chain` — show the chain walking back to genesis through every NPC thought + inference call | "that's verifiable AI. every loan is a tree of signed events you can replay byte-for-byte." |

---

## Fallback recovery

### If the rings don't appear

The kingdom rings depend on `/api/agents` returning 3 agents. If `pnpm demo` is up, the runtime is on `:8787`; refresh the world page. If still empty:

```bash
curl http://localhost:8787/api/agents
```

If the runtime crashed, restart with `pnpm demo` from a fresh terminal.

### If the demo wallet has no USDC

The seed mints USDC by writing storage directly. If your fork was reset between seeding and demoing:

```bash
DEMO=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
USDC=0x036CbD53842c5426634e7929541eC2318f3dCF7e
SLOT=$(cast index address $DEMO 9)
HEX="0x$(printf '%064x' 5000000000)"
cast rpc anvil_setStorageAt $USDC $SLOT $HEX --rpc-url http://127.0.0.1:8545
```

### If the chat panel is empty on first load

The runtime indexed `events.log` on boot. If it boots before the seed writes, the index is empty. Fix:

```bash
rm .vanta/events.idx.json
pnpm tsx scripts/demo/seed-events.ts --reset
# restart the runtime
```

The runtime rebuilds its index from `events.log` whenever `events.idx.json` is absent.

### If the runner stalls (no fresh originations)

```bash
tail -f /tmp/runner.log    # if launched via `pnpm demo`, redirect via your shell
# or simply re-run
pkill -f "scripts/demo/demo-runner"
pnpm tsx scripts/demo/demo-runner.ts &
```

The runner is stateless — it polls `/api/events?type=loan.origination` for the active loan list and signs/POSTs new events with its own ephemeral keypair.

### If anvil dies mid-demo

The public RPC upstream (Base Sepolia / Polygon Amoy) occasionally throttles fork creation. Symptom: `cast block-number --rpc-url http://localhost:8545` hangs.

```bash
pnpm anvil:down && pnpm anvil:up
bash scripts/deploy-local.sh         # contracts must be redeployed against the new fork state
pnpm tsx scripts/demo/seed-onchain.ts
```

Kill `pnpm demo` first so the orchestrator doesn't fight you for ports.

### If MetaMask gets stuck (you're not using the demo wallet)

Always use the **Demo account** entry in the RainbowKit modal. It bypasses every MetaMask failure mode (network add, key import, gas estimation). The seed funds that exact address. If a presenter wants to use MetaMask anyway:

- network: Localhost 8545
- chain id: 84532 (Base Sepolia)
- RPC URL: `http://127.0.0.1:8545`

---

## What to never explain mid-demo

- The TEE attestation pipeline — show it, don't explain it
- The HKDF derivation — irrelevant to the verifiable-AI story
- The internals of `buildAndSign` — point at the signed envelope and move on
- Why we picked Polymarket vs Manifold — orthogonal

## What to lean into

- **Three kingdoms, three theses** — the kingdom metaphor is load-bearing
- **TEE-signed audit chain** — every loan is a tree of signed events
- **One click to a real deposit** — the demo account is the unfair advantage
- **The chat panel is the agent's actual reasoning** — not a transcript, not a UI
