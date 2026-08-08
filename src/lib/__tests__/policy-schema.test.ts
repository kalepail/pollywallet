import { describe, it, expect } from "vitest";
import {
  validateSchema,
  schemaFromPatterns,
  mergeSpecIntoSchema,
  schemaToJSON,
  schemaFromJSON,
  emptySchema,
  constraintKindsForType,
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
        validSchema({ globalRules: [{ type: "threshold", params: { threshold: 3 } }] })
      );
      expect(result.valid).toBe(true);
    });

    it("should reject threshold < 1", () => {
      const result = validateSchema(
        validSchema({ globalRules: [{ type: "threshold", params: { threshold: 0 } }] })
      );
      expect(result.valid).toBe(false);
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

  it("should return exact + unconstrained for bool", () => {
    const kinds = constraintKindsForType("bool");
    expect(kinds).toContain("exact");
    expect(kinds).toContain("unconstrained");
    expect(kinds).not.toContain("range");
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

  it("accepts whole base-unit numbers, including negatives and huge values", () => {
    expect(validateSchema(withRange(undefined, "1000000000")).valid).toBe(true);
    expect(validateSchema(withRange("-1", "0")).valid).toBe(true);
    expect(validateSchema(withRange(undefined, "170141183460469231731687303715884105727")).valid).toBe(true);
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
