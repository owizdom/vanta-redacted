# VANTA Contracts

Solidity side of VANTA. Foundry project. External deps:

- OpenZeppelin Contracts `v5.6.0`
- forge-std `v1.9.4`

Both are installed into `lib/` (gitignored); only `.gitmodules`-style
metadata is committed.

## Prereqs

```
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

## Install

```
cd contracts
forge install OpenZeppelin/openzeppelin-contracts@v5.6.0 --no-commit
forge install foundry-rs/forge-std@v1.9.4 --no-commit
```

## Build / test

```
forge build
forge test -vvv
```

## Deployed addresses

| Chain        | Chain id | Contract   | Address                                      |
| ------------ | -------- | ---------- | -------------------------------------------- |
| base         | 8453     | LpVault    | `0xe2f93c448d9fc51155e2e06479b3b1e86f8ae45b` |
| base         | 8453     | LoanBook   | `0x7ED4E98D460BBd7e43854cd93fD96d8E11b71954` |
| polygon      | 137      | VantaVault | `0xe2f93c448d9fc51155e2e06479b3b1e86f8ae45b` |

Live state is mirrored in `deployments/mainnet-<chain>.json`. Sepolia/Amoy
testnet RPCs in `foundry.toml` are kept for CI / local-anvil only.

## Deploy

Required env vars:

- `BASE_RPC_URL` — Base mainnet JSON-RPC endpoint (or `BASE_SEPOLIA_RPC_URL` for testnet CI).
- `POLYGON_RPC_URL` — Polygon mainnet JSON-RPC endpoint (or `AMOY_RPC_URL` for testnet CI).
- `ETHERSCAN_API_KEY` — multi-chain key (Etherscan v2).
- `DEPLOYER_PRIVATE_KEY` — funded EOA for the target chain.

The admin address is derived from `.vanta/dev-seed` (HKDF, info
`"vanta-origination-eoa"`); see `script/01_LpVault.s.sol` and the
deployment scripts.

```
# 1. LpVault on Base mainnet
forge script script/01_LpVault.s.sol \
  --rpc-url base --broadcast --private-key $DEPLOYER_PRIVATE_KEY

# 2. LoanBook on Base mainnet
forge script script/02_LoanBook.s.sol \
  --rpc-url base --broadcast --private-key $DEPLOYER_PRIVATE_KEY

# 3. Wire LoanBook into LpVault (idempotent)
forge script script/03_WireLoanBook.s.sol \
  --rpc-url base --broadcast --private-key $DEPLOYER_PRIVATE_KEY

# 4. VantaVault on Polygon mainnet
forge script script/04_VantaVault.s.sol \
  --rpc-url polygon --broadcast --private-key $DEPLOYER_PRIVATE_KEY
```

## Layout

- `src/`     — production contracts.
- `src/interfaces/` — minimal interfaces shared across contracts.
- `script/`  — `forge script` deploy scripts.
- `test/`    — forge unit tests + inline mocks.
- `lib/`     — external dependencies (gitignored).
- `deployments/` — per-chain deployed-address JSON (only `*.json` tracked).
