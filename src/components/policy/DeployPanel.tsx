import { Rocket, CheckCircle, Copy, Check, ShieldCheck } from "@phosphor-icons/react";
import { Loader } from "@cloudflare/kumo/components/loader";
import { Badge } from "@cloudflare/kumo/components/badge";
import { useState } from "react";

export interface DeployResult {
  contractAddress: string;
  wasmHash?: string;
}

interface DeployPanelProps {
  onDeploy: () => void;
  onInstall?: (contractAddress: string) => void;
  deployResult?: DeployResult;
  loading?: boolean;
}

export default function DeployPanel({ onDeploy, onInstall, deployResult, loading }: DeployPanelProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!deployResult) return;
    await navigator.clipboard.writeText(deployResult.contractAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="bg-slate-800/50 border border-slate-700 rounded-2xl p-6">
      <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
        <Rocket size={20} weight="bold" className="text-violet-400" />
        Deploy Policy
      </h2>

      {!deployResult ? (
        <>
          <p className="text-sm text-gray-400 mb-4">
            Compile, optimize, and deploy your policy contract to Stellar Testnet.
          </p>
          <button
            onClick={onDeploy}
            disabled={loading}
            className="w-full flex items-center justify-center gap-3 px-6 py-4 bg-violet-500 hover:bg-violet-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-colors shadow-lg shadow-violet-500/25"
          >
            {loading ? (
              <>
                <Loader size={20} />
                Deploying...
              </>
            ) : (
              <>
                <Rocket size={20} />
                Deploy to Testnet
              </>
            )}
          </button>
          {loading && (
            <div className="mt-4">
              <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                <div className="h-full bg-violet-500 rounded-full animate-pulse w-2/3" />
              </div>
              <p className="text-xs text-gray-500 mt-2">
                Compiling and deploying to Stellar Testnet...
              </p>
            </div>
          )}
        </>
      ) : (
        <div className="space-y-4">
          <Badge variant="success"><CheckCircle size={16} weight="fill" /> Deployed</Badge>

          <div className="bg-slate-900/70 border border-slate-700 rounded-xl p-4">
            <p className="text-xs text-gray-500 mb-1">Contract Address</p>
            <div className="flex items-center gap-2">
              <code className="text-sm text-white font-mono truncate flex-1">
                {deployResult.contractAddress}
              </code>
              <button
                onClick={handleCopy}
                className="text-gray-400 hover:text-white transition-colors shrink-0"
              >
                {copied ? (
                  <Check size={16} className="text-emerald-400" />
                ) : (
                  <Copy size={16} />
                )}
              </button>
            </div>
            {deployResult.wasmHash && (
              <div className="mt-2">
                <p className="text-xs text-gray-500 mb-1">WASM Hash</p>
                <code className="text-xs text-gray-400 font-mono break-all">
                  {deployResult.wasmHash}
                </code>
              </div>
            )}
          </div>

          {onInstall && (
            <button
              onClick={() => onInstall(deployResult.contractAddress)}
              className="w-full flex items-center justify-center gap-3 px-6 py-4 bg-violet-500 hover:bg-violet-600 text-white font-semibold rounded-xl transition-colors shadow-lg shadow-violet-500/25"
            >
              <ShieldCheck size={20} />
              Install on Wallet
            </button>
          )}
        </div>
      )}
    </div>
  );
}
