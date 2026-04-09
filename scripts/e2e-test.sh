#!/usr/bin/env bash
set -euo pipefail

# PollyWallet E2E Test
# Runs create, fund, transfer inside a single virtual WebAuthn authenticator.
#
# Requires: agent-browser, node
# Usage: pnpm test:e2e [-- url]
#   url defaults to http://localhost:3000

URL="${1:-http://localhost:3000}"
SESSION="pw-e2e-$$"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

cleanup() {
  agent-browser --session "$SESSION" close 2>/dev/null || true
}
trap cleanup EXIT

echo "Opening $URL"
agent-browser --session "$SESSION" open "$URL" >/dev/null
sleep 2

export SESSION URL
export RECIPIENT="GAAH4OT36RRCCAGKARGPN2HLHT2NOBVFHO4GUHA6CF7UKQ4MMV24WQ4N"

node "$SCRIPT_DIR/agent-browser-webauthn-helper.mjs" run --session "$SESSION" -- \
  bash "$SCRIPT_DIR/e2e-steps.sh"
