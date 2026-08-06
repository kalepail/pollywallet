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

### Workers AI — Kimi K2.5

- Model ID: `@cf/moonshotai/kimi-k2.5`
- 256k token context window
- Supports: streaming, reasoning, function calling, vision, batch
- Pricing: $0.60/M input, $0.10/M cached input, $3.00/M output
- Use `x-session-affinity` header for prompt caching in multi-turn
- Async batch API available via `queueRequest: true` for non-realtime workloads
- Access via: `env.AI.run()` binding, REST API, or OpenAI-compatible endpoint

### Cloudflare Sandbox — Policy Testing

- SDK: `@cloudflare/sandbox` (match npm version to Docker image tag)
- Base image: `docker.io/cloudflare/sandbox:0.8.7` (must match the `@cloudflare/sandbox` npm version)
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

## Environment

- Testnet only — no mainnet safeguards needed yet
- Deploy via Cloudflare Workers
- pnpm workspace monorepo
- Server-side deploy signing for security
