import { GitBranch, Check } from "@phosphor-icons/react";
import { Badge } from "@cloudflare/kumo/components/badge";
import type { TxPattern } from "@/lib/tx-analyzer";

export type { TxPattern } from "@/lib/tx-analyzer";

interface PatternSummaryProps {
  patterns: TxPattern[];
  selected: Set<number>;
  onToggle: (index: number) => void;
}

export default function PatternSummary({ patterns, selected, onToggle }: PatternSummaryProps) {
  if (patterns.length === 0) return null;

  return (
    <div className="bg-slate-800/50 border border-slate-700 rounded-2xl p-6">
      <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
        <GitBranch size={20} weight="bold" className="text-violet-400" />
        Extracted Patterns
      </h2>
      <p className="text-sm text-gray-400 mb-4">
        Select the patterns to include in your policy.
      </p>
      <div className="space-y-3">
        {patterns.map((pattern, index) => {
          const isSelected = selected.has(index);
          return (
            <button
              key={index}
              onClick={() => onToggle(index)}
              className={`w-full text-left bg-slate-700/30 border rounded-xl px-4 py-3 transition-colors ${
                isSelected
                  ? "border-violet-500/70 bg-violet-500/10"
                  : "border-slate-600/50 hover:border-slate-500"
              }`}
            >
              <div className="flex items-start gap-3">
                <div
                  className={`mt-0.5 w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                    isSelected
                      ? "bg-violet-500 border-violet-500"
                      : "border-slate-500"
                  }`}
                >
                  {isSelected && <Check size={12} weight="bold" className="text-white" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-white">
                      {pattern.functionName}
                    </span>
                    <span className="text-xs text-gray-500">on</span>
                    <code className="text-xs text-gray-400 font-mono truncate">
                      {pattern.contractAddress}
                    </code>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {pattern.args.map((a, i) => (
                      <Badge key={i} variant="neutral"><code className="font-mono">arg{i}:{a.type}</code></Badge>
                    ))}
                    {pattern.signers.map((s, i) => (
                      <Badge key={`s${i}`} variant="blue">{s.type}</Badge>
                    ))}
                  </div>

                  {/* Show inner call decomposition for execute() patterns */}
                  {pattern.innerCall && (
                    <div className="mt-2 pl-4 border-l-2 border-violet-500/30">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-violet-400">&rarr;</span>
                        <span className="text-sm font-medium text-violet-300">
                          {pattern.innerCall.functionName}
                        </span>
                        <span className="text-xs text-gray-500">on</span>
                        <code className="text-xs text-gray-400 font-mono truncate">
                          {pattern.innerCall.targetContract}
                        </code>
                      </div>
                      {pattern.innerCall.args.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {pattern.innerCall.args.map((a, i) => (
                            <Badge key={i} variant="purple">
                              {a.type}: {a.value.length > 20 ? a.value.slice(0, 10) + "..." + a.value.slice(-6) : a.value}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Show sub-invocations tree if present */}
                  {pattern.invocationTree && pattern.invocationTree.subInvocations.length > 0 && (
                    <div className="mt-2 pl-4 border-l-2 border-amber-500/30">
                      <p className="text-xs text-amber-400 mb-1">Sub-invocations requiring auth:</p>
                      {pattern.invocationTree.subInvocations.map((sub, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <span className="text-xs text-amber-400">&#8627;</span>
                          <span className="text-xs font-medium text-amber-300">{sub.functionName}()</span>
                          <span className="text-xs text-gray-500">on</span>
                          <code className="text-xs text-gray-500 font-mono">{sub.contractAddress.slice(0, 8)}...{sub.contractAddress.slice(-4)}</code>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-gray-500">
        {selected.size} of {patterns.length} pattern{patterns.length !== 1 && "s"} selected
      </p>
    </div>
  );
}
