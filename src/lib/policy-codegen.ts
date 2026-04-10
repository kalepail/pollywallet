import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import type { PolicySchema, ArgPermission } from "./policy-schema";
import { schemaToJSON, validateSchema } from "./policy-schema";

// --- Reference source code embedded as constants ---
// These are the COMPLETE real implementations from the OpenZeppelin Stellar Contracts repo.
// With 256k context on Kimi K2.5, we include full source for maximum fidelity.

const POLICY_TRAIT_SOURCE = `\
use soroban_sdk::{auth::Context, contractclient, Address, Env, FromVal, Val, Vec};

pub trait Policy {
    type AccountParams: FromVal<Env, Val>;

    fn enforce(
        e: &Env,
        context: Context,
        authenticated_signers: Vec<Signer>,
        context_rule: ContextRule,
        smart_account: Address,
    );

    fn install(
        e: &Env,
        install_params: Self::AccountParams,
        context_rule: ContextRule,
        smart_account: Address,
    );

    fn uninstall(e: &Env, context_rule: ContextRule, smart_account: Address);
}

#[contractclient(name = "PolicyClient")]
trait PolicyClientInterface {
    fn enforce(
        e: &Env,
        context: Context,
        authenticated_signers: Vec<Signer>,
        context_rule: ContextRule,
        smart_account: Address,
    );
    fn install(e: &Env, install_params: Val, context_rule: ContextRule, smart_account: Address);
    fn uninstall(e: &Env, context_rule: ContextRule, smart_account: Address);
}`;

const CORE_TYPES_SOURCE = `\
// These types come from the smart_account module. Your generated contract
// MUST define them inline (they are passed to your functions by the smart account
// at runtime). Copy these EXACTLY into your contract file.
//
// REQUIRED IMPORTS for these types (include at the top of your file):
//   use soroban_sdk::{Address, Bytes, BytesN, String, Vec};
//   use soroban_sdk::auth::{Context, ContractContext};
//   use soroban_sdk::{FromVal, TryFromVal, IntoVal, TryIntoVal, Val};

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum Signer {
    Delegated(Address),
    External(Address, Bytes),
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum ContextRuleType {
    Default,
    CallContract(Address),
    CreateContract(BytesN<32>),
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ContextRule {
    pub id: u32,
    pub context_type: ContextRuleType,
    pub name: String,
    pub signers: Vec<Signer>,
    pub signer_ids: Vec<u32>,
    pub policies: Vec<Address>,
    pub policy_ids: Vec<u32>,
    pub valid_until: Option<u32>,
}`;

// COMPLETE spending_limit_policy example contract — this is what a deployed policy looks like.
// It wraps the library spending_limit module functions.
const SPENDING_LIMIT_CONTRACT_EXAMPLE = `\
use soroban_sdk::{auth::Context, contract, contractimpl, Address, Env, Vec};
use stellar_accounts::{
    policies::{spending_limit, Policy},
    smart_account::{ContextRule, Signer},
};

#[contract]
pub struct SpendingLimitPolicyContract;

#[contractimpl]
impl Policy for SpendingLimitPolicyContract {
    type AccountParams = spending_limit::SpendingLimitAccountParams;

    fn enforce(e: &Env, context: Context, authenticated_signers: Vec<Signer>,
               context_rule: ContextRule, smart_account: Address) {
        spending_limit::enforce(e, &context, &authenticated_signers, &context_rule, &smart_account)
    }

    fn install(e: &Env, install_params: Self::AccountParams,
               context_rule: ContextRule, smart_account: Address) {
        spending_limit::install(e, &install_params, &context_rule, &smart_account)
    }

    fn uninstall(e: &Env, context_rule: ContextRule, smart_account: Address) {
        spending_limit::uninstall(e, &context_rule, &smart_account)
    }
}

#[contractimpl]
impl SpendingLimitPolicyContract {
    pub fn get_spending_limit_data(e: Env, context_rule_id: u32, smart_account: Address)
        -> spending_limit::SpendingLimitData {
        spending_limit::get_spending_limit_data(&e, context_rule_id, &smart_account)
    }
    pub fn set_spending_limit(e: Env, spending_limit: i128, context_rule: ContextRule, smart_account: Address) {
        spending_limit::set_spending_limit(&e, spending_limit, &context_rule, &smart_account)
    }
}`;

// COMPLETE spending_limit.rs library — the full implementation with all types, storage, events, and logic.
const SPENDING_LIMIT_REFERENCE = `\
use soroban_sdk::{
    auth::{Context, ContractContext},
    contracterror, contractevent, contracttype, panic_with_error, symbol_short, Address, Env,
    TryFromVal, Vec,
};

#[contractevent]
#[derive(Clone)]
pub struct SpendingLimitEnforced {
    #[topic]
    pub smart_account: Address,
    pub context: Context,
    pub context_rule_id: u32,
    pub amount: i128,
    pub total_spent_in_period: i128,
}

#[contractevent]
#[derive(Clone, Debug)]
pub struct SpendingLimitInstalled {
    #[topic]
    pub smart_account: Address,
    pub context_rule_id: u32,
    pub spending_limit: i128,
    pub period_ledgers: u32,
}

#[contractevent]
#[derive(Clone, Debug)]
pub struct SpendingLimitChanged {
    #[topic]
    pub smart_account: Address,
    pub context_rule_id: u32,
    pub spending_limit: i128,
}

#[contractevent]
#[derive(Clone, Debug)]
pub struct SpendingLimitUninstalled {
    #[topic]
    pub smart_account: Address,
    pub context_rule_id: u32,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct SpendingLimitAccountParams {
    pub spending_limit: i128,
    pub period_ledgers: u32,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct SpendingLimitData {
    pub spending_limit: i128,
    pub period_ledgers: u32,
    pub spending_history: Vec<SpendingEntry>,
    pub cached_total_spent: i128,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct SpendingEntry {
    pub amount: i128,
    pub ledger_sequence: u32,
}

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum SpendingLimitError {
    SmartAccountNotInstalled = 3220,
    SpendingLimitExceeded = 3221,
    InvalidLimitOrPeriod = 3222,
    NotAllowed = 3223,
    HistoryCapacityExceeded = 3224,
    AlreadyInstalled = 3225,
    LessThanZero = 3226,
    OnlyCallContractAllowed = 3227,
}

#[contracttype]
pub enum SpendingLimitStorageKey {
    AccountContext(Address, u32),
}

const DAY_IN_LEDGERS: u32 = 17280;
pub const SPENDING_LIMIT_EXTEND_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
pub const SPENDING_LIMIT_TTL_THRESHOLD: u32 = SPENDING_LIMIT_EXTEND_AMOUNT - DAY_IN_LEDGERS;
pub const MAX_HISTORY_ENTRIES: u32 = 1000;

pub fn get_spending_limit_data(e: &Env, context_rule_id: u32, smart_account: &Address) -> SpendingLimitData {
    let key = SpendingLimitStorageKey::AccountContext(smart_account.clone(), context_rule_id);
    e.storage().persistent().get(&key)
        .inspect(|_| {
            e.storage().persistent().extend_ttl(&key, SPENDING_LIMIT_TTL_THRESHOLD, SPENDING_LIMIT_EXTEND_AMOUNT);
        })
        .unwrap_or_else(|| panic_with_error!(e, SpendingLimitError::SmartAccountNotInstalled))
}

pub fn enforce(e: &Env, context: &Context, authenticated_signers: &Vec<Signer>,
               context_rule: &ContextRule, smart_account: &Address) {
    smart_account.require_auth();
    if authenticated_signers.is_empty() { panic_with_error!(e, SpendingLimitError::NotAllowed) }
    let key = SpendingLimitStorageKey::AccountContext(smart_account.clone(), context_rule.id);
    let mut data = get_spending_limit_data(e, context_rule.id, smart_account);
    let current_ledger = e.ledger().sequence();
    match context {
        Context::Contract(ContractContext { fn_name, args, .. }) => {
            if fn_name == &symbol_short!("transfer") {
                if let Some(amount_val) = args.get(2) {
                    if let Ok(amount) = i128::try_from_val(e, &amount_val) {
                        if amount < 0 { panic_with_error!(e, SpendingLimitError::LessThanZero) }
                        let removed = cleanup_old_entries(&mut data.spending_history, current_ledger, data.period_ledgers);
                        data.cached_total_spent -= removed;
                        if data.cached_total_spent + amount > data.spending_limit {
                            panic_with_error!(e, SpendingLimitError::SpendingLimitExceeded)
                        }
                        if data.spending_history.len() >= MAX_HISTORY_ENTRIES {
                            panic_with_error!(e, SpendingLimitError::HistoryCapacityExceeded)
                        }
                        data.spending_history.push_back(SpendingEntry { amount, ledger_sequence: current_ledger });
                        data.cached_total_spent += amount;
                        e.storage().persistent().set(&key, &data);
                        SpendingLimitEnforced {
                            smart_account: smart_account.clone(), context: context.clone(),
                            context_rule_id: context_rule.id, amount, total_spent_in_period: data.cached_total_spent,
                        }.publish(e);
                        return;
                    }
                }
            }
        }
        _ => { panic_with_error!(e, SpendingLimitError::NotAllowed) }
    }
    panic_with_error!(e, SpendingLimitError::NotAllowed)
}

pub fn install(e: &Env, params: &SpendingLimitAccountParams, context_rule: &ContextRule, smart_account: &Address) {
    smart_account.require_auth();
    if !matches!(context_rule.context_type, ContextRuleType::CallContract(_)) {
        panic_with_error!(e, SpendingLimitError::OnlyCallContractAllowed)
    }
    if params.spending_limit <= 0 || params.period_ledgers == 0 {
        panic_with_error!(e, SpendingLimitError::InvalidLimitOrPeriod)
    }
    let key = SpendingLimitStorageKey::AccountContext(smart_account.clone(), context_rule.id);
    if e.storage().persistent().has(&key) { panic_with_error!(e, SpendingLimitError::AlreadyInstalled) }
    let data = SpendingLimitData {
        spending_limit: params.spending_limit, period_ledgers: params.period_ledgers,
        spending_history: Vec::new(e), cached_total_spent: 0,
    };
    e.storage().persistent().set(&key, &data);
    SpendingLimitInstalled {
        smart_account: smart_account.clone(), context_rule_id: context_rule.id,
        spending_limit: params.spending_limit, period_ledgers: params.period_ledgers,
    }.publish(e);
}

pub fn uninstall(e: &Env, context_rule: &ContextRule, smart_account: &Address) {
    smart_account.require_auth();
    let key = SpendingLimitStorageKey::AccountContext(smart_account.clone(), context_rule.id);
    if !e.storage().persistent().has(&key) { panic_with_error!(e, SpendingLimitError::SmartAccountNotInstalled) }
    e.storage().persistent().remove(&key);
    SpendingLimitUninstalled { smart_account: smart_account.clone(), context_rule_id: context_rule.id }.publish(e);
}

fn cleanup_old_entries(spending_history: &mut Vec<SpendingEntry>, current_ledger: u32, period_ledgers: u32) -> i128 {
    let cutoff_ledger = current_ledger.saturating_sub(period_ledgers);
    let mut removed_total = 0i128;
    while let Some(entry) = spending_history.get(0) {
        if entry.ledger_sequence <= cutoff_ledger {
            removed_total += entry.amount;
            spending_history.pop_front();
        } else { break; }
    }
    removed_total
}`;

// COMPLETE threshold_policy example contract
const THRESHOLD_CONTRACT_EXAMPLE = `\
use soroban_sdk::{auth::Context, contract, contractimpl, Address, Env, Vec};
use stellar_accounts::{
    policies::{simple_threshold, Policy},
    smart_account::{ContextRule, Signer},
};

#[contract]
pub struct ThresholdPolicyContract;

#[contractimpl]
impl Policy for ThresholdPolicyContract {
    type AccountParams = simple_threshold::SimpleThresholdAccountParams;

    fn enforce(e: &Env, context: Context, authenticated_signers: Vec<Signer>,
               context_rule: ContextRule, smart_account: Address) {
        simple_threshold::enforce(e, &context, &authenticated_signers, &context_rule, &smart_account)
    }

    fn install(e: &Env, install_params: Self::AccountParams,
               context_rule: ContextRule, smart_account: Address) {
        simple_threshold::install(e, &install_params, &context_rule, &smart_account)
    }

    fn uninstall(e: &Env, context_rule: ContextRule, smart_account: Address) {
        simple_threshold::uninstall(e, &context_rule, &smart_account)
    }
}

#[contractimpl]
impl ThresholdPolicyContract {
    pub fn get_threshold(e: &Env, context_rule_id: u32, smart_account: Address) -> u32 {
        simple_threshold::get_threshold(e, context_rule_id, &smart_account)
    }
    pub fn set_threshold(e: Env, threshold: u32, context_rule: ContextRule, smart_account: Address) {
        simple_threshold::set_threshold(&e, threshold, &context_rule, &smart_account)
    }
}`;

// COMPLETE simple_threshold.rs library implementation
const SIMPLE_THRESHOLD_REFERENCE = `\
use soroban_sdk::{
    auth::Context, contracterror, contractevent, contracttype, panic_with_error, Address, Env, Vec,
};

#[contractevent]
#[derive(Clone)]
pub struct SimpleEnforced {
    #[topic]
    pub smart_account: Address,
    pub context: Context,
    pub context_rule_id: u32,
    pub authenticated_signers: Vec<Signer>,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SimpleInstalled {
    #[topic]
    pub smart_account: Address,
    pub context_rule_id: u32,
    pub threshold: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SimpleUninstalled {
    #[topic]
    pub smart_account: Address,
    pub context_rule_id: u32,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct SimpleThresholdAccountParams {
    pub threshold: u32,
}

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum SimpleThresholdError {
    SmartAccountNotInstalled = 3200,
    InvalidThreshold = 3201,
    NotAllowed = 3202,
    AlreadyInstalled = 3203,
}

#[contracttype]
pub enum SimpleThresholdStorageKey {
    AccountContext(Address, u32),
}

const DAY_IN_LEDGERS: u32 = 17280;
pub const SIMPLE_THRESHOLD_EXTEND_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
pub const SIMPLE_THRESHOLD_TTL_THRESHOLD: u32 = SIMPLE_THRESHOLD_EXTEND_AMOUNT - DAY_IN_LEDGERS;

pub fn get_threshold(e: &Env, context_rule_id: u32, smart_account: &Address) -> u32 {
    let key = SimpleThresholdStorageKey::AccountContext(smart_account.clone(), context_rule_id);
    e.storage().persistent().get(&key)
        .inspect(|_| {
            e.storage().persistent().extend_ttl(&key, SIMPLE_THRESHOLD_TTL_THRESHOLD, SIMPLE_THRESHOLD_EXTEND_AMOUNT);
        })
        .unwrap_or_else(|| panic_with_error!(e, SimpleThresholdError::SmartAccountNotInstalled))
}

pub fn enforce(e: &Env, context: &Context, authenticated_signers: &Vec<Signer>,
               context_rule: &ContextRule, smart_account: &Address) {
    smart_account.require_auth();
    let threshold = get_threshold(e, context_rule.id, smart_account);
    if authenticated_signers.len() >= threshold {
        SimpleEnforced {
            smart_account: smart_account.clone(), context: context.clone(),
            context_rule_id: context_rule.id, authenticated_signers: authenticated_signers.clone(),
        }.publish(e);
    } else {
        panic_with_error!(e, SimpleThresholdError::NotAllowed)
    }
}

pub fn install(e: &Env, params: &SimpleThresholdAccountParams, context_rule: &ContextRule, smart_account: &Address) {
    smart_account.require_auth();
    let key = SimpleThresholdStorageKey::AccountContext(smart_account.clone(), context_rule.id);
    if e.storage().persistent().has(&key) { panic_with_error!(e, SimpleThresholdError::AlreadyInstalled) }
    if params.threshold == 0 || params.threshold > context_rule.signers.len() {
        panic_with_error!(e, SimpleThresholdError::InvalidThreshold)
    }
    e.storage().persistent().set(&key, &params.threshold);
    SimpleInstalled {
        smart_account: smart_account.clone(), context_rule_id: context_rule.id, threshold: params.threshold,
    }.publish(e);
}

pub fn uninstall(e: &Env, context_rule: &ContextRule, smart_account: &Address) {
    smart_account.require_auth();
    let key = SimpleThresholdStorageKey::AccountContext(smart_account.clone(), context_rule.id);
    if !e.storage().persistent().has(&key) { panic_with_error!(e, SimpleThresholdError::SmartAccountNotInstalled) }
    e.storage().persistent().remove(&key);
    SimpleUninstalled { smart_account: smart_account.clone(), context_rule_id: context_rule.id }.publish(e);
}`;

// --- Prompt Construction ---

export function buildSystemPrompt(): string {
  return `You are a Soroban smart contract expert. You generate Rust source code for Stellar/Soroban policy contracts.

Your generated contract must be a STANDALONE, COMPILABLE Rust file that depends only on soroban-sdk = "25.3". It will NOT have access to the stellar-accounts crate — you must define all types inline.

RULES:
1. Output ONLY valid Rust source code. No markdown fences, no explanations.
1a. The VERY FIRST LINE of the file MUST be \`#![no_std]\` — this is a WASM contract, not a binary.
2. The contract struct MUST be named \`PolicyContract\` with \`#[contract] pub struct PolicyContract;\`
3. Implement enforce, install, uninstall as \`#[contractimpl] impl PolicyContract { pub fn enforce(...) ... }\`
4. The function signatures must match the Policy trait exactly (see below).
5. Define Signer, ContextRule, ContextRuleType as inline #[contracttype] enums/structs (copy from CORE TYPES below).
6. Use #[contracterror] for error enums and #[contractevent] with .publish(e) for events (these ARE available in soroban-sdk 25.3).
7. Use persistent storage keyed by (smart_account_address, context_rule_id) via a StorageKey enum.
8. Always call smart_account.require_auth() at the start of enforce, install, and uninstall.
9. Use TTL extension (extend_ttl) when reading persistent storage.
10. Use ONLY soroban_sdk types: Address, Bytes, BytesN, Map, Symbol, String, Vec. Never use std types.
11. Include BOTH getter AND setter functions for policy data. See the references.
12. Follow the EXACT patterns from the reference implementations below — they are real, production code.

COMMON MISTAKES TO AVOID:
- symbol_short!() ONLY accepts string literals up to 9 ASCII characters. "transfer" (8 chars) is OK. "approve_all" (11 chars) is NOT. For function names longer than 9 chars, use Symbol::new(env, "long_function_name") instead and compare with == Symbol::new(env, "...").
- Do NOT hardcode contract addresses as byte arrays. Stellar StrKey addresses are base32, NOT hex — never write BytesN::from_array with address characters. If you need to reference a specific contract address, use Address::from_string(&String::from_str(e, "C...")) or better yet rely on ContextRuleType::CallContract(addr) from the context_rule which already provides the scoped address.
- Do NOT create helper functions like get_target_contract() that try to decode Stellar addresses. The context_rule.context_type already contains the contract Address.
- Use Vec::pop_front() for history cleanup (like the rolling sum reference), not filtering into a new Vec.
- Always include a set_* function alongside every get_* function for policy reconfiguration.
- ALWAYS include these imports at the top (after #![no_std]):
  \`use soroban_sdk::{contract, contractimpl, contracttype, contracterror, contractevent, panic_with_error, Address, Bytes, BytesN, Env, FromVal, IntoVal, Map, String, Symbol, TryFromVal, TryIntoVal, Val, Vec};\`
  \`use soroban_sdk::auth::{Context, ContractContext};\`
  Only include imports you actually use. Remove any unused imports.
- The install function signature MUST be: \`pub fn install(e: &Env, install_params: Val, context_rule: ContextRule, smart_account: Address)\`.
- install_params may be Val::VOID (no configuration) or a Map<Val, Val> with Symbol keys. ALWAYS handle both cases:
  \`\`\`
  // Check if install_params is void (no config provided)
  if install_params.is_void() {
      // Store sensible defaults and return
  } else {
      let params: Map<Val, Val> = FromVal::from_val(e, &install_params);
      let max_amount: i128 = params.get(Symbol::new(e, "max_arg_name").into_val(e)).map(|v| i128::try_from_val(e, &v).unwrap()).unwrap_or(i128::MAX);
      let threshold: u32 = params.get(Symbol::new(e, "threshold").into_val(e)).map(|v| u32::try_from_val(e, &v).unwrap()).unwrap_or(1);
  }
  \`\`\`
  The key names follow this convention: "max_{arg_name}" for range max, "min_{arg_name}" for range min, "threshold" for threshold, "allowed_{arg_name}" for allowlists. Use .unwrap_or() with safe defaults so install succeeds even if a key is missing. When params is void, use maximum/permissive defaults (i128::MAX for limits, 1 for thresholds).
- Arguments in the schema are listed in order (index 0, 1, 2, ...). When extracting args for enforcement, use the argument's position in the schema's function args list as the index. For example, if the schema lists args [from, to, amount], then from=args.get(0), to=args.get(1), amount=args.get(2).
- For execute() wrapping, inner_args indices correspond to the argument positions in the schema (the schema already accounts for the execute wrapper).
- The soroban-sdk auto-generates a \`PolicyContractClient\` type from \`#[contract] pub struct PolicyContract\` + \`#[contractimpl]\`. Tests use this client.

CRITICAL RUST OWNERSHIP RULES (these cause most compilation failures):
- Context does NOT implement Debug or PartialEq. NEVER derive Debug on structs containing Context. If you need events with context info, store only the relevant fields (fn_name, contract address) not the full Context.
- When pattern matching on Context::Contract(ContractContext { contract, fn_name, args }), use \`ref args\` to borrow instead of move: Context::Contract(ContractContext { contract, fn_name, ref args }). This lets you still use \`context\` later.
- Address does NOT implement Copy. When using an Address more than once, call .clone() on the FIRST use: \`address.clone()\`. Same for String, Vec, Bytes, and all soroban_sdk types.
- When building structs with Address fields from params, clone each field: \`allowed_contract: params.allowed_contract.clone()\`.
- Prefer \`#[allow(unused_imports)]\` before your import block to suppress warnings about unused imports.

UNDERSTANDING AUTHORIZATION CONTEXT (CRITICAL):
This policy will be attached to a Default context rule, meaning enforce() is called for EVERY auth context in the transaction. The policy must handle all contexts correctly.

enforce() receives Context::Contract(ContractContext { contract, fn_name, args }) for each authorization. There are TWO patterns:

PATTERN 1 — EXECUTE WRAPPING (most common):
When the smart wallet calls execute(target, fn, args), Soroban auto-satisfies require_auth for direct sub-calls. enforce() sees:
  - fn_name = symbol_short!("execute")
  - args[0] = target contract Address
  - args[1] = inner function name (Symbol)
  - args[2] = inner arguments (Vec<Val>)

To enforce rules, extract the inner call:
  let target: Address = args.get(0).unwrap().try_into_val(e).unwrap();
  let inner_fn: Symbol = args.get(1).unwrap().try_into_val(e).unwrap();
  let inner_args: Vec<Val> = args.get(2).unwrap().try_into_val(e).unwrap();
  // Then apply arg-indexed rules against inner_args

PATTERN 2 — SUB-INVOCATION (DeFi/cross-contract):
When an intermediate contract (not the wallet) calls require_auth(wallet), a separate auth context is created. enforce() sees:
  - fn_name = the actual function name (e.g. "transfer", "swap", "deposit")
  - contract = the actual contract address
  - args = the raw function arguments
  // Apply arg-indexed rules directly against args

UNDERSTANDING CONSTRAINTS AND NOTES (CRITICAL):
The schema uses per-argument constraints and natural language notes. Each argument has a name, type, and optional constraint.

CONSTRAINT KINDS:
- "exact" { value }: The argument must equal this exact value. Panic otherwise.
- "range" { min?, max? }: The numeric argument must be within [min, max]. Panic if outside.
- "allowlist" { values[] }: The argument (typically Address) must be one of the listed values. Panic otherwise.
- "blocklist" { values[] }: The argument must NOT be one of the listed values. Panic if it matches.
- "unconstrained": No structural constraint — any value is allowed.

NOTES:
Each function and each argument can have a "note" field containing natural language guidance. Use these notes to implement complex enforcement behaviors that constraints alone cannot express. Examples:
- "Enforce a rolling window sum on this amount over 17280 ledgers"
- "Allow max 10 calls per day"
- "Only allow this if the previous arg is a specific address"

When notes describe rolling sums, rate limits, or stateful behavior, use the spending_limit reference below as an implementation pattern.

CRITICAL RULES FOR ENFORCE:
1. ALWAYS match on fn_name first. Handle both "execute" (Pattern 1) AND direct function names (Pattern 2).
2. For "execute" contexts, extract and validate the inner call. Check the target contract address against allowed contracts.
3. For direct contexts (Pattern 2), validate the contract address and function name.
4. DEFAULT-REJECT: Any fn_name or contract not explicitly handled MUST panic. Never allow unknown calls to pass silently.
5. Use a match statement with a catch-all that panics.
6. For each constrained argument, extract it by index using try_into_val and enforce the constraint.
7. Store allowed contract addresses and constraint configurations during install(). In enforce(), verify against stored data.
8. For each allowed contract, only permit its listed functions. Reject any function not explicitly whitelisted per-contract.
9. Constraints must be keyed by contract+function in storage — not global.

Below are COMPLETE reference implementations from the OpenZeppelin Stellar Contracts repository. Study them carefully and mirror their patterns exactly. The spending_limit reference demonstrates the rolling-sum pattern — adapt it for the argument position specified in the schema rather than hardcoding any specific argument index.

=== POLICY TRAIT DEFINITION ===
${POLICY_TRAIT_SOURCE}

=== CORE TYPES (define these inline in your contract) ===
${CORE_TYPES_SOURCE}

=== EXAMPLE: Threshold Policy Contract (wrapper pattern) ===
${THRESHOLD_CONTRACT_EXAMPLE}

=== REFERENCE: simple_threshold.rs (complete library implementation) ===
${SIMPLE_THRESHOLD_REFERENCE}

=== EXAMPLE: Spending Limit Policy Contract (wrapper pattern) ===
${SPENDING_LIMIT_CONTRACT_EXAMPLE}

=== REFERENCE: spending_limit.rs (rolling sum implementation — adapt for generic argIndex) ===
${SPENDING_LIMIT_REFERENCE}

=== YOUR TASK ===
Generate a STANDALONE policy contract (no external crate dependencies except soroban-sdk).
Copy the Signer, ContextRule, ContextRuleType types inline into your contract.
Follow the enforce/install/uninstall patterns from the references exactly.
Name your contract struct PolicyContract.

IMPORTANT: This policy will be used with a Default context rule. Your enforce() function MUST:
- Handle BOTH the "execute" wrapper pattern AND direct contract call patterns
- DEFAULT-REJECT any unrecognized function name or contract address
- Extract inner call details from execute() args when fn_name is "execute"
- Apply argument rules using positional indices matching the schema's arg order (0, 1, 2, ...)
- Be called potentially multiple times per transaction (once per auth context)`;
}

/** Build a list of install_params keys that the test harness will send. */
function buildInstallParamsKeyList(schema: PolicySchema): string {
  const keys: string[] = [];
  for (const contract of schema.contracts) {
    for (const func of contract.functions) {
      for (const arg of func.args) {
        if (!arg.constraint || arg.constraint.kind === "unconstrained") continue;
        if (arg.constraint.kind === "range") {
          if (arg.constraint.max) keys.push(`- "max_${arg.name}" (i128): maximum allowed value for ${arg.name}`);
          if (arg.constraint.min) keys.push(`- "min_${arg.name}" (i128): minimum allowed value for ${arg.name}`);
        }
        if (arg.constraint.kind === "allowlist") {
          keys.push(`- "allowed_${arg.name}" (bool): flag that allowlist is enabled for ${arg.name}`);
        }
      }
    }
  }
  for (const rule of schema.globalRules) {
    if (rule.type === "threshold") keys.push(`- "threshold" (u32): minimum number of signers required (value: ${rule.params.threshold})`);
    if (rule.type === "time_lock") {
      if (rule.params.validAfterLedger != null) keys.push(`- "valid_after_ledger" (u32): earliest allowed ledger`);
      if (rule.params.validUntilLedger != null) keys.push(`- "valid_until_ledger" (u32): latest allowed ledger`);
    }
  }
  if (keys.length === 0) return "  (no configuration needed — install_params may be Val::VOID)";
  return keys.join("\n");
}

export function buildUserPrompt(schema: PolicySchema): string {
  const schemaJson = schemaToJSON(schema);

  // Build a human-readable summary with constraints and notes
  const contractSummary = schema.contracts.map(c => {
    const funcs = c.functions.map(f => {
      const argSig = f.args
        .map(a => `${a.name}: ${a.type}`)
        .join(", ");

      const constraintLines = f.args
        .filter(a => a.constraint && a.constraint.kind !== "unconstrained")
        .map(a => {
          const c = a.constraint!;
          switch (c.kind) {
            case "exact": return `    - ${a.name}: must equal "${c.value}"`;
            case "range": return `    - ${a.name}: range [${c.min ?? "..."}, ${c.max ?? "..."}]`;
            case "allowlist": return `    - ${a.name}: allowlist [${c.values.join(", ")}]`;
            case "blocklist": return `    - ${a.name}: blocklist [${c.values.join(", ")}]`;
            default: return "";
          }
        })
        .filter(Boolean);

      const noteLines: string[] = [];
      // Per-arg notes
      for (const a of f.args) {
        if (a.note) noteLines.push(`    - ${a.name} note: "${a.note}"`);
      }
      // Function-level note
      if (f.note) noteLines.push(`    Function note: "${f.note}"`);

      let result = `  - ${f.name}(${argSig})`;
      if (constraintLines.length > 0) {
        result += `\n    Constraints:\n${constraintLines.join("\n")}`;
      }
      if (noteLines.length > 0) {
        result += `\n    Notes:\n${noteLines.join("\n")}`;
      }
      return result;
    }).join("\n");
    return `Contract ${c.address}${c.label ? ` (${c.label})` : ""}:\n${funcs}`;
  }).join("\n\n");

  return `Generate a complete Soroban smart contract that implements the following policy schema.
The contract should be a single Rust file with all necessary types, storage, events, and functions.

POLICY SCHEMA:
${schemaJson}

CONTRACT PERMISSIONS (with typed arguments, constraints, and enforcement notes):
${contractSummary}

Global rules: ${schema.globalRules.map(r => r.type).join(", ") || "none"}

INSTALL PARAMS FORMAT:
install_params is a Map<Val, Val> with these Symbol keys (decode each with .get() and .unwrap_or(default)):
${buildInstallParamsKeyList(schema)}

CRITICAL SECURITY REQUIREMENTS:
- This policy will be attached to a Default context rule (matches all auth contexts)
- The enforce() function must handle both execute() wrapper calls and direct contract calls
- ONLY the contracts listed above are permitted. ALL other contracts must be REJECTED (panic).
- ONLY the functions listed under each contract are permitted. ALL other functions must be REJECTED.
- Each function's constraints apply ONLY to that specific contract+function combination.
- For constrained arguments, extract the value by index and enforce the constraint (exact match, range check, allowlist/blocklist lookup).
- For arguments/functions with notes, implement the described behavior (rolling sums, rate limits, conditional logic, etc.).
- Unknown function names or contracts must be rejected (panic)

Generate ONLY the Rust source code. No markdown, no explanations.`;
}

export function buildFixPrompt(originalCode: string, compileErrors: string): string {
  return `The following Soroban policy contract failed to compile. Fix ALL compilation errors while preserving the contract's logic and structure.

COMPILATION ERRORS:
${compileErrors}

ORIGINAL CODE:
${originalCode}

RULES:
1. Output ONLY the fixed Rust source code. No markdown fences, no explanations.
2. Fix all compilation errors shown above.
3. Do NOT change the contract's business logic — only fix compilation issues (type errors, missing imports, wrong signatures, unused imports, etc.).
4. Keep the contract struct named PolicyContract.
5. The first line MUST be \`#![no_std]\`.
6. Remove any unused imports that cause warnings.

COMMON FIXES:
- Missing imports: Add \`#[allow(unused_imports)]\` then \`use soroban_sdk::{contract, contractimpl, contracttype, contracterror, contractevent, panic_with_error, Address, Bytes, BytesN, Env, FromVal, IntoVal, Map, String, Symbol, TryFromVal, TryIntoVal, Val, Vec};\` and \`use soroban_sdk::auth::{Context, ContractContext};\`
- Remove any imports that are truly unused (or add #[allow(unused_imports)]).
- symbol_short!() only supports ≤9 char literals. For longer names, use Symbol::new(env, "name").
- install must take Val: \`pub fn install(e: &Env, install_params: Val, context_rule: ContextRule, smart_account: Address)\`
- "doesn't implement Debug": Context does NOT implement Debug. Remove Debug from #[derive(...)] on any struct containing Context. Use only the fields you need (fn_name, contract) instead of the full Context in events.
- "borrow of partially moved value: context": When matching Context::Contract(ContractContext { contract, fn_name, args }), change args to ref args: \`Context::Contract(ContractContext { contract, fn_name, ref args })\`
- "use of moved value" for Address/String/Vec: These types don't implement Copy. Clone them on first use: \`value.clone()\`
- "cannot find type" errors: check that Signer, ContextRule, ContextRuleType are defined as #[contracttype] types in the file
- panic_with_error! requires #[contracterror] enum`;
}

// --- Server Function for AI Code Generation ---

interface GenerateInput {
  schemaJson: string;
}

function validateGenerateInput(data: unknown): GenerateInput {
  if (typeof data !== "object" || data === null) {
    throw new Error("Invalid payload");
  }
  const { schemaJson } = data as { schemaJson?: unknown };
  if (typeof schemaJson !== "string" || schemaJson.length === 0) {
    throw new Error("schemaJson is required");
  }
  if (schemaJson.length > 50_000) {
    throw new Error("schemaJson exceeds maximum size");
  }
  return { schemaJson };
}

interface FixInput {
  rustCode: string;
  compileErrors: string;
}

function validateFixInput(data: unknown): FixInput {
  if (typeof data !== "object" || data === null) {
    throw new Error("Invalid payload");
  }
  const { rustCode, compileErrors } = data as Record<string, unknown>;
  if (typeof rustCode !== "string" || !rustCode) throw new Error("rustCode is required");
  if (typeof compileErrors !== "string" || !compileErrors) throw new Error("compileErrors is required");
  if (rustCode.length > 100_000) throw new Error("rustCode exceeds maximum size");
  return { rustCode, compileErrors };
}

/**
 * Server function that calls Cloudflare Workers AI (Kimi K2.5) to generate
 * a Rust/Soroban policy contract from a policy schema.
 *
 * Returns the generated Rust source code as a string.
 * For streaming, the caller should use EventSource or fetch with streaming.
 */
export const generatePolicyCode = createServerFn({ method: "POST" })
  .inputValidator(validateGenerateInput)
  .handler(async ({ data }) => {
    const { schemaJson } = data;

    // Parse and validate the schema
    // We import inline to avoid pulling bigint-heavy code into validation
    const { schemaFromJSON, validateSchema: validate } = await import("./policy-schema");
    const schema = schemaFromJSON(schemaJson);
    const validation = validate(schema);
    if (!validation.valid) {
      return {
        success: false as const,
        error: `Schema validation failed: ${validation.errors.join("; ")}`,
        code: null,
      };
    }

    // Build the prompt
    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(schema);

    // Access Workers AI binding via cloudflare:workers import
    const ai = env.AI;
    if (!ai) {
      return {
        success: false as const,
        error: "Workers AI binding not available. Ensure AI binding is configured in wrangler.jsonc.",
        code: null,
      };
    }

    try {
      // Use streaming to avoid 504 timeouts on large code generation.
      // Kimi K2.5 with a big system prompt can take 30-60s — streaming
      // keeps the connection alive by sending tokens incrementally.
      const stream = (await ai.run("@cf/moonshotai/kimi-k2.5", {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        stream: true,
        max_tokens: 16384,
        temperature: 0.1,
        // Disable reasoning/thinking for faster output — the reference
        // implementations are explicit enough that thinking isn't needed.
        chat_template_kwargs: {
          enable_thinking: false,
        },
      })) as ReadableStream;

      // Collect all streamed tokens server-side
      const code = await collectStreamedResponse(stream);

      if (!code) {
        return {
          success: false as const,
          error: "AI model returned empty response",
          code: null,
        };
      }

      // Unescape literal escape sequences from model output, then strip
      // any markdown fences the model might add despite instructions
      const cleanCode = stripMarkdownFences(unescapeCodeContent(code));

      return {
        success: true as const,
        error: null,
        code: cleanCode,
      };
    } catch (err: any) {
      return {
        success: false as const,
        error: err.message || "AI code generation failed",
        code: null,
      };
    }
  });

// --- Streaming Server Function (async generator) ---

/** Chunk type sent from server to client during streaming generation. */
export interface GenerateChunk {
  /** "token" for code tokens, "error" for errors, "done" for completion */
  type: "token" | "error" | "done";
  /** The token text (for type="token") or error message (for type="error") */
  text?: string;
  /** Running total of tokens emitted so far */
  tokenCount?: number;
}

/**
 * Streaming server function using async generator.
 * Yields GenerateChunks as tokens arrive from Workers AI.
 */
export const streamPolicyCode = createServerFn({ method: "POST" })
  .inputValidator(validateGenerateInput)
  .handler(async function* ({ data }): AsyncGenerator<GenerateChunk> {
    const { schemaJson } = data;

    const { schemaFromJSON: parse, validateSchema: validate } = await import("./policy-schema");
    const schema = parse(schemaJson);
    const validation = validate(schema);
    if (!validation.valid) {
      yield { type: "error", text: `Schema validation failed: ${validation.errors.join("; ")}` };
      return;
    }

    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(schema);

    const ai = env.AI;
    if (!ai) {
      yield { type: "error", text: "Workers AI binding not available." };
      return;
    }

    let tokenCount = 0;
    let codeBuffer = "";

    try {
      const aiStream = (await ai.run("@cf/moonshotai/kimi-k2.5", {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        stream: true,
        max_tokens: 16384,
        temperature: 0.1,
        chat_template_kwargs: { enable_thinking: false },
      })) as ReadableStream;

      const reader = aiStream.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split("\n");
        sseBuffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ") || trimmed === "data: [DONE]") continue;
          try {
            const json = JSON.parse(trimmed.slice(6));
            const token = extractTokenFromChunk(json);
            if (token) {
              tokenCount++;
              codeBuffer += token;
              yield { type: "token", text: token, tokenCount };
            }
          } catch {
            // Skip malformed chunks
          }
        }
      }

      // Flush any remaining buffer content
      if (sseBuffer.trim().startsWith("data: ") && sseBuffer.trim() !== "data: [DONE]") {
        try {
          const json = JSON.parse(sseBuffer.trim().slice(6));
          const token = extractTokenFromChunk(json);
          if (token) {
            tokenCount++;
            codeBuffer += token;
          }
        } catch {
          // Skip malformed final chunk
        }
      }

      // Clean and yield final result
      const cleanCode = stripMarkdownFences(unescapeCodeContent(codeBuffer));
      yield { type: "done", text: cleanCode, tokenCount };
    } catch (err: any) {
      yield { type: "error", text: err.message || "Stream error" };
    }
  });

// --- Fix Server Function (compile error auto-retry) ---

/**
 * Server function that sends the original code + compile errors back to Kimi
 * to fix compilation issues. Uses the full system prompt for context.
 */
export const fixPolicyCode = createServerFn({ method: "POST" })
  .inputValidator(validateFixInput)
  .handler(async ({ data }) => {
    const { rustCode, compileErrors } = data;

    const systemPrompt = buildSystemPrompt();
    const fixPrompt = buildFixPrompt(rustCode, compileErrors);

    const ai = env.AI;
    if (!ai) {
      return { success: false as const, error: "Workers AI binding not available.", code: null };
    }

    try {
      const stream = (await ai.run("@cf/moonshotai/kimi-k2.5", {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: fixPrompt },
        ],
        stream: true,
        max_tokens: 16384,
        temperature: 0.1,
        chat_template_kwargs: { enable_thinking: false },
      })) as ReadableStream;

      const code = await collectStreamedResponse(stream);

      if (!code) {
        return { success: false as const, error: "AI returned empty response", code: null };
      }

      const cleanCode = stripMarkdownFences(unescapeCodeContent(code));
      return { success: true as const, error: null, code: cleanCode };
    } catch (err: any) {
      return { success: false as const, error: err.message || "Fix failed", code: null };
    }
  });

// --- Client-side convenience ---

/**
 * Client-side wrapper that prepares the schema and calls the server function.
 * Returns the complete code (non-streaming).
 */
export async function requestPolicyGeneration(schema: PolicySchema): Promise<{
  success: boolean;
  error: string | null;
  code: string | null;
}> {
  const validation = validateSchema(schema);
  if (!validation.valid) {
    return {
      success: false,
      error: `Schema validation failed: ${validation.errors.join("; ")}`,
      code: null,
    };
  }

  const result = await generatePolicyCode({
    data: { schemaJson: schemaToJSON(schema) },
  });

  return result;
}

/**
 * Client-side streaming wrapper. Returns an async iterable of GenerateChunks.
 * Use `for await...of` to consume tokens as they arrive.
 */
export async function requestStreamingGeneration(
  schema: PolicySchema
): Promise<AsyncIterable<GenerateChunk> | { error: string }> {
  const validation = validateSchema(schema);
  if (!validation.valid) {
    return { error: `Schema validation failed: ${validation.errors.join("; ")}` };
  }

  const generator = await streamPolicyCode({
    data: { schemaJson: schemaToJSON(schema) },
  });

  return generator;
}

/**
 * Client-side wrapper that sends code + compile errors to Kimi for a fix.
 * Strips noisy "Compiling..." lines before sending.
 */
export async function requestFixCode(
  rustCode: string,
  compileErrors: string,
): Promise<{ success: boolean; error: string | null; code: string | null }> {
  // Strip dependency compilation noise — only send actual errors/warnings
  const cleanErrors = compileErrors
    .split("\n")
    .filter(line => {
      const trimmed = line.trim();
      return trimmed !== "" &&
        !trimmed.startsWith("Compiling ") &&
        !trimmed.startsWith("Downloading ") &&
        !trimmed.startsWith("Downloaded ") &&
        !trimmed.startsWith("Blocking ");
    })
    .join("\n")
    .trim();

  return fixPolicyCode({
    data: { rustCode, compileErrors: cleanErrors || compileErrors },
  });
}

// --- Helpers ---

/**
 * Read a Workers AI SSE stream and collect the full text response.
 * Handles both legacy Workers AI format ("response" field) and
 * OpenAI-compatible format ("choices[0].delta.content" field).
 * SSE format: "data: {...}\n\n" ... "data: [DONE]\n\n"
 */
async function collectStreamedResponse(stream: ReadableStream): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Process complete SSE lines
    const lines = buffer.split("\n");
    // Keep the last potentially incomplete line in the buffer
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ") || trimmed === "data: [DONE]") continue;
      try {
        const json = JSON.parse(trimmed.slice(6));
        result += extractTokenFromChunk(json);
      } catch {
        // Skip malformed JSON chunks
      }
    }
  }

  // Process any remaining buffer
  if (buffer.trim().startsWith("data: ") && buffer.trim() !== "data: [DONE]") {
    try {
      const json = JSON.parse(buffer.trim().slice(6));
      result += extractTokenFromChunk(json);
    } catch {}
  }

  return result;
}

/**
 * Extract the token text from a streaming chunk, supporting both
 * legacy Workers AI format and OpenAI-compatible format.
 */
function extractTokenFromChunk(json: any): string {
  // Legacy Workers AI format: { response: "token" }
  if (typeof json.response === "string") {
    return json.response;
  }
  // OpenAI-compatible format: { choices: [{ delta: { content: "token" } }] }
  if (json.choices?.[0]?.delta?.content) {
    return json.choices[0].delta.content;
  }
  // OpenAI-compatible non-streaming: { choices: [{ message: { content: "..." } }] }
  if (json.choices?.[0]?.message?.content) {
    return json.choices[0].message.content;
  }
  return "";
}

function stripMarkdownFences(code: string): string {
  let cleaned = code.trim();
  // Remove opening fence
  if (cleaned.startsWith("```")) {
    const firstNewline = cleaned.indexOf("\n");
    if (firstNewline !== -1) {
      cleaned = cleaned.slice(firstNewline + 1);
    }
  }
  // Remove closing fence
  if (cleaned.endsWith("```")) {
    cleaned = cleaned.slice(0, cleaned.lastIndexOf("```"));
  }
  return cleaned.trim();
}

/**
 * Unescape string literal escape sequences in AI-generated code.
 * Some models (e.g., Kimi K2.5) output \\n, \\t, etc. as literal
 * escape sequences in the JSON content instead of actual whitespace.
 * Also handles \\x3C -> < which appears for generics in Rust.
 */
function unescapeCodeContent(code: string): string {
  // Always replace hex escapes — \x3C and \x3E are never valid in Rust
  // source code and appear when serialization layers escape < and >.
  let result = code.replace(/\\x3C/g, "<").replace(/\\x3E/g, ">");

  // If code has no real newlines but has literal \n, unescape whitespace too
  const firstLineEnd = result.indexOf("\n");
  if (firstLineEnd === -1 && result.includes("\\n")) {
    result = result
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"');
  }
  return result;
}
