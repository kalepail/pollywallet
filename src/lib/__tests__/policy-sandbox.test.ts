import { describe, it, expect, vi } from "vitest";

// Apply the input validator, as the real runtime does. A mock that drops it silently exempts
// every server function's validation from these tests — including the check that keeps
// caller-supplied test code out of the sandbox.
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    inputValidator: (validate: (data: unknown) => unknown) => ({
      handler: (handler: (args: any) => unknown) => (args: any) =>
        handler({ ...args, data: validate(args?.data) }),
    }),
  }),
}));

import { constraintKindsForType, installParamsSpec, validateSchema } from "../policy-schema";
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

// A page loaded before tests moved server-side still posts `testCode` and no `schemaJson`.
// That must fail (accepting testCode is the bypass), but the message has to be actionable
// rather than naming an internal field.
describe("stale client bundles get an actionable error", () => {
  it("tells the user to reload instead of surfacing a field name", async () => {
    const { streamPolicyTest } = await import("../policy-sandbox");
    const chunks: any[] = [];
    await expect(
      (async () => {
        for await (const c of await streamPolicyTest({
          data: { rustCode: "fn main() {}", testCode: "" } as any,
        })) chunks.push(c);
      })(),
    ).rejects.toThrow(/out of date — reload/);
  });
});

// The generated suite is the gate that let the units bug through. A max-only range fell to
// the 0i128 default, so every acceptance test sent amount = 0 — a value ANY policy accepts,
// including one that divided the cap by 10^7 and then rejected every real transfer. Found by
// an adversarial reviewer reading the harness rather than the policy.
describe("acceptance tests exercise a real in-range value", () => {
  const schemaWith = (constraint: any): any => ({
    $schema: "pollywallet-policy/v0",
    name: "cap",
    description: "cap fixture",
    globalRules: [],
    contracts: [{
      address: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      decimals: 7,
      functions: [{ name: "transfer", args: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "amount", type: "i128", constraint },
      ] }],
    }],
  });

  it("uses the max as the positive value, never 0", () => {
    const rust = generateTestCases(schemaWith({ kind: "range", max: "1000000000" }));
    expect(rust).toContain("1000000000i128");
    // The tell-tale of the old behaviour: amount defaulting to zero.
    // Anchored so it cannot match the tail of a legitimate value like 1000000000i128.
    expect(rust).not.toMatch(/(?<![0-9])0i128\.into_val\(&?env\)\); \/\/ amount/);
  });

  it("falls back to the min when only a min is set", () => {
    const rust = generateTestCases(schemaWith({ kind: "range", min: "500" }));
    expect(rust).toContain("500i128");
  });

  it("still emits a valid literal for a negative bound", () => {
    const rust = generateTestCases(schemaWith({ kind: "range", max: "-1" }));
    // Must be parenthesised: -1i128 parses as -(1i128.into_val(..)) and fails to compile.
    expect(rust).toMatch(/\(-1i128\)/);
  });
});

// A time window is only enforced if calls OUTSIDE it are rejected. The suite previously
// generated only test_enforce_within_time_window, which cannot detect the CLOCKS bug at all:
// Env::default() leaves timestamp() at 0, so a policy comparing timestamp() against
// valid_until_ledger sees 0 > N, accepts, and passes. Moving the ledger SEQUENCE outside the
// window is what separates a sequence-based policy from a timestamp-confused one.
describe("time-lock windows are tested at both edges", () => {
  const withWindow = (params: Record<string, number>): any => ({
    $schema: "pollywallet-policy/v0",
    name: "window",
    description: "window fixture",
    globalRules: [{ type: "time_lock", params }],
    contracts: [{
      address: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      functions: [{ name: "transfer", args: [{ name: "amount", type: "i128" }] }],
    }],
  });

  it("rejects a call past valid_until_ledger", () => {
    const rust = generateTestCases(withWindow({ validAfterLedger: 100, validUntilLedger: 5000 }));
    expect(rust).toContain("fn test_enforce_after_window_is_rejected");
    expect(rust).toContain("sequence_number = 5001");
    expect(rust).toContain("try_enforce");
  });

  it("rejects a call before valid_after_ledger", () => {
    const rust = generateTestCases(withWindow({ validAfterLedger: 100, validUntilLedger: 5000 }));
    expect(rust).toContain("fn test_enforce_before_window_is_rejected");
    expect(rust).toContain("sequence_number = 99");
  });

  // The failure message has to name the likely cause, because "enforce accepted a call" alone
  // sends the reader looking at the window logic rather than at which clock was read.
  it("names the wrong-clock hypothesis in the assertion message", () => {
    const rust = generateTestCases(withWindow({ validUntilLedger: 5000 }));
    expect(rust).toMatch(/ledger\(\)\.timestamp\(\).*instead of.*ledger\(\)\.sequence\(\)/s);
  });

  it("emits only the applicable edge when one bound is open", () => {
    const onlyUntil = generateTestCases(withWindow({ validUntilLedger: 5000 }));
    expect(onlyUntil).toContain("fn test_enforce_after_window_is_rejected");
    expect(onlyUntil).not.toContain("fn test_enforce_before_window_is_rejected");

    const onlyAfter = generateTestCases(withWindow({ validAfterLedger: 100 }));
    expect(onlyAfter).toContain("fn test_enforce_before_window_is_rejected");
    expect(onlyAfter).not.toContain("fn test_enforce_after_window_is_rejected");
  });

  it("still keeps the positive in-window test", () => {
    const rust = generateTestCases(withWindow({ validAfterLedger: 100, validUntilLedger: 5000 }));
    expect(rust).toContain("fn test_enforce_within_time_window");
  });

  it("adds nothing when the schema declares no window", () => {
    const rust = generateTestCases({
      $schema: "pollywallet-policy/v0", name: "n", description: "d", globalRules: [],
      contracts: [{ address: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
        functions: [{ name: "transfer", args: [] }] }],
    } as any);
    expect(rust).not.toContain("window_is_rejected");
  });
});

// Every case here produced Rust that does not parse or does not mean what it says — each one
// costing a full cargo build to discover, reported as an opaque compile error. Found by two
// independent reviewers approaching from opposite directions.
describe("generated Rust survives hostile schema strings and values", () => {
  const W = (args: any[], name = "call"): any => ({
    $schema: "pollywallet-policy/v0", name: "hostile", description: "hostile fixture",
    globalRules: [],
    contracts: [{ address: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      functions: [{ name, args }] }],
  });

  // A quote in a function name closed the string literal early: symbol_short!("x"").
  it("escapes quotes and backslashes in a function name", () => {
    const rust = generateTestCases(W([], 'ev"il'));
    expect(rust).toContain('ev\\"il');
    expect(rust).not.toMatch(/symbol_short!\("ev"il"\)/);
  });

  it("escapes hostile values inside exact constraints", () => {
    const rust = generateTestCases(W([{ name: "tag", type: "symbol", constraint: { kind: "exact", value: 'a"b' } }]));
    expect(rust).toContain('a\\"b');
  });

  // -1i128.into_val(&env) parses as -(1i128.into_val(&env)) and fails with E0600.
  it("parenthesises a negative exact literal", () => {
    const rust = generateTestCases(W([{ name: "n", type: "i128", constraint: { kind: "exact", value: "-1" } }]));
    expect(rust).toContain("(-1i128)");
    expect(rust).not.toMatch(/(?<!\()-1i128\.into_val/);
  });

  it("parenthesises a negative range bound", () => {
    const rust = generateTestCases(W([{ name: "n", type: "i128", constraint: { kind: "range", max: "-5" } }]));
    expect(rust).toContain("(-5i128)");
  });

  // A non-integer would previously interpolate straight through as `1e5u32`.
  it("fails loudly rather than emitting a non-integer literal", () => {
    const rust = generateTestCases(W([{ name: "n", type: "u32", constraint: { kind: "exact", value: "1e5" } }]));
    expect(rust).not.toMatch(/\b1e5u32\b/);
    expect(rust).toContain("compile_error!");
  });
});

// generateWrongValueForType builds the counterexample for a rejection test. It used to call
// BigInt() unguarded and step past the type's maximum, so it either took the whole generation
// down or emitted a literal that does not fit.
describe("rejection counterexamples stay inside the type", () => {
  const W = (type: string, value: string): any => ({
    $schema: "pollywallet-policy/v0", name: "wrong", description: "wrong fixture", globalRules: [],
    contracts: [{ address: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      functions: [{ name: "call", args: [{ name: "n", type, constraint: { kind: "exact", value } }] }] }],
  });

  it("steps down at the type maximum instead of overflowing", () => {
    const rust = generateTestCases(W("u32", "4294967295"));
    expect(rust).not.toContain("4294967296u32");
    expect(rust).toContain("4294967294u32");
  });

  it("does not throw on a non-integer exact value", () => {
    expect(() => generateTestCases(W("u32", "1e5"))).not.toThrow();
    expect(() => generateTestCases(W("i128", "abc"))).not.toThrow();
  });

  it("parenthesises a negative counterexample", () => {
    const rust = generateTestCases(W("i128", "-3"));
    expect(rust).toMatch(/\(-2i128\)|\(-4i128\)/);
  });

  // If the counterexample equals the required value, the rejection test fails against a
  // CORRECT policy — the worst kind of test, because it looks like a real defect.
  it("never uses the required value as the counterexample", () => {
    const rust = generateTestCases(W("symbol", "__wrong__"));
    expect(rust).toContain("__wrong2__");
  });
});

// Testing only values[0] is how a policy that checks `x == blocked[0]` — the shape a model most
// often produces from a list — ships green with every later entry still spendable. An adversarial
// review built exactly that mutant against a two-address blocklist and it passed all 11 tests.
describe("every blocklisted value gets its own rejection test", () => {
  const BLOCKED = [
    "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBP2X",
    "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCLZR",
  ];
  const rust = generateTestCases({
    $schema: SCHEMA_VERSION, name: "blocklist", description: "blocklist fixture", globalRules: [],
    contracts: [{ address: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      functions: [{ name: "transfer", args: [
        { name: "to", type: "address", constraint: { kind: "blocklist", values: BLOCKED } },
      ] }] }],
  } as PolicySchema);

  it("emits one test per blocked value, not just the first", () => {
    const names = [...rust.matchAll(/fn (test_enforce_\w*_to_blocked_\d+)\(/g)].map((m) => m[1]);
    expect(names).toHaveLength(BLOCKED.length);
    expect(new Set(names).size).toBe(BLOCKED.length);
  });

  it("puts each blocked value into the generated Rust", () => {
    for (const value of BLOCKED) expect(rust).toContain(value);
  });
});

describe("argument type honesty", () => {
  const withArgs = (args: any[]): PolicySchema => ({
    $schema: SCHEMA_VERSION,
    name: "type-honesty",
    description: "type honesty fixture",
    globalRules: [],
    contracts: [{
      address: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      functions: [{ name: "call", args }],
    }],
  });

  it("never emits Val::VOID for a positive argument of any accepted type", () => {
    const types = [
      "address", "i128", "u128", "i64", "u64", "i32", "u32", "bool", "symbol",
      "string", "u256", "i256", "timepoint", "duration", "bytes", "bytes<32>",
      "Vec<address>", "Map<address, i128>", "Option<address>",
    ];
    const schema = withArgs(types.map((type, i) => ({ name: `arg_${i}`, type })));
    expect(validateSchema(schema).valid).toBe(true);

    const helpers = generateTestCases(schema).match(
      /fn build_default_args[\s\S]*?\n}\n\nfn create_function_context/,
    )?.[0] ?? "";
    expect(helpers).not.toContain("Val::VOID");
    for (let i = 0; i < types.length; i++) expect(helpers).toContain(`// arg_${i}`);
    expect(helpers).toContain("String::from_str(env, \"\")");
    expect(helpers).toContain("U256::from_u32(env, 0)");
    expect(helpers).toContain("I256::from_i32(env, 0)");
    expect(helpers).toContain("Timepoint::from_unix(env, 0)");
    expect(helpers).toContain("Duration::from_seconds(env, 0)");
    expect(helpers).toContain("Bytes::new(env)");
    expect(helpers).toContain("BytesN::<32>::from_array(env, &[0u8; 32])");
    expect(helpers).toContain("Vec::<soroban_sdk::Val>::new(env)");
    expect(helpers).toContain("Map::<soroban_sdk::Val, soroban_sdk::Val>::new(env)");
    expect(helpers).toContain("Option::<soroban_sdk::Val>::None");
  });

  it("emits a typed positive string and a different-string rejection", () => {
    const rust = generateTestCases(withArgs([
      { name: "memo", type: "string", constraint: { kind: "exact", value: "hello" } },
    ]));
    expect(rust).toContain('String::from_str(env, "hello")');
    expect(rust).toContain("test_enforce_c0_f0_memo_wrong_value");
    expect(rust).toContain('String::from_str(&env, "__wrong__")');
  });

  it("chooses a string counterexample outside the whole allowlist", () => {
    const rust = generateTestCases(withArgs([
      {
        name: "memo",
        type: "string",
        constraint: { kind: "allowlist", values: ["__wrong__", "__wrong2__"] },
      },
    ]));
    expect(rust).toContain('String::from_str(&env, "__wrong3__")');
  });

  it("emits at least one rejection for every constraint/type combination it advertises", () => {
    const types = [
      "address", "i128", "u128", "i64", "u64", "i32", "u32", "bool", "symbol", "string",
    ];
    for (const type of types) {
      for (const kind of constraintKindsForType(type).filter(kind => kind !== "unconstrained")) {
        const constraint = kind === "exact" ? { kind, value: type === "address"
          ? "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
          : type === "bool" ? "true" : type === "symbol" || type === "string" ? "kept" : "10" }
          : kind === "range" ? { kind, min: "1", max: "10" }
          : { kind, values: [type === "address"
            ? "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
            : "kept"] };
        const schema = withArgs([{ name: "value", type, constraint }]);
        expect(validateSchema(schema).valid, `${type}/${kind} should validate`).toBe(true);
        expect(
          generateTestCases(schema).match(/fn test_enforce_c0_f0_value_(?:wrong_value|exceeds_max|below_min|not_allowlisted|blocked)/g)?.length ?? 0,
          `${type}/${kind} emitted no rejection test`,
        ).toBeGreaterThan(0);
      }
    }
  });
});

// A deployed policy is multi-tenant: one contract serves many smart accounts and many context
// rules. Nothing else in the suite falsifies that. `test_enforce_before_install_is_rejected`
// looks like it does and does not — a policy keyed by rule id alone, or globally, has no state
// there either and panics for a right-looking reason. Only installing for ONE (account, rule)
// and then enforcing for a neighbour tells them apart. Verified by mutation against a real
// cargo build: keying by rule id alone fails exactly test_enforce_rejects_other_smart_account,
// keying by account alone fails exactly test_enforce_rejects_other_context_rule, and a
// correctly-keyed policy passes both.
describe("multi-tenancy is falsifiable", () => {
  const schema: PolicySchema = {
    $schema: SCHEMA_VERSION,
    name: "tenancy",
    description: "no constraints at all",
    globalRules: [],
    contracts: [{
      address: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      functions: [{ name: "transfer", args: [] }],
    }],
  };

  it("emits both neighbour tests for every schema, constrained or not", () => {
    const rust = generateTestCases(schema);
    expect(rust).toContain("fn test_enforce_rejects_other_smart_account");
    expect(rust).toContain("fn test_enforce_rejects_other_context_rule");
  });

  it("enforces for a DIFFERENT account and a DIFFERENT rule id, after a positive control", () => {
    const rust = generateTestCases(schema);
    const byAccount = rust.slice(rust.indexOf("fn test_enforce_rejects_other_smart_account"));
    expect(byAccount).toContain("let other_account = Address::generate(&env);");
    // Positive control first, then the neighbour must be rejected.
    expect(byAccount.indexOf("positive_control(&env, &ok_ctx")).toBeLessThan(byAccount.indexOf("try_enforce"));
    expect(byAccount).toContain("&context_rule, &other_account).is_err()");

    const byRule = rust.slice(rust.indexOf("fn test_enforce_rejects_other_context_rule"));
    expect(byRule).toContain("create_test_context_rule_with_id(&env, 2)");
    expect(byRule).toContain("&other_rule, &smart_account).is_err()");
  });

  it("keeps the fixture rule at id 1 so the neighbour id is genuinely different", () => {
    const rust = generateTestCases(schema);
    expect(rust).toContain("create_test_context_rule_with_id(env, 1)");
  });
});

// An `exact` constraint is equality. A single counterexample ABOVE the value is passed by a
// policy that implements `if x > value { panic }` — a bound where equality was asked for — and
// every value below stays spendable. Mutation-verified: that mutant fails only the below test.
describe("exact constraints are tested on both sides", () => {
  const withExact = (type: string, value: string): PolicySchema => ({
    $schema: SCHEMA_VERSION,
    name: "exact-both-sides",
    description: "exact fixture",
    globalRules: [],
    contracts: [{
      address: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      functions: [{ name: "call", args: [{ name: "value", type, constraint: { kind: "exact", value } }] }],
    }],
  });

  it("emits an above AND a below counterexample for a numeric exact", () => {
    const rust = generateTestCases(withExact("i128", "100"));
    expect(rust).toContain("fn test_enforce_c0_f0_value_wrong_value");
    expect(rust).toContain("fn test_enforce_c0_f0_value_below_exact_value");
    expect(rust).toContain("args.push_back(101i128.into_val(&env)); // value (overridden)");
    expect(rust).toContain("args.push_back(99i128.into_val(&env)); // value (overridden)");
  });

  it("parenthesises a negative below-counterexample so the literal compiles", () => {
    // `-1i128.into_val(&env)` parses as `-(1i128.into_val(&env))` and fails with E0600.
    expect(generateTestCases(withExact("i128", "0"))).toContain("args.push_back((-1i128).into_val(&env))");
  });

  it("skips the below test at the type floor, where no counterexample is representable", () => {
    const rust = generateTestCases(withExact("u32", "0"));
    expect(rust).toContain("fn test_enforce_c0_f0_value_wrong_value");
    expect(rust).not.toContain("below_exact_value");
    expect(rust).not.toContain("-1u32");
  });

  it("adds nothing for a non-numeric exact, which has no ordering", () => {
    const address = generateTestCases(withExact("address", "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"));
    expect(address).toContain("fn test_enforce_c0_f0_value_wrong_value");
    expect(address).not.toContain("below_exact_value");
    expect(generateTestCases(withExact("bool", "true"))).not.toContain("below_exact_value");
  });
});

// validateSchema() refuses weighted_threshold outright and always runs before this generator, so
// the branch that emitted a positive-only test for it was unreachable — and a positive-only test
// is precisely why the rule type was refused. Nothing should reintroduce one.
describe("no test is emitted for a refused rule type", () => {
  it("never emits a weighted-threshold test", () => {
    const schema: PolicySchema = {
      $schema: SCHEMA_VERSION,
      name: "weighted",
      description: "refused rule type",
      contracts: [{
        address: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
        functions: [{ name: "transfer", args: [] }],
      }],
      globalRules: [{ type: "weighted_threshold", params: { threshold: 2, weights: [] } }],
    };
    expect(validateSchema(schema).valid).toBe(false);
    expect(generateTestCases(schema)).not.toContain("weighted");
  });

  it("asserts on the threshold call itself rather than swallowing any panic", () => {
    const schema: PolicySchema = {
      $schema: SCHEMA_VERSION,
      name: "threshold-strict",
      description: "threshold fixture",
      contracts: [{
        address: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
        functions: [{ name: "transfer", args: [] }],
      }],
      // 1 is the only threshold validateSchema now accepts — a policy rule is deployed with
      // exactly one signer — so pin the shape that can actually reach the sandbox.
      globalRules: [{ type: "threshold", params: { threshold: 1 } }],
    };
    expect(validateSchema(schema).valid).toBe(true);
    const rust = generateTestCases(schema);
    // No bare should_panic anywhere, including the threshold branch.
    expect(rust).not.toContain("#[should_panic]");
    const test = rust.slice(rust.indexOf("fn test_enforce_insufficient_signers"));
    expect(test).toContain("create_test_signers(&env, 1), &context_rule, &smart_account)"); // control
    expect(test).toContain("create_test_signers(&env, 0)"); // the negative: no signers at all
    expect(test).toContain("try_enforce");
  });
});

// A positive control is a REAL enforce(), and a stateful policy mutates state when it runs.
// Sharing an instance with the call under test let the control consume the budget, so the
// rejection fired for exhaustion rather than for the mutated argument and the test passed while
// proving nothing. Mutation-verified against a real cargo build: a globally-keyed, one-call
// policy survived every tenancy test with a shared control and is caught with an isolated one.
describe("positive controls cannot poison the call under test", () => {
  const schema: PolicySchema = {
    $schema: SCHEMA_VERSION,
    name: "isolation",
    description: "control isolation fixture",
    globalRules: [{ type: "threshold", params: { threshold: 1 } }],
    contracts: [{
      address: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      functions: [{
        name: "transfer",
        args: [{ name: "amount", type: "i128", constraint: { kind: "range", max: "1000" } }],
      }],
    }],
  };

  it("runs every control on its own freshly registered policy instance", () => {
    const rust = generateTestCases(schema);
    expect(rust).toContain("fn positive_control(");
    expect(rust).toContain("let control_id = env.register(PolicyContract, ());");
    // No control may go through the same client the assertion under test uses.
    expect(rust).not.toContain("client.enforce(&ok_ctx");
  });

  it("routes every rejection test's control through the isolated helper", () => {
    const rust = generateTestCases(schema);
    const controls = rust.match(/positive_control\(&env, &ok_ctx/g)?.length ?? 0;
    const assertions = rust.match(/try_enforce\(&context/g)?.length ?? 0;
    // Every ok_ctx built is handed to the helper, and there is one control per rejection.
    expect(rust.match(/let ok_ctx =/g)?.length ?? 0).toBe(controls);
    expect(controls).toBeGreaterThan(0);
    expect(assertions).toBeGreaterThanOrEqual(controls);
  });
});
