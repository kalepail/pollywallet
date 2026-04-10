# Policy Builder — Implementation Plan

## Overview

A GUI-based policy builder that lets users input Stellar transaction hashes, analyze them to extract authorization patterns, generate a deterministic policy schema, use an AI agent (Cloudflare Workers AI / Kimi 2.5) to produce Rust/Soroban policy contract code, test it in a sandbox with the Stellar CLI, and finally compile, optimize, and deploy it to the network.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Policy Builder GUI                        │
│  ┌──────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │ TX Hash  │→ │ TX Analyzer  │→ │ Policy Schema Editor   │ │
│  │ Input    │  │ (decode XDR) │  │ (visual rule builder)  │ │
│  └──────────┘  └──────────────┘  └────────────────────────┘ │
│                                            │                 │
│                                            ▼                 │
│  ┌────────────────────────────────────────────────────────┐  │
│  │              Deterministic Policy Schema (JSON)         │  │
│  │  { contextType, allowedFns, limits, thresholds, ... }  │  │
│  └────────────────────────────────────────────────────────┘  │
│                            │                                 │
└────────────────────────────┼─────────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────┐
│               Cloudflare Worker (AI Agent)                   │
│  ┌─────────────┐  ┌───────────────┐  ┌──────────────────┐  │
│  │ Schema →    │→ │ Rust/Soroban  │→ │ Sandbox Test     │  │
│  │ Prompt Gen  │  │ Code Gen      │  │ (stellar-cli)    │  │
│  └─────────────┘  └───────────────┘  └──────────────────┘  │
│                                              │               │
│                                              ▼               │
│                    ┌──────────────────────────────────┐      │
│                    │ Compile → Optimize → Deploy WASM │      │
│                    └──────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────┘
```

---

## Phase 1 — Transaction Analysis & Pattern Extraction

### Goal
Parse transaction hashes via Stellar RPC to extract authorization patterns that inform policy rules.

### What we extract from a transaction

| Data Point | Source | Policy Relevance |
|---|---|---|
| Target contract address | `InvokeContractArgs.contractAddress` | `ContextRuleType::CallContract(addr)` |
| Function name | `InvokeContractArgs.functionName` | Filter enforcement to specific fns (e.g. `transfer`) |
| Arguments (amounts, recipients) | `InvokeContractArgs.args` as `ScVal` | Spending limits, allowlists |
| Auth entries | `SorobanAuthorizationEntry[]` | Signer requirements, context rule IDs |
| Signer identities | `AuthPayload.signers` map | Who signed and with what verifier |
| Context rule IDs used | `AuthPayload.context_rule_ids` | Which rules were invoked |
| Ledger sequence | Transaction metadata | Time-window calculations |

### Implementation

1. **`src/lib/tx-analyzer.ts`** — Fetch and decode transactions
   - `fetchTransaction(hash: string)` → call `server.getTransaction(hash)` on Stellar RPC
   - `decodeTransaction(xdr: string)` → parse XDR via `@stellar/stellar-sdk`
   - `extractPolicyPatterns(tx)` → return structured analysis:
     ```ts
     interface TxPattern {
       contractAddress: string;
       functionName: string;
       args: { type: string; value: string }[];
       signers: { type: 'Delegated' | 'External'; identity: string }[];
       amounts: { token: string; value: bigint }[];
     }
     ```

2. **GUI: Transaction list with decoded summaries**
   - Show each added tx hash with: target contract, function called, amounts, signers
   - Highlight common patterns across multiple transactions
   - Allow user to select which patterns to include in policy

### Files to create/modify
- `src/lib/tx-analyzer.ts` (new)
- `src/routes/policies.tsx` (update — wire up analysis)

---

## Phase 2 — Deterministic Policy Schema

### Goal
Define a JSON schema that deterministically describes a policy contract. This schema is the bridge between the GUI and the AI code generator — it must be unambiguous enough that the same schema always produces functionally equivalent code.

### Schema Definition

```jsonc
{
  "$schema": "pollywallet-policy/v1",
  "name": "my-transfer-policy",
  "description": "Limits XLM transfers to 100 per day with 2-of-3 approval",

  // What context this policy applies to
  "context": {
    "type": "CallContract",           // "Default" | "CallContract" | "CreateContract"
    "contractAddress": "CXXX...",     // only for CallContract
    "allowedFunctions": ["transfer"]  // optional function whitelist
  },

  // Rules that compose the policy's enforce() logic
  "rules": [
    {
      "type": "threshold",
      "params": {
        "threshold": 2                // M-of-N (N comes from context rule signers)
      }
    },
    {
      "type": "spending_limit",
      "params": {
        "limit": 1000000000,          // stroops (100 XLM)
        "period_ledgers": 17280       // ~1 day
      }
    },
    {
      "type": "allowlist",
      "params": {
        "addresses": ["GDEST1...", "GDEST2..."]  // allowed recipients
      }
    },
    {
      "type": "time_lock",
      "params": {
        "valid_after_ledger": 500000,
        "valid_until_ledger": 600000
      }
    },
    {
      "type": "function_whitelist",
      "params": {
        "allowed": ["transfer", "approve"]
      }
    }
  ],

  // Storage requirements (derived from rules)
  "storage": {
    "persistent": [
      { "key": "threshold", "type": "u32" },
      { "key": "spending_data", "type": "SpendingLimitData" }
    ]
  },

  // Events the policy emits
  "events": [
    { "name": "PolicyEnforced", "fields": ["smart_account", "context_rule_id", "amount"] },
    { "name": "PolicyInstalled", "fields": ["smart_account", "context_rule_id"] }
  ]
}
```

### Rule Types (extensible)

| Rule Type | Parameters | Enforce Logic |
|---|---|---|
| `threshold` | `threshold: u32` | `authenticated_signers.len() >= threshold` |
| `spending_limit` | `limit: i128, period_ledgers: u32` | Rolling window sum check on transfer amounts |
| `allowlist` | `addresses: string[]` | Transfer recipient must be in list |
| `blocklist` | `addresses: string[]` | Transfer recipient must NOT be in list |
| `time_lock` | `valid_after_ledger?, valid_until_ledger?` | Current ledger must be within window |
| `function_whitelist` | `allowed: string[]` | `fn_name` must be in allowed set |
| `max_single_transfer` | `max_amount: i128` | Single transfer amount cap |
| `daily_tx_count` | `max_count: u32, period_ledgers: u32` | Rate limiting by tx count |

### Implementation

1. **`src/lib/policy-schema.ts`** — Schema types and validation
   - TypeScript types mirroring the JSON schema
   - `validateSchema(schema)` → returns errors/warnings
   - `schemaFromPatterns(patterns: TxPattern[])` → auto-generate initial schema from analyzed txs

2. **GUI: Visual Rule Builder**
   - Card-based UI for adding/removing rules
   - Each rule type has a parameter form
   - Live schema preview (JSON)
   - Validation feedback

### Files to create/modify
- `src/lib/policy-schema.ts` (new)
- `src/routes/policies.tsx` (update — schema editor UI)
- `src/components/policy/` (new directory)
  - `RuleCard.tsx` — individual rule editor component
  - `SchemaPreview.tsx` — JSON preview panel
  - `PatternSummary.tsx` — shows extracted tx patterns

---

## Phase 3 — AI Code Generation (Cloudflare Worker)

### Goal
Send the deterministic schema to a Cloudflare Worker that uses Workers AI Kimi K2.5 (`@cf/moonshotai/kimi-k2.5`, 256k context) to generate a complete Rust/Soroban policy contract.

### Prompt Engineering Strategy

The AI prompt is constructed from:
1. **System prompt** — Full Policy trait definition, storage patterns, error handling conventions, and reference implementations (threshold, spending_limit) from `stellar-contracts/`
2. **User prompt** — The policy schema JSON + specific instructions

The system prompt includes:
- The `Policy` trait from `packages/accounts/src/policies/mod.rs`
- A complete reference implementation (e.g., `spending_limit.rs`)
- Soroban SDK conventions (`#[contract]`, `#[contractimpl]`, `#[contracttype]`, storage patterns)
- The `ContextRule`, `Signer`, `Context` type definitions

### Prompt Template

```
Given the following policy schema, generate a complete Soroban smart contract
that implements the Policy trait. The contract must:

1. Implement enforce(), install(), and uninstall() per the Policy trait
2. Use persistent storage keyed by (smart_account, context_rule_id)
3. Handle all error cases with contracterror
4. Emit contractevent for install, enforce, and uninstall
5. Include query functions for reading policy state
6. Follow the exact patterns from the reference implementation below

SCHEMA:
{policy_schema_json}

REFERENCE - Policy Trait:
{policy_trait_source}

REFERENCE - Spending Limit Implementation:
{spending_limit_source}

Generate ONLY the Rust source code. No markdown, no explanations.
```

### Implementation

1. **`src/lib/policy-codegen.ts`** — Client-side prompt assembly
   - `buildPrompt(schema: PolicySchema)` → assemble full prompt with references
   - `generatePolicyCode(schema)` → call Cloudflare Worker endpoint

2. **Cloudflare Worker endpoint** — `/api/policy/generate`
   - Receives schema JSON
   - Constructs prompt from schema + embedded reference code
   - Calls `env.AI.run("@cf/moonshotai/kimi-k2.5", { messages, stream: true })`
   - Uses `x-session-affinity` for prompt caching across iterative refinements
   - Returns streamed Rust source code via SSE
   - For batch/non-realtime: use `queueRequest: true` async API

3. **GUI: Code generation panel**
   - "Generate Policy" button
   - Streaming code output with syntax highlighting
   - Manual edit capability before proceeding to test

### Files to create/modify
- `src/lib/policy-codegen.ts` (new)
- `src/routes/policies.tsx` (update — code gen UI)
- `src/components/policy/CodeEditor.tsx` (new — display/edit generated code)
- Worker route or API endpoint for AI generation

---

## Phase 4 — Sandbox Testing

### Goal
Compile and test the generated policy contract in a sandboxed environment before deployment.

### Approach — Cloudflare Sandbox SDK

Using `@cloudflare/sandbox` with a custom Dockerfile preloaded with Rust + Stellar CLI.

- **Instance type**: `standard-2` (1 vCPU, 6 GiB RAM, 12 GB disk)
- **Base image**: `docker.io/cloudflare/sandbox:0.7.0` + Rust toolchain + stellar-cli
- **Transport**: WebSocket (`SANDBOX_TRANSPORT=websocket`) to multiplex many exec calls
- **Flow**: `writeFile()` source → `exec("stellar contract build")` → `exec("cargo test")` → `readFile()` WASM

### Test Strategy

For each generated policy, auto-generate tests that verify:

1. **Installation** — Policy installs with given params without panicking
2. **Enforcement (happy path)** — Valid transactions pass enforcement
3. **Enforcement (rejection)** — Invalid transactions are rejected
   - Over spending limit → `SpendingLimitExceeded`
   - Under threshold → `InsufficientSigners`
   - Wrong function → `NotAllowed`
   - Wrong contract → context type mismatch
4. **Uninstallation** — Clean removal of storage
5. **Edge cases** — Zero amounts, expired rules, empty signer sets

### Test Template Generation

From the schema, generate test cases:
```rust
#[test]
fn test_enforce_within_spending_limit() {
    // Setup: install policy with limit=100XLM, period=1day
    // Action: enforce transfer of 50XLM
    // Assert: no panic
}

#[test]
#[should_panic(expected = "SpendingLimitExceeded")]
fn test_enforce_exceeds_spending_limit() {
    // Setup: install policy with limit=100XLM
    // Action: enforce transfer of 150XLM
    // Assert: panic with SpendingLimitExceeded
}
```

### Implementation

1. **Sandbox service endpoint** — `/api/policy/test`
   - Receives: Rust source code + test cases
   - Creates temp Cargo project with dependencies
   - Runs `cargo test` with timeout
   - Returns: pass/fail results with output

2. **GUI: Test results panel**
   - Show test cases with pass/fail status
   - Show compilation errors if any
   - Allow re-generation with feedback loop back to AI

### Files to create/modify
- `src/lib/policy-sandbox.ts` (new — client for sandbox API)
- `src/components/policy/TestResults.tsx` (new)
- Sandbox worker/service (separate deployment)

---

## Phase 5 — Compile, Optimize & Deploy

### Goal
Take the tested policy contract, compile it to optimized WASM, and deploy it to Stellar testnet (and eventually mainnet).

### Compilation Pipeline

1. **Compile** — `stellar contract build` (produces `.wasm`)
2. **Optimize** — `stellar contract optimize` (reduces WASM size)
3. **Upload WASM** — `stellar contract upload --wasm policy.wasm`
4. **Deploy instance** — `stellar contract deploy --wasm-hash <hash>`
5. **Install on smart account** — Call `add_policy()` on the user's smart wallet

### Deploy Flow

```
Generated Rust → cargo build → optimize WASM → upload to network → deploy contract → install on wallet
                     ↑                                                        ↓
              sandbox service                                    returns contract address
```

### Implementation

1. **Deploy service endpoint** — `/api/policy/deploy`
   - Receives: compiled WASM (or source to compile)
   - Uploads WASM to Stellar testnet
   - Deploys contract instance
   - Returns: contract address + WASM hash

2. **Smart wallet integration** — Install policy on user's account
   - Call `add_policy(context_rule_id, policy_address, install_params)` via the existing relayer
   - Or `add_context_rule(...)` to create a new rule with the policy

3. **GUI: Deploy panel**
   - Network selector (testnet/mainnet)
   - Deploy button with progress indicator
   - Show deployed contract address
   - "Install on my wallet" button
   - Context rule configuration (which rule to attach to)

### Files to create/modify
- `src/lib/policy-deploy.ts` (new)
- `src/components/policy/DeployPanel.tsx` (new)
- `src/routes/policies.tsx` (update — full flow integration)
- Update `useWallet.ts` or new hook for policy management

---

## Phase 6 — Policy Management

### Goal
After deployment, allow users to view, update, and remove installed policies.

### Features
- List all context rules and their attached policies
- View policy state (current spending, thresholds)
- Update policy parameters (set_threshold, set_spending_limit)
- Remove policies from rules
- Share policy contracts (show contract address for others to install)

### Implementation
- `src/hooks/usePolicies.ts` (new — query and manage policies)
- `src/components/policy/PolicyList.tsx` (new)
- `src/components/policy/PolicyDetail.tsx` (new)

---

## Technical Decisions

### Why a deterministic schema?
- **Reproducibility** — same schema always means same policy behavior
- **Auditability** — users can review the schema before code generation
- **Versioning** — schemas can be saved, shared, versioned
- **AI-agnostic** — schema works regardless of which AI model generates the code
- **Testing** — test cases derive directly from schema, not from generated code

### Why server-side AI + sandbox?
- Rust compilation requires a full toolchain (not feasible in browser)
- AI models need large context windows for reference code
- Sandbox isolation prevents malicious code execution
- Cloudflare Workers provide global, low-latency execution

### Why not just compose existing policies?
- Existing policies (threshold, spending_limit) cover basic cases
- Custom policies enable novel logic: allowlists, rate limiting, time locks, multi-condition AND/OR
- GUI makes custom policies accessible to non-developers
- AI generation handles the Rust boilerplate complexity

---

## File Structure (final)

```
src/
├── routes/
│   ├── policies.tsx           # Main policy builder page (multi-step flow)
│   └── policies.$id.tsx       # Individual policy detail/management page
├── components/
│   └── policy/
│       ├── TxHashInput.tsx     # Transaction hash input + list
│       ├── PatternSummary.tsx  # Analyzed transaction patterns
│       ├── RuleCard.tsx        # Individual rule editor
│       ├── SchemaPreview.tsx   # JSON schema preview
│       ├── CodeEditor.tsx      # Generated code display/edit
│       ├── TestResults.tsx     # Sandbox test results
│       ├── DeployPanel.tsx     # Compile + deploy controls
│       ├── PolicyList.tsx      # Installed policies overview
│       └── PolicyDetail.tsx    # Single policy state + management
├── hooks/
│   └── usePolicies.ts         # Policy management hook
├── lib/
│   ├── tx-analyzer.ts         # Transaction fetching + pattern extraction
│   ├── policy-schema.ts       # Schema types, validation, auto-generation
│   ├── policy-codegen.ts      # Prompt assembly + AI worker client
│   ├── policy-sandbox.ts      # Sandbox testing client
│   └── policy-deploy.ts       # Compilation + deployment client
```

---

## Milestones

| # | Milestone | Deliverable |
|---|---|---|
| 1 | TX Analysis | Input hashes → decoded summaries with extracted patterns |
| 2 | Schema Editor | Visual rule builder → valid JSON policy schema |
| 3 | Code Generation | Schema → AI-generated Rust policy contract |
| 4 | Sandbox Testing | Generated code → compiled + tested in sandbox |
| 5 | Deploy Pipeline | Tested WASM → deployed contract on testnet |
| 6 | Wallet Integration | Deployed policy → installed on user's smart wallet |
| 7 | Policy Management | View, update, remove installed policies |

---

## Resolved Decisions

### 1. AI Model — Kimi K2.5 via Workers AI

- **Model ID**: `@cf/moonshotai/kimi-k2.5`
- **Context window**: 256,000 tokens (plenty for full Policy trait + reference impls + schema)
- **Capabilities**: Reasoning, function calling, streaming, structured outputs
- **Pricing**: $0.60/M input tokens, $0.10/M cached input, $3.00/M output tokens
- **Prompt caching**: Use `x-session-affinity` header for multi-turn conversations
- **Async batch**: `queueRequest: true` for non-realtime jobs (code gen can use this)
- **Access**: `env.AI.run("@cf/moonshotai/kimi-k2.5", { messages, stream: true })`

### 2. Sandbox — Cloudflare Sandbox SDK with Custom Dockerfile

Use `@cloudflare/sandbox` with a custom Dockerfile that preinstalls Rust + Stellar CLI.

**Instance type**: `standard-2` (1 vCPU, 6 GiB RAM, 12 GB disk) for Rust compilation.
If needed, custom instance: `{ vcpu: 2, memory_mib: 8192, disk_mb: 16000 }`.

**Custom Dockerfile**:
```dockerfile
FROM docker.io/cloudflare/sandbox:0.7.0

# Install Rust toolchain
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y \
    && . $HOME/.cargo/env \
    && rustup target add wasm32-unknown-unknown

# Install Stellar CLI
RUN curl -fsSL https://stellar.sh | bash

# Pre-cache soroban dependencies by building a template project
# (reduces per-build compile times)
```

**Wrangler config**:
```jsonc
{
  "containers": [{
    "class_name": "Sandbox",
    "image": "./sandbox/Dockerfile",
    "instance_type": "standard-2",
    "max_instances": 3
  }]
}
```

**Transport**: Use WebSocket transport (`SANDBOX_TRANSPORT=websocket`) to avoid hitting the 1,000 subrequest limit during multi-step compile workflows.

**Key SDK methods**:
- `sandbox.writeFile()` — write generated Rust source
- `sandbox.exec()` — run `stellar contract build`, `cargo test`, `stellar contract optimize`
- `sandbox.execStream()` — stream compilation output back to GUI
- `sandbox.readFile()` — read compiled `.wasm` output

### 3. Policy Sharing — Not now, save deployed policies

No marketplace yet. But every policy deployed through this service will be saved with:
- The schema that generated it
- The deployed contract address
- Deployment timestamp and network

Future: community policy schema registry.

### 4. Network — Testnet only

No mainnet safeguards needed. All deployments target Stellar Testnet.

### 5. Schema Versioning — Start at v0

- Schema `$schema` field: `"pollywallet-policy/v0"`
- Breaking changes increment the version
- Old schemas remain parseable (migration functions if needed)
