#!/usr/bin/env bash
set -euo pipefail

# Policy builder E2E: wallet/passkey -> generate/test -> deploy -> install -> verify.
# Uses the production preview by default; pass a different base URL as $1.

BASE_URL="${1:-http://localhost:4173}"
BASE_URL="${BASE_URL%/}"
BASE_URL="${BASE_URL%/policies}"
SESSION="e2e3-policy"
TX_HASH="${TX_HASH:-a3622f19cbea4c32bd06fbf7687a8c0e3a8204c47f8bf0dd8b31007a79f2eb08}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [[ "${2:-}" != "--steps" ]]; then
  ARTIFACT_DIR="$(mktemp -d)"
  export SESSION BASE_URL TX_HASH
  export WEBAUTHN_EVENTS_FILE="$ARTIFACT_DIR/webauthn.jsonl"

  cleanup() {
    agent-browser --session "$SESSION" close 2>/dev/null || true
  }
  trap cleanup EXIT

  agent-browser --session "$SESSION" close 2>/dev/null || true
  for _ in 1 2 3; do
    agent-browser --session "$SESSION" --headed open "$BASE_URL" >/dev/null 2>&1 && break
    sleep 1
  done
  agent-browser --session "$SESSION" open "$BASE_URL" >/dev/null

  node "$SCRIPT_DIR/agent-browser-webauthn-helper.mjs" run \
    --session "$SESSION" --require-credential true -- \
    bash "$0" "$BASE_URL" --steps

  grep -q '"event":"WebAuthn.credentialAdded"' "$WEBAUTHN_EVENTS_FILE"
  grep -q '"event":"WebAuthn.credentialAsserted"' "$WEBAUTHN_EVENTS_FILE"
  echo "PASS WebAuthn: credential created and asserted"
  exit 0
fi

ab() { agent-browser --session "$SESSION" "$@"; }
body() { ab get text body 2>/dev/null || true; }

fail() {
  echo "FAIL: $1" >&2
  body >&2
  exit 1
}

wait_text() {
  local expected="$1" timeout="$2" errors="${3:-}" page
  for ((i = 0; i < timeout; i += 2)); do
    page="$(body)"
    grep -Fq "$expected" <<<"$page" && return 0
    if [[ -n "$errors" ]] && grep -Eq "$errors" <<<"$page"; then
      fail "$(grep -Em1 "$errors" <<<"$page")"
    fi
    sleep 2
  done
  fail "timed out waiting for: $expected"
}

wait_enabled_button() {
  local name="$1" timeout="$2" snapshot line
  for ((i = 0; i < timeout; i += 2)); do
    snapshot="$(ab snapshot -i 2>/dev/null || true)"
    line="$(grep -F "button \"$name\"" <<<"$snapshot" || true)"
    [[ -n "$line" && "$line" != *disabled* ]] && return 0
    sleep 2
  done
  fail "timed out waiting for enabled button: $name"
}

echo "=== 0. Create and fund passkey wallet ==="
ab find role button click --name "Create Smart Wallet" >/dev/null
wait_text "Wallet created!" 180 "Simulation failed|Deploy failed|Relayer not configured|Something went wrong"
WALLET_ADDR="$(body | grep -Eom1 'C[A-Z2-7]{55}')"
[[ -n "$WALLET_ADDR" ]] || fail "wallet contract address missing"

ab find role button click --name "Fund with Friendbot" >/dev/null
wait_text "Funded!" 180 "Friendbot failed|Simulation failed|Fund via relayer failed|Something went wrong"
grep -Eq '[1-9][0-9]*\.[0-9]+ XLM' <<<"$(body)" || fail "wallet balance did not increase"
echo "PASS wallet: $WALLET_ADDR"

echo "=== 1. Analyze transaction ==="
ab open "$BASE_URL/policies" >/dev/null
ab wait --text "Add Transaction Hashes" >/dev/null
ab find placeholder "Transaction hash..." fill "$TX_HASH" >/dev/null
ab press Enter >/dev/null
wait_text "Extracted Patterns" 120 "Transaction not found|Failed to analyze|pruned"
TARGET_ADDR="$(body | grep -Eom1 'C[A-Z2-7]{55}')"
[[ -n "$TARGET_ADDR" ]] || fail "analyzed target contract missing"
echo "PASS analyze: $TARGET_ADDR"

echo "=== 2. Build schema ==="
ab find role button click --name "Continue with 1 Pattern" >/dev/null
wait_text "Policy Details" 60
wait_enabled_button "Generate Policy Code" 120
grep -Fq "$TARGET_ADDR" <<<"$(body)" || fail "schema lost analyzed target contract"
echo "PASS schema: auto-policy"

echo "=== 3. Generate policy ==="
ab find role button click --name "Generate Policy Code" >/dev/null
wait_enabled_button "Test in Sandbox" 600
echo "PASS generation"

echo "=== 4. Compile and test ==="
ab find role button click --name "Test in Sandbox" >/dev/null
wait_text "3 passed" 900 "Compilation failed after [0-9]+ fix attempt|[0-9]+ test\(s\) failed"
wait_enabled_button "Deploy to Testnet" 180
echo "PASS sandbox: 3 passed"

echo "=== 5. Deploy policy ==="
ab find role button click --name "Deploy to Testnet" >/dev/null
wait_text "Install Policy on Wallet" 300 "Deploy failed \(|Deployment failed|Sandbox service not configured"
DEPLOY_BODY="$(body)"
POLICY_ADDR="$(grep -Eo 'C[A-Z2-7]{55}' <<<"$DEPLOY_BODY" | tail -1)"
WASM_HASH="$(grep -Eo '[0-9a-f]{64}' <<<"$DEPLOY_BODY" | tail -1)"
[[ -n "$POLICY_ADDR" && -n "$WASM_HASH" ]] || fail "deployment address or WASM hash missing"

export POLICY_ADDR WASM_HASH
node --input-type=module <<'NODE'
import { rpc } from "@stellar/stellar-sdk";
const server = new rpc.Server("https://soroban-testnet.stellar.org");
const instance = await server.getContractInstance(process.env.POLICY_ADDR);
const hash = Buffer.from(instance.executable().wasmHash()).toString("hex");
if (instance.executable().switch().name !== "contractExecutableWasm") throw new Error("deployed entry is not WASM");
if (hash !== process.env.WASM_HASH) throw new Error(`WASM hash mismatch: ${hash}`);
console.log(`PASS deploy RPC: ${process.env.POLICY_ADDR} (${hash})`);
NODE

echo "=== 6. Install policy on wallet ==="
ab find role button click --name "Install on Wallet" >/dev/null
wait_text "Policy Installed" 300 "Failed to call requestAddContextRule|Simulation request failed|Simulation failed:|Relayer failed|Passkey signing was cancelled|Install failed"
INSTALL_BODY="$(body)"
RULE_ID="$(awk '/Context Rule ID/{found=1; next} found && NF{print; exit}' <<<"$INSTALL_BODY")"
EPHEMERAL="$(grep -Eo 'G[A-Z2-7]{55}' <<<"$INSTALL_BODY" | tail -1)"
INSTALL_TX="$(grep -Eo '[0-9a-f]{64}' <<<"$INSTALL_BODY" | tail -1)"
[[ "$RULE_ID" =~ ^[0-9]+$ && -n "$EPHEMERAL" && -n "$INSTALL_TX" ]] || fail "install result fields missing"
[[ "$(ab eval "Object.keys(JSON.parse(localStorage.getItem('pollywallet:ephemeral-signers')||'{}')).includes('$EPHEMERAL')")" == "true" ]] \
  || fail "ephemeral signer secret was not persisted"

export WALLET_ADDR TARGET_ADDR RULE_ID EPHEMERAL INSTALL_TX
node --input-type=module <<'NODE'
import { rpc, StrKey } from "@stellar/stellar-sdk";
const server = new rpc.Server("https://soroban-testnet.stellar.org");
const tx = await server.getTransaction(process.env.INSTALL_TX);
if (tx.status !== "SUCCESS") throw new Error(`install transaction status: ${tx.status}`);
const count = await server.queryContract(process.env.WALLET_ADDR, "get_context_rules_count");
const rule = (await server.queryContract(process.env.WALLET_ADDR, "get_context_rule", {
  context_rule_id: Number(process.env.RULE_ID),
})).result;
const signer = StrKey.encodeEd25519PublicKey(Buffer.from(rule.signers[0].values[1]));
if (count.result < 2) throw new Error(`context rule count: ${count.result}`);
if (rule.id !== Number(process.env.RULE_ID)) throw new Error(`wrong rule id: ${rule.id}`);
if (rule.context_type.values[0] !== process.env.TARGET_ADDR) throw new Error("wrong target contract");
if (!rule.policies.includes(process.env.POLICY_ADDR)) throw new Error("policy missing from context rule");
if (signer !== process.env.EPHEMERAL) throw new Error("ephemeral signer mismatch");
console.log(`PASS install RPC: tx ${process.env.INSTALL_TX}, rule #${rule.id}, policy ${rule.policies[0]}`);
NODE

echo "=== 7. Verify policy-store listing ==="
ab open "$BASE_URL/rules" >/dev/null
wait_text "auto-policy" 120 "Failed to fetch context rules"
ab find role heading click --name "auto-policy" >/dev/null
wait_enabled_button "Code" 120
grep -Fq "$POLICY_ADDR" <<<"$(body)" || fail "policy address missing from Rules listing"
ab find role button click --name "Code" >/dev/null
wait_text "Rust source" 60
grep -Fq "pub struct PolicyContract" <<<"$(body)" || fail "saved Rust source missing from policy-store listing"

echo "PASS policy-store: auto-policy metadata and Rust source visible"
echo "ALL POLICY E2E CHECKS PASSED"
echo "Wallet: $WALLET_ADDR"
echo "Policy: $POLICY_ADDR"
echo "Install TX: $INSTALL_TX"
echo "Context rule: $RULE_ID"
