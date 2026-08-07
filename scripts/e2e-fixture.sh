#!/usr/bin/env bash
set -euo pipefail

# Reusable testnet wallet with a CallContract rule and installed policy.
# The manifest contains public chain identifiers only; management signing still
# uses a fresh wallet/passkey in e2e-rules.sh.

BASE_URL="${1:-http://localhost:4173}"
BASE_URL="${BASE_URL%/}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FIXTURE_FILE="${E2E_FIXTURE_FILE:-$SCRIPT_DIR/.e2e-fixture.json}"
SESSION="skip1-fixture"

validate_fixture() {
  FIXTURE_FILE="$FIXTURE_FILE" node --input-type=module <<'NODE'
import { readFileSync } from "node:fs";
import { rpc, StrKey } from "@stellar/stellar-sdk";

const fixture = JSON.parse(readFileSync(process.env.FIXTURE_FILE, "utf8"));
for (const field of ["walletContractId", "targetContractId", "policyContractId"]) {
  if (!StrKey.isValidContract(fixture[field])) throw new Error(`invalid ${field}`);
}
if (!/^[0-9a-f]{64}$/.test(fixture.installTxHash)) throw new Error("invalid installTxHash");
if (!Number.isInteger(fixture.contextRuleId) || fixture.contextRuleId < 1) throw new Error("invalid contextRuleId");

const server = new rpc.Server("https://soroban-testnet.stellar.org");
const [tx, count, rule, policy] = await Promise.all([
  server.getTransaction(fixture.installTxHash),
  server.queryContract(fixture.walletContractId, "get_context_rules_count"),
  server.queryContract(fixture.walletContractId, "get_context_rule", {
    context_rule_id: fixture.contextRuleId,
  }),
  server.getContractInstance(fixture.policyContractId),
]);
if (tx.status !== "SUCCESS") throw new Error(`install transaction status: ${tx.status}`);
if (Number(count.result) < 2) throw new Error(`context rule count: ${count.result}`);
if (Number(rule.result.id) !== fixture.contextRuleId) throw new Error(`wrong rule id: ${rule.result.id}`);
if (rule.result.context_type?.tag !== "CallContract" || rule.result.context_type?.values?.[0] !== fixture.targetContractId)
  throw new Error("target CallContract rule mismatch");
if (!rule.result.policies?.includes(fixture.policyContractId)) throw new Error("installed policy missing from rule");
if (policy.executable().switch().name !== "contractExecutableWasm") throw new Error("policy is not a WASM contract");
console.log(`VALID fixture wallet ${fixture.walletContractId}, rule #${fixture.contextRuleId}, policy ${fixture.policyContractId}`);
NODE
}

write_proven_seed() {
  FIXTURE_FILE="$FIXTURE_FILE" node --input-type=module <<'NODE'
import { writeFileSync } from "node:fs";

const fixture = {
  version: 1,
  walletContractId: "CBQNMABM2H4FDTJWGYCDF4RND2UMCQWY3DE5LTGQS23MHX77JPTB7PGM",
  targetContractId: "CCQFTX5M5B3H3VHU54CM5MYRN5AD22C2STLWCYPUY2H2JL2NNHYMSKA4",
  policyContractId: "CCRCRRSATFJCPHHECXJAWTWYBNJ2OK7CNBZU4SISOSADDFBADJUX5ODU",
  installTxHash: "6d20c3c860e3b7c3536845a4ce8a18b00b22c8ee274595d780e99853a5e0e3d8",
  contextRuleId: 1,
  ruleName: "auto-policy",
};
writeFileSync(process.env.FIXTURE_FILE, `${JSON.stringify(fixture, null, 2)}\n`);
NODE
}

write_generated_fixture() {
  FIXTURE_FILE="$FIXTURE_FILE" POLICY_LOG="$POLICY_LOG" node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
import { rpc, scValToNative } from "@stellar/stellar-sdk";

const log = readFileSync(process.env.POLICY_LOG, "utf8");
const value = (label) => log.match(new RegExp(`^${label}: (.+)$`, "m"))?.[1]?.trim();
const walletContractId = value("Wallet");
const policyContractId = value("Policy");
const installTxHash = value("Install TX");
const contextRuleId = Number(value("Context rule"));
if (!walletContractId || !policyContractId || !installTxHash || !Number.isInteger(contextRuleId))
  throw new Error("policy E2E output did not contain fixture identifiers");

const tx = await new rpc.Server("https://soroban-testnet.stellar.org").getTransaction(installTxHash);
if (tx.status !== "SUCCESS" || !tx.returnValue) throw new Error(`install transaction status: ${tx.status}`);
const installed = scValToNative(tx.returnValue);
const targetContractId = installed.context_type?.[1];
if (installed.context_type?.[0] !== "CallContract" || !targetContractId)
  throw new Error("generated policy did not install a CallContract rule");

writeFileSync(process.env.FIXTURE_FILE, `${JSON.stringify({
  version: 1,
  walletContractId,
  targetContractId,
  policyContractId,
  installTxHash,
  contextRuleId,
  ruleName: installed.name || "auto-policy",
}, null, 2)}\n`);
NODE
}

if [[ ! -f "$FIXTURE_FILE" ]]; then
  write_proven_seed
fi

if validate_fixture; then
  echo "REUSE fixture: $FIXTURE_FILE"
  exit 0
fi

echo "REGENERATE fixture: cached rule no longer resolves on testnet"
ARTIFACT_DIR="$(mktemp -d)"
POLICY_LOG="$ARTIFACT_DIR/policy.log"
export SESSION BASE_URL POLICY_LOG
export WEBAUTHN_EVENTS_FILE="$ARTIFACT_DIR/webauthn.jsonl"

cleanup() {
  agent-browser --session "$SESSION" close 2>/dev/null || true
  rm -f "$POLICY_LOG" "$WEBAUTHN_EVENTS_FILE"
  rmdir "$ARTIFACT_DIR" 2>/dev/null || true
}
trap cleanup EXIT

agent-browser --session "$SESSION" close 2>/dev/null || true
agent-browser --session "$SESSION" open "$BASE_URL" >/dev/null
agent-browser --session "$SESSION" eval 'localStorage.clear()' >/dev/null
agent-browser --session "$SESSION" open "$BASE_URL" >/dev/null
node "$SCRIPT_DIR/agent-browser-webauthn-helper.mjs" run \
  --session "$SESSION" --require-credential true --timeout-ms 1800000 -- \
  bash -c 'set -o pipefail; bash "$1/e2e-policy.sh" "$2" --steps | tee "$3"' \
  -- "$SCRIPT_DIR" "$BASE_URL" "$POLICY_LOG"

grep -q '"event":"WebAuthn.credentialAdded"' "$WEBAUTHN_EVENTS_FILE"
grep -q '"event":"WebAuthn.credentialAsserted"' "$WEBAUTHN_EVENTS_FILE"
write_generated_fixture
validate_fixture
echo "CREATED fixture: $FIXTURE_FILE"
