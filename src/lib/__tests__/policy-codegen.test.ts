import { describe, it, expect, vi } from "vitest";

const aiRun = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    inputValidator: () => ({ handler: (fn: any) => fn }),
  }),
}));

vi.mock("cloudflare:workers", () => ({ env: { AI: { run: aiRun } } }));

import {
  buildSystemPrompt,
  buildUserPrompt,
  extractTokenFromChunk,
  extractReasoningFromChunk,
  streamPolicyCode,
  fixPolicyCode,
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

describe("streaming truncation", () => {
  const schema: PolicySchema = {
    $schema: SCHEMA_VERSION,
    name: "truncation-test",
    description: "Test policy",
    contracts: [{ address: "CTEST", functions: [{ name: "test", args: [] }] }],
    globalRules: [],
  };
  const truncationError = "AI response was truncated at the 16,384-token generation budget.";
  const missingTerminalError = "AI response stream ended before a terminal marker was received.";

  function requests() {
    return [
      () => streamPolicyCode({ data: { schemaJson: JSON.stringify(schema) } }),
      () => fixPolicyCode({ data: { rustCode: "partial", compileErrors: "error" } }),
    ];
  }

  async function expectErrorFromBoth(sse: string, error: string) {
    for (const request of requests()) {
      aiRun.mockResolvedValueOnce(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sse));
          controller.close();
        },
      }));

      const chunks = [];
      for await (const chunk of await request()) chunks.push(chunk);

      expect(chunks).toContainEqual({ type: "error", text: error });
      expect(chunks).not.toContainEqual(expect.objectContaining({ type: "done" }));
    }
  }

  it("returns an error instead of done-with-partial-code from both codegen streams", async () => {
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "thinking" }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "partial Rust" }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}`,
      "data: [DONE]",
      "",
    ].join("\n\n");

    await expectErrorFromBoth(sse, truncationError);
  });

  it("rejects streams that end without a terminal marker", async () => {
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "thinking" }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "partial Rust" }, finish_reason: null }] })}`,
      "",
    ].join("\n\n");

    await expectErrorFromBoth(sse, missingTerminalError);
  });

  it("checks a trailing length frame without a newline", async () => {
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "partial Rust" }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}`,
    ].join("\n\n");

    await expectErrorFromBoth(sse, truncationError);
  });

  it("rejects other abnormal finish reasons", async () => {
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "content_filter" }] })}`,
      "data: [DONE]",
      "",
    ].join("\n\n");

    await expectErrorFromBoth(
      sse,
      "AI response ended abnormally with finish reason \"content_filter\".",
    );
  });

  it("logs cache usage from the usage-only frame after stop", async () => {
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "complete Rust" }, finish_reason: null }], usage: { prompt_tokens: 6840, prompt_tokens_details: { cached_tokens: 0 } } })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } } })}`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 6840, prompt_tokens_details: { cached_tokens: 6784 } } })}`,
      "data: [DONE]",
      "",
    ].join("\n\n");
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      for (const request of requests()) {
        aiRun.mockResolvedValueOnce(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sse));
            controller.close();
          },
        }));

        const chunks = [];
        for await (const chunk of await request()) chunks.push(chunk);
        expect(chunks).toContainEqual(expect.objectContaining({ type: "done" }));
      }

      expect(consoleLog).toHaveBeenCalledTimes(2);
      expect(consoleLog).toHaveBeenCalledWith("[policy-codegen] Workers AI usage", {
        operation: "generate",
        promptTokens: 6840,
        cachedTokens: 6784,
      });
      expect(consoleLog).toHaveBeenCalledWith("[policy-codegen] Workers AI usage", {
        operation: "fix",
        promptTokens: 6840,
        cachedTokens: 6784,
      });
    } finally {
      consoleLog.mockRestore();
    }
  });
});
