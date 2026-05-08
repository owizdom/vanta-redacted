#!/usr/bin/env bash
# heartbeat.sh — keeps the chat panel populated with REAL agent
# reasoning, grounded in REAL Polymarket markets.
#
# Per cycle:
#   1. Fetch /api/markets/watched (live mids refreshed by the runtime
#      every 30-60s from the Polymarket CLOB).
#   2. Pick a random market with a non-null mid.
#   3. Pick the next agent in rotation: opus(anthropic), gpt(openai),
#      gemini(google). All three kingdoms light up over time.
#   4. POST /api/dev/probe-inference with:
#        - system: agent's underwriter persona (no more "connectivity
#          probe" → no more one-word replies)
#        - prompt: real market context with current numbers
#        - provider: matches the agent
#        - max_tokens: 1024 (enough for reasoning-mode models GPT-5
#          + Gemini 2.5 Pro to emit visible output past their hidden
#          chain-of-thought)
#
# Each call emits a TEE-signed op.inference event the runtime
# broadcasts via SSE. The chat panel renders the agent's actual
# underwriting view in 2-3 sentences, attached to a clickable
# attestation envelope.
#
# Run from project root:
#   ADMIN_TOKEN=<token> bash scripts/heartbeat.sh
#
# Token defaults to runtime/.env.mainnet's VANTA_DEPLOY_ADMIN_TOKEN.
# Stop with Ctrl-C.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

RUNTIME_URL="${RUNTIME_URL:-http://35.232.60.83:8787}"
INTERVAL="${INTERVAL:-45}"
ADMIN_TOKEN="${ADMIN_TOKEN:-$(grep '^VANTA_DEPLOY_ADMIN_TOKEN=' "$REPO_ROOT/runtime/.env.mainnet" | cut -d= -f2)}"
MAX_TOKENS="${MAX_TOKENS:-4096}"

if [[ -z "${ADMIN_TOKEN:-}" ]]; then
  echo "ERROR: ADMIN_TOKEN unset and not found in runtime/.env.mainnet"
  exit 1
fi

# Agent → provider mapping. The frontend's stream.ts maps the inference
# provider back to a kingdom: anthropic → opus, openai → gpt, google →
# gemini. Rotating providers therefore rotates which kingdom is shown
# as the speaker in the chat panel.
AGENTS=("opus|anthropic" "gpt|openai" "gemini|google")
N_AGENTS=${#AGENTS[@]}

# Persona system prompts. Each agent has its own thesis: opus = macro
# / rates / geopolitics, gpt = sports / culture, gemini = politics.
# The persona keeps reasoning consistent across markets even when an
# agent comments on something outside its primary kingdom.
SYSTEM_OPUS="You are vanta-opus, an autonomous prediction-market underwriter focused on macro, rates, and geopolitics. You write 2-3 plain-English sentences citing the current mid, depth (volume), and time-to-resolution. Always end with a concrete underwriting view (lend / haircut / pass) and a haircut figure when you would lend. No fluff, no greetings."
SYSTEM_GPT="You are vanta-gpt, an autonomous prediction-market underwriter focused on sports and cultural markets. You write 2-3 plain-English sentences referencing current mid, book depth, and event timing. End with a concrete underwriting view (lend / haircut / pass), giving a haircut figure when you would lend. No fluff."
SYSTEM_GEMINI="You are vanta-gemini, an autonomous prediction-market underwriter focused on US political markets. You write 2-3 plain-English sentences citing current mid, base rates, and resolution clarity. Close with a concrete underwriting view (lend / haircut / pass) and a haircut figure when you would lend. No fluff."

system_for() {
  case "$1" in
    opus)   printf '%s' "$SYSTEM_OPUS" ;;
    gpt)    printf '%s' "$SYSTEM_GPT" ;;
    gemini) printf '%s' "$SYSTEM_GEMINI" ;;
  esac
}

echo "heartbeat: runtime=$RUNTIME_URL interval=${INTERVAL}s max_tokens=$MAX_TOKENS"
echo "Ctrl-C to stop."
echo

i=0
while true; do
  # Fetch live markets every cycle so prices are always fresh.
  markets_json=$(curl -fsS --max-time 10 "$RUNTIME_URL/api/markets/watched" 2>/dev/null || echo '{"markets":[]}')

  # Pick a random market with a usable mid + agent in rotation. The
  # python helper reads markets_json from MARKETS_JSON env var (we
  # can't pipe to stdin because the heredoc-script already owns it),
  # builds a real underwriting prompt with current numbers, and
  # prints "agent|provider|prompt" for the bash to consume.
  picked=$(MARKETS_JSON="$markets_json" CYCLE="$i" python3 <<'PY'
import json, os, random, datetime, re

cycle = int(os.environ.get("CYCLE", "0"))
agents = ["opus|anthropic", "gpt|openai", "gemini|google"]
agent, provider = agents[cycle % len(agents)].split("|")

data = json.loads(os.environ.get("MARKETS_JSON", "{}") or "{}")
markets = [m for m in data.get("markets", []) if not m.get("closed")]
if not markets:
    print("__skip__|" + agent + "|" + provider + "|no live markets")
    sys.exit(0)

# Prefer markets with at least one non-null mid for fresh numbers.
usable = []
for m in markets:
    yes_mid = m.get("mid", {}).get("yes")
    no_mid = m.get("mid", {}).get("no")
    try:
        if yes_mid is not None and 0 < float(yes_mid) < 1:
            usable.append(m)
            continue
        if no_mid is not None and 0 < float(no_mid) < 1:
            usable.append(m)
    except Exception:
        pass

if not usable:
    usable = markets
m = random.choice(usable)

q = (m.get("question") or m.get("short_name") or "untitled market").strip()
short = m.get("short_name") or q[:32]
yes_mid = m.get("mid", {}).get("yes")
no_mid = m.get("mid", {}).get("no")

vol = m.get("volume_usd")
vol_24h = m.get("volume_24h_usd")
liq = m.get("liquidity_usd")
end_iso = m.get("end_date_iso")
days_to_resolve = None
if isinstance(end_iso, str) and end_iso:
    try:
        end_dt = datetime.datetime.fromisoformat(end_iso.replace("Z", "+00:00"))
        delta = end_dt - datetime.datetime.now(datetime.timezone.utc)
        days_to_resolve = max(0, delta.days)
    except Exception:
        pass

bits = []
bits.append(f"Polymarket market: \"{q}\".")
mid_parts = []
if yes_mid is not None:
    try:
        mid_parts.append(f"YES at ${float(yes_mid):.3f}")
    except Exception:
        pass
if no_mid is not None:
    try:
        mid_parts.append(f"NO at ${float(no_mid):.3f}")
    except Exception:
        pass
if mid_parts:
    bits.append("Live: " + ", ".join(mid_parts) + ".")
if vol is not None:
    try:
        v = float(vol)
        bits.append(f"Total volume ${v/1_000_000:.1f}M.")
    except Exception:
        pass
if vol_24h is not None:
    try:
        v24 = float(vol_24h)
        bits.append(f"24h volume ${v24:,.0f}.")
    except Exception:
        pass
if liq is not None:
    try:
        L = float(liq)
        bits.append(f"Book liquidity ${L:,.0f}.")
    except Exception:
        pass
if days_to_resolve is not None:
    bits.append(f"~{days_to_resolve} days to resolution.")

bits.append("As an underwriter, would you lend USDC against a holder of the YES side, and at what haircut?")
prompt = " ".join(bits)
prompt = re.sub(r"\s+", " ", prompt).strip()

print(f"{agent}|{provider}|{prompt}")
PY
)

  IFS='|' read -r AGENT PROVIDER PROMPT <<<"$picked"
  ts=$(date +%H:%M:%S)

  if [[ "$AGENT" == "__skip__" ]]; then
    echo "[$ts] skip — $PROMPT"
    i=$((i + 1))
    sleep "$INTERVAL"
    continue
  fi

  SYSTEM=$(system_for "$AGENT")
  ENC_PROMPT=$(printf '%s' "$PROMPT" | python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.stdin.read()),end="")')
  ENC_SYSTEM=$(printf '%s' "$SYSTEM" | python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.stdin.read()),end="")')

  out=$(curl -fsS --max-time 60 \
    -H "x-admin-token: $ADMIN_TOKEN" \
    "$RUNTIME_URL/api/dev/probe-inference?provider=$PROVIDER&max_tokens=$MAX_TOKENS&system=$ENC_SYSTEM&prompt=$ENC_PROMPT" \
    2>&1 || echo '{"ok":false,"error":"request_failed"}')

  status=$(printf '%s' "$out" | python3 -c "
import sys,json
try:
    d=json.loads(sys.stdin.read())
    if d.get('ok'):
        text = (d.get('text') or '').replace(chr(10), ' ').strip()
        if not text:
            print('empty:' + (d.get('model') or '') + ':' + str(d.get('completion_tokens') or 0))
        else:
            print('ok:' + (d.get('model') or '') + ':' + text[:160])
    else:
        print('err:' + str(d.get('error') or 'unknown'))
except Exception as e:
    print('err:parse:' + str(e))
" 2>/dev/null || echo "err:python")

  short_q=$(printf '%s' "$PROMPT" | head -c 64)
  echo "[$ts] vanta-$AGENT ($PROVIDER) ← ${short_q}…"
  echo "         → $status"
  echo

  i=$((i + 1))
  sleep "$INTERVAL"
done
