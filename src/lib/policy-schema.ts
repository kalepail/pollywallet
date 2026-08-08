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
  /**
   * Result of calling `decimals()` on this contract, when it is a token.
   *
   * Amount arguments cross the contract boundary in BASE UNITS: `transfer(from, to, amount)`
   * takes 10_000_000 for 1 XLM, not 1. Without this, a "max 100" typed in the builder installs
   * a 100-stroop cap — 0.00001 XLM — and every real transfer is rejected. That shipped, and
   * cost two live wallets their policies until it was traced on-device.
   *
   * Queried, never assumed: 7 is overwhelmingly common but is a property of the token, not of
   * Stellar. Undefined means "not a token / not known", and amounts are then passed through
   * verbatim as base units.
   */
  decimals?: number;
}

/** 10^decimals, as a bigint, for converting between display and base units. */
function unitScale(decimals: number): bigint {
  return 10n ** BigInt(decimals);
}

/**
 * Convert a human-typed decimal amount ("1.5") into base units ("15000000" at 7 decimals).
 *
 * String math, never floats: 0.1 XLM through `Number` arithmetic lands on 1000000.0000000001
 * stroops. Returns null when the input is not a well-formed decimal or carries more precision
 * than the token can express, so callers can surface that instead of silently truncating.
 */
export function toBaseUnits(display: string, decimals: number): string | null {
  const trimmed = display.trim();
  const m = /^(-?)(\d+)(?:\.(\d*))?$/.exec(trimmed);
  if (!m) return null;
  const [, sign, whole, frac = ""] = m;
  if (frac.length > decimals) return null;
  const digits = whole + frac.padEnd(decimals, "0");
  return `${sign}${BigInt(digits)}`;
}

/** Inverse of toBaseUnits, for redisplaying a stored schema. Trailing zeros trimmed. */
export function toDisplayUnits(base: string, decimals: number): string {
  const trimmed = base.trim();
  if (!/^-?\d+$/.test(trimmed)) return base;
  const negative = trimmed.startsWith("-");
  const magnitude = BigInt(negative ? trimmed.slice(1) : trimmed);
  const scale = unitScale(decimals);
  const frac = (magnitude % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${magnitude / scale}${frac ? `.${frac}` : ""}`;
}

/**
 * Whether this argument carries a token amount, and so needs unit conversion.
 *
 * Deliberately narrow: an i128 on a token contract is nearly always an amount, but `decimals`
 * is only set for contracts that actually answered `decimals()`, so non-token contracts never
 * reach here and a non-amount i128 on a token contract is rare enough to accept.
 */
export function isAmountArg(arg: ArgPermission, decimals?: number): boolean {
  return decimals != null && arg.type.toLowerCase() === "i128";
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
              }

              if (arg.constraint && arg.constraint.kind !== "unconstrained") {
                const validKinds = constraintKindsForType(arg.type);
                if (!validKinds.includes(arg.constraint.kind)) {
                  errors.push(`${aPrefix}: constraint kind "${arg.constraint.kind}" is not valid for type "${arg.type}"`);
                }
                const constraintErrors = validateConstraint(arg.constraint, aPrefix);
                errors.push(...constraintErrors);

                // Address VALUES need the same checksum check as contract addresses. The
                // generated policy bakes these literals into Address::from_string(), so a
                // malformed one panics at runtime with an opaque
                // Error(Value, InvalidInput) "unexpected strkey length" during install —
                // long after the schema was accepted.
                if (arg.type.toLowerCase() === "address") {
                  const values = arg.constraint.kind === "exact" ? [arg.constraint.value]
                    : arg.constraint.kind === "allowlist" || arg.constraint.kind === "blocklist"
                      ? arg.constraint.values : [];
                  for (const v of values) {
                    if (typeof v === "string" && v && !isValidAddress(v)) {
                      errors.push(
                        `${aPrefix}: "${v}" is not a valid Stellar address (G... or C... StrKey)`
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
      `argument name differently. Install params are a flat map, so only one bound would ` +
      `survive. Rename the argument or split these into separate policies.`
  );
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

        if (c.kind === "allowlist" && c.values.length > 0) {
          // A feature flag only. The permitted VALUES are baked into the generated contract
          // from the schema; install params carry no list. Keep the flag so the contract can
          // verify it was configured deliberately.
          params.push({
            key: `allowed_${arg.name}`, type: "bool", value: "true",
            description: `flag that the allowlist for ${arg.name} is enabled`,
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
 * Implemented locally rather than via `StrKey` from @stellar/stellar-sdk so this module stays
 * dependency-free: it is imported by the prompt builder, the test generator, and the browser
 * route alike.
 */
export function isValidContractAddress(value: string): boolean {
  return isValidStrKey(value, "C");
}

/** True for either an account (`G...`) or contract (`C...`) address. */
export function isValidAddress(value: string): boolean {
  return isValidStrKey(value, "G") || isValidStrKey(value, "C");
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function isValidStrKey(value: string, prefix: string): boolean {
  if (typeof value !== "string" || !value.startsWith(prefix) || value.length !== 56) return false;

  // base32 decode
  const bytes: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const ch of value) {
    const idx = B32.indexOf(ch);
    if (idx === -1) return false;
    acc = (acc << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  if (bytes.length !== 35) return false; // 1 version + 32 payload + 2 checksum

  const payload = bytes.slice(0, 33);
  const checksum = bytes[33] | (bytes[34] << 8);
  return crc16xmodem(payload) === checksum;
}

/** CRC16-XModem, the checksum StrKey uses. */
function crc16xmodem(bytes: number[]): number {
  let crc = 0x0000;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}
