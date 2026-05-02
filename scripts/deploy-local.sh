#!/usr/bin/env bash
# Run the four numbered Foundry deploy scripts against the running
# local anvils. Writes deployments/local-{base-sepolia,amoy}.json.
#
# Requires anvil-up.sh to have been run first.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT/contracts"

# Anvil's first prefunded EOA — funds gas + acts as deploy broadcaster
# for scripts that don't require admin authority.
DEPLOYER_KEY="${DEPLOYER_PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"

# Origination admin key. Derived from `.vanta/dev-seed` via the same
# HKDF-SHA256 derivation the runtime uses (`@vanta/tee.deriveOriginationEOA`)
# so the deploy-time owner of LpVault + LoanBook agrees with the
# runtime's I-RT-2 boot check. Production callers override via
# ADMIN_PRIVATE_KEY env var.
SEED_PATH="$REPO_ROOT/.vanta/dev-seed"
if [[ -z "${ADMIN_PRIVATE_KEY:-}" ]]; then
  if [[ ! -f "$SEED_PATH" ]]; then
    echo "FATAL: $SEED_PATH missing. Run 'bash installer.sh' first or set ADMIN_PRIVATE_KEY."
    exit 1
  fi
  ADMIN_KEY=$(node "$REPO_ROOT/scripts/derive-admin-key.mjs" "$SEED_PATH")
  if [[ -z "$ADMIN_KEY" ]]; then
    echo "FATAL: derive-admin-key.mjs produced no output"
    exit 1
  fi
else
  ADMIN_KEY="$ADMIN_PRIVATE_KEY"
fi

export BASE_SEPOLIA_RPC_URL="${BASE_SEPOLIA_RPC_URL:-http://127.0.0.1:8545}"
export AMOY_RPC_URL="${AMOY_RPC_URL:-http://127.0.0.1:8546}"

# Fund the admin EOA on both chains so script 03 has gas.
DERIVED_ADMIN=$(cast wallet address --private-key "$ADMIN_KEY")
echo "funding admin $DERIVED_ADMIN on Base Sepolia"
cast send "$DERIVED_ADMIN" --value 1ether \
  --private-key "$DEPLOYER_KEY" \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" >/dev/null

run_script() {
  local script="$1" rpc_alias="$2" key="$3" log="$4"
  echo "==> $script  ($rpc_alias)"
  DEPLOYER_PRIVATE_KEY="$key" forge script "$script" \
    --rpc-url "$rpc_alias" --broadcast 2>&1 | tee "$log"
}

mkdir -p /tmp/vanta-anvil
run_script script/01_LpVault.s.sol     base_sepolia "$DEPLOYER_KEY" /tmp/vanta-anvil/01.log
run_script script/02_LoanBook.s.sol    base_sepolia "$DEPLOYER_KEY" /tmp/vanta-anvil/02.log
run_script script/03_WireLoanBook.s.sol base_sepolia "$ADMIN_KEY"   /tmp/vanta-anvil/03.log
run_script script/04_VantaVault.s.sol  amoy         "$DEPLOYER_KEY" /tmp/vanta-anvil/04.log

# Stamp expectedAdmin into the base-sepolia deployment JSON.
DEPLOY_JSON="$REPO_ROOT/contracts/deployments/local-base-sepolia.json"
TMP=$(mktemp)
jq --arg admin "$DERIVED_ADMIN" '. + {expectedAdmin: $admin, rpcUrl: "http://127.0.0.1:8545"}' \
  "$DEPLOY_JSON" > "$TMP" && mv "$TMP" "$DEPLOY_JSON"

AMOY_JSON="$REPO_ROOT/contracts/deployments/local-amoy.json"
TMP=$(mktemp)
jq --arg admin "$DERIVED_ADMIN" \
   '. + {expectedAdmin: $admin, rpcUrl: "http://127.0.0.1:8546", umaCtfAdapter: "0x2F6f8DA6A21023E62399801945eed1b1975A4e12", umaAdminShape: "single-EOA mapping (Polymarket Auth pattern: mapping(address=>bool) admins at slot 0; no owner(); not AccessControlEnumerable)."}' \
  "$AMOY_JSON" > "$TMP" && mv "$TMP" "$AMOY_JSON"

echo "==> deployments:"
cat "$DEPLOY_JSON"
echo
cat "$AMOY_JSON"
