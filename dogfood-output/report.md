# Dogfood Report: PollyWallet Policy Builder

| Field | Value |
|-------|-------|
| **Date** | 2026-08-11 |
| **App URL** | http://localhost:4173/policies |
| **Session** | pollywallet-policy-e2e |
| **Scope** | Policy analyze, schema, generate, sandbox test, deploy, install, and policy-shape coverage |

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 4 |
| Medium | 3 |
| Low | 2 |
| **Total** | **9** |

## Issues

| Severity | Status | Area | Finding |
|----------|--------|------|---------|
| High | Fixed | Schema/test fixtures | User-defined ABI values such as `ChannelOperation` were rejected because the harness had no fixture representation. Analysis now retains raw ScVal XDR and generated tests replay it with `Val::from_xdr`. |
| High | Fixed | Wallet funding | A fresh Friendbot account could be used before the RPC/relayer observed it, producing account-missing and `Auth, InvalidAction` failures. Funding, simulation, and submission now wait/retry only the matching transient errors. |
| High | Fixed | Authorization | Source-account credentials were incorrectly converted into address credentials with an invented nonce. They are now rejected; fresh-account simulations use a throwaway source so Stellar returns address credentials legitimately. |
| High | Fixed | Install confirmation | The UI reported `Policy Installed` without checking the terminal transaction result. It now requires `SUCCESS`, retries policy visibility and relayer simulation propagation, and derives the rule ID from the confirmed result. |
| Medium | Fixed | Sandbox startup | Custom outbound host policy required `ContainerProxy` plus `enable_ctx_exports`; without them the container never became ready. |
| Medium | Fixed | Deploy | Deprecated `stellar contract install` and short propagation retries caused account-not-found / `Wasm does not exist` failures. Deployment now uses `upload` and bounded retries for testnet RPC lag. |
| Medium | Environment | Local Cloudflare preview | Docker `proxy-everything` intermittently/reset TLS to Stellar, including 100 seconds of consecutive `Connect` failures. The patched flow passed against a temporary private cloud sandbox; production was not changed and staging was deleted. |
| Low | Fixed | Generation | Kimi repeatedly emitted invalid `Val::VOID` comparisons and Option closure signatures. The prompt now gives the exact Soroban 27 idioms; the next sample passed all 14 tests on its first build. |
| Low | Fixed | E2E harness | The runner used stale button text, hard-coded `3 passed`, missed deploy errors, and assumed immediate RPC read-after-write. Selectors/counts/errors are current and RPC verification polls. |

## Verified flow

- Fresh virtual-WebAuthn wallet creation and XLM funding.
- Transaction analysis, schema generation, Kimi policy generation, real Rust compilation, and 14/14 generated tests.
- Testnet policy deployment and independent WASM-hash verification.
- Passkey-authorized policy install; wallet rule count became 2 and rule `#1` referenced the deployed policy.
- Rules UI displayed `auto-policy`, its policy address, metadata, and saved Rust source.

Evidence: `screenshots/policy-generation-live.png`, `screenshots/policy-installed-rules.png`.
