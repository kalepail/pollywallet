#!/usr/bin/env bash
# Inner wallet lifecycle steps — run inside the WebAuthn helper.

set -uo pipefail

S="$SESSION"
R="$RECIPIENT"
FAILURES=0

ab() { agent-browser --session "$S" "$@"; }
body() { ab get text body 2>/dev/null || true; }
snap() { ab snapshot -i 2>/dev/null; }

ref() {
  echo "$2" | grep -F "$1" | grep -o 'e[0-9][0-9]*' | tail -1
}

wait_text() {
  local expected="$1" deadline=$((SECONDS + ${2:-90})) b
  while (( SECONDS < deadline )); do
    b="$(body)"
    if echo "$b" | grep -Fq "$expected"; then return 0; fi
    sleep 1
  done
  return 1
}

wait_balance() {
  local expected="$1" deadline=$((SECONDS + ${2:-90}))
  while (( SECONDS < deadline )); do
    if [[ "$(balance)" == "$expected" ]]; then return 0; fi
    sleep 1
  done
  return 1
}

wait_control() {
  local directive="$1" deadline=$((SECONDS + 10))
  while (( SECONDS < deadline )); do
    if grep -Fq "\"controlApplied\":\"$directive\"" "$WEBAUTHN_EVENTS_FILE"; then return 0; fi
    sleep 1
  done
  return 1
}

balance() {
  body | sed -nE 's/^[[:space:]]*([0-9]+\.[0-9]{2}) XLM$/\1/p' | head -1
}

contract_id() {
  body | grep -Eo 'C[A-Z2-7]{55}' | head -1
}

assert_equal() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "  PASS: $label = $actual"
  else
    echo "  FAIL: $label expected '$expected', got '$actual'"
    FAILURES=$((FAILURES + 1))
  fi
}

critical() {
  echo "  FAIL: $1"
  exit 1
}

click_button() {
  local label="$1" snapshot button_ref
  snapshot="$(snap)"
  button_ref="$(ref "button \"$label\"" "$snapshot")"
  [[ -n "$button_ref" ]] || critical "$label button not found"
  ab click "@$button_ref" >/dev/null
}

fill_transfer() {
  local destination="$1" amount="$2" snapshot destination_ref amount_ref
  snapshot="$(snap)"
  destination_ref="$(ref 'Destination' "$snapshot")"
  [[ -n "$destination_ref" ]] || critical "destination input not found"
  ab fill "@$destination_ref" "$destination" >/dev/null
  snapshot="$(snap)"
  amount_ref="$(ref 'Amount' "$snapshot")"
  [[ -n "$amount_ref" ]] || critical "amount input not found"
  ab fill "@$amount_ref" "$amount" >/dev/null
}

subtract_xlm() {
  node -e 'console.log((Number(process.argv[1]) - Number(process.argv[2])).toFixed(2))' "$1" "$2"
}

echo ""
echo "=== 1. Create Smart Wallet ==="
click_button "Create Smart Wallet"
wait_text "Wallet created!" 180 || critical "expected 'Wallet created!', got '$(body | tail -1)'"
WALLET_ID="$(contract_id)"
[[ "$WALLET_ID" =~ ^C[A-Z2-7]{55}$ ]] || critical "wallet contract ID missing: '$WALLET_ID'"
wait_balance "0.00" 60 || critical "initial balance expected 0.00 XLM, got '$(balance)'"
echo "  PASS: status = Wallet created!"
echo "  PASS: contract = $WALLET_ID"
echo "  PASS: balance = 0.00 XLM"

echo ""
echo "=== 2. Fund with Friendbot and refresh balance ==="
click_button "Fund with Friendbot"
wait_text "Funded!" 180 || critical "expected 'Funded!', got '$(body | tail -1)'"
wait_balance "9995.00" 90 || critical "funded balance expected 9995.00 XLM, got '$(balance)'"
wait_text "View transaction" 10 || critical "successful funding did not expose a transaction link"
echo "  PASS: status = Funded!"
echo "  PASS: balance = 9995.00 XLM"
echo "  PASS: transaction link = View transaction"

echo ""
echo "=== 3. Restore wallet from storage in fresh React state ==="
ab reload >/dev/null
wait_text "Disconnect" 30 || critical "wallet view did not restore after reload"
wait_balance "9995.00" 60 || critical "refreshed balance expected 9995.00 XLM, got '$(balance)'"
assert_equal "restored contract" "$WALLET_ID" "$(contract_id)"
assert_equal "refreshed balance" "9995.00" "$(balance)"

echo ""
echo "=== 4. Reject malformed destination ==="
ASSERTIONS_BEFORE="$(grep -c 'WebAuthn.credentialAsserted' "$WEBAUTHN_EVENTS_FILE" || true)"
fill_transfer "not-a-stellar-address" "1"
click_button "Send"
wait_text "Invalid destination address" 15 || {
  echo "  FAIL: expected 'Invalid destination address'"
  FAILURES=$((FAILURES + 1))
}
echo "  RESULT: $(body | grep -F 'Invalid destination address' | head -1)"
assert_equal "balance after malformed destination" "9995.00" "$(balance)"
assert_equal "passkey assertions after malformed destination" "$ASSERTIONS_BEFORE" "$(grep -c 'WebAuthn.credentialAsserted' "$WEBAUTHN_EVENTS_FILE" || true)"

echo ""
echo "=== 5. Reject insufficient funds ==="
ASSERTIONS_BEFORE="$(grep -c 'WebAuthn.credentialAsserted' "$WEBAUTHN_EVENTS_FILE" || true)"
fill_transfer "$R" "9996"
click_button "Send"
wait_text "Insufficient balance: you have 9995.00 XLM" 15 || {
  echo "  FAIL: expected 'Insufficient balance: you have 9995.00 XLM'"
  FAILURES=$((FAILURES + 1))
}
echo "  RESULT: $(body | grep -F 'Insufficient balance:' | head -1)"
assert_equal "balance after insufficient funds" "9995.00" "$(balance)"
assert_equal "passkey assertions after insufficient funds" "$ASSERTIONS_BEFORE" "$(grep -c 'WebAuthn.credentialAsserted' "$WEBAUTHN_EVENTS_FILE" || true)"

echo ""
echo "=== 6. Reject passkey verification ==="
fill_transfer "$R" "1"
printf 'uv:false\n' >"$WEBAUTHN_CONTROL_FILE"
wait_control "uv:false" || critical "WebAuthn uv:false control was not applied"
click_button "Send"
if wait_text "The operation either timed out or was not allowed" 90; then
  echo "  PASS: error = $(body | grep -F 'The operation either timed out or was not allowed' | head -1)"
else
  echo "  FAIL: expected passkey rejection, got '$(body | tail -1)'"
  FAILURES=$((FAILURES + 1))
fi
BALANCE_AFTER_REJECTION="$(balance)"
printf 'uv:true\n' >"$WEBAUTHN_CONTROL_FILE"
wait_control "uv:true" || critical "WebAuthn uv:true control was not restored"

echo ""
echo "=== 7. Transfer 10 XLM with restored passkey ==="
fill_transfer "$R" "10"
click_button "Send"
wait_text "Transfer sent!" 180 || critical "expected 'Transfer sent!', got '$(body | tail -1)'"
EXPECTED_BALANCE="$(subtract_xlm "$BALANCE_AFTER_REJECTION" "10")"
wait_balance "$EXPECTED_BALANCE" 90 || critical "post-transfer balance expected $EXPECTED_BALANCE XLM, got '$(balance)'"
wait_text "View transaction" 10 || critical "successful transfer did not expose a transaction link"
echo "  PASS: status = Transfer sent!"
echo "  PASS: balance = $EXPECTED_BALANCE XLM"
echo "  PASS: transaction link = View transaction"

echo ""
if (( FAILURES > 0 )); then
  echo "=== WALLET LIFECYCLE FAILED: $FAILURES assertion(s) ==="
  exit 1
fi
echo "=== ALL WALLET LIFECYCLE TESTS PASSED ==="
