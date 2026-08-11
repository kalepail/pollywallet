import { Flask, CheckCircle, XCircle, CaretDown, Warning, Wrench } from "@phosphor-icons/react";
import { Loader } from "@cloudflare/kumo/components/loader";
import { Badge } from "@cloudflare/kumo/components/badge";
import { useEffect, useRef, useState } from "react";

export interface TestResult {
  name: string;
  passed: boolean;
  output: string;
}

export interface BuildAttempt {
  attempt: number;
  compiled: boolean;
  errors: string;
  fixed: boolean;
}

interface TestResultsProps {
  results: TestResult[];
  loading?: boolean;
  buildTimeline?: BuildAttempt[];
  /** Live cargo output while a build is running. */
  log?: string[];
  /**
   * Free-text notes in the schema. The generator builds tests from constraints and global rules
   * only, so nothing here covers a note — an all-green run says nothing about whether the policy
   * implements them. The builder warns while a note is typed; this is the same truth at the
   * moment it matters most, when a passing suite is about to be read as "verified".
   */
  unverifiedNotes?: string[];
}

export default function TestResults({ results, loading, buildTimeline, log, unverifiedNotes }: TestResultsProps) {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  const notes = unverifiedNotes ?? [];

  return (
    <div className="bg-slate-800/50 border border-slate-700 rounded-2xl p-6 space-y-4">
      <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
        <Flask size={20} weight="bold" className="text-violet-400" />
        Test Results
      </h2>

      {/* Build Timeline */}
      {buildTimeline && buildTimeline.length > 0 && (
        <BuildTimeline attempts={buildTimeline} />
      )}

      {loading ? (
        <div className="bg-slate-900/70 border border-slate-700 rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-3">
            <Loader size={20} />
            <p className="text-sm text-gray-400">
              Running sandbox tests
              {log && log.length > 0 && <span className="text-gray-500"> — {log.length} lines</span>}
            </p>
          </div>
          <BuildLog log={log} />
        </div>
      ) : results.length === 0 ? (
        <p className="text-sm text-gray-500">No test results yet.</p>
      ) : (
        <>
          <div className="flex items-center gap-4 mb-4 text-sm">
            <Badge variant="success">{passed} passed</Badge>
            {failed > 0 && (
              <Badge variant="error">{failed} failed</Badge>
            )}
          </div>

          {/* What the green above does NOT cover. Stated here because this is where a passing
              run gets read as "the policy does what I asked". */}
          {notes.length > 0 && (
            <div className="mb-4 border border-amber-500/40 bg-amber-500/5 rounded-xl p-3 space-y-1">
              <p className="text-xs text-amber-300 flex items-center gap-2">
                <Warning size={14} weight="bold" />
                {notes.length} {notes.length === 1 ? "note is" : "notes are"} not covered by these tests
              </p>
              <ul className="text-xs text-gray-400 space-y-0.5 pl-5 list-disc">
                {notes.map((note, i) => (
                  <li key={i} className="truncate">{note}</li>
                ))}
              </ul>
              <p className="text-xs text-gray-500">
                Tests are generated from constraints and global rules. Whether the policy
                implements a note is not checked — read the generated Rust for these.
              </p>
            </div>
          )}
          <div className="space-y-2">
            {results.map((result, index) => (
              <TestResultItem key={index} result={result} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function BuildLog({ log }: { log?: string[] }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [log?.length]);

  if (!log || log.length === 0) {
    return (
      <p className="text-xs text-gray-500 font-mono">
        Starting container — a cold run downloads and compiles ~180 crates, which takes a few minutes.
      </p>
    );
  }

  return (
    <pre className="bg-slate-950/60 rounded-lg p-3 text-xs text-gray-400 font-mono overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap">
      {log.join("\n")}
      <div ref={endRef} />
    </pre>
  );
}

/**
 * Summarise a build timeline.
 *
 * `fixed` marks a FAILED attempt whose code was repaired and retried, so the repair count is
 * the number of failures carrying it — never the total number of entries with the flag. The
 * successful final entry must not carry it, or one repair reads as two.
 */
export function summarizeBuildAttempts(attempts: BuildAttempt[]): string {
  if (attempts.length === 1) return "1 build attempt";
  const failed = attempts.filter((a) => !a.compiled).length;
  const fixed = attempts.filter((a) => !a.compiled && a.fixed).length;
  return `${attempts.length} build attempts (${failed} failed, ${fixed} auto-fixed)`;
}

function BuildTimeline({ attempts }: { attempts: BuildAttempt[] }) {
  const [expanded, setExpanded] = useState(false);

  if (attempts.length === 0) return null;
  if (attempts.length === 1 && attempts[0].compiled) return null; // No failures, no timeline

  return (
    <div className="border border-slate-700 rounded-xl overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-4 py-2.5 bg-slate-900/50 text-left"
      >
        <Wrench size={14} className="text-amber-400 shrink-0" />
        <span className="text-xs text-gray-400 flex-1">
          {summarizeBuildAttempts(attempts)}
        </span>
        <CaretDown
          size={14}
          className={`text-gray-500 transition-transform ${expanded ? "rotate-180" : ""}`}
        />
      </button>
      {expanded && (
        <div className="px-4 py-3 space-y-2">
          {attempts.map((attempt) => (
            <div
              key={attempt.attempt}
              className={`border rounded-lg p-3 ${
                attempt.compiled
                  ? "border-emerald-500/20 bg-emerald-500/5"
                  : "border-red-500/20 bg-red-500/5"
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                {attempt.compiled ? (
                  <CheckCircle size={12} weight="fill" className="text-emerald-400" />
                ) : (
                  <Warning size={12} weight="fill" className="text-red-400" />
                )}
                <span className="text-xs text-gray-300 font-medium">
                  Attempt {attempt.attempt}
                  {attempt.fixed && " → auto-fixed"}
                  {attempt.compiled && !attempt.fixed && " → compiled"}
                  {!attempt.compiled && !attempt.fixed && " → failed"}
                </span>
              </div>
              {attempt.errors && (
                <pre className="text-xs text-gray-500 font-mono mt-1 overflow-x-auto max-h-32 overflow-y-auto whitespace-pre-wrap">
                  {attempt.errors}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TestResultItem({ result }: { result: TestResult }) {
  const [expanded, setExpanded] = useState(!result.passed);

  return (
    <div
      className={`border rounded-xl overflow-hidden ${
        result.passed
          ? "border-emerald-500/30 bg-emerald-500/5"
          : "border-red-500/30 bg-red-500/5"
      }`}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left"
      >
        {result.passed ? (
          <CheckCircle size={16} weight="fill" className="text-emerald-400 shrink-0" />
        ) : (
          <XCircle size={16} weight="fill" className="text-red-400 shrink-0" />
        )}
        <span className="text-sm text-white flex-1 font-mono">{result.name}</span>
        <CaretDown
          size={16}
          className={`text-gray-400 transition-transform ${expanded ? "rotate-180" : ""}`}
        />
      </button>
      {expanded && (
        <div className="px-4 pb-3">
          <pre className="bg-slate-900/70 rounded-lg p-3 text-xs text-gray-400 font-mono overflow-x-auto max-h-40 overflow-y-auto">
            {result.output || "(no output)"}
          </pre>
        </div>
      )}
    </div>
  );
}
