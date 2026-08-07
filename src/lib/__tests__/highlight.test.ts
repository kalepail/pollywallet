import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("shiki/core");
  vi.resetModules();
});

describe("highlightRust", () => {
  it("returns themed HTML with source text safely escaped", async () => {
    const { highlightRust } = await import("../highlight");

    const html = await highlightRust("fn main() { let x = \"<tag>\"; }");

    expect(html).toMatch(/^<pre class="shiki vesper"/);
    expect(html).toContain("fn");
    expect(html).toMatch(/(?:&lt;|&#x3C;)tag>/);
    expect(html).not.toContain("<tag>");
  });

  it("returns null when highlighter initialization fails", async () => {
    vi.doMock("shiki/core", async () => {
      const actual = await vi.importActual<typeof import("shiki/core")>("shiki/core");
      return {
        ...actual,
        createHighlighterCore: vi.fn().mockRejectedValue(new Error("grammar failed")),
      };
    });
    const { highlightRust } = await import("../highlight");

    await expect(highlightRust("fn main() {}")).resolves.toBeNull();
  });
});
