import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { buildSystemPrompt } from "../policy-codegen";
import { generateTestCases } from "../policy-sandbox";
import { SCHEMA_VERSION, type PolicySchema } from "../policy-schema";

/**
 * Drift guard between the OpenZeppelin smart-account standard and our copies of it.
 *
 * A generated policy is a STANDALONE contract: it cannot depend on `stellar-accounts`, so it
 * re-declares `Signer`, `ContextRule` and `ContextRuleType` inline, and the prompt carries
 * those declarations. That makes them a copy of someone else's source, and copies rot.
 *
 * Rot here is not a compile error. `#[contracttype]` structs cross the contract boundary as
 * maps keyed by FIELD NAME, so a renamed, reordered-into-absence, added or removed field
 * decodes wrong at install or enforce time — on-chain, in a policy that gates funds, with an
 * error that names none of this. The whole point of checking mechanically is that a human
 * reading two struct definitions side by side will not reliably notice a missing `signer_ids`.
 *
 * These tests parse the canonical declarations out of the pinned submodule and compare. When
 * one fails after a submodule bump, the standard moved: update the prompt's CORE TYPES block
 * (and the harness in policy-sandbox.ts), do not weaken the test.
 */

const STORAGE_RS = "stellar-contracts/packages/accounts/src/smart_account/storage.rs";
const POLICIES_RS = "stellar-contracts/packages/accounts/src/policies/mod.rs";
const ACCOUNT_RS = "stellar-contracts/packages/accounts/src/smart_account/mod.rs";

const haveSubmodule = existsSync(STORAGE_RS) && existsSync(POLICIES_RS);
const read = (path: string) => readFileSync(path, "utf8");

/** Strip doc comments, line comments and blank lines so declarations compare cleanly. */
function stripNoise(block: string): string[] {
  return block
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, "").trim())
    .filter(Boolean);
}

/** The body of `<keyword> <Name> { ... }`, plus the derive line immediately above it. */
function declaration(source: string, keyword: "struct" | "enum", name: string) {
  const start = source.indexOf(`pub ${keyword} ${name} {`);
  if (start < 0) throw new Error(`no declaration for ${keyword} ${name}`);
  const open = source.indexOf("{", start);
  const close = source.indexOf("\n}", open);
  const body = source.slice(open + 1, close);

  const before = source.slice(Math.max(0, start - 400), start);
  const derives = [...before.matchAll(/#\[derive\(([^)]*)\)\]/g)].pop();

  return {
    derives: (derives?.[1] ?? "").split(",").map((d) => d.trim()).filter(Boolean),
    lines: stripNoise(body),
  };
}

/** `pub name: Type,` → "name: Type", in declaration order. */
function fields(decl: { lines: string[] }): string[] {
  return decl.lines
    .filter((l) => l.startsWith("pub ") && l.includes(":"))
    .map((l) => l.replace(/^pub\s+/, "").replace(/,$/, "").replace(/\s+/g, " "));
}

/** `Variant(A, B),` → "Variant(A, B)", in declaration order. */
function variants(decl: { lines: string[] }): string[] {
  return decl.lines
    .filter((l) => /^[A-Z]/.test(l))
    .map((l) => l.replace(/,$/, "").replace(/\s+/g, ""));
}

describe.skipIf(!haveSubmodule)("OZ smart-account parity", () => {
  const canonical = () => read(STORAGE_RS);
  const prompt = buildSystemPrompt();

  it.each(["ContextRule"] as const)("%s fields match the standard exactly, in order", (name) => {
    const theirs = fields(declaration(canonical(), "struct", name));
    const ours = fields(declaration(prompt, "struct", name));
    // Order is asserted too: field order is the struct's declared shape, and a reader
    // comparing sets rather than sequences would miss a swap.
    expect(ours).toEqual(theirs);
    expect(theirs.length).toBeGreaterThan(0);
  });

  it.each(["Signer", "ContextRuleType"] as const)("%s variants match the standard", (name) => {
    const theirs = variants(declaration(canonical(), "enum", name));
    const ours = variants(declaration(prompt, "enum", name));
    expect(ours).toEqual(theirs);
    expect(theirs.length).toBeGreaterThan(0);
  });

  // A missing derive is a compile error in the generated policy — Signer needs Ord to be
  // usable as a Map key, which a policy tracking per-signer state will reach for.
  it.each(["Signer", "ContextRuleType"] as const)("%s derives match the standard", (name) => {
    const theirs = declaration(canonical(), "enum", name).derives;
    const ours = declaration(prompt, "enum", name).derives;
    expect(ours).toEqual(theirs);
  });

  it("ContextRule derives match the standard", () => {
    expect(declaration(prompt, "struct", "ContextRule").derives)
      .toEqual(declaration(canonical(), "struct", "ContextRule").derives);
  });
});

describe.skipIf(!haveSubmodule)("Policy trait ABI parity", () => {
  const trait = read(POLICIES_RS);
  const prompt = buildSystemPrompt();

  /**
   * Parameter names of a declaration, in order, minus the env.
   *
   * Shape-agnostic on purpose: the trait declares `uninstall` on one line and `enforce` across
   * five, and the prompt mentions `pub fn enforce(..` in prose before declaring it properly.
   * So collect every candidate and take the one that actually carries the ABI — a real
   * declaration always names `smart_account`.
   */
  const paramsOf = (source: string, fn: string): string[] => {
    const candidates = [...source.matchAll(new RegExp(`fn ${fn}\\(([^)]*)\\)`, "g"))]
      .map((m) => m[1]);
    const decl = candidates.find((c) => c.includes("smart_account"));
    if (!decl) throw new Error(`no ${fn} declaration naming smart_account`);
    // Split into parameters and take the name before each colon. Scanning for `\w+:` instead
    // would pick up the path separator in `Self::AccountParams` as a parameter called "Self".
    // Generic arguments are flattened first so a `Map<K, V>` comma cannot split a parameter.
    return decl
      .replace(/<[^>]*>/g, "<>")
      .split(",")
      .map((param) => /^\s*(\w+)\s*:/.exec(param)?.[1])
      .filter((name): name is string => !!name && name !== "e");
  };

  const traitParams = (fn: string) => paramsOf(trait, fn);
  const promptParams = (fn: string) => paramsOf(prompt, fn);

  it.each(["enforce", "install", "uninstall"] as const)(
    "%s takes the standard's parameters in the standard's order",
    (fn) => {
      expect(promptParams(fn)).toEqual(traitParams(fn));
    }
  );

  // The one deliberate divergence: #[contractclient] erases the trait's associated
  // AccountParams type, so a standalone contract must accept a raw Val and decode it.
  it("declares install_params as Val, because the client erases AccountParams", () => {
    const decl = [...prompt.matchAll(/fn install\(([^)]*)\)/g)]
      .map((m) => m[1])
      .find((c) => c.includes("smart_account"))!;
    expect(decl).toMatch(/install_params:\s*Val\b/);
    expect(trait).toMatch(/install_params:\s*Self::AccountParams/);
  });
});

describe.skipIf(!existsSync(ACCOUNT_RS))("execute wrapper parity", () => {
  const account = read(ACCOUNT_RS);
  const prompt = buildSystemPrompt();

  // Shape B's argument layout is this signature. If the account's wrapper changes, the
  // prompt's (target, target_fn, target_args) decoding is wrong.
  it("matches the account's execute signature", () => {
    expect(account).toMatch(
      /fn execute\(\s*e: &Env,\s*target: Address,\s*target_fn: Symbol,\s*target_args: Vec<Val>\s*\)/
    );
    expect(prompt).toMatch(/execute\(target, ?target_fn, ?target_args\)|args\[0\]\s*=\s*target/i);
  });

  // OZ's own examples ship governor contracts exposing their own execute(), so identifying
  // the wrapper by function name alone misreads a direct call to one of them.
  it("identifies the wrapper by the contract being called, not the name", () => {
    expect(prompt).toMatch(/context\.contract == smart_account/);
  });
});

describe.skipIf(!haveSubmodule)("generated test harness parity", () => {
  // The harness builds a ContextRule literal. A field added upstream makes that literal
  // incomplete, and the generated crate fails to compile — after a full cargo build.
  it("constructs every canonical ContextRule field", () => {
    const schema: PolicySchema = {
      $schema: SCHEMA_VERSION,
      name: "parity",
      description: "parity fixture",
      globalRules: [],
      contracts: [{
        address: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
        functions: [{ name: "transfer", args: [{ name: "amount", type: "i128" }] }],
      }],
    } as PolicySchema;

    const rust = generateTestCases(schema);
    const canonicalFields = fields(declaration(read(STORAGE_RS), "struct", "ContextRule"))
      .map((f) => f.split(":")[0]);

    const missing = canonicalFields.filter((f) => !new RegExp(`\\b${f}\\s*:`).test(rust));
    expect(missing, `harness omits ContextRule field(s): ${missing.join(", ")}`).toEqual([]);
  });
});
