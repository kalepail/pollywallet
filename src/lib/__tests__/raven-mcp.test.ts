import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  RavenClient,
  RAVEN_TOOL_DEFINITIONS,
  RAVEN_MCP_URL,
  parseMcpBody,
  flattenToolResult,
} from "../raven-mcp";

// Raven answers streamable HTTP, so a response may be bare JSON or SSE frames depending on
// the call. Getting this wrong silently turns every lookup into "Raven call failed", which
// would degrade to no research at all rather than an obvious break.
describe("MCP body parsing", () => {
  it("parses a bare JSON response", () => {
    expect(parseMcpBody('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}')).toEqual({
      jsonrpc: "2.0", id: 1, result: { ok: true },
    } as any);
  });

  it("parses a single SSE frame", () => {
    const body = 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"hits":3}}\n\n';
    expect(parseMcpBody(body).result).toEqual({ hits: 3 });
  });

  it("takes the final frame when several arrive", () => {
    const body = [
      'event: message', 'data: {"jsonrpc":"2.0","result":{"step":1}}', '',
      'event: message', 'data: {"jsonrpc":"2.0","result":{"step":2}}', '',
    ].join("\n");
    expect(parseMcpBody(body).result).toEqual({ step: 2 });
  });

  it("treats an empty body as empty rather than throwing", () => {
    expect(parseMcpBody("   ")).toEqual({});
  });

  it("throws on a body carrying no JSON at all", () => {
    expect(() => parseMcpBody("event: ping\n\n")).toThrow("Unparseable MCP body");
  });
});

describe("tool result flattening", () => {
  it("joins text content blocks", () => {
    expect(flattenToolResult({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }))
      .toBe("a\nb");
  });

  it("falls back to JSON for non-text results", () => {
    expect(flattenToolResult({ content: [{ type: "image", data: "x" }] })).toContain("image");
    expect(flattenToolResult(null)).toBe("null");
  });
});

describe("tool definitions", () => {
  it("exposes exactly Raven's two tools with required params", () => {
    expect(RAVEN_TOOL_DEFINITIONS.map((t) => t.function.name))
      .toEqual(["stellar_search", "stellar_execute"]);
    expect(RAVEN_TOOL_DEFINITIONS[0].function.parameters.required).toEqual(["query"]);
    expect(RAVEN_TOOL_DEFINITIONS[1].function.parameters.required).toEqual(["code"]);
  });

  // The description is the only thing steering the model toward checking denominations,
  // which is the failure this whole path exists to prevent.
  it("tells the model what is worth verifying", () => {
    const search = RAVEN_TOOL_DEFINITIONS[0].function.description;
    expect(search).toMatch(/decimals|base unit/i);
    expect(search).toMatch(/ledger sequence|timestamp/i);
  });
});

describe("RavenClient", () => {
  const KEY = "pollywallet-codegen:tok";
  let fetchMock: ReturnType<typeof vi.fn>;

  const jsonResponse = (payload: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(payload), { status: 200, headers });

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("initializes once, reuses the session id, and sends the bearer key", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ result: { serverInfo: {} } }, { "mcp-session-id": "sess-1" }))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ result: { content: [{ type: "text", text: "found" }] } }))
      .mockResolvedValueOnce(jsonResponse({ result: { content: [{ type: "text", text: "again" }] } }));

    const client = new RavenClient(KEY);
    expect(await client.callTool("stellar_search", { query: "decimals" })).toBe("found");
    expect(await client.callTool("stellar_search", { query: "ledger" })).toBe("again");

    // initialize + notifications/initialized + two tool calls; NOT re-initialized.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(RAVEN_MCP_URL);
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(init.headers["mcp-session-id"]).toBeUndefined();
    expect(fetchMock.mock.calls[2][1].headers["mcp-session-id"]).toBe("sess-1");
  });

  it("maps model-facing names onto Raven's tool names", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ result: {} }, { "mcp-session-id": "s" }))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ result: { content: [{ type: "text", text: "ran" }] } }));

    await new RavenClient(KEY).callTool("stellar_execute", { code: "async () => 1" });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).params.name).toBe("execute");
  });

  // A lookup that fails should let the model try something else, not abort the generation.
  it("returns transport and protocol failures as text", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    await expect(new RavenClient(KEY).callTool("stellar_search", { query: "x" }))
      .resolves.toMatch(/Raven call failed: network down/);

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ result: {} }, { "mcp-session-id": "s" }))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ error: { message: "bad query" } }));
    await expect(new RavenClient(KEY).callTool("stellar_search", { query: "x" }))
      .resolves.toBe("Raven error: bad query");
  });

  it("rejects an unknown tool name without calling out", async () => {
    const result = await new RavenClient(KEY).callTool("rm_rf", {});
    expect(result).toMatch(/Unknown tool/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a non-200 as a readable error", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 401 }));
    await expect(new RavenClient(KEY).callTool("stellar_search", { query: "x" }))
      .resolves.toMatch(/401/);
  });

  it("truncates a huge tool result instead of blowing the context", async () => {
    const huge = "x".repeat(20_000);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ result: {} }, { "mcp-session-id": "s" }))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ result: { content: [{ type: "text", text: huge }] } }));
    const out = await new RavenClient(KEY).callTool("stellar_search", { query: "x" });
    expect(out.length).toBeLessThan(9_000);
    expect(out).toMatch(/truncated/);
  });
});

// Shapes measured against the live Workers AI endpoint 2026-08-08. K2.7 Code answers in the
// OpenAI shape; pinning only the flat one would mean the research loop silently never fires.
describe("Workers AI response shapes", () => {
  it("finds tool calls in the OpenAI shape K2.7 Code actually returns", async () => {
    const { extractToolCalls, extractResponseText } = await import("../policy-codegen");
    const live = {
      choices: [{
        finish_reason: "tool_calls",
        message: {
          content: null,
          reasoning_content: "I need to verify this.",
          role: "assistant",
          tool_calls: [{
            function: { arguments: '{"query": "stroops base unit"}', name: "stellar_search" },
            id: "functions.stellar_search:0",
            type: "function",
          }],
        },
      }],
    };
    expect(extractToolCalls(live)).toHaveLength(1);
    expect(extractToolCalls(live)[0].function.name).toBe("stellar_search");
    expect(extractResponseText(live)).toBe("");
  });

  it("finds tool calls and text in the flat binding shape", async () => {
    const { extractToolCalls, extractResponseText } = await import("../policy-codegen");
    expect(extractToolCalls({ tool_calls: [{ name: "stellar_search" }] })).toHaveLength(1);
    expect(extractResponseText({ response: "amount is in base units" }))
      .toBe("amount is in base units");
  });

  it("reports no tool calls when the model is done", async () => {
    const { extractToolCalls, extractResponseText } = await import("../policy-codegen");
    const done = { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Confirmed: 7 decimals." } }] };
    expect(extractToolCalls(done)).toEqual([]);
    expect(extractResponseText(done)).toBe("Confirmed: 7 decimals.");
    expect(extractToolCalls({})).toEqual([]);
    expect(extractResponseText({})).toBe("");
  });
});
