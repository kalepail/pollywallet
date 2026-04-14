import { Flask, CheckCircle, XCircle, CaretDown, Warning, Wrench } from "@phosphor-icons/react";
import { Loader } from "@cloudflare/kumo/components/loader";
import { Badge } from "@cloudflare/kumo/components/badge";
import { useState } from "react";

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
}

export default function TestResults({ results, loading, buildTimeline }: TestResultsProps) {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;

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
        <div className="bg-slate-900/70 border border-slate-700 rounded-xl p-8 flex flex-col items-center justify-center gap-3">
          <Loader size={32} />
          <p className="text-sm text-gray-400">Running sandbox tests...</p>
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
          {attempts.length === 1
            ? "1 build attempt"
            : `${attempts.length} build attempts (${attempts.filter(a => !a.compiled).length} failed, ${attempts.filter(a => a.fixed).length} auto-fixed)`}
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
