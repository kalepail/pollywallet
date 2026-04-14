import { ShieldCheck, Key, CheckCircle, Copy, Check, ArrowRight } from "@phosphor-icons/react";
import { Loader } from "@cloudflare/kumo/components/loader";
import { Badge } from "@cloudflare/kumo/components/badge";
import { useState } from "react";

export interface InstallResult {
  contextRuleId: number;
  ephemeralPublicKey: string;
  txHash: string;
}

interface InstallPanelProps {
  policyAddress: string;
  walletConnected: boolean;
  onInstall: () => Promise<void>;
  installResult?: InstallResult;
  loading?: boolean;
  error?: string | null;
  status?: string;
}

export default function InstallPanel({
  policyAddress,
  walletConnected,
  onInstall,
  installResult,
  loading,
  error,
  status,
}: InstallPanelProps) {
  const [copied, setCopied] = useState<string | null>(null);

  const handleCopy = async (text: string, key: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  if (!walletConnected) {
    return (
      <div className="bg-slate-800/50 border border-slate-700 rounded-2xl p-6 text-center space-y-3">
        <Key size={32} weight="duotone" className="text-amber-400 mx-auto" />
        <h2 className="text-lg font-semibold text-white">Wallet Required</h2>
        <p className="text-sm text-gray-400">
          Connect your PollyWallet first to install this policy. Go to the{" "}
          <a href="/" className="text-violet-400 hover:text-violet-300 underline">
            home page
          </a>{" "}
          to create or connect a wallet.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-slate-800/50 border border-slate-700 rounded-2xl p-6 space-y-4">
      <h2 className="text-lg font-semibold text-white flex items-center gap-2">
        <ShieldCheck size={20} weight="bold" className="text-violet-400" />
        Install Policy on Wallet
      </h2>

      {!installResult ? (
        <>
          <p className="text-sm text-gray-400">
            This will create a <strong className="text-gray-300">new context rule</strong> on your smart wallet
            scoped to the target contract, with an ephemeral G-address signer and your deployed policy attached.
          </p>

          <div className="bg-slate-900/70 border border-slate-700 rounded-xl p-4 space-y-2">
            <div>
              <p className="text-xs text-gray-500">Policy Contract</p>
              <code className="text-xs text-white font-mono">{policyAddress}</code>
            </div>
            <div>
              <p className="text-xs text-gray-500">What happens</p>
              <ul className="text-xs text-gray-400 list-disc list-inside space-y-1 mt-1">
                <li>Generates an ephemeral keypair (Delegated signer)</li>
                <li>Creates a new context rule scoped to the target contract</li>
                <li>Installs the policy on that context rule</li>
                <li>Requires passkey signature to authorize</li>
              </ul>
            </div>
          </div>

          {status && (
            <div className="text-sm text-violet-400 flex items-center gap-2">
              {loading && <Loader size={14} />}
              {status}
            </div>
          )}

          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2 text-sm text-red-400">
              {error}
            </div>
          )}

          <button
            onClick={onInstall}
            disabled={loading}
            className="w-full flex items-center justify-center gap-3 px-6 py-4 bg-violet-500 hover:bg-violet-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-colors shadow-lg shadow-violet-500/25"
          >
            {loading ? (
              <>
                <Loader size={20} />
                Installing...
              </>
            ) : (
              <>
                <ShieldCheck size={20} />
                Install on Wallet
                <ArrowRight size={16} />
              </>
            )}
          </button>
        </>
      ) : (
        <div className="space-y-4">
          <Badge variant="success">
            <CheckCircle size={16} weight="fill" /> Installed
          </Badge>

          <div className="bg-slate-900/70 border border-slate-700 rounded-xl p-4 space-y-3">
            <div>
              <p className="text-xs text-gray-500 mb-1">Context Rule ID</p>
              <div className="flex items-center gap-2">
                <code className="text-sm text-white font-mono">
                  {installResult.contextRuleId}
                </code>
              </div>
            </div>

            <div>
              <p className="text-xs text-gray-500 mb-1">Ephemeral Signer (G-address)</p>
              <div className="flex items-center gap-2">
                <code className="text-xs text-white font-mono truncate flex-1">
                  {installResult.ephemeralPublicKey}
                </code>
                <button
                  onClick={() => handleCopy(installResult.ephemeralPublicKey, "signer")}
                  className="text-gray-400 hover:text-white transition-colors shrink-0"
                >
                  {copied === "signer" ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                </button>
              </div>
            </div>

            <div>
              <p className="text-xs text-gray-500 mb-1">Install Transaction</p>
              <div className="flex items-center gap-2">
                <code className="text-xs text-gray-400 font-mono truncate flex-1">
                  {installResult.txHash}
                </code>
                <button
                  onClick={() => handleCopy(installResult.txHash, "tx")}
                  className="text-gray-400 hover:text-white transition-colors shrink-0"
                >
                  {copied === "tx" ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                </button>
              </div>
            </div>

            <div>
              <p className="text-xs text-gray-500 mb-1">Policy Contract</p>
              <code className="text-xs text-gray-400 font-mono break-all">
                {policyAddress}
              </code>
            </div>
          </div>

          <p className="text-xs text-gray-500">
            Your policy is now active on context rule {installResult.contextRuleId}. Transfers
            through this context rule will be enforced by the policy. The ephemeral signer
            above can authorize transactions on this rule.
          </p>
        </div>
      )}
    </div>
  );
}
