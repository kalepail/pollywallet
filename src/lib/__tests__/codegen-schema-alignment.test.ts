import { describe, it, expect, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    inputValidator: () => ({ handler: (fn: any) => fn }),
  }),
}));

import { schemaFromPatterns, schemaToJSON, type TxPattern } from "../policy-schema";
import { buildUserPrompt } from "../policy-codegen";

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
