import { createFileRoute } from "@tanstack/react-router";
import { useWallet } from "../hooks/useWallet";
import { Wallet, Plus, Send, Coins, LogOut, Copy, Check, Loader2 } from "lucide-react";

export const Route = createFileRoute("/")({ component: App });

function App() {
  const {
    wallet, balance, status, loading, copied, destination, amount,
    contextRules, selectedRuleId, rulesLoading,
    setDestination, setAmount, setSelectedRuleId,
    handleCreate, handleFund, handleTransfer, handleDisconnect, handleCopy,
  } = useWallet();

  if (!wallet) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center px-4">
        <div className="max-w-md w-full">
          <div className="text-center mb-8">
            <Wallet className="w-16 h-16 text-cyan-400 mx-auto mb-4" />
            <h1 className="text-4xl font-bold text-white mb-2">PollyWallet</h1>
            <p className="text-gray-400">Passkey-secured smart wallet on Stellar Testnet</p>
          </div>
          <button
            onClick={handleCreate}
            disabled={loading}
            className="w-full flex items-center justify-center gap-3 px-6 py-4 bg-cyan-500 hover:bg-cyan-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-colors shadow-lg shadow-cyan-500/25"
          >
            {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Plus className="w-5 h-5" />}
            Create Smart Wallet
          </button>
          {status && <p className="mt-4 text-sm text-center text-gray-400">{status}</p>}
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
            {balance ?? "..."} <span className="text-lg text-gray-400">XLM</span>
          </p>
          <div className="mt-3 flex items-center gap-2">
            <code className="text-xs text-gray-500 truncate flex-1">{wallet.contractId}</code>
            <button onClick={handleCopy} className="text-gray-400 hover:text-white transition-colors" title="Copy address">
              {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
            </button>
          </div>
        </div>

        <button
          onClick={handleFund}
          disabled={loading}
          className="w-full flex items-center justify-center gap-3 px-6 py-3 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-colors"
        >
          {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Coins className="w-5 h-5" />}
          Fund with Friendbot
        </button>

        <div className="bg-slate-800/50 border border-slate-700 rounded-2xl p-6">
          <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
            <Send className="w-5 h-5 text-cyan-400" />
            Send XLM
          </h2>
          <div className="space-y-3">
            {/* Context Rule Selector */}
            {contextRules.length > 0 && (
              <div>
                <label className="block text-xs text-gray-400 mb-1">Signing Rule</label>
                <select
                  value={selectedRuleId}
                  onChange={(e) => setSelectedRuleId(Number(e.target.value))}
                  className="w-full px-4 py-3 bg-slate-700/50 border border-slate-600 rounded-xl text-white focus:outline-none focus:border-cyan-500 transition-colors"
                >
                  {contextRules.map((rule) => (
                    <option key={rule.id} value={rule.id}>
                      {rule.name}
                      {rule.policies.length > 0 ? ` (${rule.policies.length} policy)` : ""}
                      {rule.contextType === "Default" ? " — passkey" : ""}
                      {rule.signers.some(s => s.type === "Delegated") ? " — ephemeral key" : ""}
                    </option>
                  ))}
                </select>
                {(() => {
                  const rule = contextRules.find(r => r.id === selectedRuleId);
                  if (rule && rule.policies.length > 0) {
                    return (
                      <div className="mt-2 bg-violet-500/10 border border-violet-500/30 rounded-lg px-3 py-2">
                        <p className="text-xs text-violet-400">
                          Policy-enforced: {rule.policies.length} policy active
                          {rule.signers.some(s => s.type === "Delegated")
                            ? " — signs with ephemeral key (no passkey needed)"
                            : ""}
                        </p>
                      </div>
                    );
                  }
                  return null;
                })()}
              </div>
            )}
            {rulesLoading && (
              <p className="text-xs text-gray-500">Loading signing rules...</p>
            )}
            <input type="text" placeholder="Destination (G... or C...)" value={destination}
              onChange={(e) => setDestination(e.target.value)}
              className="w-full px-4 py-3 bg-slate-700/50 border border-slate-600 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:border-cyan-500 transition-colors" />
            <input type="number" placeholder="Amount (XLM)" value={amount}
              onChange={(e) => setAmount(e.target.value)} step="any" min="0"
              className="w-full px-4 py-3 bg-slate-700/50 border border-slate-600 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:border-cyan-500 transition-colors" />
            <button onClick={handleTransfer} disabled={loading || !destination || !amount}
              className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-cyan-500 hover:bg-cyan-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-colors"
            >
              {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-4 h-4" />}
              Send
            </button>
          </div>
        </div>

        {status && <p className="text-sm text-center text-gray-400">{status}</p>}

        <button onClick={handleDisconnect}
          className="w-full flex items-center justify-center gap-2 px-6 py-3 text-gray-400 hover:text-red-400 transition-colors"
        >
          <LogOut className="w-4 h-4" />
          Disconnect
        </button>
      </div>
    </div>
  );
}
