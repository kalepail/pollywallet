import { describe, it, expect, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    inputValidator: () => ({ handler: (fn: any) => fn }),
  }),
}));

import { generateTestCases } from "../policy-sandbox";
import type { PolicySchema } from "../policy-schema";
import { SCHEMA_VERSION } from "../policy-schema";

describe("generateTestCases", () => {
  it("should generate basic install/uninstall tests", () => {
    const schema: PolicySchema = {
      $schema: SCHEMA_VERSION,
      name: "basic-policy",
      description: "A basic policy",
      contracts: [{
        address: "CABCDEF",
        functions: [{ name: "transfer", args: [] }],
      }],
      globalRules: [{ type: "threshold", params: { threshold: 1 } }],
    };

    const output = generateTestCases(schema);
    expect(output).toContain("test_install_succeeds");
    expect(output).toContain("test_uninstall_succeeds");
    expect(output).toContain("test_uninstall_when_not_installed");
  });

  it("should generate threshold tests", () => {
    const schema: PolicySchema = {
      $schema: SCHEMA_VERSION,
      name: "threshold-policy",
      description: "A threshold policy",
      contracts: [{
        address: "CABCDEF",
        functions: [{ name: "transfer", args: [] }],
      }],
      globalRules: [{ type: "threshold", params: { threshold: 2 } }],
    };

    const output = generateTestCases(schema);
    expect(output).toContain("test_enforce_with_enough_signers");
    expect(output).toContain("test_enforce_insufficient_signers");
  });

  it("should generate constraint-based tests", () => {
    const schema: PolicySchema = {
      $schema: SCHEMA_VERSION,
      name: "constrained-policy",
      description: "A constrained policy",
      contracts: [{
        address: "CABCDEF",
        functions: [{
          name: "transfer",
          args: [
            { name: "to", type: "address", constraint: { kind: "allowlist", values: ["GABCDEF"] } },
            { name: "amount", type: "i128", constraint: { kind: "range", max: "1000000" } },
          ],
        }],
      }],
      globalRules: [],
    };

    const output = generateTestCases(schema);
    expect(output).toContain("test_enforce_to_allowed");
    expect(output).toContain("test_enforce_amount_exceeds_range");
  });

  it("should use first function name for context helpers", () => {
    const schema: PolicySchema = {
      $schema: SCHEMA_VERSION,
      name: "fn-policy",
      description: "A function policy",
      contracts: [{
        address: "CABCDEF",
        functions: [{ name: "swap", args: [] }],
      }],
      globalRules: [{ type: "threshold", params: { threshold: 1 } }],
    };

    const output = generateTestCases(schema);
    expect(output).toContain('symbol_short!("swap")');
  });

  it("should use contract address in context helpers", () => {
    const addr = "CABCDEFGHIJKLMNOPQRSTUVWXYZ234567890ABCDEFGHIJKLMNOPQRSTU";
    const schema: PolicySchema = {
      $schema: SCHEMA_VERSION,
      name: "addr-policy",
      description: "A contract-scoped policy",
      contracts: [{
        address: addr,
        functions: [{ name: "transfer", args: [] }],
      }],
      globalRules: [{ type: "threshold", params: { threshold: 1 } }],
    };

    const output = generateTestCases(schema);
    expect(output).toContain(addr);
  });

  it("should generate arg builder comments with arg names", () => {
    const schema: PolicySchema = {
      $schema: SCHEMA_VERSION,
      name: "args-policy",
      description: "A policy with typed args",
      contracts: [{
        address: "CABCDEF",
        functions: [{
          name: "deposit",
          args: [
            { name: "user", type: "address" },
            { name: "amount", type: "i128" },
            { name: "auto_stake", type: "bool" },
          ],
        }],
      }],
      globalRules: [{ type: "threshold", params: { threshold: 1 } }],
    };

    const output = generateTestCases(schema);
    expect(output).toContain("// user");
    expect(output).toContain("// amount");
    expect(output).toContain("// auto_stake");
  });
});
