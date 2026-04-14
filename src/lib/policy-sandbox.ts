import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import type { PolicySchema, ArgPermission } from "./policy-schema";
import { schemaToJSON } from "./policy-schema";

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
export function generateTestCases(schema: PolicySchema): string {
  const tests: string[] = [];

  const contractAddress = schema.contracts[0]?.address ?? "";
  const firstFunc = schema.contracts[0]?.functions[0];
  const firstFunctionName = firstFunc?.name ?? "invoke";
  const firstFuncArgs = firstFunc?.args ?? [];

  // For symbol_short!, function names must be ≤9 chars; use Symbol::new for longer names
  const fnNameExpr = firstFunctionName.length <= 9
    ? `soroban_sdk::symbol_short!("${firstFunctionName}")`
    : `soroban_sdk::Symbol::new(env, "${firstFunctionName}")`;

  const contractAddrExpr = contractAddress
    ? `soroban_sdk::Address::from_string(&soroban_sdk::String::from_str(env, "${contractAddress}"))`
    : `<soroban_sdk::Address as soroban_sdk::testutils::Address>::generate(env)`;

  // Test preamble
  tests.push(`
#[allow(unused_imports)]
use soroban_sdk::testutils::Address as _;
#[allow(unused_imports)]
use soroban_sdk::auth::{Context, ContractContext};
#[allow(unused_imports)]
use soroban_sdk::{IntoVal, TryFromVal, FromVal};

fn create_test_context_rule(env: &soroban_sdk::Env) -> ContextRule {
    let contract_addr = ${contractAddrExpr};
    ContextRule {
        id: 1,
        context_type: ContextRuleType::CallContract(contract_addr),
        name: soroban_sdk::String::from_str(env, "test-rule"),
        signers: soroban_sdk::Vec::new(env),
        signer_ids: soroban_sdk::Vec::new(env),
        policies: soroban_sdk::Vec::new(env),
        policy_ids: soroban_sdk::Vec::new(env),
        valid_until: None,
    }
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
}`);

  // Basic lifecycle tests
  tests.push(`
#[test]
fn test_install_succeeds() {
    let env = Env::default();
    env.mock_all_auths();
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
    let contract_id = env.register(PolicyContract, ());
    let client = PolicyContractClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);
    let context_rule = create_test_context_rule(&env);
    client.install(&create_test_params(&env), &context_rule, &smart_account);
    let args = build_default_args(&env);
    let context = create_function_context(&env, args);
    let signers = create_test_signers(&env, 1);
    client.enforce(&context, &signers, &context_rule, &smart_account);
}`);

  // Constraint-based tests per argument
  for (const contract of schema.contracts) {
    for (const func of contract.functions) {
      const argIndex = (arg: ArgPermission) => func.args.indexOf(arg);

      for (const arg of func.args) {
        if (!arg.constraint || arg.constraint.kind === "unconstrained") continue;

        switch (arg.constraint.kind) {
          case "exact": {
            // Negative test: use a DIFFERENT value to prove the exact enforcement works.
            // This makes exact constraints visible in test output and catches
            // policies that silently pass when they should reject.
            const wrongValue = generateWrongValueForType(arg.type, arg.constraint.value);
            if (wrongValue) {
              tests.push(`
#[test]
#[should_panic]
fn test_enforce_${arg.name}_wrong_value() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PolicyContract, ());
    let client = PolicyContractClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);
    let context_rule = create_test_context_rule(&env);
    client.install(&create_test_params(&env), &context_rule, &smart_account);
    let mut args: soroban_sdk::Vec<soroban_sdk::Val> = soroban_sdk::Vec::new(&env);
${generateArgBuilderLines(func.args, "    ", "default", { override_: { overrideIndex: argIndex(arg), overrideValue: wrongValue }, useConstraintValues: true })}
    let context = create_function_context(&env, args);
    let signers = create_test_signers(&env, 1);
    client.enforce(&context, &signers, &context_rule, &smart_account);
}`);
            }
            break;
          }

          case "range":
            if (arg.constraint.max) {
              // Build args with the specific constrained arg EXCEEDING the max
              const exceedingValue = `${BigInt(arg.constraint.max) + 1n}`;
              tests.push(`
#[test]
#[should_panic]
fn test_enforce_${arg.name}_exceeds_range() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PolicyContract, ());
    let client = PolicyContractClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);
    let context_rule = create_test_context_rule(&env);
    client.install(&create_test_params(&env), &context_rule, &smart_account);
    let mut args: soroban_sdk::Vec<soroban_sdk::Val> = soroban_sdk::Vec::new(&env);
${generateArgBuilderLines(func.args, "    ", "default", { overrideIndex: argIndex(arg), overrideValue: `${exceedingValue}${numericSuffix(arg.type)}` })}
    let context = create_function_context(&env, args);
    let signers = create_test_signers(&env, 1);
    client.enforce(&context, &signers, &context_rule, &smart_account);
}`);
            }
            break;

          case "allowlist":
            // Use a value that IS in the allowlist so enforce should succeed
            if (arg.constraint.values.length > 0) {
              const allowedValue = arg.constraint.values[0];
              tests.push(`
#[test]
fn test_enforce_${arg.name}_allowed() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PolicyContract, ());
    let client = PolicyContractClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);
    let context_rule = create_test_context_rule(&env);
    client.install(&create_test_params(&env), &context_rule, &smart_account);
    let mut args: soroban_sdk::Vec<soroban_sdk::Val> = soroban_sdk::Vec::new(&env);
${generateArgBuilderLines(func.args, "    ", "default", { overrideIndex: argIndex(arg), overrideValue: generateLiteralForType(arg.type, allowedValue) })}
    let context = create_function_context(&env, args);
    let signers = create_test_signers(&env, 1);
    client.enforce(&context, &signers, &context_rule, &smart_account);
}`);
            }
            break;

          case "blocklist":
            // Use a value that IS in the blocklist so enforce should panic
            if (arg.constraint.values.length > 0) {
              const blockedValue = arg.constraint.values[0];
              tests.push(`
#[test]
#[should_panic]
fn test_enforce_${arg.name}_blocked() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PolicyContract, ());
    let client = PolicyContractClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);
    let context_rule = create_test_context_rule(&env);
    client.install(&create_test_params(&env), &context_rule, &smart_account);
    let mut args: soroban_sdk::Vec<soroban_sdk::Val> = soroban_sdk::Vec::new(&env);
${generateArgBuilderLines(func.args, "    ", "default", { overrideIndex: argIndex(arg), overrideValue: generateLiteralForType(arg.type, blockedValue) })}
    let context = create_function_context(&env, args);
    let signers = create_test_signers(&env, 1);
    client.enforce(&context, &signers, &context_rule, &smart_account);
}`);
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

      case "time_lock":
        tests.push(`
#[test]
fn test_enforce_within_time_window() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PolicyContract, ());
    let client = PolicyContractClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);
    let context_rule = create_test_context_rule(&env);
    client.install(&create_test_params(&env), &context_rule, &smart_account);
    let args = build_default_args(&env);
    let context = create_function_context(&env, args);
    let signers = create_test_signers(&env, 1);
    client.enforce(&context, &signers, &context_rule, &smart_account);
}`);
        break;

      case "weighted_threshold":
        tests.push(`
#[test]
fn test_enforce_weighted_threshold() {
    let env = Env::default();
    env.mock_all_auths();
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
#[should_panic]
fn test_uninstall_when_not_installed() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(PolicyContract, ());
    let client = PolicyContractClient::new(&env, &contract_id);
    let smart_account = Address::generate(&env);
    let context_rule = create_test_context_rule(&env);
    client.uninstall(&context_rule, &smart_account);
}`);

  return tests.join("\n");
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
      if (a.constraint.kind === "range" && a.constraint.min != null) {
        return `${indent}args.push_back(${a.constraint.min}${numericSuffix(a.type)}.into_val(&env)); // ${a.name} (range min)`;
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

function generateInstallParamsHelper(schema: PolicySchema): string {
  // Build a generic install params map from constraints and notes
  const parts: string[] = [];

  for (const contract of schema.contracts) {
    for (const func of contract.functions) {
      for (const arg of func.args) {
        if (!arg.constraint || arg.constraint.kind === "unconstrained") continue;

        if (arg.constraint.kind === "range") {
          if (arg.constraint.max) {
            parts.push(`map.set(soroban_sdk::Symbol::new(env, "max_${arg.name}").into_val(env), ${arg.constraint.max}i128.into_val(env));`);
          }
          if (arg.constraint.min) {
            parts.push(`map.set(soroban_sdk::Symbol::new(env, "min_${arg.name}").into_val(env), ${arg.constraint.min}i128.into_val(env));`);
          }
        }
        if (arg.constraint.kind === "allowlist" && arg.constraint.values.length > 0) {
          // Store first allowlisted address as a reference
          parts.push(`map.set(soroban_sdk::Symbol::new(env, "allowed_${arg.name}").into_val(env), true.into_val(env));`);
        }
      }
    }
  }

  // Check global rules
  for (const rule of schema.globalRules) {
    if (rule.type === "threshold") {
      parts.push(`map.set(soroban_sdk::Symbol::new(env, "threshold").into_val(env), ${rule.params.threshold}u32.into_val(env));`);
    }
    if (rule.type === "time_lock") {
      const after = rule.params.validAfterLedger ?? 0;
      const until = rule.params.validUntilLedger ?? 999999999;
      parts.push(`map.set(soroban_sdk::Symbol::new(env, "valid_after_ledger").into_val(env), ${after}u32.into_val(env));`);
      parts.push(`map.set(soroban_sdk::Symbol::new(env, "valid_until_ledger").into_val(env), ${until}u32.into_val(env));`);
    }
  }

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

const CARGO_TOML_TEMPLATE = `\
[package]
name = "policy-contract"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
soroban-sdk = "25.3"

[dev-dependencies]
soroban-sdk = { version = "25.3", features = ["testutils"] }

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
  testCode?: string;
}

function validateSandboxInput(data: unknown): SandboxInput {
  if (typeof data !== "object" || data === null) {
    throw new Error("Invalid payload");
  }
  const { rustCode, testCode } = data as { rustCode?: unknown; testCode?: unknown };
  if (typeof rustCode !== "string" || rustCode.length === 0) {
    throw new Error("rustCode is required");
  }
  if (rustCode.length > 100_000) {
    throw new Error("rustCode exceeds maximum size");
  }
  if (testCode != null && typeof testCode !== "string") {
    throw new Error("testCode must be a string");
  }
  return { rustCode, testCode: testCode as string | undefined };
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

export const testPolicyCode = createServerFn({ method: "POST" })
  .inputValidator(validateSandboxInput)
  .handler(async ({ data }): Promise<TestResult> => {
    const { rustCode, testCode } = data;
    const sandbox = env.SANDBOX;
    if (!sandbox) {
      return { success: false, compiled: false, testCases: [], compileOutput: "Sandbox service not configured." };
    }
    try {
      const response = await sandbox.fetch("https://sandbox/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cargoToml: CARGO_TOML_TEMPLATE, libRs: rustCode, testCode: testCode ?? "" }),
      });
      if (!response.ok) {
        const errorText = await response.text();
        return { success: false, compiled: false, testCases: [], compileOutput: `Sandbox test failed (${response.status}): ${errorText}` };
      }
      const result = await response.json() as any;
      return {
        success: result.success ?? false,
        compiled: result.compiled ?? false,
        testCases: (result.testCases ?? []).map((tc: any) => ({ name: tc.name ?? "unknown", passed: tc.passed ?? false, output: tc.output ?? "" })),
        compileOutput: result.compileOutput ?? "",
      };
    } catch (err: any) {
      return { success: false, compiled: false, testCases: [], compileOutput: err.message || "Failed to reach sandbox service" };
    }
  });

// --- Client-side convenience ---

export async function requestCompile(rustCode: string): Promise<CompileResult> {
  return compilePolicyCode({ data: { rustCode } });
}

export async function requestTest(rustCode: string, schema: PolicySchema): Promise<TestResult> {
  const testCode = generateTestCases(schema);
  return testPolicyCode({ data: { rustCode, testCode } });
}
