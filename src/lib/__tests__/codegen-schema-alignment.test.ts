import { describe, it, expect, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    inputValidator: () => ({ handler: (fn: any) => fn }),
  }),
}));

import {
  schemaFromPatterns,
  installParamsSpec,
  validateSchema,
  SCHEMA_VERSION,
  type PolicySchema,
  type TxPattern,
} from "../policy-schema";
import { buildUserPrompt, buildSystemPrompt } from "../policy-codegen";

const executePattern: TxPattern = {
  contractAddress: "CBA4GX3ON5AO6NLMFU23AAT76ZX4CI5MD3RZ27NKGCAZRWHUIOBJJ27S",
  functionName: "execute",
  args: [
    { type: "Address", value: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC" },
    { type: "symbol", value: "transfer" },
    { type: "vec", value: "[...]" },
  ],
  signers: [{ type: "External", identity: "CBA4GX3ON5AO6NLMFU23AAT76ZX4CI5MD3RZ27NKGCAZRWHUIOBJJ27S" }],
  innerCall: {
    targetContract: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    functionName: "transfer",
    args: [
      { type: "Address", value: "CBA4GX3ON5AO6NLMFU23AAT76ZX4CI5MD3RZ27NKGCAZRWHUIOBJJ27S" },
      { type: "Address", value: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC" },
      { type: "i128", value: "950000000" },
    ],
  },
};

const directPattern: TxPattern = {
  contractAddress: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  functionName: "transfer",
  args: [
    { type: "Address", value: "GSOURCE1234" },
    { type: "Address", value: "GDEST5678" },
    { type: "i128", value: "500000000" },
  ],
  signers: [{ type: "Delegated", identity: "GSOURCE1234" }],
};

describe("codegen-schema alignment: execute pattern", () => {
  const schema = schemaFromPatterns([executePattern]);

  it("should use innerCall target as contract address", () => {
    expect(schema.contracts[0].address).toBe("CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC");
  });

  it("should have transfer function with 3 args", () => {
    const func = schema.contracts[0].functions.find(f => f.name === "transfer");
    expect(func).toBeDefined();
    expect(func!.args.length).toBe(3);
  });

  it("should NOT have execute as a function", () => {
    expect(schema.contracts[0].functions.find(f => f.name === "execute")).toBeUndefined();
  });

  it("buildUserPrompt should mention the contract", () => {
    const prompt = buildUserPrompt(schema);
    expect(prompt).toContain("CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC");
    expect(prompt).toContain("transfer");
  });

  it("should not list execute in prompt", () => {
    const prompt = buildUserPrompt(schema);
    expect(prompt).not.toMatch(/- execute\(/);
  });
});

describe("codegen-schema alignment: direct pattern", () => {
  const schema = schemaFromPatterns([directPattern]);

  it("should have the token contract address", () => {
    expect(schema.contracts[0].address).toBe("CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC");
  });

  it("should have transfer function with observed values", () => {
    const func = schema.contracts[0].functions[0];
    expect(func.name).toBe("transfer");
    expect(func.args.length).toBe(3);
    expect(func.args[0].observedValues).toContain("GSOURCE1234");
  });
});

// The system prompt states the install-param key CONVENTION in prose, which makes it a fourth
// consumer of installParamsSpec() alongside the prompt's per-policy key list, the generated
// tests, and the deploy path — and the only one nothing derived. It drifted immediately: adding
// `exact_*` and `blocked_*` left the convention line naming only max/min/threshold/allowed, and
// the time-lock keys had never been in it at all. A policy told a key does not exist has no
// reason to require it, which is how a "REQUIRED configuration" key turns optional.
describe("the prompt's install-param convention covers every key installParamsSpec can emit", () => {
  const everyKindSchema: PolicySchema = {
    $schema: SCHEMA_VERSION,
    name: "every-key",
    description: "one argument per constraint kind, plus both global rules",
    contracts: [{
      address: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      functions: [{
        name: "transfer",
        args: [
          { name: "ranged", type: "i128", constraint: { kind: "range", min: "1", max: "100" } },
          { name: "listed", type: "address", constraint: { kind: "allowlist", values: ["GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57"] } },
          { name: "denied", type: "address", constraint: { kind: "blocklist", values: ["GABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQHGPC"] } },
          { name: "fixed", type: "i128", constraint: { kind: "exact", value: "7" } },
        ],
      }],
    }],
    globalRules: [
      { type: "threshold", params: { threshold: 1 } },
      { type: "time_lock", params: { validAfterLedger: 100, validUntilLedger: 900_000 } },
    ],
  };

  it("names the shape of every key, with the argument name templated", () => {
    expect(validateSchema(everyKindSchema).valid).toBe(true);
    const prompt = buildSystemPrompt();
    const argNames = everyKindSchema.contracts[0].functions[0].args.map(a => a.name);

    const shapes = new Set(
      installParamsSpec(everyKindSchema).map(p => {
        const arg = argNames.find(n => p.key.endsWith(`_${n}`));
        return arg ? p.key.replace(new RegExp(`_${arg}$`), "_{arg_name}") : p.key;
      }),
    );

    // Guards the guard: a schema that stopped producing keys would make this vacuous.
    expect(shapes.size).toBeGreaterThanOrEqual(7);
    for (const shape of shapes) {
      expect(prompt, `system prompt never names the install-param key "${shape}"`).toContain(shape);
    }
  });

  it("still hands the model the exact key list for the policy at hand", () => {
    const user = buildUserPrompt(everyKindSchema);
    for (const param of installParamsSpec(everyKindSchema)) {
      expect(user).toContain(`"${param.key}"`);
    }
  });
});
