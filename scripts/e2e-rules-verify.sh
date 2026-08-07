#!/usr/bin/env bash
set -uo pipefail

run_inner() {
  local base_url="$1" failures=0
  local ascii_name="ABCDEFGHIJKLMNOPQRST"
  local utf8_name="éééééééééééééééééééé"

  ab() { agent-browser --session "$SESSION" "$@"; }
  body() { ab get text body 2>/dev/null || true; }
  snap() { ab snapshot -i 2>/dev/null || true; }

  click_button() {
    local label="$1" snapshot button_ref
    snapshot="$(snap)"
    button_ref="$(echo "$snapshot" | grep -F "button \"$label\"" | grep -o 'e[0-9][0-9]*' | tail -1)"
    [[ -n "$button_ref" ]] || return 1
    ab click "@$button_ref" >/dev/null
  }

  wait_text() {
    local expected="$1" deadline=$((SECONDS + ${2:-90}))
    while (( SECONDS < deadline )); do
      if body | grep -Fq "$expected"; then return 0; fi
      sleep 1
    done
    return 1
  }

  wait_editor_closed() {
    local selector="$1" expected="$2" deadline=$((SECONDS + ${3:-180}))
    while (( SECONDS < deadline )); do
      if [[ "$(ab get count "$selector" 2>/dev/null || true)" == "0" ]] &&
         body | grep -Fq "$expected"; then
        return 0
      fi
      sleep 1
    done
    return 1
  }

  wait_rule_without() {
    local selector="$1" unexpected="$2" deadline=$((SECONDS + ${3:-180})) current
    while (( SECONDS < deadline )); do
      current="$(body)"
      if [[ "$(ab get count "$selector" 2>/dev/null || true)" == "0" ]] &&
         echo "$current" | grep -Fxq "Default" &&
         ! echo "$current" | grep -Fq "$unexpected"; then
        return 0
      fi
      sleep 1
    done
    return 1
  }

  credential_assertions() {
    grep -c 'WebAuthn.credentialAsserted' "$WEBAUTHN_EVENTS_FILE" 2>/dev/null || true
  }

  wait_event() {
    local event="$1" deadline=$((SECONDS + ${2:-15}))
    while (( SECONDS < deadline )); do
      if grep -Fq "\"event\":\"$event\"" "$WEBAUTHN_EVENTS_FILE"; then return 0; fi
      sleep 1
    done
    return 1
  }

  critical() {
    echo "  FIXTURE FAILED: $1"
    echo "$(body)"
    exit 1
  }

  expand_rule() {
    if ! body | grep -Fxq "Rename"; then
      ab click h3 >/dev/null
    fi
  }

  open_rename() {
    expand_rule
    ab find role button click --name "Rename" >/dev/null
  }

  open_expiration() {
    expand_rule
    ab find role button click --name "Expiration" >/dev/null
  }

  echo ""
  echo "=== Wallet fixture ==="
  click_button "Create Smart Wallet" || critical "Create Smart Wallet button not found"
  wait_event "WebAuthn.credentialAdded" 15 || critical "Create click produced no credentialAdded event"
  wait_text "Wallet created!" 180 || critical "wallet creation did not reach 'Wallet created!'"
  local wallet_id
  wallet_id="$(body | grep -Eo 'C[A-Z2-7]{55}' | head -1)"
  [[ "$wallet_id" =~ ^C[A-Z2-7]{55}$ ]] || critical "wallet contract ID missing"
  echo "  PASS: Wallet created!"
  echo "  PASS: contract = $wallet_id"

  click_button "Fund with Friendbot" || critical "Fund with Friendbot button not found"
  wait_text "Funded!" 180 || critical "funding did not reach 'Funded!'"
  wait_text "9995.00 XLM" 60 || critical "funded balance was not 9995.00 XLM"
  echo "  PASS: Funded!"
  echo "  PASS: balance = 9995.00 XLM"

  echo ""
  echo "=== Rules fixture and enumeration sanity check ==="
  ab open "$base_url/rules" >/dev/null
  wait_text "Default" 90 || critical "default context rule did not load"
  local rules_body rule_zero_count
  rules_body="$(body)"
  rule_zero_count="$(echo "$rules_body" | grep -Fxc '#0' || true)"
  [[ "$rule_zero_count" == "1" ]] || critical "expected exactly one #0 rule, got $rule_zero_count"
  echo "  PASS: rendered exactly one #0 Default rule"
  echo "  FIX 3 NOT REACHABLE: this fresh wallet has only contiguous rule #0; sparse-ID enumeration is not proven"
  echo "  FIX 4 NOT REACHABLE: a real contract does not return an unsupported count ScVal, and no fault injection was used"

  echo ""
  echo "=== FIX 1: UTF-8 byte validation and ASCII boundary ==="
  local fix1_ok=1 before after chars bytes utf8_body
  expand_rule
  open_rename
  ab fill 'input[type=text]' "$ascii_name" >/dev/null
  ab press Enter >/dev/null
  if wait_editor_closed 'input[type=text]' "$ascii_name" 180; then
    ab reload >/dev/null
    wait_text "Default" 90 || true
    if body | grep -Fq "$ascii_name"; then
      echo "  PASS: 20-byte ASCII name accepted and persisted = $ascii_name"
    else
      echo "  FAIL: 20-byte ASCII name did not persist after reload"
      fix1_ok=0
    fi
  else
    echo "  FAIL: 20-byte ASCII name was not accepted"
    echo "$(body)"
    fix1_ok=0
  fi

  expand_rule
  open_rename
  ab fill 'input[type=text]' "$utf8_name" >/dev/null
  chars="$(ab eval 'document.querySelector("input[type=text]").value.length')"
  bytes="$(ab eval 'new TextEncoder().encode(document.querySelector("input[type=text]").value).length')"
  before="$(credential_assertions)"
  ab press Enter >/dev/null
  if wait_text "Name must be 20 UTF-8 bytes or fewer." 15; then
    utf8_body="$(body)"
    after="$(credential_assertions)"
    echo "  PASS: 20-character / 40-byte name rejected = Name must be 20 UTF-8 bytes or fewer."
    echo "  PASS: measured chars=$chars bytes=$bytes"
    if [[ "$before" != "$after" ]]; then
      echo "  FAIL: client validation triggered a passkey ceremony ($before -> $after)"
      fix1_ok=0
    fi
    if echo "$utf8_body" | grep -Eq 'Simulation failed|HostError'; then
      echo "  FAIL: raw contract error leaked into the UI"
      fix1_ok=0
    fi
  else
    echo "  FAIL: missing exact UTF-8 validation message"
    echo "$(body)"
    fix1_ok=0
  fi
  [[ "$(ab get attr 'input[type=text]' aria-invalid 2>/dev/null || true)" == "true" ]] || {
    echo "  FAIL: rejected name input was not marked aria-invalid"
    fix1_ok=0
  }
  ab press Escape >/dev/null
  if (( fix1_ok )); then echo "  FIX 1 VERIFIED"; else echo "  FIX 1 FAILED"; failures=$((failures + 1)); fi

  echo ""
  echo "=== FIX 5: u32 expiration ceiling ==="
  local fix5_ok=1 validation_body
  open_expiration
  ab fill 'input[type=number]' "4294967296" >/dev/null
  before="$(credential_assertions)"
  ab press Enter >/dev/null
  if wait_text "Expiration cannot exceed ledger 4,294,967,295." 15; then
    validation_body="$(body)"
    after="$(credential_assertions)"
    echo "  PASS: Expiration cannot exceed ledger 4,294,967,295."
    [[ "$before" == "$after" ]] || { echo "  FAIL: overflow validation triggered a passkey ceremony"; fix5_ok=0; }
    echo "$validation_body" | grep -Eq 'HostError|Simulation failed' && { echo "  FAIL: raw error leaked"; fix5_ok=0; }
  else
    echo "  FAIL: exact u32 overflow message missing"
    echo "$(body)"
    fix5_ok=0
  fi
  [[ "$(ab get attr 'input[type=number]' aria-invalid 2>/dev/null || true)" == "true" ]] || {
    echo "  FAIL: overflow input was not marked aria-invalid"
    fix5_ok=0
  }
  ab press Escape >/dev/null
  if (( fix5_ok )); then echo "  FIX 5 VERIFIED"; else echo "  FIX 5 FAILED"; failures=$((failures + 1)); fi

  echo ""
  echo "=== FIX 6: fractional expiration ==="
  local fix6_ok=1
  open_expiration
  ab fill 'input[type=number]' "1.5" >/dev/null
  before="$(credential_assertions)"
  ab press Enter >/dev/null
  if wait_text "Expiration must be a whole ledger number." 15; then
    validation_body="$(body)"
    after="$(credential_assertions)"
    echo "  PASS: Expiration must be a whole ledger number."
    [[ "$before" == "$after" ]] || { echo "  FAIL: fractional validation triggered a passkey ceremony"; fix6_ok=0; }
    echo "$validation_body" | grep -Eq 'HostError|Simulation failed' && { echo "  FAIL: raw error leaked"; fix6_ok=0; }
  else
    echo "  FAIL: exact fractional expiration message missing"
    echo "$(body)"
    fix6_ok=0
  fi
  [[ "$(ab get attr 'input[type=number]' aria-invalid 2>/dev/null || true)" == "true" ]] || {
    echo "  FAIL: fractional input was not marked aria-invalid"
    fix6_ok=0
  }
  ab press Escape >/dev/null
  if (( fix6_ok )); then echo "  FIX 6 VERIFIED"; else echo "  FIX 6 FAILED"; failures=$((failures + 1)); fi

  echo ""
  echo "=== FIX 2: set, persist, clear, and persist expiration ==="
  local fix2_ok=1 ledger_display ledger future future_display
  expand_rule
  ledger_display="$(body | sed -n 's/^Current ledger: //p' | tail -1)"
  ledger="${ledger_display//,/}"
  if [[ ! "$ledger" =~ ^[0-9]+$ ]]; then
    echo "  FAIL: could not parse current ledger from '$ledger_display'"
    fix2_ok=0
  else
    future=$((ledger + 5000))
    future_display="$(node -e 'console.log(Number(process.argv[1]).toLocaleString("en-US"))' "$future")"

    open_expiration
    ab fill 'input[type=number]' "$future" >/dev/null
    ab find role button click --name "Save" >/dev/null
    if wait_editor_closed 'input[type=number]' "L$future_display" 180; then
      echo "  PASS: future expiration saved = L$future_display"
    else
      echo "  FAIL: future expiration did not save"
      echo "$(body)"
      fix2_ok=0
    fi

    ab reload >/dev/null
    wait_text "Default" 90 || true
    expand_rule
    if body | grep -Fq "Ledger $future_display"; then
      echo "  PASS: future expiration persisted after reload = Ledger $future_display"
    else
      echo "  FAIL: future expiration missing after reload"
      fix2_ok=0
    fi

    open_expiration
    ab fill 'input[type=number]' "" >/dev/null
    ab find role button click --name "Save" >/dev/null
    if wait_rule_without 'input[type=number]' "L$future_display" 180; then
      echo "  PASS: blank expiration removed the L$future_display badge"
    else
      echo "  FAIL: clearing expiration did not reach No expiration"
      echo "$(body)"
      fix2_ok=0
    fi

    ab reload >/dev/null
    wait_text "Default" 90 || true
    expand_rule
    local cleared_body
    cleared_body="$(body)"
    if echo "$cleared_body" | grep -Fq "No expiration" &&
       ! echo "$cleared_body" | grep -Fq "Ledger $future_display"; then
      echo "  PASS: cleared expiration persisted after reload = No expiration"
    else
      echo "  FAIL: old expiration survived reload"
      echo "$cleared_body"
      fix2_ok=0
    fi
  fi
  if (( fix2_ok )); then echo "  FIX 2 VERIFIED"; else echo "  FIX 2 FAILED"; failures=$((failures + 1)); fi

  echo ""
  echo "=== RULE FIX SUMMARY ==="
  echo "FIX 1: $([[ $fix1_ok == 1 ]] && echo VERIFIED || echo FAILED)"
  echo "FIX 2: $([[ $fix2_ok == 1 ]] && echo VERIFIED || echo FAILED)"
  echo "FIX 3: NOT REACHABLE (only rule #0 exists; no sparse IDs)"
  echo "FIX 4: NOT REACHABLE (invalid count ScVal requires fault injection)"
  echo "FIX 5: $([[ $fix5_ok == 1 ]] && echo VERIFIED || echo FAILED)"
  echo "FIX 6: $([[ $fix6_ok == 1 ]] && echo VERIFIED || echo FAILED)"
  echo "WebAuthn assertions observed: $(credential_assertions)"
  (( failures == 0 ))
}

if [[ "${1:-}" == "--inner" ]]; then
  run_inner "${2:?base URL required}"
  exit $?
fi

BASE_URL="${1:-http://localhost:4173}"
BASE_URL="${BASE_URL%/}"
SESSION="e2e1-wallet"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ARTIFACT_DIR="$(mktemp -d)"
export SESSION WEBAUTHN_EVENTS_FILE="$ARTIFACT_DIR/webauthn.jsonl"
export AGENT_BROWSER_IDLE_TIMEOUT_MS=600000

cleanup() {
  agent-browser --session "$SESSION" close 2>/dev/null || true
  rm -f "$WEBAUTHN_EVENTS_FILE"
  rmdir "$ARTIFACT_DIR" 2>/dev/null || true
}
trap cleanup EXIT

agent-browser --session "$SESSION" close >/dev/null 2>&1 || true
agent-browser --session "$SESSION" open "$BASE_URL/rules" >/dev/null
agent-browser --session "$SESSION" eval 'localStorage.clear()' >/dev/null
agent-browser --session "$SESSION" reload >/dev/null
NO_WALLET_BODY="$(agent-browser --session "$SESSION" get text body)"
if [[ "$NO_WALLET_BODY" != *"Create a wallet first to manage context rules."* ]]; then
  echo "NO-WALLET GATE FAILED: expected exact copy"
  echo "$NO_WALLET_BODY"
  exit 1
fi
echo "NO-WALLET GATE PASS: Create a wallet first to manage context rules."

agent-browser --session "$SESSION" close >/dev/null
sleep 2
agent-browser --session "$SESSION" open "$BASE_URL/" >/dev/null
agent-browser --session "$SESSION" wait --text "Create Smart Wallet" --timeout 30000 >/dev/null
node "$SCRIPT_DIR/agent-browser-webauthn-helper.mjs" run \
  --session "$SESSION" --require-credential true -- \
  bash "$SCRIPT_DIR/e2e-rules-verify.sh" --inner "$BASE_URL"
run_status=$?

events_ok=1
grep -q '"event":"WebAuthn.credentialAdded"' "$WEBAUTHN_EVENTS_FILE" || {
  echo "FAIL: WebAuthn.credentialAdded was not observed"
  run_status=1
  events_ok=0
}
grep -q '"event":"WebAuthn.credentialAsserted"' "$WEBAUTHN_EVENTS_FILE" || {
  echo "FAIL: WebAuthn.credentialAsserted was not observed"
  run_status=1
  events_ok=0
}
if (( events_ok )); then
  echo "WebAuthn events: credentialAdded + credentialAsserted"
fi
exit "$run_status"
