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
  POLICY_CODEGEN_TOKEN_BUDGET,
  compactCompileErrors,
} from "../policy-codegen";
import { schemaFromPatterns, type PolicySchema, type TxPattern, SCHEMA_VERSION } from "../policy-schema";

describe("buildSystemPrompt", () => {
  it("should contain context guidance and constraint descriptions", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("DEFAULT-REJECT");
    expect(prompt).toContain("CONSTRAINT KINDS");
    expect(prompt).toContain("allowlist");
    expect(prompt).toContain("NOTES");
    expect(prompt).toContain("authenticated_signers");
  });

  // The execute() wrapper context is REAL, and a previous revision of this prompt wrongly
  // told the model it was a fiction. The smart account's execute(target, fn, args) calls
  // e.current_contract_address().require_auth() before invoking the target; Soroban's
  // invoker-auth model builds that requirement's context from the CURRENT invocation, so a
  // Default-scoped rule sees fn_name == "execute" with args[0..2]. This repo's own default
  // send path does exactly that — see src/hooks/useWallet.ts, "Default: wallet.execute()
  // wrapper". OpenZeppelin's reference policies never handle it only because all three are
  // CallContract-scoped.
  it("teaches BOTH context shapes, including the execute() wrapper", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("SHAPE A");
    expect(prompt).toContain("SHAPE B");
    expect(prompt).toContain("execute");
    expect(prompt).toMatch(/args\[0\]\s+= target contract Address/);
    expect(prompt).toContain("HANDLE BOTH");
    // The false claim must never come back.
    expect(prompt).not.toContain("There is exactly ONE shape");
    expect(prompt).not.toMatch(/No such context is ever delivered/);
  });

  // Falling back to a permissive value on missing config turns a malformed install into a
  // policy that authorizes everything — the exact inverse of its purpose.
  it("must instruct the model to fail closed on install params", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("FAIL CLOSED");
    // The prompt names `unwrap_or(i128::MAX)` on purpose — as a prohibited anti-pattern.
    // What must never come back is the old instruction to actually do it.
    expect(prompt).toContain("Never substitute a permissive fallback");
    expect(prompt).not.toMatch(/use maximum\/permissive defaults/);
    expect(prompt).not.toMatch(/so install succeeds even if a key is missing/);
  });

  // Reads the version out of CARGO_TOML_TEMPLATE rather than hardcoding it, so this actually
  // catches the drift it exists to catch: bumping the sandbox's SDK without updating the
  // prompt (which is how the prompt ended up telling the model to target 25.3 while the
  // sandbox compiled 27.0.5).
  it("targets the same soroban-sdk version the sandbox actually builds", async () => {
    const { CARGO_TOML_TEMPLATE } = await import("../policy-sandbox");
    const version = CARGO_TOML_TEMPLATE.match(/soroban-sdk = "([^"]+)"/)?.[1];
    expect(version).toBeTruthy();
    expect(buildSystemPrompt()).toContain(`soroban-sdk = "${version}"`);
  });
});

describe("buildUserPrompt", () => {
  it("should include constraints and notes in prompt", () => {
    const schema: PolicySchema = {
      $schema: SCHEMA_VERSION,
      name: "default-policy",
      description: "A default context policy",
      contracts: [{
        address: "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526",
        functions: [{
          name: "transfer",
          args: [
            { name: "from", type: "address" },
            { name: "to", type: "address", constraint: { kind: "allowlist", values: ["GABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQHGPC"] } },
            { name: "amount", type: "i128", constraint: { kind: "range", max: "1000000" } },
          ],
          note: "Enforce rolling window on amount over 17280 ledgers",
        }],
      }],
      globalRules: [],
    };

    const prompt = buildUserPrompt(schema);
    expect(prompt).toContain("CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526");
    expect(prompt).toContain("transfer(from: address, to: address, amount: i128)");
    expect(prompt).toContain("allowlist");
    expect(prompt).toContain("GABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQHGPC");
    expect(prompt).toContain("range");
    expect(prompt).toContain("rolling window");
  });

  it("should include global rules", () => {
    const schema: PolicySchema = {
      $schema: SCHEMA_VERSION,
      name: "global-policy",
      description: "A policy with globals",
      contracts: [{
        address: "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526",
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
          { type: "i128", value: "50000000" },
        ],
      },
    }];

    const schema = schemaFromPatterns(patterns);
    const prompt = buildUserPrompt(schema);

    expect(prompt).toContain("CACQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQLC2U");
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
    contracts: [{ address: "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526", functions: [{ name: "test", args: [] }] }],
    globalRules: [],
  };
  // Derived, not hardcoded: the budget is tuned against measured reasoning-token usage and
  // moves. The assertion is about the message, not the number.
  const truncationError =
    `AI response was truncated at the ${POLICY_CODEGEN_TOKEN_BUDGET.toLocaleString("en-US")}-token generation budget.`;
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

describe("compactCompileErrors", () => {
  const noisy = [
    "Compiling soroban-sdk v27.0.5",
    "Downloading crates ...",
    "Blocking waiting for file lock",
    "error[E0308]: mismatched types",
    " --> src/lib.rs:145:42",
    "",
    "error: aborting due to 1 previous error",
  ].join("\n");

  it("strips dependency noise but keeps diagnostics", () => {
    const out = compactCompileErrors(noisy);
    expect(out).toContain("error[E0308]: mismatched types");
    expect(out).not.toContain("Compiling soroban-sdk");
    expect(out).not.toContain("Downloading");
    expect(out).not.toContain("Blocking");
  });

  // Regression guard. A real failing build measured 37,642 chars across 39 diagnostics AFTER
  // noise-stripping. An earlier revision capped this input and THREW above 20,000, which
  // disabled the auto-fix path in exactly the case that needs it most.
  it("truncates a realistically huge log instead of rejecting it", () => {
    const oneError = "error[E0425]: cannot find value `x` in this scope\n --> src/lib.rs:1:1\n";
    const huge = oneError.repeat(600); // ~46k chars, 600 diagnostics
    expect(huge.length).toBeGreaterThan(37_000);

    const out = compactCompileErrors(huge);
    expect(out.length).toBeLessThan(21_000);
    expect(out).toContain("error[E0425]");
    expect(out).toMatch(/\[truncated: showing the first \d+ of 600 errors/);
    // Must stay under the server-side bound so the fix request is actually accepted.
    expect(out.length).toBeLessThan(100_000);
  });

  it("keeps the head, because cargo emits root causes before cascading errors", () => {
    const first = "error[E0001]: THE ROOT CAUSE\n";
    const rest = "error[E0999]: cascading\n --> src/lib.rs:9:9\n".repeat(900);
    const out = compactCompileErrors(first + rest);
    expect(out).toContain("THE ROOT CAUSE");
  });
});

// Load-bearing prompt facts, pinned per the skill's own rule. Each of these has either
// regressed before or was found wrong by review; without a pin, nothing stops an edit from
// quietly removing them.
describe("prompt facts that must not regress", () => {
  const prompt = buildSystemPrompt();

  // Keying Shape B on the function name alone misreads any TARGET contract that exposes its
  // own execute() — routers, multicall, batch — and the policy then decodes that call's first
  // three args as (target, fn_name, inner_args) and validates the wrong values entirely.
  it("identifies the execute wrapper by contract, not by function name", () => {
    expect(prompt).toMatch(/context\.contract == smart_account/);
    expect(prompt).toMatch(/fn_name == "execute"/);
    expect(prompt).not.toMatch(/Dispatch on fn_name:\s*\n?"execute" takes Shape B/);
  });

  // A policy is configured through install/uninstall. Telling the model to add a mutator for
  // every getter invites an unauthenticated reconfiguration entry point into a contract that
  // gates funds.
  it("does not ask for a setter beside every getter", () => {
    expect(prompt).not.toMatch(/set_\* function alongside every get_\*/);
  });

  // Three different import instructions pulled in three directions; a model picks arbitrarily.
  it("gives exactly one import rule", () => {
    expect(prompt).not.toMatch(/Only include imports you actually use/);
    expect(prompt).toMatch(/keep only what you use/);
  });

  // Units guidance must stay general — it applies to every argument, not just token amounts.
  it("states the units rule for all arguments, not only tokens", () => {
    expect(prompt).toMatch(/SAME units as the argument it\s+constrains/i);
    expect(prompt).toMatch(/EVERY argument type, not just token amounts/);
  });

  it("keeps ledger bounds on the sequence clock", () => {
    expect(prompt).toMatch(/e\.ledger\(\)\.sequence\(\)/);
    expect(prompt).toMatch(/NEVER \\?`?e\.ledger\(\)\.timestamp\(\)/);
  });
});
