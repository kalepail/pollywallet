import { Code, PencilSimple, Eye, Lightning, Hash, FileText, Copy, Check } from "@phosphor-icons/react";
import { Loader } from "@cloudflare/kumo/components/loader";
import { Badge } from "@cloudflare/kumo/components/badge";
import { useState, useEffect, useRef, useCallback } from "react";
import { codeToHtml } from "shiki";

interface StreamStats {
  tokenCount: number;
  linesOfCode: number;
  tokensPerSecond: number;
  startTime: number;
  status: "idle" | "streaming" | "highlighting" | "done" | "error";
}

interface CodeEditorProps {
  code: string;
  loading?: boolean;
  streaming?: boolean;
  streamingCode?: string;
  stats?: StreamStats;
  onEdit: (code: string) => void;
}

export type { StreamStats };

export default function CodeEditor({
  code,
  loading,
  streaming,
  streamingCode,
  stats,
  onEdit,
}: CodeEditorProps) {
  const [editing, setEditing] = useState(false);
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const codeRef = useRef<HTMLPreElement>(null);
  const displayCode = streaming ? streamingCode ?? "" : code;

  // Auto-scroll during streaming
  useEffect(() => {
    if (streaming && codeRef.current) {
      codeRef.current.scrollTop = codeRef.current.scrollHeight;
    }
  }, [streaming, streamingCode]);

  // Highlight with Shiki when code is finalized (not during streaming)
  useEffect(() => {
    if (!code || streaming || editing) {
      setHighlightedHtml(null);
      return;
    }

    let cancelled = false;
    codeToHtml(code, {
      lang: "rust",
      theme: "vesper",
    }).then((html) => {
      if (!cancelled) setHighlightedHtml(html);
    }).catch(() => {
      // Shiki failed — fallback to plain text
    });

    return () => { cancelled = true; };
  }, [code, streaming, editing]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [code]);

  const elapsed = stats?.startTime
    ? ((stats.status === "done" ? Date.now() : Date.now()) - stats.startTime) / 1000
    : 0;

  return (
    <div className="bg-slate-800/50 border border-slate-700 rounded-2xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-slate-700/60">
        <h2 className="text-sm font-semibold text-white flex items-center gap-2">
          <Code size={16} weight="bold" className="text-violet-400" />
          Generated Policy Code
        </h2>
        <div className="flex items-center gap-2">
          {!loading && !streaming && code && (
            <>
              <button
                onClick={handleCopy}
                className="flex items-center gap-1 text-xs text-gray-400 hover:text-white transition-colors px-2 py-1 rounded"
              >
                {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                {copied ? "Copied" : "Copy"}
              </button>
              <button
                onClick={() => setEditing(!editing)}
                className="flex items-center gap-1 text-xs text-gray-400 hover:text-violet-400 transition-colors px-2 py-1 bg-slate-700/50 rounded"
              >
                {editing ? (
                  <><Eye size={12} /> Preview</>
                ) : (
                  <><PencilSimple size={12} /> Edit</>
                )}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Stats bar — visible during streaming and after completion */}
      {stats && stats.status !== "idle" && (
        <div className="flex items-center gap-4 px-5 py-2 bg-slate-900/50 border-b border-slate-700/40 text-xs">
          <Badge variant="purple"><Lightning size={12} /> {stats.tokensPerSecond.toFixed(1)} tok/s</Badge>
          <Badge variant="neutral"><Hash size={12} /> {stats.tokenCount.toLocaleString()} tokens</Badge>
          <Badge variant="neutral"><FileText size={12} /> {stats.linesOfCode} lines</Badge>
          <div className="ml-auto flex items-center gap-1.5">
            {stats.status === "streaming" && (
              <span className="flex items-center gap-1 text-emerald-400">
                <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse" />
                Generating
              </span>
            )}
            {stats.status === "highlighting" && (
              <span className="text-violet-400">Highlighting...</span>
            )}
            {stats.status === "done" && (
              <span className="text-gray-500">
                {elapsed.toFixed(1)}s
              </span>
            )}
            {stats.status === "error" && (
              <span className="text-red-400">Error</span>
            )}
          </div>
        </div>
      )}

      {/* Code display */}
      <div className="relative">
        {loading && !streaming ? (
          <div className="p-8 flex flex-col items-center justify-center gap-3 min-h-48">
            <Loader size={32} />
            <p className="text-sm text-gray-400">Preparing generation...</p>
          </div>
        ) : editing ? (
          <textarea
            value={code}
            onChange={(e) => onEdit(e.target.value)}
            spellCheck={false}
            className="w-full bg-slate-900/70 p-4 text-sm text-gray-300 font-mono leading-relaxed focus:outline-none resize-y min-h-64 border-0"
            rows={20}
          />
        ) : highlightedHtml && !streaming ? (
          <div
            className="[&>pre]:p-4 [&>pre]:m-0 [&>pre]:bg-transparent [&>pre]:text-sm [&>pre]:leading-relaxed [&>pre]:!overflow-auto [&>pre]:max-h-[32rem]"
            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          />
        ) : (
          <pre
            ref={codeRef}
            className="p-4 overflow-x-auto text-sm text-gray-300 font-mono leading-relaxed max-h-[32rem] overflow-y-auto bg-slate-900/70"
          >
            {displayCode || (
              <span className="text-gray-500 italic">
                No code generated yet. Click "Generate Policy Code" to start.
              </span>
            )}
            {streaming && (
              <span className="inline-block w-2 h-4 bg-violet-400 ml-0.5 animate-pulse" />
            )}
          </pre>
        )}
      </div>
    </div>
  );
}
