#!/usr/bin/env bash
# Bring up two anvil forks for the local demo: Base Sepolia (8545) and
# Polygon Amoy (8546). Pinned to the upstream RPCs' current head.
#
# Idempotent: kills any prior anvils on those ports, then starts fresh.
# Writes pids to /tmp/vanta-anvil/{base,amoy}.pid so anvil-down.sh can
# tear them down.
set -euo pipefail

ANVIL_DIR=/tmp/vanta-anvil
mkdir -p "$ANVIL_DIR"

BASE_RPC="${BASE_RPC:-https://sepolia.base.org}"
BASE_RPC_FALLBACK="${BASE_RPC_FALLBACK:-https://base-sepolia-rpc.publicnode.com/}"
AMOY_RPC="${AMOY_RPC:-https://polygon-amoy-bor-rpc.publicnode.com}"

kill_port() {
  local port="$1"
  local pid
  pid=$(lsof -tiTCP:"$port" -sTCP:LISTEN || true)
  if [[ -n "$pid" ]]; then
    echo "killing pre-existing process on :$port (pid $pid)"
    kill -9 "$pid" || true
    sleep 1
  fi
}

probe_block() {
  local rpc="$1"
  cast block-number --rpc-url "$rpc" 2>/dev/null
}

start_anvil() {
  local label="$1" port="$2" chain_id="$3" rpc="$4" block="$5"
  echo "starting anvil[$label] :$port chain=$chain_id rpc=$rpc block=$block"
  nohup anvil \
    --fork-url "$rpc" \
    --fork-block-number "$block" \
    --port "$port" \
    --chain-id "$chain_id" \
    --block-time 2 \
    > "$ANVIL_DIR/$label.log" 2>&1 &
  echo $! > "$ANVIL_DIR/$label.pid"
}

kill_port 8545
kill_port 8546

BASE_BLOCK=$(probe_block "$BASE_RPC" || probe_block "$BASE_RPC_FALLBACK")
if [[ -z "${BASE_BLOCK:-}" ]]; then
  echo "FATAL: cannot reach any Base Sepolia public RPC"
  exit 1
fi
AMOY_BLOCK=$(probe_block "$AMOY_RPC")
if [[ -z "${AMOY_BLOCK:-}" ]]; then
  echo "FATAL: cannot reach Amoy public RPC"
  exit 1
fi

start_anvil base 8545 84532 "$BASE_RPC" "$BASE_BLOCK"
start_anvil amoy 8546 80002 "$AMOY_RPC" "$AMOY_BLOCK"

# Wait for both anvils to accept connections.
for port in 8545 8546; do
  for i in {1..30}; do
    if cast block-number --rpc-url "http://127.0.0.1:$port" >/dev/null 2>&1; then
      echo ":$port up"
      break
    fi
    sleep 1
  done
done

echo "anvil base pid=$(cat "$ANVIL_DIR/base.pid")"
echo "anvil amoy pid=$(cat "$ANVIL_DIR/amoy.pid")"
