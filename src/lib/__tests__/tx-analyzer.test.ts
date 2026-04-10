import { describe, it, expect } from "vitest";
import { analyzeTransaction, summarizePattern } from "../tx-analyzer";
import type { TxPattern } from "../tx-analyzer";

describe("analyzeTransaction", () => {
  it(
    "should analyze execute->transfer transaction",
    async () => {
      const result = await analyzeTransaction(
        "4fe9ae338af0524a9afeb1e0d4250b988458d90dd0ca8998c37dc376ed7c5e97"
      );

      expect(result.patterns.length).toBeGreaterThanOrEqual(1);

      const first = result.patterns[0];
      expect(first.functionName).toBe("execute");
      expect(first.innerCall).toBeDefined();
      expect(first.innerCall!.functionName).toBe("transfer");
      expect(first.innerCall!.targetContract).toMatch(/^C/);
      expect(first.args.length).toBeGreaterThan(0);
      expect(first.signers.length).toBeGreaterThan(0);
      expect(first.signers[0].type).toBe("External");
      expect(first.invocationTree).toBeDefined();
      expect(result.ledger).toBeGreaterThan(0);
    },
    30000
  );
});

describe("summarizePattern", () => {
  it("should include arrow notation for execute patterns", () => {
    const pattern: TxPattern = {
      contractAddress: "CABCDEFGHIJKLMNOPQRSTUVWXYZ234567890ABCDEFGHIJKLMNOPQRSTU",
      functionName: "execute",
      args: [{ type: "Address", value: "CTARGET" }],
      signers: [{ type: "External", identity: "GABCDEF" }],
      innerCall: {
        targetContract: "CTARGETCONTRACTADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        functionName: "transfer",
        args: [],
      },
    };

    const summary = summarizePattern(pattern);
    expect(summary).toContain("execute()");
    expect(summary).toContain("\u2192");
    expect(summary).toContain("transfer()");
  });

  it("should show args summary without arrow when no innerCall", () => {
    const pattern: TxPattern = {
      contractAddress: "CABCDEFGHIJKLMNOPQRSTUVWXYZ234567890ABCDEFGHIJKLMNOPQRSTU",
      functionName: "transfer",
      args: [
        { type: "Address", value: "GFROM" },
        { type: "Address", value: "GTO" },
        { type: "i128", value: "1000" },
      ],
      signers: [],
    };

    const summary = summarizePattern(pattern);
    expect(summary).toContain("transfer()");
    expect(summary).not.toContain("\u2192");
    expect(summary).toContain("args:");
    expect(summary).toContain("arg0:Address");
  });
});
