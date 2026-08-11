import { StrKey } from "@stellar/stellar-sdk";

// --- Policy Schema Types ---
// Deterministic JSON schema that describes a policy contract.
// Version: pollywallet-policy/v0
//
// Schema is spec-driven: function signatures come from contract WASM specs
// with named, typed parameters. Constraints are per-argument. Complex
// enforcement behaviors are described via natural language notes.

export const SCHEMA_VERSION = "pollywallet-policy/v0";

// --- Argument Constraint Types ---

export type ArgConstraint =
  | { kind: "exact"; value: string }
  | { kind: "range"; min?: string; max?: string }
  | { kind: "allowlist"; values: string[] }
  | { kind: "blocklist"; values: string[] }
  | { kind: "unconstrained" };

export type ArgConstraintKind = ArgConstraint["kind"];

/** Per-argument permission with optional constraint and notes. */
export interface ArgPermission {
  /** Argument name from contract spec (e.g. "to", "amount", "token_a") */
  name: string;
  /** Argument type from contract spec (e.g. "address", "i128", "Vec<address>") */
  type: string;
  /** User-defined constraint on this argument */
  constraint?: ArgConstraint;
  /** Natural language guidance for Kimi about this argument */
  note?: string;
  /** Observed values from tx analysis (for pre-filling defaults) */
  observedValues?: string[];
  /** One observed ScVal XDR fixture for ABI types the harness cannot construct itself. */
  observedXdr?: string;
}

// --- Global Rule Types (unchanged) ---

export interface ThresholdParams {
  threshold: number;
}

export interface WeightedThresholdParams {
  threshold: number;
  weights: Array<{ signer: string; weight: number }>;
}

export interface TimeLockParams {
  validAfterLedger?: number;
  validUntilLedger?: number;
}

// --- Contract-scoped Permission Types ---

/** Contract-level permission — explicitly listed contracts are allowed, all others rejected. */
export interface ContractPermission {
  /** Stellar contract address (C...) */
  address: string;
  /** Human-readable label */
  label?: string;
  /** Allowed functions on this contract. Unlisted functions are rejected. */
  functions: FunctionPermission[];
  /**
   * Result of calling `decimals()` on this contract, when it answers. DISPLAY ONLY.
   *
   * Constraint values are always base units — what the contract actually compares — and this
   * never changes what is stored. It exists so the builder can show "1000000000" alongside
   * "= 100.0000000", which is what makes a mis-scaled bound visible at the moment it is typed.
   *
   * An earlier revision used this to CONVERT typed values, treating every i128 on a contract
   * with decimals as a token amount. That is not knowable in general: a policy may constrain
   * any argument of any contract, and an i128 deadline, id, price or ratio would have been
   * silently multiplied by 10^decimals — the same ten-million-fold error the conversion was
   * added to prevent, just pointing the other way. Units are a property of an argument's
   * meaning, which the contract spec does not carry, so the builder no longer guesses.
   *
   * Queried, never assumed: 7 is near-universal but is a property of the asset, not of Stellar.
   */
  decimals?: number;
}

/**
 * Render a base-unit integer in whole tokens, for DISPLAY ONLY.
 *
 * Nothing derived from this is ever stored. Constraint values are always base units, exactly
 * as the contract compares them, so this only exists to make a typed number legible: 1000000000
 * beside "= 100.0000000". String math, never floats — Number arithmetic puts 0.1 XLM at
 * 1000000.0000000001 stroops.
 */
export function toDisplayUnits(base: string, decimals: number): string {
  const trimmed = base.trim();
  if (!/^-?\d+$/.test(trimmed)) return base;
  const negative = trimmed.startsWith("-");
  const magnitude = BigInt(negative ? trimmed.slice(1) : trimmed);
  const scale = 10n ** BigInt(decimals);
  const frac = (magnitude % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${magnitude / scale}${frac ? `.${frac}` : ""}`;
}

/** Function-level permission with per-arg constraints and notes. */
export interface FunctionPermission {
  /** Function name from contract spec (e.g. "transfer", "swap", "deposit") */
  name: string;
  /** Per-argument permissions with types, constraints, and notes */
  args: ArgPermission[];
  /** Natural language guidance for Kimi about this function's enforcement behavior */
  note?: string;
}

/** Rules that apply globally regardless of contract (signer requirements, time windows) */
export type GlobalRule =
  | { type: "threshold"; params: ThresholdParams }
  | { type: "weighted_threshold"; params: WeightedThresholdParams }
  | { type: "time_lock"; params: TimeLockParams };

export type GlobalRuleType = GlobalRule["type"];

// --- Top-level Schema ---

export interface PolicySchema {
  $schema: string;
  name: string;
  description: string;
  /** Allowed contracts and their function permissions. Unlisted contracts are rejected. */
  contracts: ContractPermission[];
  /** Global rules applied to all contexts (signer thresholds, time locks) */
  globalRules: GlobalRule[];
}

// --- TxPattern (imported concept from tx-analyzer) ---

export interface TxPattern {
  contractAddress: string;
  functionName: string;
  args: { type: string; value: string; xdr?: string }[];
  signers: { type: "Delegated" | "External"; identity: string }[];
  /** If this is an execute() call, decomposed inner call details */
  innerCall?: {
    targetContract: string;
    functionName: string;
    args: { type: string; value: string; xdr?: string }[];
  };
}

// --- Constraint-Type Compatibility ---

/** Returns the valid constraint kinds for a given argument type. */
/**
 * Whether a bound or exact value for this type is a raw integer quantity.
 *
 * Only these carry base units. `exact` is also valid on address, bool, symbol and string, and
 * labelling one of those "(base units)" tells the user their memo is a number.
 */
export function isIntegerArgType(argType: string): boolean {
  return ["i128", "u128", "i64", "u64", "i32", "u32"].includes(argType.toLowerCase());
}

export function constraintKindsForType(argType: string): ArgConstraintKind[] {
  const t = argType.toLowerCase();

  if (t === "address") {
    return ["unconstrained", "exact", "allowlist", "blocklist"];
  }
  if (t === "i128") {
    return ["unconstrained", "exact", "range"];
  }
  if (["u128", "i64", "u64", "i32", "u32"].includes(t)) {
    return ["unconstrained", "exact"];
  }
  if (t === "bool") {
    return ["unconstrained", "exact"];
  }
  if (["symbol", "string"].includes(t)) {
    return ["unconstrained", "exact", "allowlist"];
  }
  // Complex types (Vec, Map, struct, enum, bytes, etc.) — notes only
  return ["unconstrained"];
}

function isHarnessRepresentableType(argType: string): boolean {
  const t = argType.toLowerCase();
  return [
    "address", "i128", "u128", "i64", "u64", "i32", "u32", "bool", "symbol",
    "string", "u256", "i256", "timepoint", "duration", "bytes",
  ].includes(t) || /^bytes<\d+>$/.test(t) || /^(vec|option)<.+>$/.test(t) || /^map<.+,.+>$/.test(t);
}

function numericTypeBounds(argType: string): { min: bigint; max: bigint } | null {
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

// --- Validation ---

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const VALID_GLOBAL_RULE_TYPES: GlobalRuleType[] = [
  "threshold",
  "weighted_threshold",
  "time_lock",
];

export function validateSchema(schema: PolicySchema): ValidationResult {
  const errors: string[] = [];

  if (schema.$schema !== SCHEMA_VERSION) {
    errors.push(`Invalid $schema: expected "${SCHEMA_VERSION}", got "${schema.$schema}"`);
  }

  if (!schema.name || typeof schema.name !== "string") {
    errors.push("name is required and must be a non-empty string");
  } else if (!/^[a-z0-9-]+$/.test(schema.name)) {
    errors.push("name must be lowercase alphanumeric with hyphens only");
  } else if (schema.name.length > 20) {
    errors.push("name must be 20 characters or fewer (smart account limit)");
  }

  if (!schema.description || typeof schema.description !== "string") {
    errors.push("description is required and must be a non-empty string");
  }

  // Contracts validation
  if (!Array.isArray(schema.contracts) || schema.contracts.length === 0) {
    errors.push("At least one contract is required");
  } else if (schema.contracts.length > 1) {
    // Deployment builds ONE ContextRuleType::CallContract from contracts[0] (policy-deploy.ts).
    // The account rejects calls to every other contract before the policy is ever consulted, so
    // a multi-contract schema installs "successfully" with all but the first permission dead.
    // Fail here rather than report a false success.
    errors.push(
      `Only one contract per policy is supported — this schema lists ${schema.contracts.length}. ` +
      `Deployment attaches the policy to a single contract, so the others would silently never apply. ` +
      `Split them into separate policies.`
    );
  } else {
    for (let ci = 0; ci < schema.contracts.length; ci++) {
      const c = schema.contracts[ci];
      const cPrefix = `Contract ${ci}`;

      if (!c.address || typeof c.address !== "string") {
        errors.push(`${cPrefix}: address is required`);
      } else if (!isValidContractAddress(c.address)) {
        // A first-character check is not enough. An address with a valid prefix but a bad
        // checksum passes straight through to codegen and the generated tests, then fails at
        // RUNTIME inside the contract with
        //   HostError: Error(Value, InvalidInput) "couldn't process the string as strkey"
        // which surfaces as an unexplained test failure rather than a schema error.
        errors.push(
          `${cPrefix}: address is not a valid Stellar contract address (C... StrKey): "${c.address}"`
        );
      }

      if (!Array.isArray(c.functions) || c.functions.length === 0) {
        errors.push(`${cPrefix}: at least one function is required`);
      } else {
        for (let fi = 0; fi < c.functions.length; fi++) {
          const func = c.functions[fi];
          const fPrefix = `${cPrefix}, Function ${fi}`;

          if (!func.name || typeof func.name !== "string") {
            errors.push(`${fPrefix}: name is required and must be a non-empty string`);
          }

          // Validate arg constraints
          if (Array.isArray(func.args)) {
            for (let ai = 0; ai < func.args.length; ai++) {
              const arg = func.args[ai];
              const aPrefix = `${fPrefix}, Arg ${ai} (${arg.name})`;

              if (!arg.name || typeof arg.name !== "string") {
                errors.push(`${aPrefix}: name is required`);
              }
              if (!arg.type || typeof arg.type !== "string") {
                errors.push(`${aPrefix}: type is required`);
              } else if (!isHarnessRepresentableType(arg.type) && !arg.observedXdr) {
                errors.push(
                  `${aPrefix}: type "${arg.type}" needs an analyzed transaction fixture because ` +
                  `the policy test harness cannot construct this user-defined ABI type. Re-analyze ` +
                  `a transaction that calls this function.`,
                );
              }

              if (arg.constraint && arg.constraint.kind !== "unconstrained") {
                const validKinds = constraintKindsForType(arg.type);
                if (!validKinds.includes(arg.constraint.kind)) {
                  errors.push(
                    `${aPrefix}: constraint kind "${arg.constraint.kind}" is not valid for type ` +
                    `"${arg.type}" because it is not yet supported by the policy test harness; ` +
                    `use unconstrained with a note, ` +
                    `but note-driven behavior cannot be verified automatically`,
                  );
                }
                const numericArgType = numericTypeBounds(arg.type) ? arg.type : undefined;
                const constraintErrors = validateConstraint(arg.constraint, aPrefix, numericArgType);
                errors.push(...constraintErrors);

                // Address VALUES need the same checksum check as contract addresses. The
                // generated policy bakes these literals into Address::from_string(), so a
                // malformed one panics at runtime with an opaque
                // Error(Value, InvalidInput) "unexpected strkey length" during install —
                // long after the schema was accepted.
                const constraintValues = arg.constraint.kind === "exact" ? [arg.constraint.value]
                  : arg.constraint.kind === "allowlist" || arg.constraint.kind === "blocklist"
                    ? arg.constraint.values : [];

                if (arg.type.toLowerCase() === "address") {
                  for (const v of constraintValues) {
                    if (typeof v === "string" && v && !isValidAddress(v)) {
                      errors.push(
                        `${aPrefix}: "${v}" is not a valid Stellar address (G... or C... StrKey)`
                      );
                    }
                  }
                }

                // Symbols need the same check for the same reason as addresses. A Soroban Symbol
                // is [a-zA-Z0-9_] up to 32 chars and `Symbol::new` PANICS on anything else — at
                // runtime, inside the generated test fixtures. An unvalidated value reached
                // build_default_args and killed every enforce test in setup with
                // `Error(Value, InvalidInput)`, reporting ~10 failures against a policy that may
                // be perfectly correct and naming nothing in the schema.
                if (arg.type.toLowerCase() === "symbol") {
                  for (const v of constraintValues) {
                    if (typeof v === "string" && !/^[a-zA-Z0-9_]{1,32}$/.test(v)) {
                      errors.push(
                        `${aPrefix}: "${v}" is not a valid Soroban Symbol — letters, digits and ` +
                        `underscores only, 1 to 32 characters`
                      );
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  // Global rules validation
  if (Array.isArray(schema.globalRules)) {
    const seenTypes = new Set<GlobalRuleType>();
    for (let i = 0; i < schema.globalRules.length; i++) {
      const rule = schema.globalRules[i];
      if (!VALID_GLOBAL_RULE_TYPES.includes(rule.type)) {
        errors.push(`Global Rule ${i}: invalid type "${rule.type}"`);
        continue;
      }
      // One rule per type. The test generator emits a fixed set of test fns per rule, so two
      // rules of the same type produce two Rust fns with the same name and the whole crate
      // fails to compile — reported as an opaque build failure with nothing pointing at the
      // schema. Two rules of one type also have no meaning: the second silently wins in
      // install params, which are a flat map.
      if (seenTypes.has(rule.type)) {
        errors.push(
          `Global Rule ${i}: a second "${rule.type}" rule. Only one rule of each type is ` +
          `supported — install params are a flat map and the generated tests are named per ` +
          `rule type, so a duplicate would overwrite the first and break the build.`
        );
        continue;
      }
      seenTypes.add(rule.type);
      const ruleErrors = validateGlobalRule(rule, `Global Rule ${i}`);
      errors.push(...ruleErrors);
    }
  }

  errors.push(...collidingInstallParamKeys(schema));

  return { valid: errors.length === 0, errors };
}

/**
 * Install params are a flat Map keyed by "max_{arg}"/"min_{arg}"/"allowed_{arg}", so two
 * functions that constrain an argument of the SAME NAME collide — `transfer(amount)` capped at
 * 100 and `burn(amount)` capped at 50 both emit `max_amount`. An ScMap cannot hold a duplicate
 * key: one bound silently disappears and the policy enforces the wrong number, with nothing
 * on screen to say so.
 *
 * The flat key space is what the generated contract and the prompt convention are built on, so
 * rather than silently picking a winner, refuse the schema. Identical values are harmless and
 * allowed — that is one bound expressed twice, not two bounds.
 */
function collidingInstallParamKeys(schema: PolicySchema): string[] {
  const seen = new Map<string, string>();
  const collisions = new Set<string>();
  for (const param of installParamsSpec(schema)) {
    const previous = seen.get(param.key);
    if (previous !== undefined && previous !== param.value) collisions.add(param.key);
    else seen.set(param.key, param.value);
  }
  return [...collisions].map(
    (key) =>
      `Conflicting values for install param "${key}": two functions constrain the same ` +
      `argument name with different values. Install params are a flat map, so only one bound ` +
      `would survive. Argument names come from the contract ABI and cannot be renamed, so ` +
      `either use the same bound for both, or split them into separate policies — one per ` +
      `context rule.`
  );
}

function validateConstraint(
  constraint: ArgConstraint,
  prefix: string,
  /** Set when the argument is a numeric Soroban type, so literals can be checked. */
  numericArgType?: string,
): string[] {
  const errors: string[] = [];

  switch (constraint.kind) {
    case "exact": {
      if (!constraint.value || typeof constraint.value !== "string") {
        errors.push(`${prefix}: exact constraint requires a value`);
      } else if (numericArgType && !/^-?\d+$/.test(constraint.value.trim())) {
        // Reaches generated Rust as `<value><suffix>`; "1e5" or "1.5" is not a Rust integer
        // literal and the crate fails to compile after a full cargo build.
        errors.push(
          `${prefix}: exact value for a ${numericArgType} argument must be a whole number, ` +
          `got "${constraint.value}"`
        );
      } else if (numericArgType) {
        const bounds = numericTypeBounds(numericArgType)!;
        const value = BigInt(constraint.value.trim());
        if (value < bounds.min || value > bounds.max) {
          errors.push(`${prefix}: exact value ${constraint.value} is outside the ${numericArgType} range`);
        }
      }
      break;
    }
    case "range": {
      if (constraint.min == null && constraint.max == null) {
        errors.push(`${prefix}: range constraint requires at least min or max`);
        break;
      }
      // Bounds are base-unit integers. Anything else fails far away and opaquely: BigInt()
      // throws while building install params at deploy, and the generated tests interpolate
      // it as `${value}i128`, so the crate fails to compile for reasons that name neither the
      // schema nor the field.
      for (const [name, bound] of [["min", constraint.min], ["max", constraint.max]] as const) {
        if (bound != null && !/^-?\d+$/.test(String(bound).trim())) {
          errors.push(`${prefix}: range ${name} must be a whole number in base units, got "${bound}"`);
        } else if (bound != null && numericArgType) {
          const bounds = numericTypeBounds(numericArgType)!;
          const value = BigInt(String(bound).trim());
          if (value < bounds.min || value > bounds.max) {
            errors.push(`${prefix}: range ${name} ${bound} is outside the ${numericArgType} range`);
          }
        }
      }
      if (
        constraint.min != null && constraint.max != null &&
        /^-?\d+$/.test(String(constraint.min).trim()) && /^-?\d+$/.test(String(constraint.max).trim()) &&
        BigInt(String(constraint.min).trim()) > BigInt(String(constraint.max).trim())
      ) {
        errors.push(`${prefix}: range min (${constraint.min}) is greater than max (${constraint.max})`);
      }
      if (numericArgType) {
        const bounds = numericTypeBounds(numericArgType)!;
        const min = constraint.min != null && /^-?\d+$/.test(String(constraint.min).trim())
          ? BigInt(String(constraint.min).trim()) : bounds.min;
        const max = constraint.max != null && /^-?\d+$/.test(String(constraint.max).trim())
          ? BigInt(String(constraint.max).trim()) : bounds.max;
        if (min <= bounds.min && max >= bounds.max) {
          errors.push(
            `${prefix}: range covers every ${numericArgType} value, so the test harness cannot produce a rejection counterexample`,
          );
        }
      }
      break;
    }
    case "allowlist": {
      if (!Array.isArray(constraint.values) || constraint.values.length === 0) {
        errors.push(`${prefix}: allowlist requires at least one value`);
      }
      break;
    }
    case "blocklist": {
      if (!Array.isArray(constraint.values) || constraint.values.length === 0) {
        errors.push(`${prefix}: blocklist requires at least one value`);
      }
      break;
    }
  }

  return errors;
}

/** A real, whole, in-range u32 — what every global-rule number becomes in the generated Rust. */
function isU32(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

function validateGlobalRule(rule: GlobalRule, prefix: string): string[] {
  const errors: string[] = [];

  switch (rule.type) {
    case "threshold": {
      // `< 1` alone let 1.5 through, which reaches the generated tests as
      // `const REQUIRED_SIGNERS: u32 = 1.5;` and `create_test_signers(&env, 1.5)`, and reaches
      // the deploy path as `BigInt("1.5")`, which throws. Neither names the schema.
      if (!isU32(rule.params.threshold) || rule.params.threshold < 1) {
        errors.push(`${prefix}: threshold must be a whole number of at least 1`);
      } else if (rule.params.threshold > 1) {
        // Refused for the same reason as weighted_threshold: nothing downstream can satisfy it.
        // buildAddContextRuleTx attaches EXACTLY ONE signer to a policy rule — the ephemeral
        // ed25519 key — and rule-management can only remove signers, never add them. So
        // `authenticated_signers` can never exceed 1 for a rule carrying a policy. A threshold
        // above 1 either fails install (the OZ pattern validates threshold <= signers.len()) or
        // installs and then rejects every real transaction, both AFTER the suite passed and the
        // policy deployed. Threshold 1 is still meaningful: a policy-only rule can authenticate
        // zero signers.
        errors.push(
          `${prefix}: threshold must be 1. A policy rule is deployed with exactly one delegated ` +
          `signer (the ephemeral key) and signers can only be removed from it, so a threshold ` +
          `above 1 can never be met on-chain — the policy would install and then reject every ` +
          `transaction. Requiring more signers means changing how the rule is deployed, not the ` +
          `policy.`
        );
      }
      break;
    }
    case "weighted_threshold": {
      // Refused, not validated. Three things have to be true for a weighted threshold to mean
      // anything, and none of them are:
      //   1. Deployment attaches exactly ONE External signer, the ephemeral key
      //      (policy-deploy.ts). The addresses named in `weights` are not signers on the rule.
      //   2. Install params carry no weights and no threshold, so the deployed policy has
      //      nothing to enforce against.
      //   3. The generated suite has only a positive test for this rule and no rejection test,
      //      and cannot build one: it fabricates arbitrary signers rather than the named ones.
      // A policy ignoring the rule entirely passes every generated test. Accepting the schema
      // would tell a user they configured M-of-N when they deployed 1-of-1.
      errors.push(
        `${prefix}: weighted_threshold is not supported. A deployed policy carries a single ` +
        `delegated key, weights are never written to install params, and the generated test ` +
        `suite cannot prove a below-threshold signer set is rejected — so the rule would be ` +
        `decorative. Use a "threshold" rule, or express the requirement in an argument note.`
      );
      break;
    }
    case "time_lock": {
      const { validAfterLedger, validUntilLedger } = rule.params;
      if (validAfterLedger == null && validUntilLedger == null) {
        errors.push(`${prefix}: at least one of validAfterLedger or validUntilLedger is required`);
      } else if (validUntilLedger == null && validAfterLedger === 0) {
        // A window of "after ledger 0" is every ledger, so the generator can build no rejection
        // counterexample for it: the after-window test needs an upper bound and the before-window
        // test needs `after > 0`. The schema emitted a positive-only test that any policy
        // ignoring the rule passes, while installParamsSpec still sent valid_after_ledger and the
        // UI still showed a configured time lock. Decorative, in the weighted_threshold sense.
        errors.push(
          `${prefix}: validAfterLedger 0 is not a window — every ledger is after 0, so nothing ` +
          `can be tested against it and the rule would be decorative. Set validUntilLedger, or ` +
          `a validAfterLedger above 0.`
        );
      }
      // A ledger sequence is a u32 on-chain and is interpolated straight into the generated
      // Rust. Unchecked, a float emitted `l.sequence_number = 4294967295.5`, and u32::MAX
      // emitted `4294967296` for the past-the-window edge — `error: literal out of range`,
      // which takes the whole crate down for a reason that names nothing in the schema.
      for (const [name, value] of [
        ["validAfterLedger", validAfterLedger], ["validUntilLedger", validUntilLedger],
      ] as const) {
        // u32::MAX is excluded deliberately: the rejection test needs `validUntilLedger + 1`.
        if (value != null && (!isU32(value) || value >= 0xffff_ffff)) {
          errors.push(
            `${prefix}: ${name} must be a whole ledger sequence between 0 and ${0xffff_fffe}`
          );
        }
      }
      if (validAfterLedger != null && validUntilLedger != null && validAfterLedger >= validUntilLedger) {
        errors.push(`${prefix}: validAfterLedger must be less than validUntilLedger`);
      }
      break;
    }
  }

  return errors;
}

// --- Schema Generation from TxPatterns ---

/**
 * Auto-generate a policy schema from analyzed transaction patterns.
 * Creates per-arg permissions with observed values and type-appropriate
 * default constraints.
 */
export function schemaFromPatterns(patterns: TxPattern[]): PolicySchema {
  if (patterns.length === 0) {
    return emptySchema();
  }

  const contractMap = new Map<string, Map<string, {
    args: Map<number, { type: string; values: string[]; xdr?: string }>;
  }>>();

  for (const p of patterns) {
    const effectiveContract = (p.functionName === "execute" && p.innerCall)
      ? p.innerCall.targetContract
      : p.contractAddress;
    const effectiveFunction = (p.functionName === "execute" && p.innerCall)
      ? p.innerCall.functionName
      : p.functionName;
    const effectiveArgs = (p.functionName === "execute" && p.innerCall)
      ? p.innerCall.args
      : p.args;

    if (!contractMap.has(effectiveContract)) {
      contractMap.set(effectiveContract, new Map());
    }
    const funcMap = contractMap.get(effectiveContract)!;

    if (!funcMap.has(effectiveFunction)) {
      funcMap.set(effectiveFunction, { args: new Map() });
    }

    const entry = funcMap.get(effectiveFunction)!;
    for (let i = 0; i < effectiveArgs.length; i++) {
      if (!entry.args.has(i)) {
        entry.args.set(i, {
          type: effectiveArgs[i].type,
          values: [],
          xdr: effectiveArgs[i].xdr,
        });
      }
      const arg = entry.args.get(i)!;
      arg.values.push(effectiveArgs[i].value);
      arg.xdr ??= effectiveArgs[i].xdr;
    }
  }

  // Build contracts
  const contracts: ContractPermission[] = [...contractMap.entries()].map(([addr, funcMap]) => ({
    address: addr,
    functions: [...funcMap.entries()].map(([funcName, entry]) => {
      const args: ArgPermission[] = [...entry.args.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, argData]) => {
          const arg: ArgPermission = {
            name: `arg${[...entry.args.entries()].find(([, v]) => v === argData)?.[0] ?? 0}`,
            type: argData.type,
            observedValues: [...new Set(argData.values)],
            observedXdr: argData.xdr,
          };
          return arg;
        });

      return { name: funcName, args } as FunctionPermission;
    }),
  }));

  // Global rules (threshold from signer counts)
  const globalRules: GlobalRule[] = [];
  const signerCounts = patterns.map(p => p.signers.length);
  const maxSigners = Math.max(...signerCounts, 0);
  if (maxSigners > 1) {
    globalRules.push({ type: "threshold", params: { threshold: Math.ceil(maxSigners / 2) } });
  }

  return {
    $schema: SCHEMA_VERSION,
    name: "auto-policy",
    description: `Policy for ${contracts.length} contract(s)`,
    contracts,
    globalRules,
  };
}

/**
 * Merge contract spec info into a schema, enriching arg names and types.
 * Spec-derived names/types take precedence over tx-analysis guesses.
 */
export function mergeSpecIntoSchema(
  schema: PolicySchema,
  contractAddress: string,
  specFunctions: { name: string; inputs: { name: string; type: string }[] }[],
  decimals?: number,
): PolicySchema {
  return {
    ...schema,
    contracts: schema.contracts.map(c => {
      if (c.address !== contractAddress) return c;
      return {
        ...c,
        decimals: decimals ?? c.decimals,
        functions: c.functions.map(func => {
          const specFunc = specFunctions.find(sf => sf.name === func.name);
          if (!specFunc) return func;

          // Merge spec arg names/types into existing arg permissions
          const mergedArgs: ArgPermission[] = specFunc.inputs.map((specInput, i) => {
            const existingArg = func.args[i];
            return {
              name: specInput.name,
              type: specInput.type,
              constraint: existingArg?.constraint,
              note: existingArg?.note,
              observedValues: existingArg?.observedValues,
              observedXdr: existingArg?.observedXdr,
            };
          });

          return { ...func, args: mergedArgs };
        }),
      };
    }),
  };
}

/** Create an empty schema with sensible defaults for the editor. */
export function emptySchema(): PolicySchema {
  return {
    $schema: SCHEMA_VERSION,
    name: "",
    description: "",
    contracts: [],
    globalRules: [],
  };
}

// --- JSON Serialization Helpers ---

export function schemaToJSON(schema: PolicySchema): string {
  return JSON.stringify(schema, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
    2
  );
}

export function schemaFromJSON(json: string): PolicySchema {
  return JSON.parse(json) as PolicySchema;
}

// --- Install Params Convention (single source of truth) ---
//
// The Symbol keys sent to a policy's `install()` are consumed by THREE independent places:
//   1. buildInstallParamsKeyList()   (policy-codegen.ts) — tells the model which keys exist
//   2. generateInstallParamsHelper() (policy-sandbox.ts) — what the generated tests install with
//   3. the deploy path               (routes/policies.tsx) — what is actually sent on-chain
//
// They MUST agree. They previously drifted: the prompt declared `allowed_*` and time-lock keys
// that the on-chain builder never sent, and the on-chain builder used truthy `if (max)` guards
// that silently dropped a bound of 0. Once the prompt began instructing policies to PANIC on a
// missing declared key, that drift turned from a silent-permissive bug into a hard install
// failure: allowlist/time_lock schemas would pass their tests, deploy, then fail
// add_context_rule on-chain. Derive all three from this one function.

export interface InstallParam {
  key: string;
  /** Soroban type of the value. */
  type: "i128" | "u32" | "bool";
  /** Value as a string; callers convert per `type`. */
  value: string;
  /** Human-readable purpose, used in the prompt's key list. */
  description: string;
}

export function installParamsSpec(schema: PolicySchema): InstallParam[] {
  const params: InstallParam[] = [];

  for (const contract of schema.contracts) {
    for (const func of contract.functions) {
      for (const arg of func.args) {
        const c = arg.constraint;
        if (!c || c.kind === "unconstrained") continue;

        if (c.kind === "range") {
          // `!= null`, never truthiness: a bound of "0" is a real constraint.
          if (c.max != null) {
            params.push({
              key: `max_${arg.name}`, type: "i128", value: String(c.max),
              description: `maximum allowed value for ${arg.name}`,
            });
          }
          if (c.min != null) {
            params.push({
              key: `min_${arg.name}`, type: "i128", value: String(c.min),
              description: `minimum allowed value for ${arg.name}`,
            });
          }
        }

        // Feature flags only. The permitted VALUES are baked into the generated contract from
        // the schema; install params carry no list. The flag exists so every declared constraint
        // puts SOMETHING in install_params.
        //
        // That invariant is load-bearing, and exact/blocklist used to break it. The system
        // prompt says a void install_params is acceptable ONLY when the schema declares no
        // constraints and no global rules, and must panic otherwise. An exact-only or
        // blocklist-only schema declared constraints and produced an EMPTY param list, so both
        // the generated tests and the real deploy sent Val::VOID — leaving the model a coin
        // flip between obeying the prompt (panic, failing test_install_succeeds) and accepting
        // it (passing, contradicting the prompt). Same value, same key space, no drift: the
        // prompt's key list, the tests, and the deploy path all read this function.
        if (c.kind === "allowlist" && c.values.length > 0) {
          params.push({
            key: `allowed_${arg.name}`, type: "bool", value: "true",
            description: `flag that the allowlist for ${arg.name} is enabled`,
          });
        }

        if (c.kind === "blocklist" && c.values.length > 0) {
          params.push({
            key: `blocked_${arg.name}`, type: "bool", value: "true",
            description: `flag that the blocklist for ${arg.name} is enabled`,
          });
        }

        if (c.kind === "exact") {
          params.push({
            key: `exact_${arg.name}`, type: "bool", value: "true",
            description: `flag that the exact-value rule for ${arg.name} is enabled`,
          });
        }
      }
    }
  }

  for (const rule of schema.globalRules) {
    if (rule.type === "threshold") {
      params.push({
        key: "threshold", type: "u32", value: String(rule.params.threshold),
        description: `minimum number of signers required (value: ${rule.params.threshold})`,
      });
    }
    if (rule.type === "time_lock") {
      if (rule.params.validAfterLedger != null) {
        params.push({
          key: "valid_after_ledger", type: "u32", value: String(rule.params.validAfterLedger),
          description: "earliest allowed ledger",
        });
      }
      if (rule.params.validUntilLedger != null) {
        params.push({
          key: "valid_until_ledger", type: "u32", value: String(rule.params.validUntilLedger),
          description: "latest allowed ledger",
        });
      }
    }
  }

  // Soroban requires ScMap keys in ascending order and REJECTS an unsorted map during
  // ScVal -> host conversion. Schema order is not sorted order: two constrained args yield
  // [max_amount, min_amount, max_to, min_to], which must become
  // [max_amount, max_to, min_amount, min_to]. The in-contract test harness never caught this
  // because it builds the map with host `Map::set`, which sorts for you — only the real
  // deploy path hand-builds the ScMap. smart-account-kit sorts its own param maps the same
  // way (canonical lexical field order).
  return params.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// --- Address validation ---

/**
 * True when `value` is a checksum-valid Stellar contract address.
 *
 * Contracts must be `C...` StrKeys. A prefix-only check lets a malformed address reach the
 * generated Rust, where `Address::from_string` panics at runtime with an opaque
 * `Error(Value, InvalidInput)` — a schema problem disguised as a policy bug.
 *
 */
export function isValidContractAddress(value: string): boolean {
  return StrKey.isValidContract(value);
}

/** True for either an account (`G...`) or contract (`C...`) address. */
export function isValidAddress(value: string): boolean {
  return StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value);
}
