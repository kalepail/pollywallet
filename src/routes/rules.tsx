import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useCallback } from "react";
import { ListBullets, Warning } from "@phosphor-icons/react";
import { Loader } from "@cloudflare/kumo/components/loader";
import {
  requestContextRules,
  type ContextRuleInfo,
} from "@/lib/context-rules";
import {
  loadWallet,
  signWalletAuthEntries,
  TESTNET_RPC_URL,
  TESTNET_NETWORK_PASSPHRASE,
  LEDGERS_PER_HOUR,
  type StoredWallet,
} from "@/lib/passkey";
import {
  requestRemoveContextRule,
  requestRenameContextRule,
  requestUpdateExpiration,
} from "@/lib/rule-management";
import { requestSubmitToRelayer } from "@/lib/policy-deploy";
import { loadPolicy, type SavedPolicy } from "@/lib/policy-store";
import RuleCard from "@/components/rules/RuleCard";

export const Route = createFileRoute("/rules")({ component: RulesManager });

function RulesManager() {
  // Wallet — loaded from localStorage, same pattern as policies.tsx
  const [wallet] = useState<StoredWallet | null>(() => {
    try {
      return loadWallet();
    } catch {
      return null;
    }
  });

  const [rules, setRules] = useState<ContextRuleInfo[]>([]);
  const [rulesLoading, setRulesLoading] = useState(false);
  const [latestLedger, setLatestLedger] = useState(0);
  const [policyMeta, setPolicyMeta] = useState<Map<string, SavedPolicy>>(
    new Map()
  );
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);

  // --- Fetch rules + ledger ---
  const fetchRules = useCallback(async (contractId: string) => {
    setRulesLoading(true);
    setError(null);
    try {
      const result = await requestContextRules(contractId);
      if (result.success) {
        setRules(result.rules);
      } else {
        setError(result.error || "Failed to fetch context rules");
      }
    } catch (err: any) {
      setError(err.message || "Failed to fetch context rules");
    } finally {
      setRulesLoading(false);
    }
  }, []);

  const fetchLatestLedger = useCallback(async () => {
    try {
      const { rpc } = await import("@stellar/stellar-sdk");
      const server = new rpc.Server(TESTNET_RPC_URL);
      const ledgerInfo = await server.getLatestLedger();
      setLatestLedger(ledgerInfo.sequence);
    } catch {
      /* best effort */
    }
  }, []);

  useEffect(() => {
    if (wallet) {
      fetchRules(wallet.contractId);
      fetchLatestLedger();
    }
  }, [wallet, fetchRules, fetchLatestLedger]);

  // --- Fetch KV policy metadata for all policy addresses ---
  useEffect(() => {
    const addresses = new Set(rules.flatMap((r) => r.policies));
    if (addresses.size === 0) return;

    (async () => {
      const metaMap = new Map<string, SavedPolicy>(policyMeta);
      for (const addr of addresses) {
        if (metaMap.has(addr)) continue; // don't re-fetch already loaded
        try {
          const meta = await loadPolicy({ data: { contractAddress: addr } });
          if (meta) metaMap.set(addr, meta);
        } catch {
          /* not all policies will have KV metadata */
        }
      }
      setPolicyMeta(metaMap);
    })();
  }, [rules]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Shared signing + submission flow ---
  async function executeManagementOp(
    actionKey: string,
    hostFuncXdr: string
  ): Promise<boolean> {
    if (!wallet) return false;
    setActionInProgress(actionKey);
    setStatus("");
    setError(null);

    try {
      const {
        xdr,
        Account,
        Keypair,
        TransactionBuilder,
        Operation,
        rpc: rpcModule,
      } = await import("@stellar/stellar-sdk");

      const server = new rpcModule.Server(TESTNET_RPC_URL);
      const hostFunc = xdr.HostFunction.fromXDR(hostFuncXdr, "base64");

      // Simulate
      setStatus("Simulating...");
      const simAccount = new Account(Keypair.random().publicKey(), "0");
      const simTx = new TransactionBuilder(simAccount, {
        fee: "1000000",
        networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
      })
        .addOperation(
          Operation.invokeHostFunction({ func: hostFunc, auth: [] })
        )
        .setTimeout(30)
        .build();

      const simResult = await server.simulateTransaction(simTx);
      if ("error" in simResult) {
        throw new Error(
          `Simulation failed: ${(simResult as any).error}`
        );
      }
      const simSuccess =
        simResult as import("@stellar/stellar-sdk/rpc").Api.SimulateTransactionSuccessResponse;

      const authEntries = simSuccess.result?.auth ?? [];
      const expiration = simSuccess.latestLedger + LEDGERS_PER_HOUR;
      setLatestLedger(simSuccess.latestLedger);

      // Sign with passkey (always uses rule 0 — the Default passkey rule)
      setStatus("Sign with your passkey...");
      const signedAuth = await signWalletAuthEntries({
        authEntries,
        wallet,
        contextRuleIds: [0],
        expiration,
      });

      // Submit via relayer
      setStatus("Submitting...");
      const relayerResult = await requestSubmitToRelayer({
        func: hostFunc.toXDR("base64"),
        auth: signedAuth.map((e) => e.toXDR("base64")),
      });
      if (!relayerResult.success) {
        throw new Error(relayerResult.error || "Relayer submission failed");
      }

      if (relayerResult.hash) {
        setStatus("Confirming...");
        await server.pollTransaction(relayerResult.hash, { attempts: 15 });
      }

      setStatus("");
      return true;
    } catch (err: any) {
      let msg = err.message || "Operation failed";
      if (msg.includes("timed out or was not allowed")) {
        msg =
          "Passkey signing was cancelled or timed out. Please try again.";
      }
      setError(msg);
      setStatus("");
      return false;
    } finally {
      setActionInProgress(null);
    }
  }

  // --- Action handlers ---
  const handleRename = async (ruleId: number, newName: string) => {
    if (!wallet) return;
    const result = await requestRenameContextRule({
      walletContractId: wallet.contractId,
      contextRuleId: ruleId,
      name: newName,
    });
    if (!result.success || !result.hostFuncXdr) {
      setError(result.error || "Failed to build rename transaction");
      return;
    }
    const ok = await executeManagementOp(`rename-${ruleId}`, result.hostFuncXdr);
    if (ok) await fetchRules(wallet.contractId);
  };

  const handleDelete = async (ruleId: number) => {
    if (!wallet) return;
    const result = await requestRemoveContextRule({
      walletContractId: wallet.contractId,
      contextRuleId: ruleId,
    });
    if (!result.success || !result.hostFuncXdr) {
      setError(result.error || "Failed to build remove transaction");
      return;
    }
    const ok = await executeManagementOp(`delete-${ruleId}`, result.hostFuncXdr);
    if (ok) await fetchRules(wallet.contractId);
  };

  const handleUpdateExpiration = async (
    ruleId: number,
    validUntil: number | null
  ) => {
    if (!wallet) return;
    const result = await requestUpdateExpiration({
      walletContractId: wallet.contractId,
      contextRuleId: ruleId,
      validUntil,
    });
    if (!result.success || !result.hostFuncXdr) {
      setError(result.error || "Failed to build update expiration transaction");
      return;
    }
    const ok = await executeManagementOp(
      `expiration-${ruleId}`,
      result.hostFuncXdr
    );
    if (ok) await fetchRules(wallet.contractId);
  };

  // --- No wallet state ---
  if (!wallet) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center px-4">
        <div className="text-center">
          <ListBullets
            size={48}
            weight="duotone"
            className="text-cyan-400 mx-auto mb-3"
          />
          <h1 className="text-2xl font-bold text-white mb-2">Context Rules</h1>
          <p className="text-gray-400">
            Create a wallet first to manage context rules.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-slate-800 to-slate-900 px-4 py-8">
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Header */}
        <div className="text-center mb-8">
          <ListBullets
            size={48}
            weight="duotone"
            className="text-cyan-400 mx-auto mb-3"
          />
          <h1 className="text-3xl font-bold text-white mb-2">Context Rules</h1>
          <p className="text-gray-400">
            View, rename, and delete signing rules on your smart wallet
          </p>
        </div>

        {/* Status / Error */}
        {status && (
          <div className="bg-slate-800/50 border border-slate-700 rounded-xl px-4 py-3">
            <p className="text-sm text-cyan-400 flex items-center gap-2">
              <Loader size="sm" />
              {status}
            </p>
          </div>
        )}
        {error && (
          <div className="bg-red-950/30 border border-red-800/40 rounded-xl px-4 py-3">
            <p className="text-sm text-red-400 flex items-center gap-2">
              <Warning size={16} />
              {error}
            </p>
            <button
              onClick={() => setError(null)}
              className="text-xs text-red-500 hover:text-red-300 mt-1 transition-colors"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Loading */}
        {rulesLoading && (
          <div className="flex items-center justify-center py-12">
            <Loader size="base" />
          </div>
        )}

        {/* Empty state */}
        {!rulesLoading && rules.length === 0 && (
          <div className="bg-slate-800/50 border border-slate-700 rounded-2xl p-8 text-center">
            <p className="text-gray-400">
              No context rules found on this wallet.
            </p>
            <p className="text-gray-500 text-sm mt-1">
              Create a policy via the Policy Builder to add your first rule.
            </p>
          </div>
        )}

        {/* Rule list */}
        {!rulesLoading &&
          rules.map((rule) => (
            <RuleCard
              key={rule.id}
              rule={rule}
              latestLedger={latestLedger}
              policyMeta={policyMeta}
              actionInProgress={actionInProgress}
              onRename={handleRename}
              onDelete={handleDelete}
              onUpdateExpiration={handleUpdateExpiration}
            />
          ))}

        {/* Ledger info */}
        {latestLedger > 0 && (
          <p className="text-xs text-gray-600 text-center">
            Current ledger: {latestLedger.toLocaleString()}
          </p>
        )}
      </div>
    </div>
  );
}
