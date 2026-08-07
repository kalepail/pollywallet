#!/usr/bin/env bash
set -uo pipefail

# Context-rules production E2E. The same file is re-entered under the
# WebAuthn helper so one virtual authenticator survives every ceremony.

run_inner() {
  local base_url="$1"
  local passes=0 failures=0 skips=0
  local name20="ABCDEFGHIJKLMNOPQRST"
  local name21="ABCDEFGHIJKLMNOPQRSTU"
  local utf8_name20="éééééééééééééééééééé"

  ab() { agent-browser --session "$SESSION" "$@"; }
  body() { ab get text body 2>/dev/null || true; }
  snap() { ab snapshot -i 2>/dev/null || true; }

  pass() {
    passes=$((passes + 1))
    echo "  PASS: $1"
  }

  fail() {
    failures=$((failures + 1))
    echo "  FAIL: $1"
  }

  skip() {
    skips=$((skips + 1))
    echo "  SKIP: $1"
  }

  check_eq() {
    local label="$1" expected="$2" actual="$3"
    if [[ "$actual" == "$expected" ]]; then
      pass "$label -> $expected"
    else
      fail "$label -> expected '$expected', got '$actual'"
    fi
  }

  check_contains() {
    local label="$1" expected="$2" actual="$3"
    if [[ "$actual" == *"$expected"* ]]; then
      pass "$label -> $expected"
    else
      fail "$label -> missing '$expected'"
    fi
  }

  check_not_contains() {
    local label="$1" unexpected="$2" actual="$3"
    if [[ "$actual" != *"$unexpected"* ]]; then
      pass "$label -> absent '$unexpected'"
    else
      fail "$label -> unexpectedly contained '$unexpected'"
    fi
  }

  wait_text() {
    local text="$1" timeout="${2:-60000}"
    ab wait --text "$text" --timeout "$timeout" >/dev/null 2>&1
  }

  ensure_expanded() {
    if [[ "$(ab get count 'button[title="Copy"]' 2>/dev/null || true)" == "0" ]]; then
      ab click h3 >/dev/null
      snap >/dev/null
    fi
  }

  open_rename() {
    ensure_expanded
    ab find role button click --name Rename >/dev/null
    snap >/dev/null
  }

  open_expiration() {
    ensure_expanded
    ab find role button click --name Expiration >/dev/null
    snap >/dev/null
  }

  click_button() {
    local label="$1" deadline=$((SECONDS + 30)) snapshot line button_ref
    while ((SECONDS < deadline)); do
      snapshot="$(snap)"
      line="$(echo "$snapshot" | grep -F "button \"$label\"" | tail -1 || true)"
      if [[ -n "$line" && "$line" != *disabled* ]]; then
        button_ref="$(echo "$line" | grep -o 'e[0-9][0-9]*' | tail -1)"
        ab click "@$button_ref" >/dev/null
        return
      fi
      sleep 1
    done
    return 1
  }

  click_copy_number() {
    local number="$1" snapshot button_ref
    snapshot="$(snap)"
    button_ref="$(grep -F 'button "Copy"' <<<"$snapshot" | sed -n "${number}p" | grep -o 'e[0-9][0-9]*' | tail -1)"
    [[ -n "$button_ref" ]] || return 1
    ab click "@$button_ref" >/dev/null
  }

  echo ""
  echo "=== Wallet fixture: real testnet wallet with virtual WebAuthn ==="
  if ! wait_text "Create Smart Wallet" 30000 || ! click_button "Create Smart Wallet"; then
    fail "enabled 'Create Smart Wallet' button was not reachable"
    echo "$(body)"
    return 1
  fi
  if wait_text "Wallet created" 120000; then
    local wallet_body contract_id
    wallet_body="$(body)"
    check_contains "wallet creation result" "Wallet created!" "$wallet_body"
    contract_id="$(echo "$wallet_body" | grep -E '^C[A-Z2-7]{55}$' | head -1 || true)"
    if [[ "$contract_id" =~ ^C[A-Z2-7]{55}$ ]]; then
      pass "wallet rendered a concrete testnet contract id -> $contract_id"
    else
      fail "wallet did not render a C... contract id"
      echo "$wallet_body"
      return 1
    fi
  else
    fail "wallet creation did not render 'Wallet created!'"
    echo "$(body)"
    return 1
  fi

  if ! click_button "Fund with Friendbot"; then
    fail "enabled 'Fund with Friendbot' button was not reachable"
    echo "$(body)"
    return 1
  fi
  if wait_text "Funded!" 180000; then
    local funded_body
    funded_body="$(body)"
    check_contains "wallet funding result" "Funded!" "$funded_body"
    check_contains "funded wallet balance" "9995.00 XLM" "$funded_body"
  else
    fail "wallet funding did not render 'Funded!'"
    echo "$(body)"
    return 1
  fi

  echo ""
  echo "=== Rules route: load, expand, copy, default-rule guard ==="
  ab network har start --content none >/dev/null
  ab open "$base_url/rules" >/dev/null
  ab wait --load networkidle >/dev/null
  if wait_text Default 60000; then
    local rules_body
    rules_body="$(body)"
    check_contains "rules heading" "Context Rules" "$rules_body"
    check_contains "default rule name" "multisig" "$rules_body"
    check_contains "default badge" "Default" "$rules_body"
    check_contains "ledger read" "Current ledger:" "$rules_body"
  else
    fail "default rule did not load"
    echo "$(body)"
    return 1
  fi
  ab network har stop "$RULES_HAR" >/dev/null
  local used_next_id_rpc
  used_next_id_rpc="$(node -e '
    const fs = require("node:fs");
    const har = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const methods = har.log.entries.flatMap((entry) => {
      const text = entry.request.postData?.text;
      if (!text) return [];
      try { return [JSON.parse(text).method]; } catch { return []; }
    });
    process.stdout.write(String(methods.includes("getLedgerEntries")));
  ' "$RULES_HAR")"
  check_eq "FIX 3: authoritative NextId contract-instance RPC used" "true" "$used_next_id_rpc"

  ab click h3 >/dev/null
  local expanded
  expanded="$(body)"
  check_contains "expand card" "Signers (1)" "$expanded"
  check_contains "signer type" "External" "$expanded"
  check_contains "expiration empty state" "No expiration" "$expanded"

  ab click 'button[title="Copy"]' >/dev/null
  local copy_html
  copy_html="$(ab get html 'button[title="Copy"]' 2>/dev/null || true)"
  check_contains "copy visual confirmation icon" "M229.66,77.66" "$copy_html"

  local delete_disabled delete_title
  delete_disabled="$(ab eval 'document.querySelector("button[title=\"Cannot delete the default passkey rule\"]").disabled' 2>/dev/null || true)"
  delete_title="$(ab get attr 'button[title="Cannot delete the default passkey rule"]' title 2>/dev/null || true)"
  check_eq "default delete disabled" "true" "$delete_disabled"
  check_eq "default delete explanation" "Cannot delete the default passkey rule" "$delete_title"

  echo ""
  echo "=== Rename validation and persistence ==="
  open_rename
  ab fill 'input[type=text]' "" >/dev/null
  snap >/dev/null
  ab press Enter >/dev/null
  check_contains "empty name validation" "Name is required." "$(body)"
  check_eq "empty name marks field invalid" "true" "$(ab get attr 'input[type=text]' aria-invalid)"
  ab press Escape >/dev/null
  check_contains "empty name leaves stored name unchanged" "multisig" "$(body)"

  open_rename
  ab fill 'input[type=text]' temporary >/dev/null
  snap >/dev/null
  ab press Escape >/dev/null
  check_contains "Escape cancels rename" "multisig" "$(body)"

  open_rename
  ab fill 'input[type=text]' "$name21" >/dev/null
  snap >/dev/null
  local truncated maxlength
  truncated="$(ab get value 'input[type=text]')"
  maxlength="$(ab get attr 'input[type=text]' maxlength)"
  check_eq "21-character input is rejected by truncation" "$name20" "$truncated"
  check_eq "rename maxlength" "20" "$maxlength"

  ab press Enter >/dev/null
  if wait_text "$name20" 120000; then
    pass "20-character ASCII name accepted on testnet -> $name20"
  else
    fail "20-character ASCII rename did not complete"
    echo "$(body)"
  fi
  ab reload >/dev/null
  ab wait --load networkidle >/dev/null
  if wait_text "$name20" 60000; then
    pass "20-character rename persisted after reload -> $name20"
  else
    fail "20-character rename was not persisted after reload"
  fi

  open_rename
  ab fill 'input[type=text]' "$utf8_name20" >/dev/null
  snap >/dev/null
  local utf8_chars utf8_bytes assertions_before assertions_after utf8_result
  utf8_chars="$(ab eval 'document.querySelector("input[type=text]").value.length')"
  utf8_bytes="$(ab eval 'new TextEncoder().encode(document.querySelector("input[type=text]").value).length')"
  check_eq "multibyte name UI character count" "20" "$utf8_chars"
  if ((utf8_bytes > 20)); then
    pass "multibyte candidate exceeds the contract limit -> $utf8_bytes UTF-8 bytes"
  else
    fail "multibyte candidate did not exceed the 20-byte contract limit"
  fi
  assertions_before="$(grep -c 'WebAuthn.credentialAsserted' "$WEBAUTHN_EVENTS_FILE" 2>/dev/null || true)"
  ab press Enter >/dev/null
  if wait_text "Name must be 20 UTF-8 bytes or fewer." 10000; then
    utf8_result="$(body)"
    pass "FIX 1: oversized multibyte name rejected client-side with friendly message"
    check_not_contains "multibyte validation hides raw simulation error" "Simulation failed" "$utf8_result"
    check_not_contains "multibyte validation hides raw HostError" "HostError" "$utf8_result"
    check_eq "multibyte field remains invalid" "true" "$(ab get attr 'input[type=text]' aria-invalid)"
  else
    fail "FIX 1 REGRESSION: missing 'Name must be 20 UTF-8 bytes or fewer.'"
  fi
  assertions_after="$(grep -c 'WebAuthn.credentialAsserted' "$WEBAUTHN_EVENTS_FILE" 2>/dev/null || true)"
  check_eq "multibyte validation triggers no passkey ceremony" "$assertions_before" "$assertions_after"
  ab press Escape >/dev/null
  check_contains "rejected multibyte rename leaves stored name unchanged" "$name20" "$(body)"

  echo ""
  echo "=== Expiration editor and numeric boundaries ==="
  local current_display ledger_digits future future_display validation_result
  current_display="$(body | sed -n 's/.*Current ledger: //p' | tail -1)"
  ledger_digits="$(echo "$current_display" | tr -d ',')"
  if [[ "$ledger_digits" =~ ^[0-9]+$ ]]; then
    future=$((ledger_digits + 5000))
  else
    fail "could not parse current ledger for expiration tests"
    future=4294960000
  fi
  future_display="$(node -e 'console.log(Number(process.argv[1]).toLocaleString("en-US"))' "$future")"

  open_expiration
  ab fill 'input[type=number]' "$future" >/dev/null
  snap >/dev/null
  ab find role button click --name Cancel >/dev/null
  check_contains "Cancel leaves expiration unchanged" "No expiration" "$(body)"

  open_expiration
  ab fill 'input[type=number]' "$future" >/dev/null
  snap >/dev/null
  ab press Escape >/dev/null
  check_contains "Escape leaves expiration unchanged" "No expiration" "$(body)"

  open_expiration
  ab fill 'input[type=number]' 0 >/dev/null
  snap >/dev/null
  ab press Enter >/dev/null
  if wait_text "Expiration must be after current ledger $current_display." 10000; then
    pass "past/zero expiration rejected with current-ledger message"
    check_eq "past expiration field remains invalid" "true" "$(ab get attr 'input[type=number]' aria-invalid)"
  else
    fail "missing exact past-ledger validation message for expiration 0"
  fi
  ab press Escape >/dev/null
  check_contains "rejected zero leaves expiration unchanged" "No expiration" "$(body)"

  open_expiration
  ab fill 'input[type=number]' 4294967296 >/dev/null
  snap >/dev/null
  assertions_before="$(grep -c 'WebAuthn.credentialAsserted' "$WEBAUTHN_EVENTS_FILE" 2>/dev/null || true)"
  ab press Enter >/dev/null
  if wait_text "Expiration cannot exceed ledger 4,294,967,295." 10000; then
    validation_result="$(body)"
    pass "FIX 5: u32 overflow rejected client-side with friendly message"
    check_not_contains "u32 validation hides encoder error" "invalid value" "$validation_result"
    check_not_contains "u32 validation hides raw HostError" "HostError" "$validation_result"
    check_eq "u32 overflow field remains invalid" "true" "$(ab get attr 'input[type=number]' aria-invalid)"
  else
    fail "FIX 5 REGRESSION: missing 'Expiration cannot exceed ledger 4,294,967,295.'"
  fi
  assertions_after="$(grep -c 'WebAuthn.credentialAsserted' "$WEBAUTHN_EVENTS_FILE" 2>/dev/null || true)"
  check_eq "u32 validation triggers no passkey ceremony" "$assertions_before" "$assertions_after"
  ab press Escape >/dev/null

  open_expiration
  ab fill 'input[type=number]' "$future" >/dev/null
  snap >/dev/null
  ab press Enter >/dev/null
  if wait_text "L$future_display" 120000; then
    pass "positive expiration accepted -> L$future_display"
  else
    fail "positive expiration did not render L$future_display"
    echo "$(body)"
  fi
  ab reload >/dev/null
  ab wait --load networkidle >/dev/null
  if wait_text "L$future_display" 60000; then
    pass "positive expiration persisted after reload -> L$future_display"
  else
    fail "positive expiration did not persist after reload"
  fi

  open_expiration
  ab fill 'input[type=number]' 1.9 >/dev/null
  snap >/dev/null
  check_eq "fractional input reaches the editor" "1.9" "$(ab get value 'input[type=number]')"
  assertions_before="$(grep -c 'WebAuthn.credentialAsserted' "$WEBAUTHN_EVENTS_FILE" 2>/dev/null || true)"
  ab press Enter >/dev/null
  if wait_text "Expiration must be a whole ledger number." 10000; then
    validation_result="$(body)"
    pass "FIX 6: fractional expiration rejected client-side with friendly message"
    check_not_contains "fractional validation hides simulation error" "Simulation failed" "$validation_result"
    check_not_contains "fractional validation hides raw HostError" "HostError" "$validation_result"
    check_eq "fractional field remains invalid" "true" "$(ab get attr 'input[type=number]' aria-invalid)"
  else
    fail "FIX 6 REGRESSION: missing 'Expiration must be a whole ledger number.'"
  fi
  assertions_after="$(grep -c 'WebAuthn.credentialAsserted' "$WEBAUTHN_EVENTS_FILE" 2>/dev/null || true)"
  check_eq "fractional validation triggers no passkey ceremony" "$assertions_before" "$assertions_after"
  ab press Escape >/dev/null

  open_expiration
  ab fill 'input[type=number]' "" >/dev/null
  snap >/dev/null
  ab find role button click --name Save >/dev/null
  ab wait --fn 'document.querySelector("button[title=\"Copy\"]") === null' --timeout 120000 >/dev/null 2>&1 || true
  ab reload >/dev/null
  ab wait --load networkidle >/dev/null
  wait_text "$name20" 60000 || true
  local after_remove
  after_remove="$(body)"
  if [[ "$after_remove" == *"L$future_display"* ]]; then
    fail "FIX 2 REGRESSION: blank expiration removal left L$future_display after reload"
  else
    ensure_expanded
    if [[ "$(body)" == *"No expiration"* ]]; then
      pass "FIX 2: blank expiration removal persisted after reload -> No expiration"
    else
      fail "FIX 2 REGRESSION: blank removal did not render 'No expiration'"
    fi
  fi

  ensure_expanded
  delete_disabled="$(ab eval 'document.querySelector("button[title=\"Cannot delete the default passkey rule\"]").disabled' 2>/dev/null || true)"
  check_eq "delete remains disabled after management operations" "true" "$delete_disabled"

  echo ""
  echo "=== Context-rule count decoding boundary ==="
  ab find role link click --name Policies >/dev/null
  wait_text "Add Transaction Hashes" 30000 || fail "could not reach Policies before count-response fixture"
  local unsupported_count_xdr
  unsupported_count_xdr="$(node --input-type=module -e 'import { xdr } from "@stellar/stellar-sdk"; console.log(xdr.ScVal.scvVoid().toXDR("base64"));')"
  ab eval --stdin >/dev/null <<EOF
window.__pwOriginalFetch = window.fetch.bind(window);
window.__pwCountMocked = false;
window.fetch = async (...args) => {
  const request = args[0];
  const init = args[1] || {};
  let requestBody = init.body;
  if (!requestBody && request instanceof Request) requestBody = await request.clone().text();
  let rpcMethod = null;
  try { rpcMethod = JSON.parse(requestBody).method; } catch {}

  const response = await window.__pwOriginalFetch(...args);
  if (!window.__pwCountMocked && rpcMethod === "simulateTransaction") {
    const payload = await response.clone().json();
    if (payload?.result?.results?.[0]?.xdr) {
      payload.result.results[0].xdr = "$unsupported_count_xdr";
      window.__pwCountMocked = true;
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.delete("content-encoding");
      return new Response(JSON.stringify(payload), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
  }
  return response;
};
"count mock installed";
EOF
  ab find role link click --name Rules >/dev/null
  if wait_text "Contract returned an invalid context rule count" 60000; then
    local count_error_body
    count_error_body="$(body)"
    pass "FIX 4: unsupported count ScVal renders the explicit decoding error"
    check_not_contains "unsupported count is not decoded as an empty wallet" "No context rules found on this wallet." "$count_error_body"
    check_eq "unsupported count fixture intercepted the count call" "true" "$(ab eval 'window.__pwCountMocked')"
  else
    fail "FIX 4 REGRESSION: unsupported count ScVal did not render its explicit error"
    echo "$(body)"
  fi
  ab eval 'window.fetch = window.__pwOriginalFetch; delete window.__pwOriginalFetch; delete window.__pwCountMocked' >/dev/null
  ab reload >/dev/null
  ab wait --load networkidle >/dev/null
  wait_text "$name20" 60000 || fail "rules did not recover after restoring the real RPC response"

  echo ""
  echo "=== Reusable fixture: non-default rule and installed policy ==="
  local fixture_wallet fixture_target fixture_policy fixture_rule fixture_name
  IFS=$'\t' read -r fixture_wallet fixture_target fixture_policy fixture_rule fixture_name < <(
    FIXTURE_FILE="$FIXTURE_FILE" node -e 'const f=JSON.parse(require("node:fs").readFileSync(process.env.FIXTURE_FILE)); process.stdout.write([f.walletContractId,f.targetContractId,f.policyContractId,f.contextRuleId,f.ruleName].join("\t"))'
  )

  ab eval "localStorage.setItem('pollywallet:wallet', JSON.stringify({credentialId:'fixture-read-only',contractId:'$fixture_wallet',publicKey:''}))" >/dev/null
  ab open "$base_url/rules" >/dev/null
  ab wait --load networkidle >/dev/null
  if wait_text "$fixture_name" 120000; then
    local fixture_body meta_date source_body
    fixture_body="$(body)"
    check_contains "fixture rule id" "#$fixture_rule" "$fixture_body"
    check_contains "CallContract badge" "CallContract" "$fixture_body"
    check_not_contains "fixture does not mislabel CallContract as CreateContract" "CreateContract" "$fixture_body"
    check_contains "fixture policy count" "1 policy" "$fixture_body"
  else
    fail "fixture rule '$fixture_name' did not render"
    echo "$(body)"
    return 1
  fi

  ab find role heading click --name "$fixture_name" >/dev/null
  wait_text "Target Contract" 30000 || fail "fixture rule did not expand"
  fixture_body="$(body)"
  check_contains "concrete target contract" "$fixture_target" "$fixture_body"
  check_contains "installed policy metadata name" "$fixture_name" "$fixture_body"
  meta_date="$(ab eval "document.querySelector('span[title=\"$fixture_name\"]')?.nextElementSibling?.textContent || ''" | tr -d '"')"
  if [[ "$meta_date" =~ ^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$ ]]; then
    pass "installed policy deployment metadata -> $meta_date"
  else
    fail "installed policy deployment date missing, got '$meta_date'"
  fi

  ab eval 'Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async text=>{window.__fixtureCopied=text}}}); window.__fixtureCopied=""' >/dev/null
  if click_copy_number 1; then
    check_eq "target-contract copy payload" "true" "$(ab eval "window.__fixtureCopied === '$fixture_target'")"
  else
    fail "target-contract Copy button missing"
  fi
  if click_copy_number 3; then
    check_eq "concrete policy-address copy payload" "true" "$(ab eval "window.__fixtureCopied === '$fixture_policy'")"
  else
    fail "policy-address Copy button missing"
  fi

  ab find role button click --name Code >/dev/null
  wait_text "Rust source" 30000 || fail "policy source did not expand"
  source_body="$(body)"
  check_contains "real Rust source contract" "pub struct PolicyContract" "$source_body"
  check_contains "real Rust source error enum" "pub enum PolicyError" "$source_body"
  if click_copy_number 4; then
    check_eq "Rust source copy payload" "true" "$(ab eval 'window.__fixtureCopied === document.querySelector("pre")?.textContent')"
  else
    fail "Rust source Copy button missing"
  fi
  ab find role button click --name Hide >/dev/null
  check_not_contains "Hide collapses Rust source" "Rust source" "$(body)"

  ab find role button click --name Delete >/dev/null
  check_contains "delete confirmation" "Delete this rule?" "$(body)"
  ab find role button click --name Cancel >/dev/null
  fixture_body="$(body)"
  check_not_contains "delete cancel closes confirmation" "Delete this rule?" "$fixture_body"
  check_contains "delete cancel preserves fixture rule" "$fixture_name" "$fixture_body"
  pass "delete submission deliberately not executed; reusable fixture preserved"

  echo ""
  echo "=== CreateContract fault injection: RENDERING ONLY, not an on-chain lifecycle ==="
  local create_rule_xdr fixture_name_json
  create_rule_xdr="$(FIXTURE_RULE="$fixture_rule" FIXTURE_NAME="$fixture_name" node --input-type=module <<'NODE'
import { xdr } from "@stellar/stellar-sdk";

const field = (key, val) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });
const fields = {
  id: xdr.ScVal.scvU32(Number(process.env.FIXTURE_RULE)),
  name: xdr.ScVal.scvString(process.env.FIXTURE_NAME),
  context_type: xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("CreateContract"),
    xdr.ScVal.scvBytes(Buffer.from(Array.from({ length: 32 }, (_, i) => i))),
  ]),
  signers: xdr.ScVal.scvVec([]),
  signer_ids: xdr.ScVal.scvVec([]),
  policies: xdr.ScVal.scvVec([]),
  policy_ids: xdr.ScVal.scvVec([]),
  valid_until: xdr.ScVal.scvVoid(),
};
const rule = xdr.ScVal.scvMap(Object.entries(fields)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([key, val]) => field(key, val)));
process.stdout.write(rule.toXDR("base64"));
NODE
  )"
  fixture_name_json="$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$fixture_name")"
  ab find role link click --name Policies >/dev/null
  wait_text "Add Transaction Hashes" 30000 || fail "could not reach Policies before CreateContract render fixture"
  ab eval --stdin >/dev/null <<EOF
window.__pwOriginalFetch = window.fetch.bind(window);
window.__pwCreateMocked = false;
window.fetch = async (...args) => {
  const response = await window.__pwOriginalFetch(...args);
  const payload = await response.clone().json().catch(() => null);
  const resultXdr = payload?.result?.results?.[0]?.xdr;
  if (!window.__pwCreateMocked && resultXdr && atob(resultXdr).includes($fixture_name_json)) {
    payload.result.results[0].xdr = "$create_rule_xdr";
    window.__pwCreateMocked = true;
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(JSON.stringify(payload), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  return response;
};
"CreateContract render mock installed";
EOF
  ab find role link click --name Rules >/dev/null
  ab wait --load networkidle >/dev/null
  if wait_text "CreateContract" 60000; then
    fixture_body="$(body)"
    check_contains "RENDERING ONLY: injected CreateContract badge" "CreateContract" "$fixture_body"
    check_contains "RENDERING ONLY: injected WASM hash" "WASM: 00010203...1c1d1e1f" "$fixture_body"
    check_not_contains "render fixture does not retain CallContract badge" "CallContract" "$fixture_body"
    check_eq "CreateContract fixture intercepted the rule response" "true" "$(ab eval 'window.__pwCreateMocked')"
  else
    fail "RENDERING ONLY: injected CreateContract badge did not render"
    echo "$(body)"
  fi
  ab eval 'window.fetch = window.__pwOriginalFetch; delete window.__pwOriginalFetch; delete window.__pwCreateMocked' >/dev/null

  skip "expired rendering: client validation prevents submitting an already-expired ledger"

  echo ""
  echo "=== RULES E2E SUMMARY ==="
  echo "PASS=$passes FAIL=$failures SKIP=$skips"
  ((failures == 0))
}

if [[ "${1:-}" == "--inner" ]]; then
  run_inner "${2:?base URL required}"
  exit $?
fi

INPUT_URL="${1:-http://localhost:4173}"
SESSION="cc-coverage"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BASE_URL="${INPUT_URL%/}"
BASE_URL="${BASE_URL%/rules}"
RULES_URL="$BASE_URL/rules"
ARTIFACT_DIR="$(mktemp -d)"
export SESSION
export AGENT_BROWSER_IDLE_TIMEOUT_MS=600000
export WEBAUTHN_EVENTS_FILE="$ARTIFACT_DIR/webauthn.jsonl"
export RULES_HAR="$ARTIFACT_DIR/rules.har"
export FIXTURE_FILE="${E2E_FIXTURE_FILE:-$SCRIPT_DIR/.e2e-fixture.json}"

cleanup() {
  agent-browser --session "$SESSION" close 2>/dev/null || true
  rm -f "$WEBAUTHN_EVENTS_FILE" "$RULES_HAR"
  rmdir "$ARTIFACT_DIR" 2>/dev/null || true
}
trap cleanup EXIT

bash "$SCRIPT_DIR/e2e-fixture.sh" "$BASE_URL"
agent-browser --session "$SESSION" close 2>/dev/null || true

echo "=== No-wallet route gate ==="
agent-browser --session "$SESSION" open "$BASE_URL/" >/dev/null
agent-browser --session "$SESSION" eval 'localStorage.clear()' >/dev/null
agent-browser --session "$SESSION" open "$RULES_URL" >/dev/null
NO_WALLET_BODY="$(agent-browser --session "$SESSION" get text body)"
if [[ "$NO_WALLET_BODY" == *"Create a wallet first to manage context rules."* ]]; then
  echo "  PASS: exact no-wallet message -> Create a wallet first to manage context rules."
else
  echo "  FAIL: exact no-wallet message missing"
  echo "$NO_WALLET_BODY"
  exit 1
fi

agent-browser --session "$SESSION" open "$BASE_URL/" >/dev/null
if ! agent-browser --session "$SESSION" wait --fn 'typeof window.$_TSR === "undefined"' --timeout 30000 >/dev/null 2>&1; then
  ENTRY_URL="$(agent-browser --session "$SESSION" get attr 'script[type="module"]' src 2>/dev/null || true)"
  [[ "$ENTRY_URL" == /* ]] && ENTRY_URL="$BASE_URL$ENTRY_URL"
  ENTRY_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' "$ENTRY_URL" 2>/dev/null || true)"
  echo "  FAIL: production app did not hydrate; entry module $ENTRY_URL returned HTTP $ENTRY_STATUS"
  exit 1
fi

node "$SCRIPT_DIR/agent-browser-webauthn-helper.mjs" run --session "$SESSION" \
  --require-credential true --timeout-ms 300000 -- \
  bash "$SCRIPT_DIR/e2e-rules.sh" --inner "$BASE_URL"
