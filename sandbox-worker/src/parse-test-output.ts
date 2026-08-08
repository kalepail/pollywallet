export interface ParsedTestCase {
  name: string;
  passed: boolean;
  output: string;
}

export interface ParsedTestRun {
  success: boolean;
  compiled: boolean;
  testCases: ParsedTestCase[];
  compileOutput: string;
}

/**
 * libtest appends " - should panic" to the displayed name of a `#[should_panic]`
 * test, so the suffix has to be optional here. Without it every negative test —
 * which is all of the ones proving a policy *rejects* a call — parsed as no
 * match and vanished from the results list.
 */
const TEST_LINE = /^test (\S+)(?: - should panic)? \.\.\. (ok|FAILED)/gm;

/** Parse `cargo test` output into per-test results. */
export function parseTestOutput(output: string, execSucceeded: boolean): ParsedTestRun {
  const testCases: ParsedTestCase[] = [];
  TEST_LINE.lastIndex = 0;
  let match;

  while ((match = TEST_LINE.exec(output)) !== null) {
    testCases.push({ name: match[1], passed: match[2] === "ok", output: "" });
  }

  // Extract per-test failure output from cargo test's stdout sections
  // Format: "---- tests::test_name stdout ----\n...output...\n\n"
  for (const tc of testCases) {
    if (tc.passed) {
      tc.output = "ok";
      continue;
    }
    const escaped = tc.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const sectionMatch = output.match(
      new RegExp(`---- ${escaped} stdout ----\\n([\\s\\S]*?)(?=\\n\\n|$)`)
    );
    if (sectionMatch) {
      tc.output = sectionMatch[1].trim().slice(0, 2000);
    } else {
      const panicMatch = output.match(
        new RegExp(`thread '${escaped}' panicked at ([^\\n]+)`)
      );
      tc.output = panicMatch ? panicMatch[0].slice(0, 2000) : "(test failed — no captured output)";
    }
  }

  // Check if compilation succeeded (tests ran at all)
  const compiled = output.includes("running") || output.includes("test result");
  const hasRealError = output.includes("error[E") || output.includes("error: could not compile");
  // `[].every(...)` is `true`, so a run that parsed NO tests used to report success whenever
  // cargo exited 0 — which a hostile crate can arrange with a crate-level `#![cfg(any())]`
  // that disables the appended test module ("running 0 tests", exit 0). An empty suite proves
  // nothing, so it is a failure.
  const success = execSucceeded && testCases.length > 0 && testCases.every((tc) => tc.passed);

  // If not compiled and no real error, this was likely a timeout during
  // dependency download / initial compilation. Report it clearly.
  let compileOutput = output.slice(0, 5000);
  if (!compiled && !hasRealError && !execSucceeded) {
    compileOutput =
      "Build timed out (likely downloading dependencies on first run). Retrying should be faster.\n\n" +
      compileOutput;
  }

  return { success, compiled, testCases, compileOutput };
}
