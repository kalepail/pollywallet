# Agent Guidelines for PollyWallet

## Research-First Development

When working on this project, **always use MCP tools and parallel-cli for research** before implementing features that touch external services:

### When to use MCPs

- **Cloudflare (Workers, Sandbox, AI, KV, D1)**: Use `search_cloudflare_documentation` MCP
- **Library/SDK docs**: Use `context7` MCP (resolve-library-id → query-docs)
- **Stellar/Soroban**: Use `deepwiki` for repo-level docs, `perplexity` for ecosystem questions
- **General web research**: Use `parallel-search` (web_search_preview + web_fetch)
- **Deep investigations**: Use `perplexity_research` for multi-source analysis
- **Bulk research**: Use `parallel-task` for enrichment across multiple items

### Research over assumptions

- Never rely solely on training data for API signatures, SDK usage, or service configurations
- Cloudflare, Stellar, and dependency APIs change frequently — always verify current docs
- When in doubt, fetch the actual documentation page rather than guessing

## Policy Builder Architecture

The policy builder feature uses several Cloudflare services together:

### Workers AI — Kimi K2.7 Code

Verified against the live model catalog and endpoint 2026-08-07. The previous version of this
section described `kimi-k2.5` and was wrong on five counts (model, prices, batch support,
caching mechanism, and the fact that k2.5 has been auto-aliased to k2.6 since 2026-05-30).

- Model ID: `@cf/moonshotai/kimi-k2.7-code` (see `src/lib/constants.ts`)
- 262,144-token context window; same figure is the max output, shared with the prompt
- Pricing: $0.95/M input, $0.19/M cached input, $4.00/M output
- Supports streaming and reasoning. **No batch API** on this model — `queueRequest: true`
  is not available (k2.6 has `async_queue`; k2.7-code does not)
- **Prompt caching is automatic**, no header needed — measured 99-100% hit rate, 64-token
  blocks. `x-session-affinity` only improves routing to a warm instance; pass it as a
  **constant** so all traffic shares the one cached system-prompt prefix
- **Reasoning cannot be disabled or throttled.** Reasoning shares `max_tokens` with the code
  and is 70-87% of every completion. Do not pass `chat_template_kwargs` or `reasoning_effort`
  — see the comment at the `ai.run()` call sites for the measured failure modes
- **Use `stream: true`.** Non-streaming requests time out (CF error 3046) at large budgets
- Rate limit: 20 rpm per account/model (50 with AI Gateway credits)
- Access via: `env.AI.run()` binding, REST API, or OpenAI-compatible endpoint. The binding can
  set headers: `env.AI.run(model, inputs, { extraHeaders })`

For the full authoring and tuning rationale see
`.claude/skills/soroban-policy-authoring/SKILL.md`.

### Cloudflare Sandbox — Policy Testing

- SDK: `@cloudflare/sandbox` (match npm version to Docker image tag)
- Base image: `docker.io/cloudflare/sandbox:0.12.4` (must match the `@cloudflare/sandbox` npm version)
- Custom Dockerfile: extend base image, preinstall Rust toolchain + stellar-cli
- Use WebSocket transport (`SANDBOX_TRANSPORT=websocket`) to avoid subrequest limits
- Instance types for Rust compilation:
  - `standard-2` (1 vCPU, 6 GiB RAM, 12 GB disk) — what this project uses
  - Custom: up to 4 vCPU, 12 GiB RAM, 20 GB disk
  - Do NOT use `lite` (1/16 vCPU, 256 MiB, 2 GB): the image alone is ~728 MB and
    rustc cannot build a Soroban contract in 256 MiB
- Key APIs: `exec()`, `writeFile()`, `readFile()`, `mkdir()`, `execStream()`
- Each request gets its own `/workspace/policy-<uuid>` directory. `CARGO_TARGET_DIR`
  is shared so the crate cache stays warm; cargo's lock serializes concurrent builds.
- The sandbox Worker sets `workers_dev: false` — its endpoints have no auth, so it is
  reachable only through the main Worker's `SANDBOX` service binding.
- Sandbox Dockerfile should preinstall:
  - Rust toolchain (rustup + wasm32 target)
  - `stellar-cli`
  - `soroban-sdk` dependencies
  - OpenZeppelin Stellar Contracts crate

### Policy Schema

- Version: `v0`
- Deterministic JSON schema bridges GUI → AI code generation
- Argument constraint kinds: unconstrained, exact, range, allowlist, blocklist
- Global rule types: threshold, weighted_threshold, time_lock
  (these are what `src/lib/policy-schema.ts` actually defines — the longer list
  in PLAN.md was never implemented)

## Stellar Smart Wallet Policies

Policies implement the `Policy` trait with three methods:
- `enforce()` — validates authorization during `__check_auth`
- `install()` — initializes policy storage when attached to a context rule
- `uninstall()` — cleans up storage when removed

Storage is keyed by `(smart_account_address, context_rule_id)`. Multiple policies on a rule use AND semantics. Reference implementations are in `stellar-contracts/packages/accounts/src/policies/`.

## Protocol

- Stellar testnet runs **Protocol 27** (verify with RPC `getVersionInfo`).
- `@stellar/stellar-sdk` **16.x** is the Protocol 27 line; 15.x is Protocol 26.
- Rust `soroban-sdk` major tracks the protocol: use **27.x** for Protocol 27.
  It is pinned in two places that must stay in sync — `CARGO_TOML_TEMPLATE`
  (`src/lib/policy-sandbox.ts`) and the prefetch in `sandbox-worker/Dockerfile`.

## Environment

- Testnet only — no mainnet safeguards needed yet
- Deploy via Cloudflare Workers
- pnpm workspace monorepo
- Server-side deploy signing for security
