import { describe, it, expect } from "vitest";
import {
  validateSchema,
  schemaFromPatterns,
  mergeSpecIntoSchema,
  schemaToJSON,
  schemaFromJSON,
  emptySchema,
  constraintKindsForType,
  installParamsSpec,
  isIntegerArgType,
  toDisplayUnits,
  SCHEMA_VERSION,
  type PolicySchema,
  type TxPattern,
} from "../policy-schema";

// --- Helpers ---

function validSchema(overrides?: Partial<PolicySchema>): PolicySchema {
  return {
    $schema: SCHEMA_VERSION,
    name: "test-policy",
    description: "A test policy",
    contracts: [
      {
        address: "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526",
        functions: [
          {
            name: "transfer",
            args: [
              { name: "from", type: "address" },
              { name: "to", type: "address" },
              { name: "amount", type: "i128" },
            ],
          },
        ],
      },
    ],
    globalRules: [{ type: "threshold", params: { threshold: 1 } }],
    ...overrides,
  };
}

// --- validateSchema ---

describe("validateSchema", () => {
  it("should accept a valid schema", () => {
    const result = validateSchema(validSchema());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("should reject invalid $schema version", () => {
    const result = validateSchema(validSchema({ $schema: "wrong-version" }));
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("Invalid $schema");
  });

  it("should reject empty name", () => {
    const result = validateSchema(validSchema({ name: "" }));
    expect(result.valid).toBe(false);
  });

  it("should reject name with uppercase letters", () => {
    const result = validateSchema(validSchema({ name: "TestPolicy" }));
    expect(result.valid).toBe(false);
  });

  it("should accept name with hyphens and numbers", () => {
    const result = validateSchema(validSchema({ name: "my-policy-123" }));
    expect(result.valid).toBe(true);
  });

  it("should reject empty description", () => {
    const result = validateSchema(validSchema({ description: "" }));
    expect(result.valid).toBe(false);
  });

  it("should reject empty contracts array", () => {
    const result = validateSchema(validSchema({ contracts: [] }));
    expect(result.valid).toBe(false);
  });

  it("should reject contract without address", () => {
    const result = validateSchema(
      validSchema({
        contracts: [{ address: "", functions: [{ name: "transfer", args: [] }] }],
      })
    );
    expect(result.valid).toBe(false);
  });

  it("should reject contract without functions", () => {
    const result = validateSchema(
      validSchema({ contracts: [{ address: "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526", functions: [] }] })
    );
    expect(result.valid).toBe(false);
  });

  // --- Constraint validation ---

  describe("arg constraints", () => {
    it("should accept valid allowlist constraint on address arg", () => {
      const result = validateSchema(
        validSchema({
          contracts: [{
            address: "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526",
            functions: [{
              name: "transfer",
              args: [
                { name: "to", type: "address", constraint: { kind: "allowlist", values: ["GABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQHGPC"] } },
              ],
            }],
          }],
        })
      );
      expect(result.valid).toBe(true);
    });

    it("should reject empty allowlist", () => {
      const result = validateSchema(
        validSchema({
          contracts: [{
            address: "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526",
            functions: [{
              name: "transfer",
              args: [
                { name: "to", type: "address", constraint: { kind: "allowlist", values: [] } },
              ],
            }],
          }],
        })
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("at least one value"))).toBe(true);
    });

    it("should accept valid range constraint on numeric arg", () => {
      const result = validateSchema(
        validSchema({
          contracts: [{
            address: "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526",
            functions: [{
              name: "transfer",
              args: [
                { name: "amount", type: "i128", constraint: { kind: "range", max: "1000000" } },
              ],
            }],
          }],
        })
      );
      expect(result.valid).toBe(true);
    });

    it("should reject range constraint with no min or max", () => {
      const result = validateSchema(
        validSchema({
          contracts: [{
            address: "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526",
            functions: [{
              name: "transfer",
              args: [
                { name: "amount", type: "i128", constraint: { kind: "range" } },
              ],
            }],
          }],
        })
      );
      expect(result.valid).toBe(false);
    });

    it("should reject range constraint on address type", () => {
      const result = validateSchema(
        validSchema({
          contracts: [{
            address: "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526",
            functions: [{
              name: "transfer",
              args: [
                { name: "to", type: "address", constraint: { kind: "range", max: "100" } },
              ],
            }],
          }],
        })
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("not valid for type"))).toBe(true);
    });

    it("should accept unconstrained args without error", () => {
      const result = validateSchema(
        validSchema({
          contracts: [{
            address: "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526",
            functions: [{
              name: "transfer",
              args: [
                { name: "from", type: "address", constraint: { kind: "unconstrained" } },
                { name: "amount", type: "i128" },
              ],
            }],
          }],
        })
      );
      expect(result.valid).toBe(true);
    });
  });

  // --- Global rules (unchanged) ---

  describe("threshold rule (global)", () => {
    it("should accept valid threshold", () => {
      const result = validateSchema(
        validSchema({ globalRules: [{ type: "threshold", params: { threshold: 1 } }] })
      );
      expect(result.valid).toBe(true);
    });

    // buildAddContextRuleTx attaches exactly ONE signer to a policy rule (the ephemeral ed25519
    // key) and rule-management can only remove signers, never add them — so authenticated_signers
    // can never exceed 1 and a higher threshold either fails install or rejects every real
    // transaction, both after the suite passed and the policy deployed.
    it("refuses a threshold above 1, which no deployed rule can ever meet", () => {
      const result = validateSchema(
        validSchema({ globalRules: [{ type: "threshold", params: { threshold: 2 } }] })
      );
      expect(result.valid).toBe(false);
      expect(result.errors.join(" ")).toMatch(/exactly one delegated signer/);
    });

    it("refuses a non-integer threshold, which reaches the generated Rust as a u32 literal", () => {
      // `1.5` passed the old `< 1` check and emitted `const REQUIRED_SIGNERS: u32 = 1.5;`.
      const result = validateSchema(
        validSchema({ globalRules: [{ type: "threshold", params: { threshold: 1.5 } }] })
      );
      expect(result.valid).toBe(false);
    });

    it("should reject threshold < 1", () => {
      const result = validateSchema(
        validSchema({ globalRules: [{ type: "threshold", params: { threshold: 0 } }] })
      );
      expect(result.valid).toBe(false);
    });
  });

  // A schema the pipeline cannot honour must fail here, not install "successfully" with the
  // unhonoured part silently inert. Both of these were found by an adversarial review that
  // built passing mutants against them.
  describe("schemas the deployment path cannot express", () => {
    it("rejects weighted_threshold outright", () => {
      const result = validateSchema(
        validSchema({
          globalRules: [{
            type: "weighted_threshold",
            params: {
              threshold: 3,
              weights: [
                { signer: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", weight: 1 },
                { signer: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBP2X", weight: 2 },
              ],
            },
          }],
        })
      );
      expect(result.valid).toBe(false);
      // Well-formed weights must not buy their way past: it is the feature that is unsupported,
      // not this particular set of numbers.
      expect(result.errors.join(" ")).toMatch(/weighted_threshold is not supported/);
    });

    it("rejects a schema listing more than one contract", () => {
      const base = validSchema();
      const result = validateSchema(
        validSchema({
          contracts: [
            base.contracts[0],
            { ...base.contracts[0], address: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC" },
          ],
        })
      );
      expect(result.valid).toBe(false);
      expect(result.errors.join(" ")).toMatch(/Only one contract per policy/);
    });

    it("still accepts exactly one contract", () => {
      expect(validateSchema(validSchema()).valid).toBe(true);
    });

    // The generator emits a fixed set of test fn names per rule TYPE, so a duplicate type
    // produces two Rust fns with one name and the crate fails to compile — an opaque build
    // failure that names nothing in the schema.
    it("rejects a second rule of the same type", () => {
      const result = validateSchema(
        validSchema({
          globalRules: [
            { type: "threshold", params: { threshold: 1 } },
            { type: "threshold", params: { threshold: 1 } },
          ],
        })
      );
      expect(result.valid).toBe(false);
      expect(result.errors.join(" ")).toMatch(/Only one rule of each type/);
    });

    it("accepts one rule of each different type together", () => {
      expect(validateSchema(
        validSchema({
          globalRules: [
            { type: "threshold", params: { threshold: 1 } },
            { type: "time_lock", params: { validUntilLedger: 900_000 } },
          ],
        })
      ).valid).toBe(true);
    });

    // A ledger sequence is interpolated straight into the generated Rust as a u32 literal, and
    // the past-the-window test emits `validUntilLedger + 1`.
    it("rejects a ledger bound that is not a whole in-range u32", () => {
      for (const params of [
        { validUntilLedger: 4294967295 },   // +1 overflows u32 in the rejection test
        { validAfterLedger: 1.5 },
        { validUntilLedger: -1 },
      ]) {
        const result = validateSchema(validSchema({ globalRules: [{ type: "time_lock", params }] }));
        expect(result.valid, JSON.stringify(params)).toBe(false);
      }
    });
  });

  describe("time_lock rule (global)", () => {
    it("should accept validAfterLedger only", () => {
      const result = validateSchema(
        validSchema({ globalRules: [{ type: "time_lock", params: { validAfterLedger: 100 } }] })
      );
      expect(result.valid).toBe(true);
    });

    it("should reject when neither ledger is set", () => {
      const result = validateSchema(
        validSchema({ globalRules: [{ type: "time_lock", params: {} }] })
      );
      expect(result.valid).toBe(false);
    });

    it("should reject when validAfterLedger >= validUntilLedger", () => {
      const result = validateSchema(
        validSchema({
          globalRules: [{ type: "time_lock", params: { validAfterLedger: 500, validUntilLedger: 100 } }],
        })
      );
      expect(result.valid).toBe(false);
    });
  });
});

// The constraint editor labels a value "(base units)" and warns it must be a whole number.
// `exact` is valid on address, bool, symbol and string too, where both are false — this is the
// predicate that decides which input the editor renders.
describe("isIntegerArgType", () => {
  it.each(["i128", "u128", "i64", "u64", "i32", "u32", "I128", "U32"])(
    "%s carries base units",
    (t) => expect(isIntegerArgType(t)).toBe(true)
  );

  it.each(["address", "bool", "symbol", "string", "bytes", "Vec<address>"])(
    "%s does not",
    (t) => expect(isIntegerArgType(t)).toBe(false)
  );

  // These accept only `unconstrained` today, so no editor reaches them — but if that changes,
  // they still are not base-unit quantities and must not inherit the label by default.
  it.each(["u256", "i256", "timepoint", "duration"])(
    "%s is not treated as a base-unit type",
    (t) => expect(isIntegerArgType(t)).toBe(false)
  );
});

// --- constraintKindsForType ---

describe("constraintKindsForType", () => {
  it("should return address constraints for address type", () => {
    const kinds = constraintKindsForType("address");
    expect(kinds).toContain("allowlist");
    expect(kinds).toContain("blocklist");
    expect(kinds).not.toContain("range");
  });

  it("should return numeric constraints for i128", () => {
    const kinds = constraintKindsForType("i128");
    expect(kinds).toContain("range");
    expect(kinds).not.toContain("allowlist");
  });

  it("should return only unconstrained for complex types", () => {
    expect(constraintKindsForType("Vec<address>")).toEqual(["unconstrained"]);
    expect(constraintKindsForType("Map<symbol, i128>")).toEqual(["unconstrained"]);
  });

  it.each(["u256", "i256", "timepoint", "duration"])(
    "only advertises unconstrained for %s until the harness can falsify its constraints",
    (type) => expect(constraintKindsForType(type)).toEqual(["unconstrained"]),
  );

  it.each(["u128", "i64", "u64", "i32", "u32"])(
    "does not advertise range for %s while install params are i128",
    (type) => expect(constraintKindsForType(type)).toEqual(["unconstrained", "exact"]),
  );

  it("should return exact + unconstrained for bool", () => {
    const kinds = constraintKindsForType("bool");
    expect(kinds).toContain("exact");
    expect(kinds).toContain("unconstrained");
    expect(kinds).not.toContain("range");
  });
});

describe("harness-representable argument types", () => {
  const withArg = (type: string, constraint?: any): PolicySchema => {
    const schema = validSchema();
    schema.contracts[0].functions[0].args = [{ name: "value", type, constraint }];
    return schema;
  };

  it.each(["u256", "i256", "timepoint", "duration"])(
    "rejects an advertised-looking constraint on %s with an actionable error",
    (type) => {
      const result = validateSchema(withArg(type, { kind: "exact", value: "1" }));
      expect(result.valid).toBe(false);
      expect(result.errors.join(" ")).toContain(`type "${type}"`);
      expect(result.errors.join(" ")).toMatch(/not yet supported/);
    },
  );

  it.each(["Profile", "(u32, address)", "Result<u32, error>", "val", "bytes<N>"])(
    "rejects unrepresentable type %s instead of letting the positive control use VOID",
    (type) => {
      const result = validateSchema(withArg(type));
      expect(result.valid).toBe(false);
      expect(result.errors.join(" ")).toContain(`type "${type}"`);
      expect(result.errors.join(" ")).toMatch(/test harness cannot represent/);
    },
  );

  it.each([
    "address", "i128", "u128", "i64", "u64", "i32", "u32", "bool", "symbol",
    "string", "u256", "i256", "timepoint", "duration", "bytes", "bytes<32>",
    "Vec<address>", "Map<address, i128>", "Option<address>",
  ])("accepts an unconstrained %s because the harness has a typed value for it", (type) => {
    expect(validateSchema(withArg(type)).valid).toBe(true);
  });
});

// --- schemaToJSON / schemaFromJSON ---

describe("schemaToJSON / schemaFromJSON", () => {
  it("should round-trip schema with constraints", () => {
    const schema = validSchema({
      contracts: [{
        address: "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526",
        functions: [{
          name: "transfer",
          args: [
            { name: "to", type: "address", constraint: { kind: "allowlist", values: ["GACAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAJJHP"] } },
            { name: "amount", type: "i128", constraint: { kind: "range", max: "1000" } },
          ],
          note: "Limit transfers to approved addresses",
        }],
      }],
    });

    const json = schemaToJSON(schema);
    const restored = schemaFromJSON(json);

    expect(restored.contracts[0].functions[0].args[0].constraint).toEqual({
      kind: "allowlist",
      values: ["GACAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAJJHP"],
    });
    expect(restored.contracts[0].functions[0].note).toBe("Limit transfers to approved addresses");
  });

  it("should produce valid JSON", () => {
    const json = schemaToJSON(validSchema());
    expect(() => JSON.parse(json)).not.toThrow();
  });
});

// --- schemaFromPatterns ---

describe("schemaFromPatterns", () => {
  it("should return emptySchema for empty patterns", () => {
    expect(schemaFromPatterns([])).toEqual(emptySchema());
  });

  it("should generate schema with arg permissions from patterns", () => {
    const patterns: TxPattern[] = [{
      contractAddress: "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526",
      functionName: "transfer",
      args: [
        { type: "Address", value: "GSOURCE" },
        { type: "Address", value: "GDEST123" },
        { type: "i128", value: "50000000" },
      ],
      signers: [{ type: "External", identity: "GSOURCE" }],
    }];

    const schema = schemaFromPatterns(patterns);
    expect(schema.contracts.length).toBe(1);
    expect(schema.contracts[0].address).toBe("CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526");

    const func = schema.contracts[0].functions[0];
    expect(func.name).toBe("transfer");
    expect(func.args.length).toBe(3);
    expect(func.args[0].type).toBe("Address");
    expect(func.args[0].observedValues).toContain("GSOURCE");
  });

  it("should use innerCall for execute() patterns", () => {
    const patterns: TxPattern[] = [{
      contractAddress: "CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ",
      functionName: "execute",
      args: [],
      signers: [{ type: "External", identity: "GSIGNER" }],
      innerCall: {
        targetContract: "CACQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQLC2U",
        functionName: "transfer",
        args: [
          { type: "Address", value: "GFROM" },
          { type: "Address", value: "GTO" },
          { type: "i128", value: "100" },
        ],
      },
    }];

    const schema = schemaFromPatterns(patterns);
    expect(schema.contracts[0].address).toBe("CACQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQLC2U");
    expect(schema.contracts[0].functions[0].name).toBe("transfer");
    expect(schema.contracts[0].functions[0].args.length).toBe(3);
  });

  it("should add threshold when multiple signers", () => {
    const patterns: TxPattern[] = [{
      contractAddress: "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526",
      functionName: "transfer",
      args: [],
      signers: [
        { type: "External", identity: "G1" },
        { type: "External", identity: "G2" },
        { type: "External", identity: "G3" },
      ],
    }];

    const schema = schemaFromPatterns(patterns);
    const threshold = schema.globalRules.find(r => r.type === "threshold");
    expect(threshold).toBeDefined();
    expect((threshold as any).params.threshold).toBe(2);
  });

  it("should group multiple patterns into separate contracts", () => {
    const patterns: TxPattern[] = [
      { contractAddress: "CA", functionName: "transfer", args: [], signers: [{ type: "External", identity: "G1" }] },
      { contractAddress: "CB", functionName: "swap", args: [], signers: [{ type: "External", identity: "G1" }] },
    ];

    const schema = schemaFromPatterns(patterns);
    expect(schema.contracts.length).toBe(2);
  });
});

// --- mergeSpecIntoSchema ---

describe("mergeSpecIntoSchema", () => {
  it("should enrich arg names and types from spec", () => {
    const schema = schemaFromPatterns([{
      contractAddress: "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526",
      functionName: "transfer",
      args: [
        { type: "Address", value: "GFROM" },
        { type: "Address", value: "GTO" },
        { type: "i128", value: "100" },
      ],
      signers: [{ type: "External", identity: "G1" }],
    }]);

    const merged = mergeSpecIntoSchema(schema, "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526", [
      {
        name: "transfer",
        inputs: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "amount", type: "i128" },
        ],
      },
    ]);

    const func = merged.contracts[0].functions[0];
    expect(func.args[0].name).toBe("from");
    expect(func.args[1].name).toBe("to");
    expect(func.args[2].name).toBe("amount");
    expect(func.args[2].type).toBe("i128");
    // Observed values should be preserved
    expect(func.args[0].observedValues).toContain("GFROM");
  });
});

// --- emptySchema ---

describe("emptySchema", () => {
  it("should have empty contracts and globalRules", () => {
    const schema = emptySchema();
    expect(schema.$schema).toBe(SCHEMA_VERSION);
    expect(schema.contracts).toEqual([]);
    expect(schema.globalRules).toEqual([]);
  });

  it("should not share state between calls", () => {
    const a = emptySchema();
    const b = emptySchema();
    a.name = "modified";
    expect(b.name).toBe("");
  });
});

// Constraint values are base units — exactly what the contract compares — and are stored as
// typed. An earlier revision converted whole tokens to base units in the builder, which meant
// deciding that an i128 was a token amount. That is not knowable from a contract spec: a
// deadline, id, price or ratio would have been silently multiplied by 10^decimals. Units are a
// property of an argument's meaning, so the UI states them instead of inferring them, and
// toDisplayUnits exists only to render a hint beside the field.
describe("base-unit display helper", () => {
  it.each([
    ["10000000", 7, "1"],
    ["1000000000", 7, "100"],
    ["1", 7, "0.0000001"],
    ["15000000", 7, "1.5"],
    ["0", 7, "0"],
    ["1", 0, "1"],
    ["1000000000000000000", 18, "1"],
  ])("renders %s at %i decimals as %s", (base, decimals, expected) => {
    expect(toDisplayUnits(base, decimals)).toBe(expected);
  });

  // Beyond Number.MAX_SAFE_INTEGER, and exactly where float math would drift.
  it("keeps precision that float arithmetic would lose", () => {
    expect(toDisplayUnits("90071992547409930000001", 7)).toBe("9007199254740993.0000001");
    expect(toDisplayUnits("1000000", 7)).toBe("0.1");
    expect(toDisplayUnits("3000000", 7)).toBe("0.3");
  });

  // A hint must never mangle a value it cannot interpret; it returns the input untouched.
  it.each(["", "abc", "1.5", "0x10", "1e9", " "])(
    "passes non-integer input through unchanged: %j",
    (input) => expect(toDisplayUnits(input, 7)).toBe(input)
  );

  it("handles negatives without losing the sign", () => {
    expect(toDisplayUnits("-10000000", 7)).toBe("-1");
    expect(toDisplayUnits("-1", 7)).toBe("-0.0000001");
  });
});

// Install params are a flat map keyed by "max_{arg}", so two functions constraining an
// argument of the same name collide and an ScMap silently keeps one. Found by an adversarial
// reviewer: transfer(amount) max 100 and burn(amount) max 50 both emit `max_amount`.
describe("colliding install param keys", () => {
  const build = (transferMax: string, burnMax: string): PolicySchema => ({
    $schema: SCHEMA_VERSION,
    name: "collide",
    description: "collision fixture",
    globalRules: [],
    contracts: [{
      address: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      decimals: 7,
      functions: [
        { name: "transfer", args: [{ name: "amount", type: "i128", constraint: { kind: "range", max: transferMax } }] },
        { name: "burn", args: [{ name: "amount", type: "i128", constraint: { kind: "range", max: burnMax } }] },
      ],
    }],
  } as PolicySchema);

  it("rejects two different bounds that would emit the same key", () => {
    const result = validateSchema(build("1000000000", "500000000"));
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/max_amount/);
    expect(result.errors.join(" ")).toMatch(/only one bound would survive/);
  });

  // The same bound written twice is one constraint expressed redundantly, not a conflict.
  it("allows the identical bound on both functions", () => {
    expect(validateSchema(build("1000000000", "1000000000")).valid).toBe(true);
  });

  it("leaves a single-function schema alone", () => {
    const schema = build("1000000000", "1000000000");
    schema.contracts[0].functions = [schema.contracts[0].functions[0]];
    expect(validateSchema(schema).valid).toBe(true);
  });
});

// Bounds reach BigInt() at deploy and `${value}i128` in generated Rust. Garbage there fails
// opaquely and far from the cause, so it is rejected where the field is defined.
describe("numeric bound validation", () => {
  const withRange = (min: string | undefined, max: string | undefined): PolicySchema => ({
    $schema: SCHEMA_VERSION,
    name: "bounds",
    description: "bounds fixture",
    globalRules: [],
    contracts: [{
      address: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      functions: [{ name: "transfer", args: [{ name: "amount", type: "i128", constraint: { kind: "range", min, max } }] }],
    }],
  } as PolicySchema);

  it("accepts whole base-unit numbers, including negatives", () => {
    expect(validateSchema(withRange(undefined, "1000000000")).valid).toBe(true);
    expect(validateSchema(withRange("-1", "0")).valid).toBe(true);
  });

  it("rejects a range covering the whole type because it has no possible rejection test", () => {
    const result = validateSchema(withRange(undefined, "170141183460469231731687303715884105727"));
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/cannot produce a rejection counterexample/);
  });

  it("rejects a bound outside its Soroban type instead of emitting uncompilable Rust", () => {
    const result = validateSchema(withRange(undefined, "170141183460469231731687303715884105728"));
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/outside the i128 range/);
  });

  it.each(["1.5", "1e9", "abc", "0x10", "1,000", " ", "100 XLM"])(
    "rejects a non-integer bound: %j",
    (bad) => {
      const result = validateSchema(withRange(undefined, bad));
      expect(result.valid).toBe(false);
      expect(result.errors.join(" ")).toMatch(/whole number in base units/);
    }
  );

  it("rejects an inverted range", () => {
    const result = validateSchema(withRange("100", "10"));
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/greater than max/);
  });

  it("still requires at least one bound", () => {
    expect(validateSchema(withRange(undefined, undefined)).valid).toBe(false);
  });
});

// A non-integer exact value reaches generated Rust as `<value><suffix>` — "1e5u32" is not a
// Rust literal, and the crate fails to compile after a full cargo build.
describe("exact numeric validation", () => {
  const withExact = (type: string, value: string): PolicySchema => ({
    $schema: SCHEMA_VERSION, name: "exact", description: "exact fixture", globalRules: [],
    contracts: [{ address: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      functions: [{ name: "call", args: [{ name: "n", type, constraint: { kind: "exact", value } }] }] }],
  } as PolicySchema);

  it.each(["1e5", "1.5", "abc", "0x10", "1,000"])("rejects %j on a numeric argument", (bad) => {
    const r = validateSchema(withExact("u32", bad));
    expect(r.valid).toBe(false);
    expect(r.errors.join(" ")).toMatch(/must be a whole number/);
  });

  it("accepts integers, including negatives", () => {
    expect(validateSchema(withExact("i128", "-1")).valid).toBe(true);
    expect(validateSchema(withExact("u32", "100")).valid).toBe(true);
  });

  it("rejects an integer outside its Soroban type instead of emitting uncompilable Rust", () => {
    const result = validateSchema(withExact("u32", "4294967296"));
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/outside the u32 range/);
  });

  // Non-numeric arguments legitimately carry non-numeric exact values.
  it("leaves address and symbol values alone", () => {
    expect(validateSchema(withExact("symbol", "transfer")).valid).toBe(true);
    expect(validateSchema(withExact("address", "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC")).valid).toBe(true);
  });
});

// Every constraint the schema declares must put SOMETHING in install_params. The system prompt
// says a void install_params is acceptable ONLY when the schema declares no constraints and no
// global rules, and must panic otherwise — so an exact-only or blocklist-only schema that
// produced an empty param list left the model a coin flip between obeying the prompt (panic,
// failing test_install_succeeds) and accepting it (passing, contradicting the prompt).
describe("a declared constraint always reaches install_params", () => {
  const withConstraint = (type: string, constraint: any): PolicySchema => ({
    $schema: SCHEMA_VERSION,
    name: "void-params",
    description: "install param fixture",
    globalRules: [],
    contracts: [{
      address: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      functions: [{ name: "transfer", args: [{ name: "value", type, constraint }] }],
    }],
  });

  const ADDRESS = "GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57";

  it("emits a param for every constraint kind, so Val::VOID means 'nothing declared'", () => {
    const cases: Array<[string, any, string]> = [
      ["i128", { kind: "exact", value: "100" }, "exact_value"],
      ["address", { kind: "exact", value: ADDRESS }, "exact_value"],
      ["address", { kind: "blocklist", values: [ADDRESS] }, "blocked_value"],
      ["address", { kind: "allowlist", values: [ADDRESS] }, "allowed_value"],
      ["i128", { kind: "range", max: "100" }, "max_value"],
    ];
    for (const [type, constraint, expectedKey] of cases) {
      const schema = withConstraint(type, constraint);
      expect(validateSchema(schema).valid, `${type}/${constraint.kind}`).toBe(true);
      const keys = installParamsSpec(schema).map(p => p.key);
      expect(keys, `${type}/${constraint.kind}`).toContain(expectedKey);
    }
  });

  it("still emits nothing when the schema declares nothing", () => {
    expect(installParamsSpec(withConstraint("address", { kind: "unconstrained" }))).toEqual([]);
  });
});

describe("values that would panic inside the generated Rust are refused at the schema", () => {
  const withSymbol = (value: string): PolicySchema => ({
    $schema: SCHEMA_VERSION,
    name: "symbol-values",
    description: "symbol fixture",
    globalRules: [],
    contracts: [{
      address: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      functions: [{
        name: "transfer",
        args: [{ name: "tag", type: "symbol", constraint: { kind: "exact", value } }],
      }],
    }],
  });

  // Symbol::new panics at RUNTIME on anything outside [a-zA-Z0-9_]{1,32}, inside the generated
  // fixtures — so every enforce test died in setup and the run blamed a possibly-correct policy.
  it("refuses a symbol value Symbol::new would panic on", () => {
    for (const bad of ["my-tag needs space", "has-hyphen", "", "x".repeat(33)]) {
      expect(validateSchema(withSymbol(bad)).valid, JSON.stringify(bad)).toBe(false);
    }
  });

  it("accepts a legal symbol", () => {
    expect(validateSchema(withSymbol("transfer_tag_1")).valid).toBe(true);
  });

  // "after ledger 0" is every ledger, so no rejection counterexample exists: the after-window
  // test needs an upper bound and the before-window test needs after > 0. The schema emitted a
  // positive-only test any policy ignoring the rule passes, while the UI showed a time lock.
  it("refuses a time lock whose only bound is validAfterLedger 0", () => {
    const schema: PolicySchema = {
      $schema: SCHEMA_VERSION,
      name: "no-window",
      description: "degenerate window",
      globalRules: [{ type: "time_lock", params: { validAfterLedger: 0 } }],
      contracts: [{
        address: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
        functions: [{ name: "transfer", args: [] }],
      }],
    };
    expect(validateSchema(schema).valid).toBe(false);
    expect(validateSchema({
      ...schema, globalRules: [{ type: "time_lock", params: { validAfterLedger: 0, validUntilLedger: 900_000 } }],
    }).valid).toBe(true);
  });
});
