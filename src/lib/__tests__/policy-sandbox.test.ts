import { describe, it, expect, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    inputValidator: () => ({ handler: (fn: any) => fn }),
  }),
}));

import { installParamsSpec } from "../policy-schema";
import { generateTestCases, parseSseFrames } from "../policy-sandbox";
import type { PolicySchema } from "../policy-schema";
import { SCHEMA_VERSION } from "../policy-schema";

describe("generateTestCases", () => {
  it("should generate basic install/uninstall tests", () => {
    const schema: PolicySchema = {
      $schema: SCHEMA_VERSION,
      name: "basic-policy",
      description: "A basic policy",
      contracts: [{
        address: "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526",
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
        address: "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526",
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
        address: "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526",
        functions: [{
          name: "transfer",
          args: [
            { name: "to", type: "address", constraint: { kind: "allowlist", values: ["GABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQHGPC"] } },
            { name: "amount", type: "i128", constraint: { kind: "range", max: "1000000" } },
          ],
        }],
      }],
      globalRules: [],
    };

    const output = generateTestCases(schema);
    // Names are scoped by (contract, function) index so two functions sharing an argument
    // name cannot emit duplicate Rust fns.
    expect(output).toContain("test_enforce_c0_f0_to_allowed");
    expect(output).toContain("test_enforce_c0_f0_amount_exceeds_max");
    // Both sides of each boundary — an allowlist that only ever tests the allowed value is
    // passed by a policy that allows everything.
    expect(output).toContain("test_enforce_c0_f0_to_not_allowlisted");
  });

  // These are the tests that make the suite a gate. A policy whose enforce() body is empty
  // passes every positive test in the suite, so default-deny and auth must be asserted
  // unconditionally — not only for the constraint kinds a given schema happens to use.
  it("always generates default-deny and authorization tests, even for an unconstrained schema", () => {
    const schema: PolicySchema = {
      $schema: SCHEMA_VERSION,
      name: "wide-open",
      description: "No constraints at all",
      contracts: [{
        address: "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526",
        functions: [{ name: "transfer", args: [{ name: "to", type: "address" }] }],
      }],
      globalRules: [],
    };

    const output = generateTestCases(schema);
    expect(output).toContain("test_enforce_rejects_unknown_function");
    expect(output).toContain("test_enforce_rejects_unknown_contract");
    expect(output).toContain("test_enforce_requires_smart_account_auth");
    expect(output).toContain("test_enforce_before_install_is_rejected");
    expect(output).toContain("test_double_install_is_rejected");
    // Negatives must assert on the specific call, not swallow any panic from setup.
    expect(output).toContain("try_enforce");
    expect(output).not.toContain("#[should_panic]");
  });

  it("scopes contexts per (contract, function) so a later permission is not tested against the first", () => {
    const schema: PolicySchema = {
      $schema: SCHEMA_VERSION,
      name: "two-contracts",
      description: "Two contracts",
      contracts: [
        { address: "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526", functions: [{ name: "transfer", args: [] }] },
        {
          address: "CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ",
          functions: [{
            name: "swap",
            args: [{ name: "amount", type: "i128", constraint: { kind: "range", max: "10" } }],
          }],
        },
      ],
      globalRules: [],
    };

    const output = generateTestCases(schema);
    expect(output).toContain("create_context_c1_f0");
    expect(output).toContain("build_args_c1_f0");
    // Contract #2's test must use contract #2's context.
    const secondTest = output.slice(output.indexOf("test_enforce_c1_f0_amount_exceeds_max"));
    expect(secondTest).toContain("create_context_c1_f0(&env, args)");
    expect(output).toContain("CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ");
  });

  it("should use first function name for context helpers", () => {
    const schema: PolicySchema = {
      $schema: SCHEMA_VERSION,
      name: "fn-policy",
      description: "A function policy",
      contracts: [{
        address: "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526",
        functions: [{ name: "swap", args: [] }],
      }],
      globalRules: [{ type: "threshold", params: { threshold: 1 } }],
    };

    const output = generateTestCases(schema);
    expect(output).toContain('symbol_short!("swap")');
  });

  it("should use contract address in context helpers", () => {
    const addr = "CACQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQLC2U";
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
        address: "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526",
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

describe("parseSseFrames", () => {
  const frame = (chunk: unknown) => `data: ${JSON.stringify(chunk)}\n\n`;

  it("yields complete frames and holds the partial tail", () => {
    const wire = frame({ type: "log", text: "Compiling soroban-sdk v27.0.5" }) + 'data: {"type":"log","te';

    const { chunks, rest } = parseSseFrames(wire);

    expect(chunks).toEqual([{ type: "log", text: "Compiling soroban-sdk v27.0.5" }]);
    expect(rest).toBe('data: {"type":"log","te');
  });

  it("recovers a frame split across two reads", () => {
    const wire = frame({ type: "log", text: "test test_install_succeeds ... ok" });
    const split = Math.floor(wire.length / 2);

    const first = parseSseFrames(wire.slice(0, split));
    expect(first.chunks).toEqual([]);

    const second = parseSseFrames(first.rest + wire.slice(split));
    expect(second.chunks).toEqual([{ type: "log", text: "test test_install_succeeds ... ok" }]);
  });

  it("skips a malformed frame instead of throwing", () => {
    const wire = "data: {not json\n\n" + frame({ type: "result", result: { success: true, compiled: true, testCases: [], compileOutput: "" } });

    const { chunks } = parseSseFrames(wire);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].type).toBe("result");
  });
});

// The install-params Symbol keys are consumed by three independent places: the prompt's key
// list (policy-codegen), the generated tests (policy-sandbox), and the on-chain deploy path
// (routes/policies.tsx). They drifted once already: the deploy path used truthy `if (max)`
// guards and never emitted `allowed_*` or the time-lock keys the prompt declared. Because the
// prompt instructs policies to PANIC on a missing declared key, that drift made allowlist and
// time_lock policies pass their tests and then fail their real add_context_rule install.
// All three now derive from installParamsSpec(); these lock that in.
describe("install params: one convention, three consumers", () => {
  const schema: PolicySchema = {
    $schema: SCHEMA_VERSION,
    name: "drift-guard",
    description: "exercises every constraint kind that emits an install param",
    contracts: [{
      address: "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526",
      functions: [{
        name: "transfer",
        args: [
          { name: "to", type: "address", constraint: { kind: "allowlist", values: ["GABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQHGPC"] } },
          { name: "amount", type: "i128", constraint: { kind: "range", min: "0", max: "0" } },
        ],
      }],
    }],
    globalRules: [
      { type: "threshold", params: { threshold: 2 } },
      { type: "time_lock", params: { validAfterLedger: 100, validUntilLedger: 500 } },
    ],
  };

  it("emits every declared key, including allowlist and time-lock", () => {
    const keys = installParamsSpec(schema).map(p => p.key);
    expect(keys).toEqual(expect.arrayContaining([
      "allowed_to", "max_amount", "min_amount",
      "threshold", "valid_after_ledger", "valid_until_ledger",
    ]));
  });

  it("keeps a bound of 0, which truthy guards used to drop", () => {
    const keys = installParamsSpec(schema).map(p => p.key);
    expect(keys).toContain("max_amount");
    expect(keys).toContain("min_amount");
  });

  it("the prompt's declared keys and the generated tests' installed keys are identical", () => {
    const declared = installParamsSpec(schema).map(p => p.key).sort();
    // What the generated Rust actually calls map.set(...) with.
    const generated = [...generateTestCases(schema).matchAll(/Symbol::new\(env, "([a-z0-9_]+)"\)\.into_val\(env\), /g)]
      .map(m => m[1]).sort();
    expect(generated).toEqual(declared);
  });
});

// Soroban rejects an unsorted ScMap during ScVal->host conversion. The deploy path hand-builds
// the map (unlike the test harness, which uses host Map::set and sorts implicitly), so schema
// order would break any schema with two constrained args.
describe("install params are emitted in ascending key order", () => {
  it("sorts keys so the hand-built deploy ScMap is host-valid", () => {
    const schema: PolicySchema = {
      $schema: SCHEMA_VERSION,
      name: "sort-guard",
      description: "two constrained args produce interleaved keys in schema order",
      contracts: [{
        address: "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526",
        functions: [{
          name: "transfer",
          args: [
            { name: "amount", type: "i128", constraint: { kind: "range", min: "1", max: "9" } },
            { name: "fee", type: "i128", constraint: { kind: "range", min: "1", max: "9" } },
          ],
        }],
      }],
      globalRules: [{ type: "threshold", params: { threshold: 2 } }],
    };
    const keys = installParamsSpec(schema).map(p => p.key);
    expect(keys).toEqual([...keys].sort());
    // Schema order would have been max_amount, min_amount, max_fee, min_fee.
    expect(keys).toEqual(["max_amount", "max_fee", "min_amount", "min_fee", "threshold"]);
  });
});
