import { describe, it, expect, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    inputValidator: () => ({ handler: (fn: any) => fn }),
  }),
}));

import {
  buildSystemPrompt,
  buildUserPrompt,
  extractTokenFromChunk,
  extractReasoningFromChunk,
} from "../policy-codegen";
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

describe("extractTokenFromChunk: reasoning must never reach the code buffer", () => {
  // Kimi K2.7 Code always reasons. Frames below are the real shape returned by
  // @cf/moonshotai/kimi-k2.7-code when streaming with no chat_template_kwargs:
  // reasoning goes to delta.reasoning_content, code to delta.content.
  it("ignores reasoning_content and keeps only content", () => {
    const frames = [
      { choices: [{ delta: { content: "", reasoning_content: null, role: "assistant" } }] },
      { choices: [{ delta: { reasoning_content: "The user wants a policy that " } }] },
      { choices: [{ delta: { reasoning_content: "checks edge cases first.\n" } }] },
      { choices: [{ delta: { content: "#![no_std]\n" } }] },
      { choices: [{ delta: { content: "pub struct P;" } }] },
    ];
    const buffer = frames.map(extractTokenFromChunk).join("");
    expect(buffer).toBe("#![no_std]\npub struct P;");
    expect(buffer).not.toContain("The user wants");
  });

  it("still handles the legacy and non-streaming shapes", () => {
    expect(extractTokenFromChunk({ response: "tok" })).toBe("tok");
    expect(extractTokenFromChunk({ choices: [{ message: { content: "full" } }] })).toBe("full");
    expect(extractTokenFromChunk({ choices: [{ delta: { role: "assistant" } }] })).toBe("");
  });
});

describe("extractReasoningFromChunk: reasoning is streamed but stays separate", () => {
  const frames = [
    { choices: [{ delta: { content: "", reasoning_content: null, role: "assistant" } }] },
    { choices: [{ delta: { reasoning_content: "The user wants a policy that " } }] },
    { choices: [{ delta: { reasoning_content: "checks edge cases first.\n" } }] },
    { choices: [{ delta: { content: "#![no_std]\n" } }] },
    { choices: [{ delta: { content: "pub struct P;" } }] },
  ];

  it("collects reasoning without ever overlapping the code buffer", () => {
    const code = frames.map(extractTokenFromChunk).join("");
    const reasoning = frames.map(extractReasoningFromChunk).join("");

    expect(code).toBe("#![no_std]\npub struct P;");
    expect(reasoning).toBe("The user wants a policy that checks edge cases first.\n");
    // The two streams must be disjoint — this is the bug that `thinking: false` caused.
    expect(code).not.toContain("The user wants");
    expect(reasoning).not.toContain("no_std");
  });

  it("reads the `reasoning` field name too, per the K2.6+ changelog", () => {
    expect(extractReasoningFromChunk({ choices: [{ delta: { reasoning: "hm" } }] })).toBe("hm");
    expect(extractReasoningFromChunk({ choices: [{ delta: { content: "code" } }] })).toBe("");
  });
});
