#!/usr/bin/env bash
# Stop the two anvils started by anvil-up.sh. Idempotent.
set -euo pipefail

ANVIL_DIR=/tmp/vanta-anvil
for label in base amoy; do
  if [[ -f "$ANVIL_DIR/$label.pid" ]]; then
    pid=$(cat "$ANVIL_DIR/$label.pid")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" || true
      echo "stopped anvil[$label] pid=$pid"
    fi
    rm -f "$ANVIL_DIR/$label.pid"
  fi
done
