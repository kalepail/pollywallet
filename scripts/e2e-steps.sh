#!/usr/bin/env bash
# Inner test steps — run inside the webauthn helper.
# Env vars: SESSION, URL, RECIPIENT

set -uo pipefail

S="$SESSION"
R="$RECIPIENT"

body() { agent-browser --session "$S" get text body 2>/dev/null || true; }
snap() { agent-browser --session "$S" snapshot -i 2>/dev/null; }

ref() {
  echo "$2" | grep "$1" | grep -o 'e[0-9]*' | tail -1
}

wait_ok() {
  local pattern="$1" timeout="${2:-90}"
  for i in $(seq 1 "$timeout"); do
    local b
    b="$(body)"
    if echo "$b" | grep -q "$pattern"; then return 0; fi
    if echo "$b" | grep -q "Error:"; then
      echo "  FAIL: $(echo "$b" | grep 'Error:' | head -1)"
      return 1
    fi
    sleep 2
  done
  echo "  TIMEOUT: $pattern"
  return 1
}

echo ""
echo "=== Step 1: Create Smart Wallet ==="
SNAP="$(snap)"
CREATE_REF="$(ref 'Create Smart Wallet' "$SNAP")"
if [ -z "$CREATE_REF" ]; then
  echo "  FAIL: Create button not found"
  echo "$SNAP"
  exit 1
fi
agent-browser --session "$S" click "@$CREATE_REF" >/dev/null
wait_ok "Wallet created" 90 || exit 1
echo "  OK"

echo ""
echo "=== Step 2: Fund with Friendbot ==="
SNAP="$(snap)"
FUND_REF="$(ref 'Fund with Friendbot' "$SNAP")"
agent-browser --session "$S" click "@$FUND_REF" >/dev/null
wait_ok "Funded" 90 || exit 1
sleep 2
agent-browser --session "$S" open "$URL" >/dev/null
sleep 3
echo "  OK: $(body | grep 'XLM' | head -1)"

echo ""
echo "=== Step 3: Transfer 10 XLM ==="
SNAP="$(snap)"
DEST_REF="$(ref 'Destination' "$SNAP")"
AMT_REF="$(ref 'Amount' "$SNAP")"
agent-browser --session "$S" fill "@$DEST_REF" "$R" >/dev/null
agent-browser --session "$S" fill "@$AMT_REF" "10" >/dev/null
sleep 1
SNAP="$(snap)"
SEND_REF="$(echo "$SNAP" | grep 'button "Send"' | grep -v disabled | grep -o 'e[0-9]*' | tail -1)"
agent-browser --session "$S" click "@$SEND_REF" >/dev/null
wait_ok "Transfer sent" 90 || exit 1
sleep 2
agent-browser --session "$S" open "$URL" >/dev/null
sleep 3
echo "  OK: $(body | grep 'XLM' | head -1)"

echo ""
echo "=== ALL TESTS PASSED ==="
