import { Flask, CheckCircle, XCircle, CaretDown } from "@phosphor-icons/react";
import { Loader } from "@cloudflare/kumo/components/loader";
import { Badge } from "@cloudflare/kumo/components/badge";
import { useState } from "react";

export interface TestResult {
  name: string;
  passed: boolean;
  output: string;
}

interface TestResultsProps {
  results: TestResult[];
  loading?: boolean;
}

export default function TestResults({ results, loading }: TestResultsProps) {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;

  return (
    <div className="bg-slate-800/50 border border-slate-700 rounded-2xl p-6">
      <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
        <Flask size={20} weight="bold" className="text-violet-400" />
        Test Results
      </h2>

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
