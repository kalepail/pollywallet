import { describe, it, expect } from "vitest";

describe("empty suites are not passes", () => {
  it("reports failure when cargo exits 0 but no tests ran", () => {
    // A crate-level `#![cfg(any())]` disables the appended test module, so cargo prints
    // "running 0 tests" and exits 0. Nothing was proven, so this must not be a pass.
    const result = parseTestOutput("running 0 tests\n\ntest result: ok. 0 passed; 0 failed\n", true);
    expect(result.testCases).toHaveLength(0);
    expect(result.success).toBe(false);
  });
});
import { parseTestOutput } from "./parse-test-output";

/** Verbatim shape of `cargo test` output, including the " - should panic" suffix. */
const OUTPUT = `   Compiling policy-contract v0.1.0 (/workspace/policy-abc)
    Finished \`test\` profile [unoptimized + debuginfo] target(s) in 41.20s
     Running unittests src/lib.rs (/workspace/cargo-target/debug/deps/policy_contract-1a2b)

running 4 tests
test tests::test_enforce_basic_succeeds ... ok
test tests::test_install_succeeds ... ok
test tests::test_uninstall_succeeds ... ok
test tests::test_uninstall_when_not_installed - should panic ... ok

test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.04s
`;

describe("parseTestOutput", () => {
  it("counts #[should_panic] tests, which carry a ' - should panic' suffix", () => {
    const { testCases, success, compiled } = parseTestOutput(OUTPUT, true);

    expect(testCases.map((t) => t.name)).toEqual([
      "tests::test_enforce_basic_succeeds",
      "tests::test_install_succeeds",
      "tests::test_uninstall_succeeds",
      "tests::test_uninstall_when_not_installed",
    ]);
    expect(testCases.every((t) => t.passed)).toBe(true);
    expect(success).toBe(true);
    expect(compiled).toBe(true);
  });

  it("does not treat the 'test result:' summary line as a test case", () => {
    const { testCases } = parseTestOutput(OUTPUT, true);
    expect(testCases.some((t) => t.name.startsWith("result"))).toBe(false);
  });

  it("captures a failing should_panic test and its panic output", () => {
    const failing = `running 1 test
test tests::test_enforce_amount_exceeds_range - should panic ... FAILED

failures:

---- tests::test_enforce_amount_exceeds_range stdout ----
note: test did not panic as expected

test result: FAILED. 0 passed; 1 failed; 0 ignored
`;
    const { testCases, success } = parseTestOutput(failing, false);

    expect(testCases).toHaveLength(1);
    expect(testCases[0].name).toBe("tests::test_enforce_amount_exceeds_range");
    expect(testCases[0].passed).toBe(false);
    expect(testCases[0].output).toContain("did not panic as expected");
    expect(success).toBe(false);
  });

  it("flags a timed-out build that never reached the test phase", () => {
    const { compiled, compileOutput } = parseTestOutput("   Compiling libc v0.2.189\n", false);
    expect(compiled).toBe(false);
    expect(compileOutput).toContain("Build timed out");
  });
});
