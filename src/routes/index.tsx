import { createFileRoute } from "@tanstack/react-router";
import { useWallet } from "../hooks/useWallet";
import {
  Wallet,
  Plus,
  PaperPlaneTilt,
  Coins,
  SignIn,
  SignOut,
  Copy,
  Check,
  WarningCircle,
  CheckCircle,
  ArrowSquareOut,
} from "@phosphor-icons/react";
import { Loader } from "@cloudflare/kumo/components/loader";

export const Route = createFileRoute("/")({ component: App });

/**
 * Status was previously one grey line for every message, so "Sign with your
 * passkey..." and a hard failure looked identical — and these operations take
 * 10-60s. Colour + icon per state, the way Deel reports payment status.
 */
function StatusPanel({
  status,
  kind,
  txHash,
}: {
  status: string;
  kind: "idle" | "busy" | "done" | "error";
  txHash?: string | null;
}) {
  if (!status) return null;

  const styles = {
    busy: "bg-slate-800/60 border-slate-700 text-gray-300",
    done: "bg-emerald-500/10 border-emerald-500/30 text-emerald-300",
    error: "bg-red-500/10 border-red-500/30 text-red-300",
    idle: "bg-slate-800/60 border-slate-700 text-gray-300",
  }[kind];

  const icon = kind === "error" ? <WarningCircle size={16} weight="fill" className="shrink-0" />
    : kind === "done" ? <CheckCircle size={16} weight="fill" className="shrink-0" />
    : <Loader size={16} />;

  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-center gap-2 px-4 py-3 border rounded-xl text-sm ${styles}`}
    >
      {icon}
      <span className="break-words flex-1">{status}</span>
      {kind === "done" && txHash && (
        <a
          href={`https://stellar.expert/explorer/testnet/tx/${txHash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 inline-flex items-center gap-1 underline underline-offset-2 hover:no-underline"
        >
          View transaction
          <ArrowSquareOut size={14} />
        </a>
      )}
    </div>
  );
}

function App() {
  const {
    wallet, balance, status, statusKind, lastTxHash, loading, copied, destination, amount,
    tokenCode, tokens,
    contextRules, selectedRuleId, rulesLoading,
    setDestination, setAmount, setTokenCode, setSelectedRuleId,
    handleCreate, handleSignIn, handleFund, handleFundUsdc, handleTransfer, handleDisconnect, handleCopy,
  } = useWallet();

  if (!wallet) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center px-4">
        <div className="max-w-md w-full">
          <div className="text-center mb-8">
            <Wallet size={64} weight="duotone" className="text-cyan-400 mx-auto mb-4" />
            <h1 className="text-4xl font-bold text-white mb-2">PollyWallet</h1>
            <p className="text-gray-400">Passkey-secured smart wallet on Stellar Testnet</p>
          </div>
          <button
            onClick={handleCreate}
            disabled={loading}
            className="w-full flex items-center justify-center gap-3 px-6 py-4 bg-cyan-500 hover:bg-cyan-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-colors shadow-lg shadow-cyan-500/25"
          >
            {loading ? <Loader size={20} /> : <Plus size={20} weight="bold" />}
            Create Smart Wallet
          </button>
          <button
            onClick={handleSignIn}
            disabled={loading}
            className="mt-3 w-full flex items-center justify-center gap-3 px-6 py-4 bg-slate-800/50 hover:bg-slate-700/50 border border-slate-700 disabled:opacity-50 disabled:cursor-not-allowed text-gray-300 font-semibold rounded-xl transition-colors"
          >
            {loading ? <Loader size={20} /> : <SignIn size={20} weight="bold" />}
            Sign In with Passkey
          </button>
          <div className="mt-4">
            <StatusPanel status={status} kind={statusKind} txHash={lastTxHash} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-slate-800 to-slate-900 px-4 py-8">
      <div className="max-w-lg mx-auto space-y-6">
        <div className="bg-slate-800/50 border border-slate-700 rounded-2xl p-6">
          <p className="text-sm text-gray-400 mb-1">Balance</p>
          <p className="text-4xl font-bold text-white">
            {balance ?? "..."} <span className="text-lg text-gray-400">{tokenCode}</span>
          </p>
          <div className="mt-3 flex items-center gap-2">
            <code className="text-xs text-gray-500 truncate flex-1">{wallet.contractId}</code>
            <button onClick={handleCopy} className="text-gray-400 hover:text-white transition-colors" title="Copy address">
              {copied ? <Check size={16} className="text-emerald-400" /> : <Copy size={16} />}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={handleFund}
            disabled={loading}
            className="flex items-center justify-center gap-2 px-4 py-3 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-colors"
          >
            {loading ? <Loader size={20} /> : <Coins size={20} weight="bold" />}
            Fund XLM
          </button>
          <button
            onClick={handleFundUsdc}
            disabled={loading}
            title="Friendbots a throwaway account, swaps XLM for USDC on the SDEX, and sends it here"
            className="flex items-center justify-center gap-2 px-4 py-3 bg-sky-600 hover:bg-sky-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-colors"
          >
            {loading ? <Loader size={20} /> : <Coins size={20} weight="bold" />}
            Get USDC
          </button>
        </div>

        <div className="bg-slate-800/50 border border-slate-700 rounded-2xl p-6">
          <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
            <PaperPlaneTilt size={20} weight="bold" className="text-cyan-400" />
            Send {tokenCode}
          </h2>
          <div className="space-y-3">
            <div>
              <label htmlFor="destination" className="block text-xs text-gray-400 mb-1">
                Destination
              </label>
              <input id="destination" type="text" placeholder="G... or C..." value={destination}
                onChange={(e) => setDestination(e.target.value)}
                className="w-full px-4 py-3 bg-slate-700/50 border border-slate-600 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:border-cyan-500 transition-colors" />
            </div>
            <div>
              <label htmlFor="token" className="block text-xs text-gray-400 mb-1">
                Asset
              </label>
              <select
                id="token"
                value={tokenCode}
                onChange={(e) => setTokenCode(e.target.value as typeof tokenCode)}
                className="w-full px-4 py-3 bg-slate-700/50 border border-slate-600 rounded-xl text-white focus:outline-none focus:border-cyan-500 transition-colors"
              >
                {tokens.map((t) => (
                  <option key={t.code} value={t.code}>{t.code}</option>
                ))}
              </select>
            </div>
            <div>
              <div className="flex items-baseline justify-between mb-1">
                <label htmlFor="amount" className="block text-xs text-gray-400">
                  Amount ({tokenCode})
                </label>
                {balance != null && (
                  <button
                    type="button"
                    onClick={() => setAmount(balance)}
                    className="text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
                  >
                    Max: {balance}
                  </button>
                )}
              </div>
              <input id="amount" type="number" placeholder="0.00" value={amount}
                onChange={(e) => setAmount(e.target.value)} step="any" min="0"
                className="w-full px-4 py-3 bg-slate-700/50 border border-slate-600 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:border-cyan-500 transition-colors" />
            </div>

            {/* Signing method: passkey (default) or policy-enforced rule */}
            {(() => {
              const policyRules = contextRules.filter(r => r.policies.length > 0);
              if (policyRules.length === 0 && !rulesLoading) {
                return (
                  <button onClick={handleTransfer} disabled={loading || !destination || !amount}
                    className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-cyan-500 hover:bg-cyan-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-colors"
                  >
                    {loading ? <Loader size={20} /> : <PaperPlaneTilt size={16} weight="bold" />}
                    Send
                  </button>
                );
              }
              if (rulesLoading) {
                return (
                  <button disabled
                    className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-cyan-500/50 text-white/50 font-semibold rounded-xl"
                  >
                    <Loader size={16} />
                    Loading policies...
                  </button>
                );
              }
              // Has policy rules — show selector + send button
              const selectedRule = contextRules.find(r => r.id === selectedRuleId);
              const isPolicy = selectedRule && selectedRule.policies.length > 0;
              return (
                <>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Sign with</label>
                    <select
                      value={selectedRuleId}
                      onChange={(e) => setSelectedRuleId(Number(e.target.value))}
                      className="w-full px-4 py-3 bg-slate-700/50 border border-slate-600 rounded-xl text-white focus:outline-none focus:border-cyan-500 transition-colors"
                    >
                      {contextRules.map((rule) => {
                        const target = rule.targetContract
                          ? ` ${rule.targetContract.slice(0, 8)}...`
                          : "";
                        const policyCount = rule.policies.length > 0
                          ? ` (${rule.policies.length} ${rule.policies.length === 1 ? "policy" : "policies"})`
                          : "";
                        const label = rule.policies.length > 0
                          ? `#${rule.id} ${rule.name} —${target}${policyCount}`
                          : `#${rule.id} ${rule.name} — passkey`;
                        return (
                          <option key={rule.id} value={rule.id}>
                            {label}
                          </option>
                        );
                      })}
                    </select>
                  </div>
                  {isPolicy && (
                    <div className="bg-violet-500/10 border border-violet-500/30 rounded-lg px-3 py-2">
                      <p className="text-xs text-violet-400">
                        Sends through policy-enforced rule — no passkey needed
                      </p>
                    </div>
                  )}
                  <button onClick={handleTransfer} disabled={loading || !destination || !amount}
                    className={`w-full flex items-center justify-center gap-2 px-6 py-3 ${
                      isPolicy
                        ? "bg-violet-500 hover:bg-violet-600"
                        : "bg-cyan-500 hover:bg-cyan-600"
                    } disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-colors`}
                  >
                    {loading ? <Loader size={20} /> : <PaperPlaneTilt size={16} weight="bold" />}
                    {isPolicy ? "Send with Policy" : "Send"}
                  </button>
                </>
              );
            })()}
          </div>
        </div>

        <StatusPanel status={status} kind={statusKind} txHash={lastTxHash} />

        <button onClick={handleDisconnect}
          className="w-full flex items-center justify-center gap-2 px-6 py-3 text-gray-400 hover:text-red-400 transition-colors"
        >
          <SignOut size={16} weight="bold" />
          Disconnect
        </button>
      </div>
    </div>
  );
}
