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
  args: { type: string; value: string }[];
  signers: { type: "Delegated" | "External"; identity: string }[];
  /** If this is an execute() call, decomposed inner call details */
  innerCall?: {
    targetContract: string;
    functionName: string;
    args: { type: string; value: string }[];
  };
}

// --- Constraint-Type Compatibility ---

/** Returns the valid constraint kinds for a given argument type. */
export function constraintKindsForType(argType: string): ArgConstraintKind[] {
  const t = argType.toLowerCase();

  if (t === "address") {
    return ["unconstrained", "exact", "allowlist", "blocklist"];
  }
  if (["i128", "u128", "i64", "u64", "i32", "u32", "i256", "u256", "timepoint", "duration"].includes(t)) {
    return ["unconstrained", "exact", "range"];
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
  } else {
    for (let ci = 0; ci < schema.contracts.length; ci++) {
      const c = schema.contracts[ci];
      const cPrefix = `Contract ${ci}`;

      if (!c.address || typeof c.address !== "string") {
        errors.push(`${cPrefix}: address is required`);
      } else if (!c.address.startsWith("C") && !c.address.startsWith("G")) {
        errors.push(`${cPrefix}: address must start with "C" or "G"`);
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
              }

              if (arg.constraint && arg.constraint.kind !== "unconstrained") {
                const validKinds = constraintKindsForType(arg.type);
                if (!validKinds.includes(arg.constraint.kind)) {
                  errors.push(`${aPrefix}: constraint kind "${arg.constraint.kind}" is not valid for type "${arg.type}"`);
                }
                const constraintErrors = validateConstraint(arg.constraint, aPrefix);
                errors.push(...constraintErrors);
              }
            }
          }
        }
      }
    }
  }

  // Global rules validation
  if (Array.isArray(schema.globalRules)) {
    for (let i = 0; i < schema.globalRules.length; i++) {
      const rule = schema.globalRules[i];
      if (!VALID_GLOBAL_RULE_TYPES.includes(rule.type)) {
        errors.push(`Global Rule ${i}: invalid type "${rule.type}"`);
        continue;
      }
      const ruleErrors = validateGlobalRule(rule, `Global Rule ${i}`);
      errors.push(...ruleErrors);
    }
  }

  return { valid: errors.length === 0, errors };
}

function validateConstraint(constraint: ArgConstraint, prefix: string): string[] {
  const errors: string[] = [];

  switch (constraint.kind) {
    case "exact": {
      if (!constraint.value || typeof constraint.value !== "string") {
        errors.push(`${prefix}: exact constraint requires a value`);
      }
      break;
    }
    case "range": {
      if (constraint.min == null && constraint.max == null) {
        errors.push(`${prefix}: range constraint requires at least min or max`);
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

function validateGlobalRule(rule: GlobalRule, prefix: string): string[] {
  const errors: string[] = [];

  switch (rule.type) {
    case "threshold": {
      if (typeof rule.params.threshold !== "number" || rule.params.threshold < 1) {
        errors.push(`${prefix}: threshold must be a positive integer`);
      }
      break;
    }
    case "weighted_threshold": {
      if (typeof rule.params.threshold !== "number" || rule.params.threshold < 1) {
        errors.push(`${prefix}: threshold must be a positive number`);
      }
      if (!Array.isArray(rule.params.weights) || rule.params.weights.length === 0) {
        errors.push(`${prefix}: weights must be a non-empty array`);
      } else {
        let totalWeight = 0;
        for (const w of rule.params.weights) {
          if (typeof w.weight !== "number" || w.weight < 1) {
            errors.push(`${prefix}: each weight must be a positive number`);
          } else {
            totalWeight += w.weight;
          }
        }
        if (totalWeight < rule.params.threshold) {
          errors.push(`${prefix}: total weights (${totalWeight}) must be >= threshold (${rule.params.threshold})`);
        }
      }
      break;
    }
    case "time_lock": {
      const { validAfterLedger, validUntilLedger } = rule.params;
      if (validAfterLedger == null && validUntilLedger == null) {
        errors.push(`${prefix}: at least one of validAfterLedger or validUntilLedger is required`);
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
    args: Map<number, { type: string; values: string[] }>;
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
        entry.args.set(i, { type: effectiveArgs[i].type, values: [] });
      }
      entry.args.get(i)!.values.push(effectiveArgs[i].value);
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
): PolicySchema {
  return {
    ...schema,
    contracts: schema.contracts.map(c => {
      if (c.address !== contractAddress) return c;
      return {
        ...c,
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
