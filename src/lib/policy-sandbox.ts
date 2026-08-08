import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import type { PolicySchema, ArgPermission } from "./policy-schema";
import { installParamsSpec, schemaToJSON } from "./policy-schema";

declare module "cloudflare:workers" {
  interface Env {
    SANDBOX: Fetcher;
  }
}

// --- Types ---

export interface CompileResult {
  success: boolean;
  errors: string[];
  warnings: string[];
  wasmBase64: string | null;
}

export interface TestCase {
  name: string;
  passed: boolean;
  output: string;
}

export interface TestResult {
  success: boolean;
  compiled: boolean;
  testCases: TestCase[];
  compileOutput: string;
}

// --- Test Case Generation ---

/**
 * Generate test case source code from a policy schema.
 * Tests are driven by per-argument constraints and global rules.
 */
/** Rust identifiers can't contain arbitrary schema text; keep names unique AND legal. */
function ident(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned || "_";
}

/** A Symbol expression: symbol_short! only accepts <=9 chars. */
function symbolExpr(name: string, envRef: string): string {
  return name.length <= 9
    ? `soroban_sdk::symbol_short!("${name}")`
    : `soroban_sdk::Symbol::new(${envRef}, "${name}")`;
}

function addressExpr(address: string, envRef: string): string {
  return address
    ? `soroban_sdk::Address::from_string(&soroban_sdk::String::from_str(${envRef}, "${address}"))`
    : `<soroban_sdk::Address as soroban_sdk::testutils::Address>::generate(${envRef})`;
}

/**
 * Generate test case source code from a policy schema.
 *
 * Two invariants this generator exists to prove, beyond per-constraint checks:
 *   1. DEFAULT-DENY — an unlisted function or contract is rejected. Without these, a policy
 *      whose `enforce()` body is empty passes every other test in the suite.
 *   2. AUTHORIZATION — enforce/install/uninstall actually require the smart account's auth.
 *      Every other test runs under `mock_all_auths()`, which hides a missing require_auth().
 *
 * Negative tests call `try_<fn>` and assert `is_err()` rather than using bare
 * `#[should_panic]`. A bare should_panic accepts ANY panic, including one thrown during
 * setup (install, address decoding, arg conversion) — so a policy could pass a rejection
 * test for entirely the wrong reason. With `try_`, setup panics still fail the test loudly
 * and the assertion is specifically about the call under test.
 */
export function generateTestCases(schema: PolicySchema): string {
  const tests: string[] = [];

  const contractAddress = schema.contracts[0]?.address ?? "";
  const firstFunc = schema.contracts[0]?.functions[0];
  const firstFunctionName = firstFunc?.name ?? "invoke";
  const firstFuncArgs = firstFunc?.args ?? [];

  // For symbol_short!, function names must be ≤9 chars; use Symbol::new for longer names
  const fnNameExpr = symbolExpr(firstFunctionName, "env");

  const contractAddrExpr = addressExpr(contractAddress, "env");

  // A function name that cannot collide with anything the schema declares.
  const knownFnNames = new Set(
    schema.contracts.flatMap(c => c.functions.map(f => f.name))
  );
  let unknownFn = "zzunknown";
  for (let i = 0; knownFnNames.has(unknownFn); i++) unknownFn = `zzunk${i}`;

  // One fixture derived from the global rules, shared by every positive call and every
  // positive control. Previously each of those hardcoded a single signer and never touched
  // the ledger, so a CORRECT threshold or time-locked policy failed its own positive tests.
  const requiredSigners = Math.max(
    1,
    ...schema.globalRules.map(r =>
      r.type === "threshold" ? r.params.threshold
        : r.type === "weighted_threshold" ? r.params.weights.length
        : 1),
  );

  const timeLock = schema.globalRules.find(r => r.type === "time_lock");
  const fixtureLedgerBody = timeLock && timeLock.type === "time_lock"
    ? `    env.ledger().with_mut(|l| l.sequence_number = ${
        // Pick a sequence strictly inside the declared window.
        (() => {
          const after = timeLock.params.validAfterLedger ?? 0;
          const until = timeLock.params.validUntilLedger ?? after + 1000;
          return Math.max(after, Math.min(until, after + 1));
        })()
      });`
    : "    let _ = env; // no time lock in this schema";

  // Test preamble
  tests.push(`
#[allow(unused_imports)]
use soroban_sdk::testutils::Address as _;
// Brings with_mut into scope for ledger manipulation in set_fixture_ledger().
#[allow(unused_imports)]
use soroban_sdk::testutils::Ledger as _;
#[allow(unused_imports)]
use soroban_sdk::auth::{Context, ContractContext};
#[allow(unused_imports)]
use soroban_sdk::{IntoVal, TryFromVal, FromVal};

/// Signers required for a call to satisfy every global rule in the schema. Positive tests and
/// the positive controls in negative tests must use this, not a hardcoded 1 — a correct
/// threshold-N policy rejects a 1-signer call, which would fail the control and make every
/// negative test unreachable.
const REQUIRED_SIGNERS: u32 = ${requiredSigners};

fn create_test_context_rule(env: &soroban_sdk::Env) -> ContextRule {
    let contract_addr = ${contractAddrExpr};
    ContextRule {
        id: 1,
        context_type: ContextRuleType::CallContract(contract_addr),
        name: soroban_sdk::String::from_str(env, "test-rule"),
        // Must be non-empty and at least REQUIRED_SIGNERS long: policies validate
        // threshold <= context_rule.signers.len() during install, so an empty signer list
        // makes install itself fail with InvalidThreshold before enforcement is ever reached.
        signers: create_test_signers(env, REQUIRED_SIGNERS),
        signer_ids: soroban_sdk::Vec::new(env),
        policies: soroban_sdk::Vec::new(env),
        policy_ids: soroban_sdk::Vec::new(env),
        valid_until: None,
    }
}

/// The signer set every positive call and every positive control uses.
fn fixture_signers(env: &soroban_sdk::Env) -> soroban_sdk::Vec<Signer> {
    create_test_signers(env, REQUIRED_SIGNERS)
}

/// Move the ledger inside any declared time-lock window. Without this the ledger stays at 0
/// and a correct time-locked policy rejects every positive call, including the one named
/// "within time window".
fn set_fixture_ledger(env: &soroban_sdk::Env) {
${fixtureLedgerBody}
}

fn create_test_params(env: &soroban_sdk::Env) -> soroban_sdk::Val {
    ${generateInstallParamsHelper(schema)}
}

fn create_test_signers(env: &soroban_sdk::Env, count: u32) -> soroban_sdk::Vec<Signer> {
    let mut signers = soroban_sdk::Vec::new(env);
    for _ in 0..count {
        signers.push_back(Signer::Delegated(<soroban_sdk::Address as soroban_sdk::testutils::Address>::generate(env)));
    }
    signers
}

fn build_default_args(env: &soroban_sdk::Env) -> soroban_sdk::Vec<soroban_sdk::Val> {
    let mut args: soroban_sdk::Vec<soroban_sdk::Val> = soroban_sdk::Vec::new(env);
${generateArgBuilderLines(firstFuncArgs, "    ", "default", { useConstraintValues: true }).replace(/&env/g, "env")}
    args
}

fn create_function_context(env: &soroban_sdk::Env, args: soroban_sdk::Vec<soroban_sdk::Val>) -> Context {
    let contract_addr = ${contractAddrExpr};
    Context::Contract(ContractContext {
        contract: contract_addr,
        fn_name: ${fnNameExpr},
        args,
    })
}

/// A contract address that appears nowhere in the schema. Enforcement must reject it.
fn create_unknown_contract_context(env: &soroban_sdk::Env, args: soroban_sdk::Vec<soroban_sdk::Val>) -> Context {
    Context::Contract(ContractContext {
        contract: <soroban_sdk::Address as soroban_sdk::testutils::Address>::generate(env),
        fn_name: ${fnNameExpr},
        args,
    })
}

/// A function name that appears nowhere in the schema. Enforcement must reject it.
fn create_unknown_function_context(env: &soroban_sdk::Env, args: soroban_sdk::Vec<soroban_sdk::Val>) -> Context {
    let contract_addr = ${contractAddrExpr};
    Context::Contract(ContractContext {
        contract: contract_addr,
        fn_name: ${symbolExpr(unknownFn, "env")},
        args,
    })
}
${generatePerFunctionHelpers(schema)}`);

  // Basic lifecycle tests
  tests.push(`
#[test]
fn test_install_succeeds() {
    let env = Env::default();
    env.mock_all_auths();
    set_fixture_ledger(&env);
    let contract_id = env.register(PolicyContract, ());
    let client = PolicyContractClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);
    let context_rule = create_test_context_rule(&env);
    client.install(&create_test_params(&env), &context_rule, &smart_account);
}`);

  tests.push(`
#[test]
fn test_uninstall_succeeds() {
    let env = Env::default();
    env.mock_all_auths();
    set_fixture_ledger(&env);
    let contract_id = env.register(PolicyContract, ());
    let client = PolicyContractClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);
    let context_rule = create_test_context_rule(&env);
    client.install(&create_test_params(&env), &context_rule, &smart_account);
    client.uninstall(&context_rule, &smart_account);
}`);

  // Basic enforce success test — catches policies that crash on ANY enforce() call.
  // Uses constraint-satisfying values (exact values where set, valid defaults otherwise).
  tests.push(`
#[test]
fn test_enforce_basic_succeeds() {
    let env = Env::default();
    env.mock_all_auths();
    set_fixture_ledger(&env);
    let contract_id = env.register(PolicyContract, ());
    let client = PolicyContractClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);
    let context_rule = create_test_context_rule(&env);
    client.install(&create_test_params(&env), &context_rule, &smart_account);
    let args = build_default_args(&env);
    let context = create_function_context(&env, args);
    let signers = fixture_signers(&env);
    client.enforce(&context, &signers, &context_rule, &smart_account);
}`);

  // --- DEFAULT-DENY: the invariant that makes this suite a gate at all ---
  // A policy whose enforce() is `{}` passes every positive test. These two are the only
  // tests that a no-op enforcement cannot survive, so they are generated unconditionally
  // for every schema regardless of which constraint kinds it happens to use.
  tests.push(`
#[test]
fn test_enforce_rejects_unknown_function() {
    let env = Env::default();
    env.mock_all_auths();
    set_fixture_ledger(&env);
    let contract_id = env.register(PolicyContract, ());
    let client = PolicyContractClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);
    let context_rule = create_test_context_rule(&env);
    client.install(&create_test_params(&env), &context_rule, &smart_account);
    // Positive control: the permitted call must succeed, so a failure below is
    // attributable to the unknown function rather than to broken setup.
    let ok_ctx = create_function_context(&env, build_default_args(&env));
    client.enforce(&ok_ctx, &fixture_signers(&env), &context_rule, &smart_account);

    let context = create_unknown_function_context(&env, build_default_args(&env));
    let signers = fixture_signers(&env);
    assert!(
        client.try_enforce(&context, &signers, &context_rule, &smart_account).is_err(),
        "enforce() accepted a function name that is not in the policy schema — \\
         an unlisted function must be rejected (default-deny)"
    );
}`);

  tests.push(`
#[test]
fn test_enforce_rejects_unknown_contract() {
    let env = Env::default();
    env.mock_all_auths();
    set_fixture_ledger(&env);
    let contract_id = env.register(PolicyContract, ());
    let client = PolicyContractClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);
    let context_rule = create_test_context_rule(&env);
    client.install(&create_test_params(&env), &context_rule, &smart_account);
    let ok_ctx = create_function_context(&env, build_default_args(&env));
    client.enforce(&ok_ctx, &fixture_signers(&env), &context_rule, &smart_account);

    let context = create_unknown_contract_context(&env, build_default_args(&env));
    let signers = fixture_signers(&env);
    assert!(
        client.try_enforce(&context, &signers, &context_rule, &smart_account).is_err(),
        "enforce() accepted a contract address that is not in the policy schema — \\
         an unlisted contract must be rejected (default-deny)"
    );
}`);

  // --- AUTHORIZATION ---
  // Every other test runs under mock_all_auths(), which masks a missing require_auth().
  // set_auths(&[]) removes all authorizations so the call must fail.
  tests.push(`
#[test]
fn test_enforce_requires_smart_account_auth() {
    let env = Env::default();
    env.mock_all_auths();
    set_fixture_ledger(&env);
    let contract_id = env.register(PolicyContract, ());
    let client = PolicyContractClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);
    let context_rule = create_test_context_rule(&env);
    client.install(&create_test_params(&env), &context_rule, &smart_account);

    let context = create_function_context(&env, build_default_args(&env));
    let signers = fixture_signers(&env);
    // Withdraw all authorization. smart_account.require_auth() must now fail.
    env.set_auths(&[]);
    assert!(
        client.try_enforce(&context, &signers, &context_rule, &smart_account).is_err(),
        "enforce() succeeded without the smart account's authorization — it must call \\
         smart_account.require_auth()"
    );
}`);

  tests.push(`
#[test]
fn test_enforce_before_install_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    set_fixture_ledger(&env);
    let contract_id = env.register(PolicyContract, ());
    let client = PolicyContractClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);
    let context_rule = create_test_context_rule(&env);
    // Deliberately no install().
    let context = create_function_context(&env, build_default_args(&env));
    let signers = fixture_signers(&env);
    assert!(
        client.try_enforce(&context, &signers, &context_rule, &smart_account).is_err(),
        "enforce() succeeded for a smart account that never installed the policy"
    );
}`);

  tests.push(`
#[test]
fn test_double_install_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    set_fixture_ledger(&env);
    let contract_id = env.register(PolicyContract, ());
    let client = PolicyContractClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);
    let context_rule = create_test_context_rule(&env);
    client.install(&create_test_params(&env), &context_rule, &smart_account);
    assert!(
        client.try_install(&create_test_params(&env), &context_rule, &smart_account).is_err(),
        "install() succeeded twice for the same (smart_account, context_rule) — the second \\
         call must be rejected so configuration cannot be silently overwritten"
    );
}`);

  // Constraint-based tests per argument
  for (const [contractIdx, contract] of schema.contracts.entries()) {
    for (const [funcIdx, func] of contract.functions.entries()) {
      const argIndex = (arg: ArgPermission) => func.args.indexOf(arg);
      // Each permission gets its OWN context. Previously every test reused
      // contracts[0].functions[0], so a test for contract #2 sent contract #1's context and
      // could "pass" because default-reject fired for entirely the wrong reason.
      const ctxFn = `create_context_c${contractIdx}_f${funcIdx}`;
      const argsFn = `build_args_c${contractIdx}_f${funcIdx}`;
      const suffix = `c${contractIdx}_f${funcIdx}`;

      for (const arg of func.args) {
        if (!arg.constraint || arg.constraint.kind === "unconstrained") continue;

        switch (arg.constraint.kind) {
          case "exact": {
            // Negative: a DIFFERENT value must be rejected. Every other argument is set to a
            // constraint-SATISFYING value so the rejection is attributable to this one.
            const wrongValue = generateWrongValueForType(arg.type, arg.constraint.value);
            if (wrongValue) {
              tests.push(rejectionTest({
                name: `test_enforce_${suffix}_${ident(arg.name)}_wrong_value`,
                argLines: generateArgBuilderLines(func.args, "    ", "default", { override_: { overrideIndex: argIndex(arg), overrideValue: wrongValue }, useConstraintValues: true }),
                ctxFn, argsFn,
                why: `enforce() accepted ${arg.name} with a value other than the required exact value`,
              }));
            }
            break;
          }

          case "range": {
            // `!= null`: a bound of 0 is a real limit and needs its test. `outsideBound`
            // returns null when the counterexample is not representable in the argument's
            // type (u32 max, u32/u128 min of 0), in which case the test is skipped rather
            // than emitting an out-of-range literal that breaks the whole crate.
            const above = arg.constraint.max != null
              ? outsideBound(arg.constraint.max, "above", arg.type) : null;
            if (above) {
              tests.push(rejectionTest({
                name: `test_enforce_${suffix}_${ident(arg.name)}_exceeds_max`,
                argLines: generateArgBuilderLines(func.args, "    ", "default", { override_: { overrideIndex: argIndex(arg), overrideValue: above }, useConstraintValues: true }),
                ctxFn, argsFn,
                why: `enforce() accepted ${arg.name} above its declared maximum of ${arg.constraint.max}`,
              }));
            }
            // Below-min was previously untested, so a one-sided implementation passed.
            const below = arg.constraint.min != null
              ? outsideBound(arg.constraint.min, "below", arg.type) : null;
            if (below) {
              tests.push(rejectionTest({
                name: `test_enforce_${suffix}_${ident(arg.name)}_below_min`,
                argLines: generateArgBuilderLines(func.args, "    ", "default", { override_: { overrideIndex: argIndex(arg), overrideValue: below }, useConstraintValues: true }),
                ctxFn, argsFn,
                why: `enforce() accepted ${arg.name} below its declared minimum of ${arg.constraint.min}`,
              }));
            }
            break;
          }

          case "allowlist":
            if (arg.constraint.values.length > 0) {
              const allowedValue = arg.constraint.values[0];
              // Positive: a listed value passes.
              tests.push(acceptanceTest({
                name: `test_enforce_${suffix}_${ident(arg.name)}_allowed`,
                argLines: generateArgBuilderLines(func.args, "    ", "default", { override_: { overrideIndex: argIndex(arg), overrideValue: generateLiteralForType(arg.type, allowedValue) }, useConstraintValues: true }),
                ctxFn, argsFn,
              }));
              // Negative: an UNLISTED value must be rejected. Without this a no-op enforce()
              // passed every allowlist-only schema.
              const notAllowed = generateWrongValueForType(arg.type, allowedValue);
              if (notAllowed) {
                tests.push(rejectionTest({
                  name: `test_enforce_${suffix}_${ident(arg.name)}_not_allowlisted`,
                  argLines: generateArgBuilderLines(func.args, "    ", "default", { override_: { overrideIndex: argIndex(arg), overrideValue: notAllowed }, useConstraintValues: true }),
                  ctxFn, argsFn,
                  why: `enforce() accepted ${arg.name} with a value that is not on its allowlist`,
                }));
              }
            }
            break;

          case "blocklist":
            if (arg.constraint.values.length > 0) {
              const blockedValue = arg.constraint.values[0];
              tests.push(rejectionTest({
                name: `test_enforce_${suffix}_${ident(arg.name)}_blocked`,
                argLines: generateArgBuilderLines(func.args, "    ", "default", { override_: { overrideIndex: argIndex(arg), overrideValue: generateLiteralForType(arg.type, blockedValue) }, useConstraintValues: true }),
                ctxFn, argsFn,
                why: `enforce() accepted ${arg.name} with a blocklisted value`,
              }));
            }
            break;
        }
      }
    }
  }

  // Global rule tests
  for (const rule of schema.globalRules) {
    switch (rule.type) {
      case "threshold":
        tests.push(`
#[test]
fn test_enforce_with_enough_signers() {
    let env = Env::default();
    env.mock_all_auths();
    set_fixture_ledger(&env);
    let contract_id = env.register(PolicyContract, ());
    let client = PolicyContractClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);
    let context_rule = create_test_context_rule(&env);
    client.install(&create_test_params(&env), &context_rule, &smart_account);
    let args = build_default_args(&env);
    let context = create_function_context(&env, args);
    let signers = create_test_signers(&env, ${rule.params.threshold});
    client.enforce(&context, &signers, &context_rule, &smart_account);
}`);

        tests.push(`
#[test]
#[should_panic]
fn test_enforce_insufficient_signers() {
    let env = Env::default();
    env.mock_all_auths();
    set_fixture_ledger(&env);
    let contract_id = env.register(PolicyContract, ());
    let client = PolicyContractClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);
    let context_rule = create_test_context_rule(&env);
    client.install(&create_test_params(&env), &context_rule, &smart_account);
    let args = build_default_args(&env);
    let context = create_function_context(&env, args);
    let signers = create_test_signers(&env, ${Math.max(0, rule.params.threshold - 1)});
    client.enforce(&context, &signers, &context_rule, &smart_account);
}`);
        break;

      case "time_lock": {
        // A window is only enforced if calls OUTSIDE it are rejected. The positive test alone
        // cannot show that, and worse, it cannot distinguish a policy reading the wrong clock:
        // `Env::default()` leaves timestamp() at 0, so a policy comparing
        // `timestamp() > valid_until_ledger` sees 0 > N, accepts, and passes. Moving the LEDGER
        // SEQUENCE outside the window separates them — a sequence-based policy rejects, while a
        // timestamp-confused one still sees 0 and accepts, failing this test loudly.
        const after = rule.params.validAfterLedger;
        const until = rule.params.validUntilLedger;

        if (until != null) {
          tests.push(`
#[test]
fn test_enforce_after_window_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    set_fixture_ledger(&env);
    let contract_id = env.register(PolicyContract, ());
    let client = PolicyContractClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);
    let context_rule = create_test_context_rule(&env);
    client.install(&create_test_params(&env), &context_rule, &smart_account);
    // Positive control inside the window, so a failure below is about the ledger and not setup.
    let ok_ctx = create_function_context(&env, build_default_args(&env));
    client.enforce(&ok_ctx, &fixture_signers(&env), &context_rule, &smart_account);

    env.ledger().with_mut(|l| l.sequence_number = ${until + 1});
    let context = create_function_context(&env, build_default_args(&env));
    assert!(
        client.try_enforce(&context, &fixture_signers(&env), &context_rule, &smart_account).is_err(),
        "enforce() accepted a call at ledger ${until + 1}, past valid_until_ledger ${until} — \
the window is unenforced, or the policy is comparing ledger().timestamp() (0 in tests) \
instead of ledger().sequence()"
    );
}`);
        }

        if (after != null && after > 0) {
          tests.push(`
#[test]
fn test_enforce_before_window_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    set_fixture_ledger(&env);
    let contract_id = env.register(PolicyContract, ());
    let client = PolicyContractClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);
    let context_rule = create_test_context_rule(&env);
    client.install(&create_test_params(&env), &context_rule, &smart_account);
    let ok_ctx = create_function_context(&env, build_default_args(&env));
    client.enforce(&ok_ctx, &fixture_signers(&env), &context_rule, &smart_account);

    env.ledger().with_mut(|l| l.sequence_number = ${Math.max(0, after - 1)});
    let context = create_function_context(&env, build_default_args(&env));
    assert!(
        client.try_enforce(&context, &fixture_signers(&env), &context_rule, &smart_account).is_err(),
        "enforce() accepted a call at ledger ${Math.max(0, after - 1)}, before valid_after_ledger ${after} — \
the window is unenforced, or the policy is reading the wrong clock"
    );
}`);
        }

        tests.push(`
#[test]
fn test_enforce_within_time_window() {
    let env = Env::default();
    env.mock_all_auths();
    set_fixture_ledger(&env);
    let contract_id = env.register(PolicyContract, ());
    let client = PolicyContractClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);
    let context_rule = create_test_context_rule(&env);
    client.install(&create_test_params(&env), &context_rule, &smart_account);
    let args = build_default_args(&env);
    let context = create_function_context(&env, args);
    let signers = fixture_signers(&env);
    client.enforce(&context, &signers, &context_rule, &smart_account);
}`);
        break;
      }

      case "weighted_threshold":
        tests.push(`
#[test]
fn test_enforce_weighted_threshold() {
    let env = Env::default();
    env.mock_all_auths();
    set_fixture_ledger(&env);
    let contract_id = env.register(PolicyContract, ());
    let client = PolicyContractClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);
    let context_rule = create_test_context_rule(&env);
    client.install(&create_test_params(&env), &context_rule, &smart_account);
    let args = build_default_args(&env);
    let context = create_function_context(&env, args);
    let signers = create_test_signers(&env, ${rule.params.weights.length});
    client.enforce(&context, &signers, &context_rule, &smart_account);
}`);
        break;
    }
  }

  tests.push(`
#[test]
fn test_uninstall_when_not_installed() {
    let env = Env::default();
    env.mock_all_auths();
    set_fixture_ledger(&env);
    let contract_id = env.register(PolicyContract, ());
    let client = PolicyContractClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);
    let context_rule = create_test_context_rule(&env);
    assert!(
        client.try_uninstall(&context_rule, &smart_account).is_err(),
        "uninstall() succeeded for a policy that was never installed"
    );
}`);

  return tests.join("\n");
}

// --- Test body builders ---

interface TestBodyOpts {
  name: string;
  argLines: string;
  ctxFn: string;
  argsFn: string;
  why?: string;
}

/**
 * A negative test. Uses `try_enforce(...).is_err()` rather than `#[should_panic]`: a bare
 * should_panic is satisfied by ANY panic, including one raised during install or argument
 * conversion, so a policy could "pass" a rejection test without ever rejecting anything.
 * The positive control first proves setup is sound.
 */
function rejectionTest({ name, argLines, ctxFn, argsFn, why }: TestBodyOpts): string {
  return `
#[test]
fn ${name}() {
    let env = Env::default();
    env.mock_all_auths();
    set_fixture_ledger(&env);
    let contract_id = env.register(PolicyContract, ());
    let client = PolicyContractClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);
    let context_rule = create_test_context_rule(&env);
    client.install(&create_test_params(&env), &context_rule, &smart_account);
    // Positive control: the compliant call must succeed, so the assertion below is
    // attributable to the mutated argument and not to broken setup.
    let ok_ctx = ${ctxFn}(&env, ${argsFn}(&env));
    client.enforce(&ok_ctx, &fixture_signers(&env), &context_rule, &smart_account);

    let mut args: soroban_sdk::Vec<soroban_sdk::Val> = soroban_sdk::Vec::new(&env);
${argLines}
    let context = ${ctxFn}(&env, args);
    let signers = fixture_signers(&env);
    assert!(
        client.try_enforce(&context, &signers, &context_rule, &smart_account).is_err(),
        "${why ?? "enforce() accepted a value that violates the policy schema"}"
    );
}`;
}

/** A positive test: a compliant call must be accepted. */
function acceptanceTest({ name, argLines, ctxFn, argsFn: _argsFn }: TestBodyOpts): string {
  return `
#[test]
fn ${name}() {
    let env = Env::default();
    env.mock_all_auths();
    set_fixture_ledger(&env);
    let contract_id = env.register(PolicyContract, ());
    let client = PolicyContractClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);
    let context_rule = create_test_context_rule(&env);
    client.install(&create_test_params(&env), &context_rule, &smart_account);
    let mut args: soroban_sdk::Vec<soroban_sdk::Val> = soroban_sdk::Vec::new(&env);
${argLines}
    let context = ${ctxFn}(&env, args);
    let signers = fixture_signers(&env);
    client.enforce(&context, &signers, &context_rule, &smart_account);
}`;
}

/**
 * One context builder and one default-args builder per (contract, function). Sharing a single
 * contracts[0].functions[0] context across every permission's tests meant a test nominally
 * about contract #2 actually sent contract #1's context.
 */
function generatePerFunctionHelpers(schema: PolicySchema): string {
  const out: string[] = [];
  for (const [ci, contract] of schema.contracts.entries()) {
    for (const [fi, func] of contract.functions.entries()) {
      out.push(`
fn build_args_c${ci}_f${fi}(env: &soroban_sdk::Env) -> soroban_sdk::Vec<soroban_sdk::Val> {
    let mut args: soroban_sdk::Vec<soroban_sdk::Val> = soroban_sdk::Vec::new(env);
${generateArgBuilderLines(func.args, "    ", "default", { useConstraintValues: true }).replace(/&env/g, "env")}
    args
}

fn create_context_c${ci}_f${fi}(env: &soroban_sdk::Env, args: soroban_sdk::Vec<soroban_sdk::Val>) -> Context {
    Context::Contract(ContractContext {
        contract: ${addressExpr(contract.address, "env")},
        fn_name: ${symbolExpr(func.name, "env")},
        args,
    })
}`);
    }
  }
  return out.join("\n");
}

// --- Arg builder helpers ---

interface ArgOverride {
  overrideIndex: number;
  overrideValue: string;
}

interface ArgBuilderOpts {
  override_?: ArgOverride;
  /** When true, use exact/allowlist constraint values instead of generic defaults. */
  useConstraintValues?: boolean;
}

function generateArgBuilderLines(
  args: ArgPermission[],
  indent: string,
  _mode: "default" = "default",
  optsOrOverride?: ArgOverride | ArgBuilderOpts,
): string {
  if (args.length === 0) {
    return `${indent}// No args`;
  }

  // Normalize legacy ArgOverride param to ArgBuilderOpts
  const opts: ArgBuilderOpts = optsOrOverride && "overrideIndex" in optsOrOverride
    ? { override_: optsOrOverride }
    : (optsOrOverride as ArgBuilderOpts | undefined) ?? {};

  return args.map((a, i) => {
    // If this arg has an override, use the override value directly
    if (opts.override_ && i === opts.override_.overrideIndex) {
      return `${indent}args.push_back(${opts.override_.overrideValue}.into_val(&env)); // ${a.name} (overridden)`;
    }

    // When useConstraintValues is set, use exact/allowlist values so the
    // enforce test passes with the constraint-satisfying inputs.
    if (opts.useConstraintValues && a.constraint) {
      if (a.constraint.kind === "exact") {
        return `${indent}args.push_back(${generateLiteralForType(a.type, a.constraint.value)}.into_val(&env)); // ${a.name} (exact)`;
      }
      if (a.constraint.kind === "allowlist" && a.constraint.values.length > 0) {
        return `${indent}args.push_back(${generateLiteralForType(a.type, a.constraint.values[0])}.into_val(&env)); // ${a.name} (allowlisted)`;
      }
      if (a.constraint.kind === "range") {
        // Use a real in-range value, preferring the max — the largest thing the policy must
        // still accept. Falling through to the 0 default below made every acceptance test
        // send amount = 0, which ANY policy accepts: one that divided the cap by 10^7, or
        // otherwise mis-scaled it, passed the whole suite and then rejected every real
        // transfer. That is exactly the bug this suite is supposed to be the gate for, and
        // testing at the boundary is what makes it one.
        const bound = a.constraint.max ?? a.constraint.min;
        if (bound != null) {
          const which = a.constraint.max != null ? "range max" : "range min";
          return `${indent}args.push_back(${numLiteral(BigInt(bound), a.type)}.into_val(&env)); // ${a.name} (${which}, must be accepted)`;
        }
      }
    }

    const t = a.type.toLowerCase();
    if (t === "address") {
      return `${indent}args.push_back((<soroban_sdk::Address as soroban_sdk::testutils::Address>::generate(&env)).into_val(&env)); // ${a.name}`;
    }
    if (t === "i128") return `${indent}args.push_back(0i128.into_val(&env)); // ${a.name}`;
    if (t === "u128") return `${indent}args.push_back(0u128.into_val(&env)); // ${a.name}`;
    if (t === "u64") return `${indent}args.push_back(0u64.into_val(&env)); // ${a.name}`;
    if (t === "i64") return `${indent}args.push_back(0i64.into_val(&env)); // ${a.name}`;
    if (t === "u32") return `${indent}args.push_back(0u32.into_val(&env)); // ${a.name}`;
    if (t === "i32") return `${indent}args.push_back(0i32.into_val(&env)); // ${a.name}`;
    if (t === "bool") return `${indent}args.push_back(false.into_val(&env)); // ${a.name}`;
    if (t === "symbol") return `${indent}args.push_back(soroban_sdk::Symbol::new(&env, "").into_val(&env)); // ${a.name}`;
    return `${indent}args.push_back(soroban_sdk::Val::VOID.into_val(&env)); // ${a.name}`;
  }).join("\n");
}

/** Generate a Rust literal for a given Soroban type and value string. */
function generateLiteralForType(argType: string, value: string): string {
  const t = argType.toLowerCase();
  if (t === "address") {
    return `soroban_sdk::Address::from_string(&soroban_sdk::String::from_str(&env, "${value}"))`;
  }
  if (t === "i128") return `${value}i128`;
  if (t === "u128") return `${value}u128`;
  if (t === "u64") return `${value}u64`;
  if (t === "i64") return `${value}i64`;
  if (t === "u32") return `${value}u32`;
  if (t === "i32") return `${value}i32`;
  if (t === "bool") return value === "true" ? "true" : "false";
  if (t === "symbol") return `soroban_sdk::Symbol::new(&env, "${value}")`;
  return `soroban_sdk::Val::VOID`;
}

/**
 * Generate a Rust literal that is a DIFFERENT value from the given one.
 * Used for exact-constraint negative tests — the returned value must NOT
 * match the constraint so enforce() should reject it.
 */
function generateWrongValueForType(argType: string, exactValue: string): string | null {
  const t = argType.toLowerCase();
  if (t === "address") {
    // Use a randomly generated address (guaranteed different from any specific address)
    return `<soroban_sdk::Address as soroban_sdk::testutils::Address>::generate(&env)`;
  }
  if (["i128", "u128", "i64", "u64", "i32", "u32"].includes(t)) {
    // Use a value that's different from the exact value
    const n = BigInt(exactValue || "0");
    const wrong = n === 0n ? 1n : n + 1n;
    return `${wrong}${numericSuffix(t)}`;
  }
  if (t === "bool") {
    return exactValue === "true" ? "false" : "true";
  }
  if (t === "symbol") {
    return `soroban_sdk::Symbol::new(&env, "__wrong__")`;
  }
  return null; // Can't generate a wrong value for complex types
}

/**
 * A Rust numeric literal, parenthesised when negative.
 *
 * `-1i128.into_val(&env)` parses as `-(1i128.into_val(&env))` — method calls bind tighter than
 * unary minus — which fails with `E0600: cannot apply unary operator - to type Val`. Verified
 * against rustc. Any negative literal that will have a method called on it MUST be wrapped.
 */
function numLiteral(value: bigint, argType: string): string {
  const lit = `${value}${numericSuffix(argType)}`;
  return value < 0n ? `(${lit})` : lit;
}

/** Inclusive representable range of a Soroban numeric type, or null if not numeric. */
function numericBounds(argType: string): { min: bigint; max: bigint } | null {
  switch (argType.toLowerCase()) {
    case "i128": return { min: -(2n ** 127n), max: 2n ** 127n - 1n };
    case "u128": return { min: 0n, max: 2n ** 128n - 1n };
    case "i64": return { min: -(2n ** 63n), max: 2n ** 63n - 1n };
    case "u64": return { min: 0n, max: 2n ** 64n - 1n };
    case "i32": return { min: -(2n ** 31n), max: 2n ** 31n - 1n };
    case "u32": return { min: 0n, max: 2n ** 32n - 1n };
    default: return null;
  }
}

/**
 * The counterexample just outside a bound, or null when it is not representable.
 *
 * A `u32` max of 4294967295 has no representable `max + 1`, and a `u32`/`u128` min of 0 has no
 * representable `min - 1`. Emitting them anyway produced `error: literal out of range` and
 * broke the whole crate, so those tests are skipped instead.
 */
function outsideBound(bound: string, dir: "above" | "below", argType: string): string | null {
  const bounds = numericBounds(argType);
  if (!bounds) return null;
  let value: bigint;
  try {
    value = dir === "above" ? BigInt(bound) + 1n : BigInt(bound) - 1n;
  } catch {
    return null; // non-numeric bound in the schema
  }
  if (value > bounds.max || value < bounds.min) return null;
  return numLiteral(value, argType);
}

/** Get the numeric suffix for a Rust numeric type. */
function numericSuffix(argType: string): string {
  const t = argType.toLowerCase();
  if (t === "i128") return "i128";
  if (t === "u128") return "u128";
  if (t === "u64") return "u64";
  if (t === "i64") return "i64";
  if (t === "u32") return "u32";
  if (t === "i32") return "i32";
  return "i128"; // default to i128 for unknown numeric types
}

/**
 * The install params the generated tests install with. Derived from the shared
 * `installParamsSpec()` so the tests install exactly the keys the prompt declares and the
 * deploy path sends. Drift here means a policy passes its tests and then fails its real
 * on-chain install.
 */
function generateInstallParamsHelper(schema: PolicySchema): string {
  const parts = installParamsSpec(schema).map(p => {
    const val = p.type === "i128" ? `${p.value}i128`
      : p.type === "u32" ? `${p.value}u32`
      : p.value === "true" ? "true" : "false";
    return `map.set(soroban_sdk::Symbol::new(env, "${p.key}").into_val(env), ${val}.into_val(env));`;
  });

  if (parts.length === 0) {
    return `soroban_sdk::Val::VOID.to_val()`;
  }

  return `{
        let mut map = soroban_sdk::Map::<soroban_sdk::Val, soroban_sdk::Val>::new(env);
        ${parts.join("\n        ")}
        map.into_val(env)
    }`;
}

// --- Cargo.toml Template ---

export const CARGO_TOML_TEMPLATE = `\
[package]
name = "policy-contract"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
soroban-sdk = "27.0.5"

[dev-dependencies]
soroban-sdk = { version = "27.0.5", features = ["testutils"] }

[profile.release]
opt-level = "z"
overflow-checks = true
debug = 0
strip = "symbols"
debug-assertions = false
panic = "abort"
codegen-units = 1
lto = true
`;

// --- Server Functions ---

interface SandboxInput {
  rustCode: string;
}

function validateSandboxInput(data: unknown): SandboxInput {
  if (typeof data !== "object" || data === null) {
    throw new Error("Invalid payload");
  }
  const { rustCode } = data as { rustCode?: unknown };
  if (typeof rustCode !== "string" || rustCode.length === 0) {
    throw new Error("rustCode is required");
  }
  if (rustCode.length > 100_000) {
    throw new Error("rustCode exceeds maximum size");
  }
  return { rustCode };
}

interface TestInput {
  rustCode: string;
  schemaJson: string;
}

/**
 * The test endpoint takes a SCHEMA, never test source.
 *
 * It previously accepted caller-supplied `testCode`, which made the whole suite advisory: any
 * client could POST `testCode: ""` and get a run with zero tests. Server functions are
 * ordinary HTTP endpoints, so no UI-side gate could close that. Generating the tests here,
 * from a schema that must pass validateSchema() first, is what makes the suite a control
 * rather than a suggestion.
 */
function validateTestInput(data: unknown): TestInput {
  if (typeof data !== "object" || data === null) {
    throw new Error("Invalid payload");
  }
  const { rustCode, schemaJson } = data as { rustCode?: unknown; schemaJson?: unknown };
  if (typeof rustCode !== "string" || rustCode.length === 0) {
    throw new Error("rustCode is required");
  }
  if (rustCode.length > 100_000) {
    throw new Error("rustCode exceeds maximum size");
  }
  if (typeof schemaJson !== "string" || schemaJson.length === 0) {
    // A client that omits schemaJson is almost always a STALE BUNDLE: this endpoint used to
    // accept caller-supplied `testCode`, and a page loaded before that change still sends it.
    // Say so, rather than surfacing an internal field name. Do NOT restore the testCode path
    // to be lenient here — accepting caller-supplied tests is exactly the bypass that made
    // the suite advisory instead of a gate.
    throw new Error(
      "This page is out of date — reload to continue. (The test endpoint now takes a policy "
      + "schema and generates its own tests server-side.)"
    );
  }
  if (schemaJson.length > 50_000) {
    throw new Error("schemaJson exceeds maximum size");
  }
  return { rustCode, schemaJson };
}

export const compilePolicyCode = createServerFn({ method: "POST" })
  .inputValidator(validateSandboxInput)
  .handler(async ({ data }): Promise<CompileResult> => {
    const { rustCode } = data;
    const sandbox = env.SANDBOX;
    if (!sandbox) {
      return { success: false, errors: ["Sandbox service not configured."], warnings: [], wasmBase64: null };
    }
    try {
      const response = await sandbox.fetch("https://sandbox/compile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cargoToml: CARGO_TOML_TEMPLATE, libRs: rustCode }),
      });
      if (!response.ok) {
        const errorText = await response.text();
        return { success: false, errors: [`Sandbox compile failed (${response.status}): ${errorText}`], warnings: [], wasmBase64: null };
      }
      const result = await response.json() as any;
      return { success: result.success ?? false, errors: result.errors ?? [], warnings: result.warnings ?? [], wasmBase64: result.wasmBase64 ?? null };
    } catch (err: any) {
      return { success: false, errors: [err.message || "Failed to reach sandbox service"], warnings: [], wasmBase64: null };
    }
  });

/** A line of cargo output, or the final parsed result once the run finishes. */
export interface TestStreamChunk {
  type: "log" | "result";
  text?: string;
  result?: TestResult;
}

/**
 * Split a buffer of SSE text into complete chunks, returning any partial
 * trailing frame to be prepended to the next read. A network read can land
 * mid-frame, so the tail must survive rather than be parsed or dropped.
 */
export function parseSseFrames(buffer: string): { chunks: TestStreamChunk[]; rest: string } {
  const frames = buffer.split("\n\n");
  const rest = frames.pop() ?? "";
  const chunks: TestStreamChunk[] = [];

  for (const frame of frames) {
    const line = frame.trim();
    if (!line.startsWith("data: ")) continue;
    try {
      chunks.push(JSON.parse(line.slice(6)) as TestStreamChunk);
    } catch {
      // A malformed frame shouldn't kill an in-progress build — skip it.
    }
  }

  return { chunks, rest };
}

function errorChunk(message: string): TestStreamChunk {
  return {
    type: "result",
    result: { success: false, compiled: false, testCases: [], compileOutput: message },
  };
}

/**
 * Streaming server function. Yields each line the sandbox prints while the
 * build runs, then one final "result" chunk. A cold run spends minutes
 * downloading and compiling crates, so the log is the only progress signal
 * there is.
 */
export const streamPolicyTest = createServerFn({ method: "POST" })
  .inputValidator(validateTestInput)
  .handler(async function* ({ data }): AsyncGenerator<TestStreamChunk> {
    const { rustCode, schemaJson } = data;

    // Tests are generated HERE, from a schema that must validate first. The caller cannot
    // supply, weaken, or omit them.
    const { schemaFromJSON, validateSchema } = await import("./policy-schema");
    let testCode: string;
    try {
      const schema = schemaFromJSON(schemaJson);
      const validation = validateSchema(schema);
      if (!validation.valid) {
        yield errorChunk(`Schema validation failed: ${validation.errors.join("; ")}`);
        return;
      }
      testCode = generateTestCases(schema);
    } catch (err: any) {
      yield errorChunk(`Could not generate tests from schema: ${err?.message ?? "invalid schema"}`);
      return;
    }
    if (!testCode.trim()) {
      yield errorChunk("Test generation produced no tests; refusing to run an empty suite.");
      return;
    }

    const sandbox = env.SANDBOX;
    if (!sandbox) {
      yield errorChunk("Sandbox service not configured.");
      return;
    }

    let response: Response;
    try {
      response = await sandbox.fetch("https://sandbox/test/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cargoToml: CARGO_TOML_TEMPLATE, libRs: rustCode, testCode }),
      });
    } catch (err: any) {
      yield errorChunk(err.message || "Failed to reach sandbox service");
      return;
    }

    if (!response.ok || !response.body) {
      const errorText = response.body ? await response.text() : "(no response body)";
      yield errorChunk(`Sandbox test failed (${response.status}): ${errorText}`);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawResult = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const { chunks, rest } = parseSseFrames(buffer);
        buffer = rest;
        for (const chunk of chunks) {
          if (chunk.type === "result") sawResult = true;
          yield chunk;
        }
      }
    } catch (err: any) {
      yield errorChunk(err.message || "Sandbox stream failed");
      return;
    }

    if (!sawResult) {
      yield errorChunk("Sandbox stream ended without a result.");
    }
  });

// --- Client-side convenience ---

export async function requestCompile(rustCode: string): Promise<CompileResult> {
  return compilePolicyCode({ data: { rustCode } });
}

/** Runs the sandbox tests, calling `onLog` for each line of cargo output as it arrives. */
export async function requestTest(
  rustCode: string,
  schema: PolicySchema,
  onLog?: (line: string) => void,
): Promise<TestResult> {
  // Send the schema, not the tests. The server regenerates them so the suite cannot be
  // weakened by a caller.
  const generator = await streamPolicyTest({
    data: { rustCode, schemaJson: schemaToJSON(schema) },
  });

  let result: TestResult = {
    success: false,
    compiled: false,
    testCases: [],
    compileOutput: "Sandbox stream ended without a result.",
  };

  for await (const chunk of generator) {
    if (chunk.type === "log" && chunk.text) {
      onLog?.(chunk.text);
    } else if (chunk.type === "result" && chunk.result) {
      result = chunk.result;
    }
  }

  return result;
}
