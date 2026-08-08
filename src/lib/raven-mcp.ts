/**
 * Minimal MCP client for Stellar Raven, for use from the codegen Worker.
 *
 * Raven (https://agents.stellar.buzz/mcp) is a remote streamable-HTTP MCP server exposing
 * exactly two tools — `search` (ranked lookup over Stellar docs, ecosystem and skill corpora)
 * and `execute` (JavaScript in a sandboxed isolate with the service SDKs bound). Two tools is
 * a small enough surface that a hand-rolled client beats pulling in the Agents SDK, a Durable
 * Object, and the AI SDK just to reach it.
 *
 * Auth is a static API key (`Authorization: Bearer <name>:<token>`), issued from Raven's own
 * `scripts/mcp-key.mjs` and stored as the RAVEN_API_KEY secret. Raven also speaks OAuth, but
 * its authorization server advertises only `authorization_code` and `refresh_token` — no
 * `client_credentials` — so OAuth cannot be completed headlessly. The API key is what makes
 * this reachable from a Worker at all.
 */

export const RAVEN_MCP_URL = "https://agents.stellar.buzz/mcp";
export const RAVEN_PROTOCOL_VERSION = "2025-06-18";

/** Raven's two tools, as OpenAI-style function definitions for Workers AI tool calling. */
export const RAVEN_TOOL_DEFINITIONS = [
  {
    type: "function" as const,
    function: {
      name: "stellar_search",
      description:
        "Search Stellar's official documentation, SDK/CLI references, and ecosystem corpora. " +
        "Use it to confirm any Stellar or Soroban fact before relying on it — token decimals " +
        "and base units, SAC and SEP-41 semantics, contract storage durability and TTL, auth " +
        "and __check_auth behaviour, ledger sequence versus timestamp, error codes. Returns " +
        "ranked operations you can then call from stellar_execute.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              'Targeted query for one source family, e.g. "stellar asset contract decimals base units".',
          },
          service: {
            type: "string",
            description: 'Optional namespace filter: "stellarDocs", "scout", or "lumenloop".',
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "stellar_execute",
      description:
        "Run JavaScript in Raven's sandbox with the Stellar service SDKs bound as globals " +
        "(stellarDocs, scout, lumenloop, codemode). Compose several operations found via " +
        "stellar_search in ONE script and return a compact merged result. Every call resolves " +
        "to { ok: true, data } or { ok: false, error } — check .ok and read payloads under " +
        ".data. Example: async () => { const r = await stellarDocs.search_docs({ query: " +
        '"stroop smallest unit", hitsPerPage: 3 }); return r.ok ? r.data.hits : r.error; }',
      parameters: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "async arrow function, e.g. async () => { ... return result; }",
          },
        },
        required: ["code"],
      },
    },
  },
];

const TOOL_TO_MCP: Record<string, string> = {
  stellar_search: "search",
  stellar_execute: "execute",
};

/** How much of a single tool result to feed back to the model. */
const MAX_TOOL_RESULT_CHARS = 8_000;

/**
 * Deadline for a single Raven request. Research is a nice-to-have that runs before the real
 * work, so it must never be the reason a generation never starts.
 */
export const RAVEN_REQUEST_TIMEOUT_MS = 20_000;

type JsonRpcResponse = { result?: unknown; error?: { message?: string } };

/**
 * A Raven session. MCP is stateful — `initialize` issues a session id that later calls must
 * echo — so this holds that id rather than re-initializing per tool call.
 */
export class RavenClient {
  private sessionId: string | null = null;
  private nextId = 1;

  constructor(private readonly apiKey: string, private readonly url = RAVEN_MCP_URL) {}

  private async rpc(method: string, params?: unknown): Promise<JsonRpcResponse> {
    const isNotification = method.startsWith("notifications/");
    const body: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) body.params = params;
    if (!isNotification) body.id = this.nextId++;

    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Raven may answer either as JSON or as SSE frames; accept both.
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${this.apiKey}`,
        // Required by the MCP transport spec on every request after initialization.
        ...(this.sessionId
          ? { "mcp-session-id": this.sessionId, "MCP-Protocol-Version": RAVEN_PROTOCOL_VERSION }
          : {}),
      },
      body: JSON.stringify(body),
      // Without a deadline a stalled Raven blocks the whole generation: the catch in callTool
      // cannot run until fetch settles, and this runs BEFORE the streaming codegen, so the
      // user gets a spinner and no contract. Fail fast and let generation proceed without
      // research instead.
      signal: AbortSignal.timeout(RAVEN_REQUEST_TIMEOUT_MS),
    });

    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    // A session-scoped 404 means the server dropped our session. Clear it so the next call
    // re-initializes rather than reusing an id the server has forgotten.
    if (res.status === 404 && this.sessionId) this.sessionId = null;

    if (isNotification) return {};

    const text = await res.text();
    if (!res.ok) throw new Error(`Raven ${method} failed (${res.status}): ${text.slice(0, 200)}`);
    return parseMcpBody(text);
  }

  async connect(): Promise<void> {
    if (this.sessionId) return;
    await this.rpc("initialize", {
      protocolVersion: RAVEN_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "pollywallet-policy-codegen", version: "1.0.0" },
    });
    await this.rpc("notifications/initialized");
  }

  /**
   * Invoke one tool by its model-facing name. Errors are returned as text rather than thrown:
   * a failed lookup should let the model try a different query, not abort the generation.
   */
  async callTool(toolName: string, args: unknown): Promise<string> {
    const mcpName = TOOL_TO_MCP[toolName];
    if (!mcpName) return `Unknown tool "${toolName}". Available: ${Object.keys(TOOL_TO_MCP).join(", ")}.`;
    try {
      await this.connect();
      const response = await this.rpc("tools/call", { name: mcpName, arguments: args });
      if (response.error) return `Raven error: ${response.error.message ?? "unknown"}`;
      return truncate(flattenToolResult(response.result));
    } catch (err: any) {
      return `Raven call failed: ${err?.message ?? String(err)}`;
    }
  }
}

/** MCP over streamable HTTP may arrive as bare JSON or as `event: ...\ndata: {...}` frames. */
export function parseMcpBody(text: string): JsonRpcResponse {
  const trimmed = text.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);

  // SSE events are blank-line separated, and one event's `data:` may span several lines which
  // must be rejoined with newlines before parsing. Splitting on lines and taking the last one
  // corrupts any pretty-printed payload.
  const events = trimmed.split(/\r?\n\r?\n/);
  const payloads: string[] = [];
  for (const event of events) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n")
      .trim();
    if (data) payloads.push(data);
  }
  if (payloads.length === 0) throw new Error(`Unparseable MCP body: ${trimmed.slice(0, 160)}`);
  // A frame sequence ends with the actual response.
  return JSON.parse(payloads[payloads.length - 1]);
}

/** MCP tool results are content blocks; the model only needs their text. */
export function flattenToolResult(result: unknown): string {
  const content = (result as any)?.content;
  if (Array.isArray(content)) {
    const text = content
      .map((block: any) => (typeof block?.text === "string" ? block.text : JSON.stringify(block)))
      .join("\n")
      .trim();
    if (text) return text;
  }
  return JSON.stringify(result ?? null);
}

function truncate(text: string): string {
  return text.length <= MAX_TOOL_RESULT_CHARS
    ? text
    : `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n…[truncated ${text.length - MAX_TOOL_RESULT_CHARS} chars]`;
}
