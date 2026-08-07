#!/usr/bin/env bash
set -euo pipefail

# PollyWallet E2E Test
# Runs the wallet lifecycle inside a single virtual WebAuthn authenticator.
#
# Requires: agent-browser, node
# Usage: pnpm test:e2e [-- url]
#   url defaults to http://localhost:3000

if [[ "${1:-}" == "--" ]]; then shift; fi
URL="${1:-http://localhost:3000}"
SESSION="e2e1-wallet"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ARTIFACT_DIR="$(mktemp -d)"

export WEBAUTHN_EVENTS_FILE="$ARTIFACT_DIR/webauthn.jsonl"
export WEBAUTHN_CONTROL_FILE="$ARTIFACT_DIR/webauthn-control.txt"
: >"$WEBAUTHN_CONTROL_FILE"

cleanup() {
  agent-browser --session "$SESSION" close 2>/dev/null || true
  rm -f "$WEBAUTHN_EVENTS_FILE" "$WEBAUTHN_CONTROL_FILE"
  rmdir "$ARTIFACT_DIR" 2>/dev/null || true
}
trap cleanup EXIT

echo "Opening $URL"
agent-browser --session "$SESSION" open "$URL" >/dev/null
sleep 2

export SESSION URL
export RECIPIENT="GAAH4OT36RRCCAGKARGPN2HLHT2NOBVFHO4GUHA6CF7UKQ4MMV24WQ4N"

node "$SCRIPT_DIR/agent-browser-webauthn-helper.mjs" run \
  --session "$SESSION" --require-credential true -- \
  bash "$SCRIPT_DIR/e2e-steps.sh"

grep -q '"event":"WebAuthn.credentialAdded"' "$WEBAUTHN_EVENTS_FILE"
grep -q '"event":"WebAuthn.credentialAsserted"' "$WEBAUTHN_EVENTS_FILE"
echo "WebAuthn events: credentialAdded + credentialAsserted"
