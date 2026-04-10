import { MagnifyingGlass, Plus, X, FileText } from "@phosphor-icons/react";
import { Loader } from "@cloudflare/kumo/components/loader";
import { Badge } from "@cloudflare/kumo/components/badge";
import { useState } from "react";

export interface TxSummary {
  hash: string;
  contractAddress?: string;
  functionName?: string;
  argCount?: number;
  error?: string;
}

interface TxHashInputProps {
  txSummaries: TxSummary[];
  onAdd: (hash: string) => void;
  onRemove: (hash: string) => void;
  loading?: boolean;
}

export default function TxHashInput({ txSummaries, onAdd, onRemove, loading }: TxHashInputProps) {
  const [txHash, setTxHash] = useState("");

  const handleAdd = () => {
    const trimmed = txHash.trim();
    if (trimmed && !txSummaries.some((s) => s.hash === trimmed)) {
      onAdd(trimmed);
      setTxHash("");
    }
  };

  return (
    <div className="bg-slate-800/50 border border-slate-700 rounded-2xl p-6">
      <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
        <MagnifyingGlass size={20} weight="bold" className="text-violet-400" />
        Add Transaction Hashes
      </h2>
      <p className="text-sm text-gray-400 mb-4">
        Input transaction hashes to analyze. The builder will extract patterns
        and generate a policy contract that allows signing similar transactions.
      </p>
      <div className="flex gap-2">
        <input
          type="text"
          placeholder="Transaction hash..."
          value={txHash}
          onChange={(e) => setTxHash(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          disabled={loading}
          className="flex-1 px-4 py-3 bg-slate-700/50 border border-slate-600 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:border-violet-500 transition-colors font-mono text-sm disabled:opacity-50"
        />
        <button
          onClick={handleAdd}
          disabled={!txHash.trim() || loading}
          className="px-4 py-3 bg-violet-500 hover:bg-violet-600 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl transition-colors"
        >
          {loading ? <Loader size={20} /> : <Plus size={20} weight="bold" />}
        </button>
      </div>

      {txSummaries.length > 0 && (
        <div className="mt-4 space-y-2">
          <h3 className="text-sm font-medium text-gray-400">
            {txSummaries.length} transaction{txSummaries.length !== 1 && "s"} added
          </h3>
          {txSummaries.map((summary) => (
            <div
              key={summary.hash}
              className="bg-slate-700/30 border border-slate-600/50 rounded-lg px-4 py-3"
            >
              <div className="flex items-center gap-2">
                <FileText size={16} weight="bold" className="text-violet-400 shrink-0" />
                <code className="text-xs text-gray-300 truncate flex-1 font-mono">
                  {summary.hash}
                </code>
                <button
                  onClick={() => onRemove(summary.hash)}
                  className="text-gray-500 hover:text-red-400 transition-colors shrink-0"
                >
                  <X size={16} weight="bold" />
                </button>
              </div>
              {summary.error ? (
                <p className="mt-2 text-xs text-red-400">{summary.error}</p>
              ) : summary.contractAddress ? (
                <div className="mt-2 flex flex-wrap gap-2 text-xs">
                  <Badge variant="purple">{summary.functionName ?? "unknown"}</Badge>
                  <Badge variant="neutral"><code className="font-mono truncate max-w-48">{summary.contractAddress}</code></Badge>
                  {summary.argCount != null && (
                    <Badge variant="neutral">{summary.argCount} arg{summary.argCount !== 1 ? "s" : ""}</Badge>
                  )}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
