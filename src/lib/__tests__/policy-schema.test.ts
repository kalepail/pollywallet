import { describe, it, expect } from "vitest";
import {
  validateSchema,
  schemaFromPatterns,
  mergeSpecIntoSchema,
  schemaToJSON,
  schemaFromJSON,
  emptySchema,
  constraintKindsForType,
  toBaseUnits,
  toDisplayUnits,
  isAmountArg,
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

// The bug this exists to prevent shipped and cost two live wallets their policies: a builder
// entry of "100" installed max_amount=100, which the contract compares against a base-unit
// amount, making the cap 0.00001 XLM. Proven on-device: 100 stroops passed, 1 XLM did not.
describe("token amount unit conversion", () => {
  it.each([
    ["1", 7, "10000000"],
    ["100", 7, "1000000000"],
    ["0.0000001", 7, "1"],
    ["0", 7, "0"],
    ["1.5", 7, "15000000"],
    ["123456789.1234567", 7, "1234567891234567"],
    ["1", 0, "1"],
    ["1", 18, "1000000000000000000"],
  ])("converts %s at %i decimals to %s base units", (display, decimals, expected) => {
    expect(toBaseUnits(display, decimals)).toBe(expected);
  });

  // Float math puts 0.1 XLM at 1000000.0000000001 stroops; string math must not.
  it("keeps precision that float arithmetic would lose", () => {
    expect(toBaseUnits("0.1", 7)).toBe("1000000");
    expect(toBaseUnits("0.3", 7)).toBe("3000000");
    expect(toBaseUnits("1e21", 7)).toBeNull();
  });

  it("rejects more precision than the token can express", () => {
    expect(toBaseUnits("0.00000001", 7)).toBeNull();
    expect(toBaseUnits("1.5", 0)).toBeNull();
  });

  it.each(["", " ", "abc", "1.2.3", "--1", "1,000", "0x10"])(
    "rejects malformed amount %j", (input) => expect(toBaseUnits(input, 7)).toBeNull()
  );

  it("round-trips through display units", () => {
    for (const v of ["1", "100", "0.0000001", "1.5", "9999999.9999999"]) {
      expect(toDisplayUnits(toBaseUnits(v, 7)!, 7)).toBe(v);
    }
  });

  it("displays base units without trailing noise", () => {
    expect(toDisplayUnits("10000000", 7)).toBe("1");
    expect(toDisplayUnits("1", 7)).toBe("0.0000001");
    expect(toDisplayUnits("0", 7)).toBe("0");
    expect(toDisplayUnits("not-a-number", 7)).toBe("not-a-number");
  });

  // Scaling a non-amount i128, or any arg on a contract that never answered decimals(),
  // would corrupt the bound just as badly in the other direction.
  it("only treats i128 args on known-decimals contracts as amounts", () => {
    const amount = { name: "amount", type: "i128" } as any;
    expect(isAmountArg(amount, 7)).toBe(true);
    expect(isAmountArg(amount, undefined)).toBe(false);
    expect(isAmountArg({ name: "to", type: "address" } as any, 7)).toBe(false);
    expect(isAmountArg({ name: "id", type: "u32" } as any, 7)).toBe(false);
  });
});
