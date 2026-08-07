#!/usr/bin/env bash
set -euo pipefail

run_inner() {
  local base_url="$1"

  ab() { agent-browser --session skip2-expired "$@"; }
  body() { ab get text body 2>/dev/null || true; }

  fail() {
    echo "  FAIL: $1"
    echo "$(body)"
    exit 1
  }

  wait_text() {
    ab wait --text "$1" --timeout "${2:-90000}" >/dev/null 2>&1
  }

  click_button() {
    local snapshot button_ref
    snapshot="$(ab snapshot -i 2>/dev/null || true)"
    button_ref="$(echo "$snapshot" | grep -F "button \"$1\"" | grep -o 'e[0-9][0-9]*' | tail -1)"
    [[ -n "$button_ref" ]] || return 1
    ab click "@$button_ref" >/dev/null
  }

  latest_ledger() {
    curl -fsS https://soroban-testnet.stellar.org \
      -H 'Content-Type: application/json' \
      --data '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' |
      node -e 'const fs = require("node:fs"); const r = JSON.parse(fs.readFileSync(0, "utf8")); process.stdout.write(String(r.result.sequence));'
  }

  echo "=== Real testnet wallet ==="
  click_button "Create Smart Wallet" || fail "Create Smart Wallet button not found"
  wait_text "Wallet created!" 180000 || fail "wallet creation did not reach 'Wallet created!'"
  local wallet_id
  wallet_id="$(body | grep -Eo 'C[A-Z2-7]{55}' | head -1)"
  [[ "$wallet_id" =~ ^C[A-Z2-7]{55}$ ]] || fail "wallet contract ID missing"
  echo "  PASS: Wallet created! -> $wallet_id"

  click_button "Fund with Friendbot" || fail "Fund with Friendbot button not found"
  wait_text "Funded!" 180000 || fail "funding did not reach 'Funded!'"
  wait_text "9995.00 XLM" 60000 || fail "funded balance was not 9995.00 XLM"
  echo "  PASS: Funded! -> 9995.00 XLM"

  echo "=== Future expiration becomes expired ==="
  ab open "$base_url/rules" >/dev/null
  wait_text "Default" 90000 || fail "default rule #0 did not load"
  body | grep -Fxq '#0' || fail "default rule #0 was not rendered"

  ab click h3 >/dev/null
  ab find role button click --name "Expiration" >/dev/null

  local current future future_display
  current="$(latest_ledger)"
  [[ "$current" =~ ^[0-9]+$ ]] || fail "testnet RPC returned an invalid ledger sequence"
  future=$((current + 8))
  future_display="$(node -e 'process.stdout.write(Number(process.argv[1]).toLocaleString("en-US"))' "$future")"
  ab fill 'input[type=number]' "$future" >/dev/null
  ab press Enter >/dev/null

  wait_text "L$future_display" 180000 || fail "future expiration L$future_display was not confirmed and rendered"
  grep -q '"event":"WebAuthn.credentialAsserted"' "$WEBAUTHN_EVENTS_FILE" || fail "expiration update produced no WebAuthn assertion"
  echo "  PASS: future expiration accepted and confirmed -> L$future_display"

  local observed deadline
  deadline=$((SECONDS + 180))
  observed="$(latest_ledger)"
  while ((observed < future && SECONDS < deadline)); do
    sleep 2
    observed="$(latest_ledger)"
  done
  ((observed >= future)) || fail "testnet did not reach expiration ledger $future (last: $observed)"
  echo "  PASS: testnet passed expiration -> L$observed"

  ab reload >/dev/null
  wait_text "Expired" 90000 || fail "exact Expired badge did not appear after reload"

  local badge_count red_card_count current_display exact_detail expanded_body
  badge_count="$(ab eval '[...document.querySelectorAll("*")].filter((e) => e.children.length === 0 && e.textContent.trim() === "Expired").length')"
  [[ "$badge_count" == "1" ]] || fail "expected exactly one Expired badge, got $badge_count"
  red_card_count="$(ab eval '[...document.querySelectorAll("div")].filter((e) => typeof e.className === "string" && e.className.includes("bg-red-950/20") && e.className.includes("border-red-800/40")).length')"
  [[ "$red_card_count" == "1" ]] || fail "expected exactly one red expired card, got $red_card_count"

  current_display="$(body | sed -n 's/^Current ledger: //p' | tail -1)"
  [[ -n "$current_display" ]] || fail "current ledger was missing after expiration reload"
  exact_detail="Expired (current: L$current_display)"
  ab click h3 >/dev/null
  wait_text "$exact_detail" 30000 || fail "missing exact expanded text '$exact_detail'"
  expanded_body="$(body)"
  echo "$expanded_body" | grep -Fq "Ledger $future_display" || fail "expanded rule omitted expiration ledger $future_display"
  echo "$expanded_body" | grep -Fq "$exact_detail" || fail "expanded rule omitted exact expired detail '$exact_detail'"

  echo "  PASS: badge = Expired"
  echo "  PASS: state = red expired card"
  echo "  PASS: detail = $exact_detail"
  echo "EXPIRED RENDERING: PASS"
}

if [[ "${1:-}" == "--inner" ]]; then
  run_inner "${2:?base URL required}"
  exit
fi

BASE_URL="http://localhost:4173"
ARTIFACT_DIR="$(mktemp -d)"
export SESSION="skip2-expired"
export AGENT_BROWSER_IDLE_TIMEOUT_MS=600000
export WEBAUTHN_EVENTS_FILE="$ARTIFACT_DIR/webauthn.jsonl"

cleanup() {
  agent-browser --session skip2-expired close 2>/dev/null || true
  rm -f "$WEBAUTHN_EVENTS_FILE"
  rmdir "$ARTIFACT_DIR" 2>/dev/null || true
}
trap cleanup EXIT

agent-browser --session skip2-expired close 2>/dev/null || true
agent-browser --session skip2-expired open "$BASE_URL/" >/dev/null
# Clearing is required so this fixed session always creates its own wallet.
agent-browser --session skip2-expired wait --url "$BASE_URL/**" --timeout 30000 >/dev/null
agent-browser --session skip2-expired wait --load domcontentloaded --timeout 30000 >/dev/null
agent-browser --session skip2-expired wait --fn "location.origin === '$BASE_URL'" --timeout 30000 >/dev/null
agent-browser --session skip2-expired eval 'localStorage.clear()' >/dev/null
agent-browser --session skip2-expired reload >/dev/null

if ! agent-browser --session skip2-expired wait --fn 'typeof window.$_TSR === "undefined"' --timeout 30000 >/dev/null 2>&1; then
  entry_url="$(agent-browser --session skip2-expired get attr 'script[type="module"]' src 2>/dev/null || true)"
  [[ "$entry_url" == /* ]] && entry_url="$BASE_URL$entry_url"
  entry_status="$(curl -sS -o /dev/null -w '%{http_code}' "$entry_url" 2>/dev/null || true)"
  echo "STALE PREVIEW STOP: app did not hydrate; entry module $entry_url returned HTTP $entry_status"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
node "$SCRIPT_DIR/agent-browser-webauthn-helper.mjs" run \
  --session skip2-expired --require-credential true --timeout-ms 600000 -- \
  bash "$SCRIPT_DIR/e2e-expired.sh" --inner "$BASE_URL"

grep -q '"event":"WebAuthn.credentialAdded"' "$WEBAUTHN_EVENTS_FILE"
grep -q '"event":"WebAuthn.credentialAsserted"' "$WEBAUTHN_EVENTS_FILE"
echo "WebAuthn events: credentialAdded + credentialAsserted"
