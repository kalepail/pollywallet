import { describe, it, expect, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    inputValidator: () => ({ handler: (fn: any) => fn }),
  }),
}));

import { buildSystemPrompt, buildUserPrompt } from "../policy-codegen";
import { schemaFromPatterns, type PolicySchema, type TxPattern, SCHEMA_VERSION } from "../policy-schema";

describe("buildSystemPrompt", () => {
  it("should contain dual-context guidance and constraint descriptions", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("PATTERN 1");
    expect(prompt).toContain("PATTERN 2");
    expect(prompt).toContain("execute");
    expect(prompt).toContain("DEFAULT-REJECT");
    expect(prompt).toContain("CONSTRAINT KINDS");
    expect(prompt).toContain("allowlist");
    expect(prompt).toContain("NOTES");
  });
});

describe("buildUserPrompt", () => {
  it("should include constraints and notes in prompt", () => {
    const schema: PolicySchema = {
      $schema: SCHEMA_VERSION,
      name: "default-policy",
      description: "A default context policy",
      contracts: [{
        address: "CTOKENADDR",
        functions: [{
          name: "transfer",
          args: [
            { name: "from", type: "address" },
            { name: "to", type: "address", constraint: { kind: "allowlist", values: ["GDEST"] } },
            { name: "amount", type: "i128", constraint: { kind: "range", max: "1000000" } },
          ],
          note: "Enforce rolling window on amount over 17280 ledgers",
        }],
      }],
      globalRules: [],
    };

    const prompt = buildUserPrompt(schema);
    expect(prompt).toContain("CTOKENADDR");
    expect(prompt).toContain("transfer(from: address, to: address, amount: i128)");
    expect(prompt).toContain("allowlist");
    expect(prompt).toContain("GDEST");
    expect(prompt).toContain("range");
    expect(prompt).toContain("rolling window");
  });

  it("should include global rules", () => {
    const schema: PolicySchema = {
      $schema: SCHEMA_VERSION,
      name: "global-policy",
      description: "A policy with globals",
      contracts: [{
        address: "CTOKENADDR",
        functions: [{ name: "transfer", args: [] }],
      }],
      globalRules: [
        { type: "threshold", params: { threshold: 2 } },
        { type: "time_lock", params: { validAfterLedger: 100, validUntilLedger: 500 } },
      ],
    };

    const prompt = buildUserPrompt(schema);
    expect(prompt).toContain("threshold");
    expect(prompt).toContain("time_lock");
  });
});

describe("end-to-end: execute pattern -> schema -> prompt", () => {
  it("should produce a prompt with the innerCall target contract", () => {
    const patterns: TxPattern[] = [{
      contractAddress: "CWALLET",
      functionName: "execute",
      args: [],
      signers: [{ type: "External", identity: "GSIGNER" }],
      innerCall: {
        targetContract: "CTARGET123",
        functionName: "transfer",
        args: [
          { type: "Address", value: "GFROM" },
          { type: "Address", value: "GTO" },
          { type: "i128", value: "50000000" },
        ],
      },
    }];

    const schema = schemaFromPatterns(patterns);
    const prompt = buildUserPrompt(schema);

    expect(prompt).toContain("CTARGET123");
    expect(prompt).toContain("transfer");
  });
});
