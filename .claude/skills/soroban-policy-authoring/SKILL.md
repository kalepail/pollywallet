---
name: soroban-policy-authoring
description: Ground truth for writing OpenZeppelin Stellar smart-account policy contracts and for maintaining the Kimi codegen prompt that generates them. Use this whenever the task touches src/lib/policy-codegen.ts, src/lib/policy-sandbox.ts, src/lib/policy-schema.ts or generated policy Rust; whenever a policy fails to compile, install, or enforce; whenever a transfer is rejected with (Auth, InvalidAction) or a spending cap behaves as though it were off by orders of magnitude; and whenever reviewing whether a policy actually fails closed. Reach for it even when the report sounds like a wallet, signer, or passkey problem rather than a policy one — install params and unit denominations are the usual culprits and are invisible from the UI. Do not use for general Soroban contract work unrelated to smart-account policies.
---

# Soroban smart-account policy authoring

## This file is NOT read by the running service

Editing it changes nothing in production. It is a Claude Code skill: it loads for an agent or
human working on this repo, and it is not imported by any runtime code, not bundled, and not
deployed.

**The only thing Kimi ever sees is `buildSystemPrompt()` in `src/lib/policy-codegen.ts`.** To
change how policies are generated, change that function. To change what a maintainer knows,
change this file. Usually a real finding belongs in both.

The two are deliberately not identical:

| Belongs in the prompt | Belongs only here |
|---|---|
| Facts the model needs to emit correct Rust — the ABI, both context shapes, fail-closed install, storage/TTL/event/error conventions | Facts about the model and the pipeline — reasoning cannot be disabled, caching behaviour, sandbox build-cache numbers, the `mock_all_auths` recording-mode trap |

Checked at the time of writing: every load-bearing prompt fact below is present in the
rendered prompt. The two that are not — the `<=15 signers / <=5 policies` and `name <=20
bytes` context-rule limits — are enforced by the smart account when a rule is *created*; a
policy contract only receives a rule, so it does not need them.

`policy-codegen.test.ts` pins the ones most likely to regress (both context shapes, the
fail-closed instruction, and the SDK version, which reads from `CARGO_TOML_TEMPLATE` rather
than a literal). If you add a load-bearing fact to the prompt, pin it there too — otherwise
nothing stops a future edit from quietly removing it.

Every claim here was verified against the checked-in submodule
`stellar-contracts/packages/accounts/` and the local clone of `stellar/smart-account-kit`
on 2026-08-07. **Re-verify after bumping the submodule.** Where a claim is measured against
the live Workers AI endpoint it says so.

Read this before changing `buildSystemPrompt()`. The prompt is downstream of these facts;
if the two disagree, the source wins.

## Units are a trust boundary — check them, never assume them

This class of bug shipped and silently bricked two live policies. It is listed first because
it produces a policy that compiles, passes its generated tests, installs cleanly, and then
rejects everything — with an error (`Auth, InvalidAction`) that names neither the amount nor
the bound.

**Token amounts are base units at the contract boundary.** `transfer(from, to, amount)` takes
`10_000_000` for 1 XLM. A user typing "100" into the Policy Builder meant 100 XLM; installing
`max_amount = 100` caps at 100 stroops = 0.00001 XLM. Reproduced on a real device: 0.00001 XLM
passed, 1 XLM failed, same rule, same destination, only the amount differed.

**The fix is to state the unit, not to convert it.** Constraint values are base units
everywhere — schema, install params, generated tests, the field the user types into — because
that is what the contract compares. The prompt tells Kimi bounds are already in the argument's
own units, so it compares them directly and never calls `decimals()` or scales inside a policy.

The first attempt at this converted instead: the builder took whole tokens and multiplied by
`10^decimals`. It was reverted, and the reason generalises. Converting requires deciding that
an argument *is* a token amount, and the heuristic used was "any `i128` on a contract that
answered `decimals()`". A policy can constrain any argument of any contract, so an `i128`
deadline, id, price or ratio would have been silently multiplied by ten million — the same
error the conversion existed to prevent, pointing the other way. **Units are a property of an
argument's meaning, and a contract spec carries types, not meaning.** Do not infer them.

What remains from that attempt, deliberately:

* `ContractPermission.decimals` is still **queried** with `requestTokenDecimals()` — never
  assumed, since 7 is a property of the asset, not of Stellar — but it is now display only. It
  renders `= 100.0000000` beside a typed `1000000000`, which is what makes a mis-scaled bound
  visible at the moment it is typed. Nothing derived from it is stored.
* Bounds are validated as whole numbers where they are entered. Left to drift they reach
  `BigInt()` at deploy and `${value}i128` in generated Rust, failing opaquely and far from the
  cause.

**Clocks have the same shape of trap.** `valid_after_ledger`/`valid_until_ledger` are ledger
sequences, compared against `e.ledger().sequence()` (u32) — never `e.ledger().timestamp()`
(u64 unix seconds). A live sequence is ~4e6 and a timestamp ~1.79e9, so the wrong clock does
not drift, it inverts: `timestamp() > valid_until_ledger` is true forever and the policy
rejects everything. Identical failure signature to the units bug.

**The lesson generalises.** Any value crossing into a contract has a denomination the type
system does not carry — `i128` says nothing about stroops, `u32` says nothing about ledgers
vs seconds. Verify each one against live docs or the chain (Stellar Raven MCP,
`stellarDocs.search_docs`, or just calling `decimals()`), and write the convention into the
prompt. A wrong unit is indistinguishable from a wrong policy until someone traces it on
a real device.

Not units, but the same "error names the wrong thing" family: sending a SAC-wrapped classic
asset to a `G...` address requires that account to hold a trustline, and fails with
`Error(Contract, #13) trustline entry is missing`. Contract (`C...`) addresses hold SAC
balances directly and need none.

## Check assumptions against Stellar Raven, not against memory

Every bug in this file began as something that felt obvious. Stroops felt obvious. The clock
felt obvious. Training data lags the protocol, and a confident wrong answer about a
denomination is indistinguishable from a correct one until it reaches a device.

So before writing or changing any rule that encodes a domain fact — a unit, a limit, an error
code, an ABI shape, a storage durability — spend the one call to confirm it:

* `mcp__stellar-raven__search` to find the right operation, then `mcp__stellar-raven__execute`
  to run several `stellarDocs.*` queries in one script. `search_asset_token_docs` for
  token/SAC semantics, `search_soroban_contract_docs` for storage, auth and TTL,
  `search_docs` for protocol fundamentals.
* Better still, ask the chain. `decimals()`, `getContractInstance().executable()`, and a
  read-only `simulateTransaction` settle questions that documentation can only describe.
  `scripts/inspect-wallet-policies.mts` does this for a live wallet.
* Cross-check anything surprising against a second source before acting. A Raven hit claimed
  the account canonicalises `key_data` by stripping the credential-id suffix; the chain showed
  97-byte entries with the suffix intact. Both were true — the stripping happens in the
  verifier at signature-check time, not in signer storage — and acting on the first reading
  alone would have broken sign-in.

This costs one tool call and a few seconds. The units bug cost two live policies and a
device-level debugging session to find.

## Accepted risks

Recorded so they read as decisions rather than oversights. Re-open them before mainnet.

* **`streamPolicyCode` is public and unauthenticated.** Any visitor can drive a policy
  generation, which spends Workers AI budget, sandbox container CPU, and — since the Raven
  research phase — calls a third-party MCP server on the owner's API key. Two independent
  reviewers rated this DO NOT SHIP. Accepted deliberately for testnet: the blast radius is
  spend and a possible Raven rate-limit, not key disclosure (the secret never reaches the
  client bundle or the stream) and not user funds. Rate limiting or an auth gate is the fix
  when this stops being a testnet toy.

* **Raven tool calls are uncapped per generation.** Bounded only by
  `RAVEN_RESEARCH_MAX_ROUNDS` model turns, not by call count. Deliberate — Raven is
  self-hosted and free to the owner. `RAVEN_REQUEST_TIMEOUT_MS` bounds the failure mode that
  actually mattered, which was a stalled request hanging a generation.

## The other things that are easy to get wrong

### 1. There are TWO context shapes, and the `execute()` wrapper is real

This is the easiest thing to get wrong, and a previous revision of the prompt got it exactly
backwards — it told the model the wrapper was a fiction, which deleted the handling that
Default-scoped rules actually need.

`do_check_auth` passes the host's original `auth::Context` to each policy **unchanged**, and
performs no rewriting. That much is true. The mistake is concluding a wrapper shape therefore
never occurs. The shape comes from the **host**, not from the account:

- **Shape A — direct call.** The target contract calls `require_auth(smart_account)`. Context
  is `{contract: target, fn_name: "transfer", args: [...]}`. This is what a **CallContract**
  rule sees.
- **Shape B — execute wrapper.** `execute(target, target_fn, target_args)` in
  `smart_account/mod.rs` calls `e.current_contract_address().require_auth()` *before*
  `invoke_contract`. Soroban's invoker-auth model builds that requirement's context from the
  **current invocation**, so the policy receives
  `{contract: smart_account, fn_name: "execute", args: [target, fn, inner_args]}`.
  This is what a **Default** rule sees.

Three independent confirmations:
1. `smart_account/mod.rs` — `execute()` calls `require_auth()` on itself first.
2. Soroban's invoker-auth semantics: `require_auth()` authorizes the *current* invocation.
3. **This repo's own `src/hooks/useWallet.ts`** builds `fn_name: "execute"` with
   `args[0..2]` on its default send path, and its comment documents both routes explicitly.

The misleading evidence that caused the error:

```
grep -rn "execute" stellar-contracts/packages/accounts/src/policies/   # returns nothing
```

That is true but proves nothing about the platform — all three OZ reference policies are
CallContract-scoped by design, so they only ever see Shape A.

**A generated policy cannot know at compile time which rule it will be attached to, so it must
handle both and default-reject on both.**

Rule matching keys on `context.contract`, so the shapes are mutually exclusive per rule: a
`Default` rule (or one scoped to the account's own address) sees Shape B; a
`CallContract(token)` rule is never selected for an execute-routed call. And under Shape B the
inner call is a direct contract-to-contract invocation, which Soroban always authorizes — **it
never appears as a separate authorization context.** A policy receiving an execute context
must therefore enforce everything against the unwrapped inner call immediately; no second
`enforce()` arrives for it.

### Testing policies through the account

`mock_all_auths()` / `mock_auths()` put the host in *recording* mode, which marks auths
authenticated without ever invoking the account contract — so `__check_auth`, and therefore
any attached policy, **never runs** through those. Paths that do run it: `env.set_auths(&[…])`
with a real `SorobanAuthorizationEntry`, `env.try_invoke_contract_check_auth(..)`, or calling
`do_check_auth` inside `e.as_contract(..)` with hand-built contexts (OZ's own idiom, see
`smart_account/test/context_rules.rs`). On host 27.0.1 `mock_auths` additionally failed a
structurally-correct entry with a misleading "unknown contract function" error; prefer
`set_auths`.

This does **not** affect PollyWallet's generated suite, which unit-tests the policy contract
directly via its own client (the same approach OZ's policy tests take). It matters only if you
try to test the full account → policy path.

### 2. Install params must fail closed

The wire contract: the smart account passes `install_params` through untouched
(`storage.rs`, `PolicyClient::new(e, &policy).install(&param, ...)`). PollyWallet sends a
Symbol-keyed `ScVal::Map` — which in Soroban is *also* the canonical serialization of a
`#[contracttype]` struct, so a typed struct with matching field names produces identical
bytes. The kit's own encoder pins this shape in a test.

So the encoding is correct. The **defaulting** is the bug. Any instruction of the form
"use `.unwrap_or()` so install succeeds even if a key is missing", or "when params is void
use maximum/permissive defaults", converts a malformed install into a policy that
authorizes everything. Every constraint the schema declares is required configuration:
absent or unparseable ⇒ panic. Decode with `TryFromVal`, never `FromVal` + `unwrap()`.

### 3. The ABI is `Val`, but the trait is typed

Both statements are true and they are not in conflict:

- The Rust trait declares `type AccountParams: FromVal<Env, Val>` and
  `fn install(e, install_params: Self::AccountParams, ...)`.
- `#[contractclient]` cannot carry an associated type, so OpenZeppelin declares a separate
  internal `PolicyClientInterface` whose `install` takes `Val`. That is the cross-contract
  ABI.

A **standalone** generated contract must therefore export
`install(e: &Env, install_params: Val, ...)` and decode it itself. Do not tell the model
its signatures "must match the Policy trait exactly" *and* that install takes `Val` — that
pair of instructions is contradictory and makes the model oscillate.

## Required ABI

Exactly these three, and nothing more is required:

```rust
pub fn enforce(e: &Env, context: Context, authenticated_signers: Vec<Signer>,
               context_rule: ContextRule, smart_account: Address)
pub fn install(e: &Env, install_params: Val, context_rule: ContextRule, smart_account: Address)
pub fn uninstall(e: &Env, context_rule: ContextRule, smart_account: Address)
```

Smart-account-kit never introspects a policy's spec; `policy-clients.ts` hard-codes clients
for exactly the three OpenZeppelin example policies. Getters/setters are optional — add
them only when there is genuinely reconfigurable state.

## Enforcement semantics

- `enforce` runs once per **(auth context × attached policy)** pair — not once per
  transaction.
- Policies on a rule are **AND**. All must pass.
- A panic in `enforce` aborts the whole transaction (it is a plain call). Only `uninstall`
  is best-effort, via `try_uninstall`.
- `authenticated_signers` is the account's already-verified subset of the rule's signers.
  It carries **identities only**, never signature bytes. It may be empty for a policy-only
  rule and may be a proper subset. Never attempt signature verification in `enforce`.
- Context may also be a contract-creation variant. Reject unless the schema allows it.

## Conventions to mirror

| Concern | Convention |
|---|---|
| Storage | one persistent key `AccountContext(Address, u32)` = (smart_account, context_rule_id). Policies are multi-tenant; never key by rule id alone or globally. No temporary/instance storage in any reference policy. |
| TTL | `DAY_IN_LEDGERS = 17_280`; `EXTEND_AMOUNT = 30 * DAY = 518_400`; `TTL_THRESHOLD = EXTEND_AMOUNT - DAY = 501_120`. Extend on read. |
| Events | the **only** `#[topic]` is `smart_account: Address`; everything else is data. |
| Error codes | **start at 4000.** `3000-3227` is reserved by OpenZeppelin: smart account 3000-3016, WebAuthn 3110-3119, simple threshold 3200-3203, weighted 3210-3214, spending limit 3220-3227. The kit maps these to fixed messages, so reuse renders the wrong error. |
| Derives | `Signer`: `Clone, Debug, PartialEq, Eq, PartialOrd, Ord`. `ContextRuleType`: `Clone, Debug, PartialEq, Eq`. `ContextRule`: `Clone, Debug, PartialEq`. Matters when `Signer` is used as a `Map` key. |

Account invariants worth encoding: ≤15 signers, ≤5 policies, not both empty, name ≤20
bytes, external key data ≤256 bytes, `valid_until` inclusive (expires only when
`n < current_ledger`), ids monotonic and never recycled.

## SDK version

The prompt must name the SDK the sandbox actually builds. `CARGO_TOML_TEMPLATE` in
`src/lib/policy-sandbox.ts` is the source of truth (currently **27.0.5**). Note the
submodule itself pins 25.3.0 — that is fine, because generated contracts are standalone and
never link `stellar-accounts`, but it means you cannot infer the right version from the
submodule.

## Sandbox build cache

`sandbox-worker/Dockerfile` compiles the dependency graph into the shared
`CARGO_TARGET_DIR` at image-build time. Two graphs are needed and they share **no** compiled
artifacts: `cargo test` builds the host target with `testutils`, `stellar contract build`
builds `wasm32v1-none` release. Warming one does not warm the other.

Measured locally (fast laptop; a 1-vCPU `standard-2` container will be several times slower):

| | time | crates compiled |
|---|---|---|
| request build, prebuild hit | **2 s** | 1 — just the policy |
| same build, no prebuilt artifacts | 22 s | 150 |
| image-build prebuild (one-off) | 37 s | 1.1 GB of artifacts |

The earlier "60–120 s" figure in the code comments was for *downloading* sources, which the
old image already did via `cargo fetch`. The real gap was the ~150-crate compile.

Dependency artifacts are keyed by (package, features, profile, target, rustc), not by the
consuming crate's path, so per-request `/workspace/policy-<uuid>` dirs still hit the cache —
verified by building in a different directory.

**If it stops hitting**, the symptom is ~150 `Compiling` lines in the streamed cargo output
instead of one. Look at `seedLockfile()`: requests build `--locked --offline` against the
`Cargo.lock` the image compiled from, and if that lockfile is missing or the versions in
`CARGO_TOML_TEMPLATE` drifted from the Dockerfile's copy, cargo re-resolves and every
artifact is invalidated while the image still carries them.

## Kimi K2.7 Code: what the model will and will not do

Measured against the live endpoint, 2026-08-07.

- **Reasoning cannot be disabled or throttled.** `enable_thinking: false` (the real schema
  key) is an inert no-op. `thinking: false` is *not* a schema key and is harmful — it drops
  the `reasoning_content` channel so reasoning prose lands in `delta.content` and poisons
  the code buffer. `reasoning_effort` is server-validated but its measured effect is
  unreliable, and `"none"` fails the same way as `thinking: false`. **Pass none of them.**
- **Reasoning and code share `max_tokens`** (`reasoning_content + content <= max_tokens`),
  and reasoning is 70-87% of every completion. At `max_tokens: 256` the model emits 256
  tokens of reasoning and zero code.
- **Reasoning length is what varies, not output size.** The same trivial schema produced
  6,578 and 14,947 completion tokens on consecutive runs, while code stayed at ~8.1-8.3 KB.
- **Prefix caching is automatic**, no header required — measured 99-100% hit rate in
  64-token blocks. The `x-session-affinity` header should be a **constant**, not per-user;
  a per-user key fragments the shared system-prompt cache.
- **Streaming is load-bearing.** Non-streaming requests time out (CF error 3046) at large
  budgets.
- Rate limit is **20 rpm** per account/model (50 with AI Gateway credits). No batch API on
  `kimi-k2.7-code`.

Practical consequence: **do not trim the system prompt for cost.** It is ~6,275 tokens,
2.4% of the 262,144 context, and it caches at ~100%. Remove content because it is *wrong*,
never because it is long — the reference implementations are the highest-value tokens in
it. Generation is 97-99.5% of end-to-end wall clock, so sandbox speedups optimise the
remaining 1-3%.

## What the generated test suite must prove

`generateTestCases()` in `src/lib/policy-sandbox.ts` is the only gate between an AI-written
contract and a testnet deploy. Two invariants are generated for **every** schema, regardless
of which constraint kinds it uses, because without them a policy whose `enforce()` body is
empty passes everything else:

- `test_enforce_rejects_unknown_function` / `test_enforce_rejects_unknown_contract` —
  default-deny.
- `test_enforce_requires_smart_account_auth` — every other test runs under
  `mock_all_auths()`, which hides a missing `require_auth()`. This one uses
  `env.set_auths(&[])`.

Rules for anything you add:

- Use `client.try_<fn>(...).is_err()`, never bare `#[should_panic]`. A bare should_panic is
  satisfied by *any* panic — including one from install, address decoding, or argument
  conversion — so a policy can pass a rejection test without ever rejecting anything.
- Open every negative test with a **positive control**: the compliant call must succeed
  first, so the failure is attributable to the mutation and not to broken setup.
- Build a context per `(contract, function)`. Reusing `contracts[0].functions[0]` meant a
  test nominally about contract #2 actually sent contract #1's context.
- Generate both sides of every boundary. An allowlist that only tests the allowed value is
  passed by a policy that allows everything.
- Scope test names with the `c{i}_f{j}` index — two functions sharing an argument name
  otherwise emit duplicate Rust fns and the crate fails to compile.
- A run that parsed **zero** tests is a failure, not a pass (`[].every()` is `true`).

Verify changes with mutation testing, not just by reading the output. Take a policy known to
compile, gut its `enforce()` to `{}` (keeping `require_auth`), and confirm the suite fails;
then remove `require_auth` and confirm the auth test fails. Both mutants must be caught.

## When a generated policy fails

1. **Truncated / unclosed delimiter / zero bytes** → token budget, not model quality. Check
   `finish_reason`. This is the unrecoverable class: `buildFixPrompt` cannot repair severed
   source.
2. **One or two ordinary type errors** → the recoverable class; the fix pass handles it.
   Raising the budget converts failures from class 1 into class 2, which is the main value
   of the budget change.
3. **Prose mixed into the Rust** → something disabled the `reasoning_content` channel.
   Check for `thinking: false` or `reasoning_effort: "none"`.
4. **Installs but authorizes everything** → permissive defaults. See §2 above.
5. **Installs, tests green, then rejects every real transaction** → the install params, not
   the policy logic. `(Auth, InvalidAction)` names neither the value nor the bound, so read
   them off the chain rather than reasoning about them:

   ```bash
   npx tsx .claude/skills/soroban-policy-authoring/scripts/inspect-wallet-policies.mts C...
   ```

   It prints every rule, its signers, and each policy's stored params — converting bounds
   into whole tokens using the target's real `decimals()`. A cap reading
   `max_amount = 100 base units = 0.00001 tokens` is the units bug from the top of this file.
   `NOT INSTALLED for this account` means `install()` never ran and `enforce()` fails closed.
