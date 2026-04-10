import { GearSix, Trash, CaretDown, Plus, FileCode, ChatText } from "@phosphor-icons/react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { useState } from "react";
import type {
  ArgConstraint,
  ArgConstraintKind,
  ArgPermission,
  ContractPermission,
  FunctionPermission,
  GlobalRule,
  GlobalRuleType,
} from "@/lib/policy-schema";
import { constraintKindsForType } from "@/lib/policy-schema";

// --- Constraint kind labels ---

const CONSTRAINT_LABELS: Record<ArgConstraintKind, string> = {
  unconstrained: "Any value",
  exact: "Exact match",
  range: "Range",
  allowlist: "Allowlist",
  blocklist: "Blocklist",
};

// --- Global rule labels & descriptions ---

const GLOBAL_RULE_LABELS: Record<GlobalRuleType, string> = {
  threshold: "Signature Threshold",
  weighted_threshold: "Weighted Threshold",
  time_lock: "Time Lock",
};

const GLOBAL_RULE_DESCRIPTIONS: Record<GlobalRuleType, string> = {
  threshold: "Require N-of-M signers to approve",
  weighted_threshold: "Weighted signer threshold approval",
  time_lock: "Restrict to a ledger number window",
};

const GLOBAL_RULE_TYPES: GlobalRuleType[] = [
  "threshold",
  "weighted_threshold",
  "time_lock",
];

// ============================================================
// ContractCard
// ============================================================

interface ContractCardProps {
  contract: ContractPermission;
  onChange: (updated: ContractPermission) => void;
  onRemove: () => void;
  onFetchSpec?: (address: string) => void;
  specLoading?: boolean;
}

export default function ContractCard({
  contract,
  onChange,
  onRemove,
  onFetchSpec,
  specLoading,
}: ContractCardProps) {
  return (
    <div className="bg-slate-800/50 border border-slate-700 rounded-2xl p-5 space-y-4">
      {/* Header */}
      <div className="flex items-start gap-3">
        <FileCode size={20} weight="bold" className="text-violet-400 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0 space-y-3">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Contract Address</label>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="C... or G..."
                value={contract.address}
                onChange={(e) => onChange({ ...contract, address: e.target.value })}
                className="flex-1 px-3 py-2 bg-slate-700/50 border border-slate-600 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:border-violet-500 transition-colors font-mono"
              />
              {onFetchSpec && (
                <button
                  onClick={() => onFetchSpec(contract.address)}
                  disabled={!contract.address || specLoading}
                  className="px-3 py-2 bg-violet-500/20 border border-violet-500/50 rounded-lg text-violet-300 text-xs hover:bg-violet-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
                >
                  {specLoading ? "Loading..." : "Fetch Spec"}
                </button>
              )}
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Label (optional)</label>
            <input
              type="text"
              placeholder="e.g. Token Contract"
              value={contract.label ?? ""}
              onChange={(e) =>
                onChange({ ...contract, label: e.target.value || undefined })
              }
              className="w-full px-3 py-2 bg-slate-700/50 border border-slate-600 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:border-violet-500 transition-colors"
            />
          </div>
        </div>
        <button
          onClick={onRemove}
          className="text-gray-500 hover:text-red-400 transition-colors shrink-0"
        >
          <Trash size={16} />
        </button>
      </div>

      {/* Functions */}
      <div className="ml-8 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-gray-300">Functions</h3>
          <button
            onClick={() =>
              onChange({
                ...contract,
                functions: [...contract.functions, { name: "", args: [] }],
              })
            }
            className="flex items-center gap-1 text-xs text-violet-400 hover:text-violet-300 transition-colors"
          >
            <Plus size={14} weight="bold" />
            Add Function
          </button>
        </div>

        {contract.functions.length === 0 ? (
          <div className="bg-slate-900/30 border border-dashed border-slate-700 rounded-xl p-4 text-center">
            <p className="text-gray-500 text-xs">
              No functions. Add at least one to define allowed operations.
            </p>
          </div>
        ) : (
          contract.functions.map((func, fi) => (
            <FunctionCard
              key={fi}
              func={func}
              onChange={(updated) =>
                onChange({
                  ...contract,
                  functions: contract.functions.map((f, i) =>
                    i === fi ? updated : f
                  ),
                })
              }
              onRemove={() =>
                onChange({
                  ...contract,
                  functions: contract.functions.filter((_, i) => i !== fi),
                })
              }
            />
          ))
        )}
      </div>
    </div>
  );
}

// ============================================================
// FunctionCard
// ============================================================

function FunctionCard({
  func,
  onChange,
  onRemove,
}: {
  func: FunctionPermission;
  onChange: (updated: FunctionPermission) => void;
  onRemove: () => void;
}) {
  const [showNote, setShowNote] = useState(!!func.note);

  return (
    <div className="bg-slate-900/40 border border-slate-700/60 rounded-xl p-4 space-y-3">
      <div className="flex items-center gap-2">
        <input
          type="text"
          placeholder="Function name (e.g. transfer, swap)"
          value={func.name}
          onChange={(e) => onChange({ ...func, name: e.target.value })}
          className="flex-1 px-3 py-2 bg-slate-700/50 border border-slate-600 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:border-violet-500 transition-colors font-mono"
        />
        <button
          onClick={() => setShowNote(!showNote)}
          className={`transition-colors shrink-0 ${showNote ? "text-violet-400" : "text-gray-500 hover:text-violet-400"}`}
          title="Add enforcement notes"
        >
          <ChatText size={14} weight="bold" />
        </button>
        <button
          onClick={onRemove}
          className="text-gray-500 hover:text-red-400 transition-colors shrink-0"
        >
          <Trash size={14} />
        </button>
      </div>

      {/* Function-level note */}
      {showNote && (
        <div>
          <label className="block text-xs text-gray-400 mb-1">Enforcement notes (guides AI code generation)</label>
          <textarea
            placeholder="e.g. Enforce a rolling window sum on amount over 17280 ledgers. Allow max 10 calls per day."
            value={func.note ?? ""}
            onChange={(e) => onChange({ ...func, note: e.target.value || undefined })}
            rows={2}
            className="w-full px-3 py-2 bg-slate-700/50 border border-slate-600 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:border-violet-500 transition-colors resize-none"
          />
        </div>
      )}

      {/* Per-arg constraints */}
      {func.args.length > 0 && (
        <div className="space-y-2">
          <label className="block text-xs text-gray-400">Arguments</label>
          {func.args.map((arg, ai) => (
            <ArgRow
              key={ai}
              arg={arg}
              onChange={(updated) =>
                onChange({
                  ...func,
                  args: func.args.map((a, i) => (i === ai ? updated : a)),
                })
              }
            />
          ))}
        </div>
      )}

      {func.args.length === 0 && (
        <button
          onClick={() =>
            onChange({
              ...func,
              args: [
                ...func.args,
                { name: "", type: "address", constraint: { kind: "unconstrained" } },
              ],
            })
          }
          className="flex items-center gap-1 text-xs text-violet-400 hover:text-violet-300 transition-colors"
        >
          <Plus size={12} weight="bold" />
          Add Argument
        </button>
      )}
    </div>
  );
}

// ============================================================
// ArgRow — per-argument constraint editor
// ============================================================

function ArgRow({
  arg,
  onChange,
}: {
  arg: ArgPermission;
  onChange: (updated: ArgPermission) => void;
}) {
  const [showNote, setShowNote] = useState(!!arg.note);
  const validKinds = constraintKindsForType(arg.type);
  const currentKind = arg.constraint?.kind ?? "unconstrained";

  const handleKindChange = (kind: ArgConstraintKind) => {
    let constraint: ArgConstraint;
    switch (kind) {
      case "exact":
        constraint = { kind: "exact", value: "" };
        break;
      case "range":
        constraint = { kind: "range" };
        break;
      case "allowlist":
        constraint = { kind: "allowlist", values: arg.observedValues ?? [] };
        break;
      case "blocklist":
        constraint = { kind: "blocklist", values: [] };
        break;
      default:
        constraint = { kind: "unconstrained" };
    }
    onChange({ ...arg, constraint });
  };

  return (
    <div className="bg-slate-800/40 border border-slate-700/40 rounded-lg p-3 space-y-2">
      <div className="flex items-center gap-2">
        {/* Arg name + type badge */}
        <Badge variant="neutral"><code className="font-mono">{arg.name}: {arg.type}</code></Badge>

        {/* Constraint kind selector */}
        {validKinds.length > 1 && (
          <select
            value={currentKind}
            onChange={(e) => handleKindChange(e.target.value as ArgConstraintKind)}
            className="ml-auto px-2 py-1 bg-slate-700/50 border border-slate-600 rounded text-white text-xs focus:outline-none focus:border-violet-500 transition-colors"
          >
            {validKinds.map((kind) => (
              <option key={kind} value={kind}>
                {CONSTRAINT_LABELS[kind]}
              </option>
            ))}
          </select>
        )}

        {/* Note toggle */}
        <button
          onClick={() => setShowNote(!showNote)}
          className={`transition-colors shrink-0 ${showNote ? "text-violet-400" : "text-gray-600 hover:text-violet-400"}`}
          title="Add note for this argument"
        >
          <ChatText size={12} weight="bold" />
        </button>
      </div>

      {/* Observed values hint */}
      {arg.observedValues && arg.observedValues.length > 0 && currentKind === "unconstrained" && (
        <div className="flex flex-wrap gap-1">
          {arg.observedValues.slice(0, 3).map((v, i) => (
            <Badge key={i} variant="neutral">
              <code className="font-mono truncate max-w-40">
                {v.length > 16 ? `${v.slice(0, 8)}...${v.slice(-4)}` : v}
              </code>
            </Badge>
          ))}
          {arg.observedValues.length > 3 && (
            <span className="text-xs text-gray-600">+{arg.observedValues.length - 3} more</span>
          )}
        </div>
      )}

      {/* Constraint value editor */}
      <ConstraintEditor constraint={arg.constraint} onChange={(c) => onChange({ ...arg, constraint: c })} />

      {/* Per-arg note */}
      {showNote && (
        <textarea
          placeholder="Guidance for this argument..."
          value={arg.note ?? ""}
          onChange={(e) => onChange({ ...arg, note: e.target.value || undefined })}
          rows={1}
          className="w-full px-2 py-1.5 bg-slate-700/30 border border-slate-700 rounded text-white text-xs placeholder-gray-600 focus:outline-none focus:border-violet-500 transition-colors resize-none"
        />
      )}
    </div>
  );
}

// ============================================================
// ConstraintEditor — renders inputs for the active constraint kind
// ============================================================

function ConstraintEditor({
  constraint,
  onChange,
}: {
  constraint?: ArgConstraint;
  onChange: (c: ArgConstraint) => void;
}) {
  if (!constraint || constraint.kind === "unconstrained") return null;

  switch (constraint.kind) {
    case "exact":
      return (
        <ParamInput
          label="Value"
          placeholder="Exact value to match"
          value={constraint.value}
          onChange={(v) => onChange({ kind: "exact", value: v })}
        />
      );
    case "range":
      return (
        <div className="flex gap-2">
          <ParamInput
            label="Min"
            placeholder="Optional"
            value={constraint.min ?? ""}
            onChange={(v) => onChange({ ...constraint, min: v || undefined })}
          />
          <ParamInput
            label="Max"
            placeholder="Optional"
            value={constraint.max ?? ""}
            onChange={(v) => onChange({ ...constraint, max: v || undefined })}
          />
        </div>
      );
    case "allowlist":
      return (
        <ParamTextarea
          label="Allowed values (one per line)"
          placeholder="G... or C... addresses, one per line"
          value={constraint.values.join("\n")}
          onChange={(v) => onChange({ kind: "allowlist", values: splitLines(v) })}
        />
      );
    case "blocklist":
      return (
        <ParamTextarea
          label="Blocked values (one per line)"
          placeholder="G... or C... addresses, one per line"
          value={constraint.values.join("\n")}
          onChange={(v) => onChange({ kind: "blocklist", values: splitLines(v) })}
        />
      );
  }
}

// ============================================================
// GlobalRuleCard (unchanged from v1)
// ============================================================

interface GlobalRuleCardProps {
  rule: GlobalRule;
  onChange: (updated: GlobalRule) => void;
  onRemove: () => void;
}

export function GlobalRuleCard({ rule, onChange, onRemove }: GlobalRuleCardProps) {
  const [typeOpen, setTypeOpen] = useState(false);

  const handleTypeChange = (type: GlobalRuleType) => {
    onChange(getDefaultGlobalRule(type));
    setTypeOpen(false);
  };

  return (
    <div className="bg-slate-800/50 border border-slate-700 rounded-2xl p-5">
      <div className="flex items-start gap-3">
        <GearSix size={20} weight="bold" className="text-violet-400 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="relative mb-4">
            <button
              onClick={() => setTypeOpen(!typeOpen)}
              className="w-full flex items-center justify-between px-4 py-2.5 bg-slate-700/50 border border-slate-600 rounded-xl text-white text-sm hover:border-slate-500 transition-colors"
            >
              <span>{GLOBAL_RULE_LABELS[rule.type]}</span>
              <CaretDown
                size={16}
                weight="bold"
                className={`text-gray-400 transition-transform ${typeOpen ? "rotate-180" : ""}`}
              />
            </button>
            {typeOpen && (
              <div className="absolute z-10 mt-1 w-full bg-slate-700 border border-slate-600 rounded-xl overflow-hidden shadow-lg">
                {GLOBAL_RULE_TYPES.map((type) => (
                  <button
                    key={type}
                    onClick={() => handleTypeChange(type)}
                    className={`w-full text-left px-4 py-2.5 text-sm hover:bg-slate-600 transition-colors ${
                      rule.type === type ? "text-violet-400 bg-slate-600/50" : "text-gray-300"
                    }`}
                  >
                    <span className="font-medium">{GLOBAL_RULE_LABELS[type]}</span>
                    <span className="block text-xs text-gray-500 mt-0.5">
                      {GLOBAL_RULE_DESCRIPTIONS[type]}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-3">
            <GlobalRuleParams rule={rule} onChange={onChange} />
          </div>
        </div>
        <button
          onClick={onRemove}
          className="text-gray-500 hover:text-red-400 transition-colors shrink-0"
        >
          <Trash size={16} />
        </button>
      </div>
    </div>
  );
}

function GlobalRuleParams({ rule, onChange }: { rule: GlobalRule; onChange: (updated: GlobalRule) => void }) {
  switch (rule.type) {
    case "threshold":
      return (
        <ParamInput
          label="Required signatures"
          placeholder="e.g. 2"
          value={String(rule.params.threshold)}
          onChange={(v) => onChange({ type: "threshold", params: { threshold: safeInt(v) } })}
        />
      );
    case "weighted_threshold":
      return (
        <>
          <ParamInput
            label="Threshold"
            placeholder="e.g. 3"
            value={String(rule.params.threshold)}
            onChange={(v) => onChange({ type: "weighted_threshold", params: { ...rule.params, threshold: safeInt(v) } })}
          />
          <ParamTextarea
            label="Weights (signer:weight per line)"
            placeholder={"G...address:2\nG...address:1"}
            value={rule.params.weights.map((w) => `${w.signer}:${w.weight}`).join("\n")}
            onChange={(v) =>
              onChange({
                type: "weighted_threshold",
                params: {
                  ...rule.params,
                  weights: splitLines(v).map((line) => {
                    const [signer, weight] = line.split(":");
                    return { signer: signer ?? "", weight: safeInt(weight ?? "0") };
                  }),
                },
              })
            }
          />
        </>
      );
    case "time_lock":
      return (
        <>
          <ParamInput
            label="Valid after ledger"
            placeholder="Optional"
            value={rule.params.validAfterLedger != null ? String(rule.params.validAfterLedger) : ""}
            onChange={(v) => onChange({ type: "time_lock", params: { ...rule.params, validAfterLedger: v ? safeInt(v) : undefined } })}
          />
          <ParamInput
            label="Valid until ledger"
            placeholder="Optional"
            value={rule.params.validUntilLedger != null ? String(rule.params.validUntilLedger) : ""}
            onChange={(v) => onChange({ type: "time_lock", params: { ...rule.params, validUntilLedger: v ? safeInt(v) : undefined } })}
          />
        </>
      );
  }
}

// ============================================================
// Default factories
// ============================================================

export function getDefaultContract(): ContractPermission {
  return { address: "", functions: [] };
}

export function getDefaultGlobalRule(type: GlobalRuleType): GlobalRule {
  switch (type) {
    case "threshold":
      return { type, params: { threshold: 0 } };
    case "weighted_threshold":
      return { type, params: { threshold: 0, weights: [] } };
    case "time_lock":
      return { type, params: {} };
  }
}

// ============================================================
// Shared primitives
// ============================================================

function ParamInput({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex-1">
      <label className="block text-xs text-gray-400 mb-1">{label}</label>
      <input
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 bg-slate-700/50 border border-slate-600 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:border-violet-500 transition-colors"
      />
    </div>
  );
}

function ParamTextarea({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label className="block text-xs text-gray-400 mb-1">{label}</label>
      <textarea
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        className="w-full px-3 py-2 bg-slate-700/50 border border-slate-600 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:border-violet-500 transition-colors font-mono resize-none"
      />
    </div>
  );
}

function safeInt(v: string): number {
  const n = parseInt(v, 10);
  return isNaN(n) ? 0 : n;
}

function splitLines(v: string): string[] {
  return v.split("\n").map((s) => s.trim()).filter(Boolean);
}
