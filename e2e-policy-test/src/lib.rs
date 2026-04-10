#![no_std]

use soroban_sdk::{
    auth::{Context, ContractContext},
    contract, contracterror, contractevent, contractimpl, contracttype,
    panic_with_error, symbol_short, Address, Bytes, BytesN, Env, FromVal,
    String, TryFromVal, Val, Vec,
};

// --- Core Types (inline, matching smart_account module) ---

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
}

// --- Spending Limit Types ---

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

// --- Errors ---

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

// --- Events ---

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

// --- Storage ---

#[contracttype]
pub enum SpendingLimitStorageKey {
    AccountContext(Address, u32),
}

const DAY_IN_LEDGERS: u32 = 17280;
const SPENDING_LIMIT_EXTEND_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
const SPENDING_LIMIT_TTL_THRESHOLD: u32 = SPENDING_LIMIT_EXTEND_AMOUNT - DAY_IN_LEDGERS;
const MAX_HISTORY_ENTRIES: u32 = 1000;

// --- Contract ---

#[contract]
pub struct PolicyContract;

#[contractimpl]
impl PolicyContract {
    pub fn enforce(
        e: &Env,
        context: Context,
        authenticated_signers: Vec<Signer>,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        smart_account.require_auth();

        if authenticated_signers.is_empty() {
            panic_with_error!(e, SpendingLimitError::NotAllowed);
        }

        let key = SpendingLimitStorageKey::AccountContext(smart_account.clone(), context_rule.id);
        let mut data: SpendingLimitData = e
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(e, SpendingLimitError::SmartAccountNotInstalled));

        e.storage()
            .persistent()
            .extend_ttl(&key, SPENDING_LIMIT_TTL_THRESHOLD, SPENDING_LIMIT_EXTEND_AMOUNT);

        let current_ledger = e.ledger().sequence();

        match &context {
            Context::Contract(ContractContext {
                fn_name, args, ..
            }) => {
                if fn_name == &symbol_short!("transfer") {
                    if let Some(amount_val) = args.get(2) {
                        if let Ok(amount) = i128::try_from_val(e, &amount_val) {
                            if amount < 0 {
                                panic_with_error!(e, SpendingLimitError::LessThanZero);
                            }

                            let removed = cleanup_old_entries(
                                &mut data.spending_history,
                                current_ledger,
                                data.period_ledgers,
                            );
                            data.cached_total_spent -= removed;

                            if data.cached_total_spent + amount > data.spending_limit {
                                panic_with_error!(e, SpendingLimitError::SpendingLimitExceeded);
                            }

                            if data.spending_history.len() >= MAX_HISTORY_ENTRIES {
                                panic_with_error!(e, SpendingLimitError::HistoryCapacityExceeded);
                            }

                            data.spending_history.push_back(SpendingEntry {
                                amount,
                                ledger_sequence: current_ledger,
                            });
                            data.cached_total_spent += amount;

                            e.storage().persistent().set(&key, &data);

                            SpendingLimitEnforced {
                                smart_account: smart_account.clone(),
                                context: context.clone(),
                                context_rule_id: context_rule.id,
                                amount,
                                total_spent_in_period: data.cached_total_spent,
                            }
                            .publish(e);

                            return;
                        }
                    }
                }
            }
            _ => {
                panic_with_error!(e, SpendingLimitError::NotAllowed);
            }
        }

        panic_with_error!(e, SpendingLimitError::NotAllowed);
    }

    pub fn install(
        e: &Env,
        install_params: Val,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        smart_account.require_auth();

        if !matches!(
            context_rule.context_type,
            ContextRuleType::CallContract(_)
        ) {
            panic_with_error!(e, SpendingLimitError::OnlyCallContractAllowed);
        }

        let params: SpendingLimitAccountParams = FromVal::from_val(e, &install_params);

        if params.spending_limit <= 0 || params.period_ledgers == 0 {
            panic_with_error!(e, SpendingLimitError::InvalidLimitOrPeriod);
        }

        let key = SpendingLimitStorageKey::AccountContext(smart_account.clone(), context_rule.id);

        if e.storage().persistent().has(&key) {
            panic_with_error!(e, SpendingLimitError::AlreadyInstalled);
        }

        let data = SpendingLimitData {
            spending_limit: params.spending_limit,
            period_ledgers: params.period_ledgers,
            spending_history: Vec::new(e),
            cached_total_spent: 0,
        };

        e.storage().persistent().set(&key, &data);

        SpendingLimitInstalled {
            smart_account: smart_account.clone(),
            context_rule_id: context_rule.id,
            spending_limit: params.spending_limit,
            period_ledgers: params.period_ledgers,
        }
        .publish(e);
    }

    pub fn uninstall(e: &Env, context_rule: ContextRule, smart_account: Address) {
        smart_account.require_auth();

        let key = SpendingLimitStorageKey::AccountContext(smart_account.clone(), context_rule.id);

        if !e.storage().persistent().has(&key) {
            panic_with_error!(e, SpendingLimitError::SmartAccountNotInstalled);
        }

        e.storage().persistent().remove(&key);

        SpendingLimitUninstalled {
            smart_account: smart_account.clone(),
            context_rule_id: context_rule.id,
        }
        .publish(e);
    }

    pub fn get_spending_limit_data(
        e: Env,
        context_rule_id: u32,
        smart_account: Address,
    ) -> SpendingLimitData {
        let key = SpendingLimitStorageKey::AccountContext(smart_account, context_rule_id);
        e.storage()
            .persistent()
            .get(&key)
            .inspect(|_: &SpendingLimitData| {
                e.storage()
                    .persistent()
                    .extend_ttl(&key, SPENDING_LIMIT_TTL_THRESHOLD, SPENDING_LIMIT_EXTEND_AMOUNT);
            })
            .unwrap_or_else(|| panic_with_error!(e, SpendingLimitError::SmartAccountNotInstalled))
    }

    pub fn set_spending_limit(
        e: Env,
        spending_limit: i128,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        smart_account.require_auth();

        let key = SpendingLimitStorageKey::AccountContext(smart_account.clone(), context_rule.id);

        let mut data: SpendingLimitData = e
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(e, SpendingLimitError::SmartAccountNotInstalled));

        e.storage()
            .persistent()
            .extend_ttl(&key, SPENDING_LIMIT_TTL_THRESHOLD, SPENDING_LIMIT_EXTEND_AMOUNT);

        data.spending_limit = spending_limit;
        e.storage().persistent().set(&key, &data);

        SpendingLimitChanged {
            smart_account: smart_account.clone(),
            context_rule_id: context_rule.id,
            spending_limit,
        }
        .publish(&e);
    }
}

// --- Helpers ---

fn cleanup_old_entries(
    spending_history: &mut Vec<SpendingEntry>,
    current_ledger: u32,
    period_ledgers: u32,
) -> i128 {
    let cutoff_ledger = current_ledger.saturating_sub(period_ledgers);
    let mut removed_total = 0i128;

    while let Some(entry) = spending_history.get(0) {
        if entry.ledger_sequence <= cutoff_ledger {
            removed_total += entry.amount;
            spending_history.pop_front();
        } else {
            break;
        }
    }

    removed_total
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{Env, IntoVal, Map, Symbol};

    fn create_test_context_rule(env: &Env) -> ContextRule {
        let contract_addr = Address::generate(env);
        ContextRule {
            id: 1,
            context_type: ContextRuleType::CallContract(contract_addr),
            name: String::from_str(env, "test-rule"),
            signers: Vec::new(env),
            signer_ids: Vec::new(env),
            policies: Vec::new(env),
            policy_ids: Vec::new(env),
            valid_until: None,
        }
    }

    fn create_test_params(env: &Env) -> Val {
        let mut map = Map::<Val, Val>::new(env);
        map.set(
            Symbol::new(env, "period_ledgers").into_val(env),
            17280u32.into_val(env),
        );
        map.set(
            Symbol::new(env, "spending_limit").into_val(env),
            100_000_000i128.into_val(env),
        );
        map.into_val(env)
    }

    fn create_test_signers(env: &Env, count: u32) -> Vec<Signer> {
        let mut signers = Vec::new(env);
        for _ in 0..count {
            signers.push_back(Signer::Delegated(Address::generate(env)));
        }
        signers
    }

    fn create_transfer_context(env: &Env, amount: i128) -> Context {
        let contract_addr = Address::generate(env);
        let mut args: Vec<Val> = Vec::new(env);
        args.push_back(Address::generate(env).into_val(env));
        args.push_back(Address::generate(env).into_val(env));
        args.push_back(amount.into_val(env));
        Context::Contract(ContractContext {
            contract: contract_addr,
            fn_name: symbol_short!("transfer"),
            args,
        })
    }

    #[test]
    fn test_install_succeeds() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(PolicyContract, ());
        let client = PolicyContractClient::new(&env, &contract_id);
        let smart_account = Address::generate(&env);
        let context_rule = create_test_context_rule(&env);
        client.install(&create_test_params(&env), &context_rule, &smart_account);
    }

    #[test]
    fn test_uninstall_succeeds() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(PolicyContract, ());
        let client = PolicyContractClient::new(&env, &contract_id);
        let smart_account = Address::generate(&env);
        let context_rule = create_test_context_rule(&env);
        client.install(&create_test_params(&env), &context_rule, &smart_account);
        client.uninstall(&context_rule, &smart_account);
    }

    #[test]
    fn test_enforce_within_limit() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(PolicyContract, ());
        let client = PolicyContractClient::new(&env, &contract_id);
        let smart_account = Address::generate(&env);
        let context_rule = create_test_context_rule(&env);
        client.install(&create_test_params(&env), &context_rule, &smart_account);

        let context = create_transfer_context(&env, 50_000_000);
        let signers = create_test_signers(&env, 1);
        client.enforce(&context, &signers, &context_rule, &smart_account);
    }

    #[test]
    #[should_panic]
    fn test_enforce_exceeds_limit() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(PolicyContract, ());
        let client = PolicyContractClient::new(&env, &contract_id);
        let smart_account = Address::generate(&env);
        let context_rule = create_test_context_rule(&env);
        client.install(&create_test_params(&env), &context_rule, &smart_account);

        let context = create_transfer_context(&env, 200_000_000);
        let signers = create_test_signers(&env, 1);
        client.enforce(&context, &signers, &context_rule, &smart_account);
    }

    #[test]
    #[should_panic]
    fn test_uninstall_when_not_installed() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(PolicyContract, ());
        let client = PolicyContractClient::new(&env, &contract_id);
        let smart_account = Address::generate(&env);
        let context_rule = create_test_context_rule(&env);
        client.uninstall(&context_rule, &smart_account);
    }
}
