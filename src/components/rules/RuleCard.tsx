import { useState, useEffect } from "react";
import {
  Trash,
  PencilSimple,
  Copy,
  Check,
  Clock,
  ShieldCheck,
  Key,
  Warning,
  CaretDown,
  CaretUp,
  Code,
} from "@phosphor-icons/react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Loader } from "@cloudflare/kumo/components/loader";
import type { ContextRuleInfo } from "@/lib/context-rules";
import type { SavedPolicy } from "@/lib/policy-store";
import { MAX_CONTEXT_RULE_NAME } from "@/lib/constants";

interface RuleCardProps {
  rule: ContextRuleInfo;
  latestLedger: number;
  policyMeta: Map<string, SavedPolicy>;
  actionInProgress: string | null;
  onRename: (ruleId: number, newName: string) => void;
  onDelete: (ruleId: number) => void;
  onUpdateExpiration: (ruleId: number, validUntil: number | null) => void;
}

function truncateAddress(addr: string, chars = 8): string {
  if (addr.length <= chars * 2 + 3) return addr;
  return `${addr.slice(0, chars)}...${addr.slice(-chars)}`;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="text-gray-500 hover:text-white transition-colors"
      title="Copy"
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

function PolicyCodeViewer({ code }: { code: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    import("shiki").then(({ codeToHtml }) =>
      codeToHtml(code, { lang: "rust", theme: "vesper" })
    ).then((result) => {
      if (!cancelled) setHtml(result);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [code]);

  return (
    <div className="mt-2 rounded-lg overflow-hidden border border-slate-700/60">
      <div className="flex items-center justify-between px-3 py-1.5 bg-slate-900/60 border-b border-slate-700/40">
        <span className="text-xs text-gray-500 flex items-center gap-1">
          <Code size={12} /> Rust source
        </span>
        <button
          onClick={() => {
            navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
          className="text-xs text-gray-500 hover:text-white transition-colors flex items-center gap-1"
        >
          {copied ? <><Check size={10} className="text-emerald-400" /> Copied</> : <><Copy size={10} /> Copy</>}
        </button>
      </div>
      {html ? (
        <div
          className="overflow-x-auto max-h-80 overflow-y-auto [&>pre]:p-3 [&>pre]:m-0 [&>pre]:bg-transparent [&>pre]:text-xs [&>pre]:leading-relaxed"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="p-3 overflow-x-auto text-xs text-gray-400 font-mono leading-relaxed max-h-80 overflow-y-auto bg-slate-900/70">
          {code}
        </pre>
      )}
    </div>
  );
}

export default function RuleCard({
  rule,
  latestLedger,
  policyMeta,
  actionInProgress,
  onRename,
  onDelete,
  onUpdateExpiration,
}: RuleCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(rule.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingExpiration, setEditingExpiration] = useState(false);
  const [expirationInput, setExpirationInput] = useState(
    rule.validUntil?.toString() ?? ""
  );
  const [expandedPolicyCode, setExpandedPolicyCode] = useState<string | null>(null);

  const isExpired = rule.validUntil != null && rule.validUntil <= latestLedger;
  const isDefault = rule.contextType === "Default" && rule.policies.length === 0;
  const isProcessing = actionInProgress !== null;

  const handleRenameSubmit = () => {
    const trimmed = newName.trim();
    if (trimmed && trimmed !== rule.name && trimmed.length <= MAX_CONTEXT_RULE_NAME) {
      onRename(rule.id, trimmed);
    }
    setRenaming(false);
  };

  const handleExpirationSubmit = () => {
    const val = expirationInput.trim();
    if (val === "") {
      onUpdateExpiration(rule.id, null);
    } else {
      const ledger = parseInt(val, 10);
      if (!isNaN(ledger) && ledger > 0) {
        onUpdateExpiration(rule.id, ledger);
      }
    }
    setEditingExpiration(false);
  };

  return (
    <div
      className={`border rounded-2xl transition-colors ${
        isExpired
          ? "bg-red-950/20 border-red-800/40"
          : "bg-slate-800/50 border-slate-700"
      }`}
    >
      {/* Header */}
      <div
        className="flex items-center gap-3 px-5 py-4 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {renaming ? (
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleRenameSubmit();
                  if (e.key === "Escape") setRenaming(false);
                }}
                onBlur={handleRenameSubmit}
                onClick={(e) => e.stopPropagation()}
                maxLength={MAX_CONTEXT_RULE_NAME}
                autoFocus
                className="px-2 py-1 bg-slate-700 border border-cyan-500 rounded text-white text-sm font-semibold focus:outline-none w-40"
              />
            ) : (
              <h3 className="text-white font-semibold text-sm truncate">
                {rule.name}
              </h3>
            )}
            <Badge variant="neutral">#{rule.id}</Badge>
            {rule.contextType === "CallContract" && (
              <Badge variant="purple">CallContract</Badge>
            )}
            {rule.contextType === "CreateContract" && (
              <Badge variant="purple">CreateContract</Badge>
            )}
            {isDefault && <Badge variant="teal">Default</Badge>}
            {rule.policies.length > 0 && (
              <Badge variant="purple">
                {rule.policies.length} {rule.policies.length === 1 ? "policy" : "policies"}
              </Badge>
            )}
            {isExpired && <Badge variant="error">Expired</Badge>}
            {rule.validUntil != null && !isExpired && (
              <Badge variant="neutral">
                <Clock size={12} /> L{rule.validUntil.toLocaleString()}
              </Badge>
            )}
          </div>
          {rule.targetContract && (
            <p className="text-xs text-gray-500 mt-1 font-mono truncate">
              Target: {truncateAddress(rule.targetContract)}
            </p>
          )}
        </div>
        <div className="text-gray-400">
          {expanded ? <CaretUp size={16} /> : <CaretDown size={16} />}
        </div>
      </div>

      {/* Expanded Details */}
      {expanded && (
        <div className="border-t border-slate-700/60 px-5 py-4 space-y-4">
          {/* Target Contract */}
          {rule.targetContract && (
            <div>
              <p className="text-xs text-gray-400 mb-1 font-medium">Target Contract</p>
              <div className="flex items-center gap-2">
                <code className="text-xs text-gray-300 font-mono break-all">
                  {rule.targetContract}
                </code>
                <CopyButton text={rule.targetContract} />
              </div>
            </div>
          )}

          {/* Signers */}
          {rule.signers.length > 0 && (
            <div>
              <p className="text-xs text-gray-400 mb-2 font-medium flex items-center gap-1">
                <Key size={12} /> Signers ({rule.signers.length})
              </p>
              <div className="space-y-1.5">
                {rule.signers.map((signer, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 bg-slate-900/40 rounded-lg px-3 py-2"
                  >
                    <Badge variant={signer.type === "Delegated" ? "teal" : "neutral"}>
                      {signer.type}
                    </Badge>
                    <code className="text-xs text-gray-400 font-mono truncate flex-1">
                      {truncateAddress(signer.address, 10)}
                    </code>
                    <CopyButton text={signer.address} />
                    {rule.signerIds[i] != null && (
                      <span className="text-xs text-gray-600">id:{rule.signerIds[i]}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Policies */}
          {rule.policies.length > 0 && (
            <div>
              <p className="text-xs text-gray-400 mb-2 font-medium flex items-center gap-1">
                <ShieldCheck size={12} /> Policies ({rule.policies.length})
              </p>
              <div className="space-y-2">
                {rule.policies.map((addr, i) => {
                  const meta = policyMeta.get(addr);
                  const codeExpanded = expandedPolicyCode === addr;
                  return (
                    <div key={i}>
                      <div className="flex items-center gap-2 bg-slate-900/40 rounded-lg px-3 py-2">
                        <code className="text-xs text-gray-400 font-mono truncate flex-1">
                          {truncateAddress(addr, 10)}
                        </code>
                        <CopyButton text={addr} />
                        {rule.policyIds[i] != null && (
                          <span className="text-xs text-gray-600">id:{rule.policyIds[i]}</span>
                        )}
                        {meta && (
                          <span className="text-xs text-violet-400 truncate max-w-32" title={meta.name}>
                            {meta.name}
                          </span>
                        )}
                        {meta?.deployedAt && (
                          <span className="text-xs text-gray-600">
                            {new Date(meta.deployedAt).toLocaleDateString()}
                          </span>
                        )}
                        {meta?.rustCode && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpandedPolicyCode(codeExpanded ? null : addr);
                            }}
                            className="flex items-center gap-1 text-xs text-gray-500 hover:text-violet-400 transition-colors"
                            title="View policy source code"
                          >
                            <Code size={12} />
                            {codeExpanded ? "Hide" : "Code"}
                          </button>
                        )}
                      </div>
                      {codeExpanded && meta?.rustCode && (
                        <PolicyCodeViewer code={meta.rustCode} />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Expiration */}
          <div>
            <p className="text-xs text-gray-400 mb-1 font-medium flex items-center gap-1">
              <Clock size={12} /> Expiration
            </p>
            {editingExpiration ? (
              <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                <input
                  type="number"
                  value={expirationInput}
                  onChange={(e) => setExpirationInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleExpirationSubmit();
                    if (e.key === "Escape") setEditingExpiration(false);
                  }}
                  placeholder="Ledger # (blank = none)"
                  className="px-2 py-1 bg-slate-700 border border-cyan-500 rounded text-white text-xs font-mono focus:outline-none w-40"
                  autoFocus
                />
                <button
                  onClick={handleExpirationSubmit}
                  disabled={isProcessing}
                  className="px-2 py-1 bg-cyan-600 hover:bg-cyan-700 disabled:opacity-50 text-white text-xs rounded transition-colors"
                >
                  Save
                </button>
                <button
                  onClick={() => setEditingExpiration(false)}
                  className="px-2 py-1 text-gray-400 hover:text-white text-xs transition-colors"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <p className="text-xs text-gray-300">
                {rule.validUntil != null ? (
                  <>
                    Ledger {rule.validUntil.toLocaleString()}
                    {isExpired && (
                      <span className="text-red-400 ml-2">
                        <Warning size={12} className="inline" /> Expired (current: L{latestLedger.toLocaleString()})
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-gray-500">No expiration</span>
                )}
              </p>
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 pt-2 border-t border-slate-700/60">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setRenaming(true);
                setNewName(rule.name);
              }}
              disabled={isProcessing}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-400 hover:text-cyan-400 hover:bg-slate-700/50 rounded-lg transition-colors disabled:opacity-50"
            >
              {isProcessing && actionInProgress === `rename-${rule.id}` ? (
                <Loader size="sm" />
              ) : (
                <PencilSimple size={14} />
              )}
              Rename
            </button>

            <button
              onClick={(e) => {
                e.stopPropagation();
                setEditingExpiration(true);
                setExpirationInput(rule.validUntil?.toString() ?? "");
              }}
              disabled={isProcessing}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-400 hover:text-cyan-400 hover:bg-slate-700/50 rounded-lg transition-colors disabled:opacity-50"
            >
              {isProcessing && actionInProgress === `expiration-${rule.id}` ? (
                <Loader size="sm" />
              ) : (
                <Clock size={14} />
              )}
              Expiration
            </button>

            <div className="ml-auto">
              {confirmDelete ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-red-400">Delete this rule?</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(rule.id);
                      setConfirmDelete(false);
                    }}
                    disabled={isProcessing}
                    className="px-2 py-1 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-xs rounded transition-colors"
                  >
                    {isProcessing && actionInProgress === `delete-${rule.id}` ? (
                      <Loader size="sm" />
                    ) : (
                      "Confirm"
                    )}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmDelete(false);
                    }}
                    className="px-2 py-1 text-gray-400 hover:text-white text-xs transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmDelete(true);
                  }}
                  disabled={isProcessing || isDefault}
                  title={
                    isDefault
                      ? "Cannot delete the default passkey rule"
                      : "Delete this context rule"
                  }
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-400 hover:text-red-400 hover:bg-red-950/30 rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <Trash size={14} />
                  Delete
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
