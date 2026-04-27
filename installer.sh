#!/usr/bin/env bash
# VANTA local-first installer.
#
# Pins the toolchain (node, pnpm, foundry) to versions.json. Idempotent:
# if everything is already at the right version, exits cleanly with the
# "Ready" message.
#
# v2: dropped Java/Gradle/Paper (Minecraft watchable layer is out of
# scope per Phase 10 deferral). The signed event log + verify CLI is the
# audit interface.
#
# WSL-only on Windows; Bun-style `uname -ms` detect, exit 1 with WSL
# link on plain MINGW/MSYS/CYGWIN.
set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

platform=$(uname -ms)
case "$platform" in
  'Darwin arm64')   target="darwin-aarch64" ;;
  'Darwin x86_64')  target="darwin-x64" ;;
  'Linux aarch64')  target="linux-aarch64" ;;
  'Linux x86_64')   target="linux-x64" ;;
  MINGW*|MSYS*|CYGWIN*)
    echo "VANTA requires WSL2 on Windows. https://learn.microsoft.com/wsl"
    exit 1 ;;
  *)
    echo "Unsupported platform: $platform"
    exit 1 ;;
esac
echo "VANTA installer  target=$target"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq not found. Install: 'brew install jq' or your distro's package manager."
  exit 1
fi

NODE_VERSION=$(jq -r .node "$REPO/versions.json")
PNPM_VERSION=$(jq -r .pnpm "$REPO/versions.json")
FOUNDRY_VERSION=$(jq -r .foundry "$REPO/versions.json")
echo "  pinned: node=$NODE_VERSION pnpm=$PNPM_VERSION foundry=$FOUNDRY_VERSION"

# Docker (required, never installed by us).
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker not found. Install: https://docs.docker.com/get-docker/"
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 not found. Install Docker Desktop or 'docker compose' plugin."
  exit 1
fi
echo "  docker: $(docker --version | head -1)"

# Node — install via tj/n if missing or strictly older than the pin.
node_ok=0
if command -v node >/dev/null 2>&1; then
  current_node=$(node --version | sed 's/v//')
  cur_major=$(echo "$current_node" | cut -d. -f1)
  want_major=$(echo "$NODE_VERSION" | cut -d. -f1)
  if [[ "$current_node" == "$NODE_VERSION" ]]; then
    node_ok=1
  elif [[ "$cur_major" -ge "$want_major" ]]; then
    node_ok=1
    echo "  node: $current_node (newer than pinned $NODE_VERSION; tolerated)"
  fi
fi
if [[ "$node_ok" -ne 1 ]]; then
  echo "  installing node $NODE_VERSION via tj/n …"
  if ! command -v n >/dev/null 2>&1; then
    curl -fsSL https://raw.githubusercontent.com/tj/n/master/bin/n -o /tmp/n
    chmod +x /tmp/n
    mkdir -p "$HOME/.local/n" "$HOME/.local/bin"
    N_PREFIX="$HOME/.local/n" PATH="$HOME/.local/bin:$PATH" /tmp/n "$NODE_VERSION"
    echo "  add to your shell rc: export PATH=\"\$HOME/.local/bin:\$PATH\""
  else
    n "$NODE_VERSION"
  fi
fi
echo "  node: $(node --version)"

# pnpm via Corepack.
if ! command -v corepack >/dev/null 2>&1; then
  echo "corepack missing — your node install is too old (need ≥ 16.10)."
  exit 1
fi
corepack enable >/dev/null 2>&1 || true
corepack prepare "pnpm@$PNPM_VERSION" --activate >/dev/null 2>&1 || true
echo "  pnpm: $(pnpm --version)"

# Foundry.
if ! command -v foundryup >/dev/null 2>&1; then
  echo "  installing foundryup …"
  curl -L https://foundry.paradigm.xyz | bash
  export PATH="$HOME/.foundry/bin:$PATH"
fi
if command -v forge >/dev/null 2>&1; then
  echo "  forge present: $(forge --version | head -1)"
else
  foundryup -i "$FOUNDRY_VERSION"
fi

# Dev seed — same wiring as v1 (HKDF input for the origination EOA).
SEED_DIR="$REPO/.vanta"
SEED_PATH="$SEED_DIR/dev-seed"
if [[ ! -f "$SEED_PATH" ]]; then
  mkdir -p "$SEED_DIR"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -out "$SEED_PATH" 32
  else
    head -c 32 /dev/urandom > "$SEED_PATH"
  fi
  chmod 600 "$SEED_PATH"
  echo "  wrote $SEED_PATH (32 random bytes; gitignored)"
else
  echo "  seed: $SEED_PATH (cached)"
fi

cd "$REPO"
echo "  pnpm install --frozen-lockfile …"
pnpm install --frozen-lockfile

echo ""
echo "Ready. Next steps:"
echo "  cp .env.example .env    # edit if you have your own RPC URLs"
echo "  pnpm --filter @vanta/runtime smoke           # 3-loop signed-event sanity"
echo "  pnpm --filter @vanta/runtime smoke:onboarding"
