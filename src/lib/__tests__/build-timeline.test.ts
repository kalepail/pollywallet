import { describe, it, expect } from "vitest";
import { summarizeBuildAttempts } from "../../components/policy/TestResults";
import type { BuildAttempt } from "../../components/policy/TestResults";

const failed = (attempt: number, fixed: boolean): BuildAttempt =>
  ({ attempt, compiled: false, errors: "E0433", fixed }) as BuildAttempt;
const compiled = (attempt: number): BuildAttempt =>
  ({ attempt, compiled: true, errors: "", fixed: false }) as BuildAttempt;

// This label is the only signal anyone has about codegen health, and it was double-counting:
// `fixed` is set on the FAILED entry when its repair succeeds, and was also set on the
// SUCCEEDING entry because it ran repaired code. One recovered failure therefore rendered as
// "2 build attempts (1 failed, 2 auto-fixed)", which reads like the pipeline is falling over
// when it actually recovered on the first retry.
describe("build attempt summary", () => {
  it("reports a single clean build", () => {
    expect(summarizeBuildAttempts([compiled(1)])).toBe("1 build attempt");
  });

  it("counts one repaired failure as ONE auto-fix, not two", () => {
    expect(summarizeBuildAttempts([failed(1, true), compiled(2)]))
      .toBe("2 build attempts (1 failed, 1 auto-fixed)");
  });

  it("counts each repaired failure once across several retries", () => {
    expect(summarizeBuildAttempts([failed(1, true), failed(2, true), compiled(3)]))
      .toBe("3 build attempts (2 failed, 2 auto-fixed)");
  });

  // A failure the fixer could not repair is still a failure, but not an auto-fix.
  it("does not count a failure whose repair never happened", () => {
    expect(summarizeBuildAttempts([failed(1, true), failed(2, false)]))
      .toBe("2 build attempts (2 failed, 1 auto-fixed)");
  });

  // Defence in depth. The producer no longer marks the succeeding entry as fixed, but the
  // label must be right even if that regresses — this fixture IS the shape that shipped, and
  // without it the summary can be reverted to counting every flagged entry and no test fails.
  it("ignores a fixed flag on a SUCCEEDING attempt", () => {
    const successWronglyFlagged = { attempt: 2, compiled: true, errors: "", fixed: true } as BuildAttempt;
    expect(summarizeBuildAttempts([failed(1, true), successWronglyFlagged]))
      .toBe("2 build attempts (1 failed, 1 auto-fixed)");
  });

  it("never reports more fixes than failures", () => {
    const timelines: BuildAttempt[][] = [
      [failed(1, true), compiled(2)],
      [failed(1, true), failed(2, true), compiled(3)],
      [failed(1, true), failed(2, true), failed(3, true), compiled(4)],
    ];
    for (const t of timelines) {
      const m = /\((\d+) failed, (\d+) auto-fixed\)/.exec(summarizeBuildAttempts(t))!;
      expect(Number(m[2])).toBeLessThanOrEqual(Number(m[1]));
    }
  });
});
