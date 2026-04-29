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

| Chain        | Chain id | Contract      | Address |
| ------------ | -------- | ------------- | ------- |
| base-sepolia | 84532    | LpVault       | _(unset)_ |
| base-sepolia | 84532    | LoanBook      | _(unset)_ |
| amoy         | 80002    | VantaVault    | _(unset)_ |

Live state is mirrored in `deployments/<chain>.json`.

## Deploy

Required env vars:

- `BASE_SEPOLIA_RPC_URL` — Base Sepolia JSON-RPC endpoint.
- `AMOY_RPC_URL` — Polygon Amoy JSON-RPC endpoint.
- `ETHERSCAN_API_KEY` — multi-chain key (Etherscan v2).
- `DEPLOYER_PRIVATE_KEY` — funded EOA for the target chain.

The admin address is derived from `.vanta/dev-seed` (HKDF, info
`"vanta-origination-eoa"`); see `script/01_LpVault.s.sol` and the
deployment scripts.

```
# 1. LpVault on Base Sepolia
forge script script/01_LpVault.s.sol \
  --rpc-url base_sepolia --broadcast --private-key $DEPLOYER_PRIVATE_KEY

# 2. LoanBook on Base Sepolia
forge script script/02_LoanBook.s.sol \
  --rpc-url base_sepolia --broadcast --private-key $DEPLOYER_PRIVATE_KEY

# 3. Wire LoanBook into LpVault (idempotent)
forge script script/03_WireLoanBook.s.sol \
  --rpc-url base_sepolia --broadcast --private-key $DEPLOYER_PRIVATE_KEY

# 4. VantaVault on Amoy
forge script script/04_VantaVault.s.sol \
  --rpc-url amoy --broadcast --private-key $DEPLOYER_PRIVATE_KEY
```

## Layout

- `src/`     — production contracts.
- `src/interfaces/` — minimal interfaces shared across contracts.
- `script/`  — `forge script` deploy scripts.
- `test/`    — forge unit tests + inline mocks.
- `lib/`     — external dependencies (gitignored).
- `deployments/` — per-chain deployed-address JSON (only `*.json` tracked).
