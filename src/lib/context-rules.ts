import { TESTNET_RPC_URL, TESTNET_NETWORK_PASSPHRASE } from "./constants";

// --- Types ---

export interface ContextRuleInfo {
  id: number;
  name: string;
  contextType: "Default" | "CallContract" | "CreateContract";
  targetContract?: string;
  signers: Array<{ type: "Delegated" | "External"; address: string; keyData?: Uint8Array }>;
  signerIds: number[];
  policies: string[];
  policyIds: number[];
  validUntil?: number;
}

// --- Client-side Context Rule Fetching ---
// This runs entirely client-side (read-only RPC simulation).
// No server function needed — avoids Workers SDK import issues.

import {
  Contract,
  TransactionBuilder,
  Keypair,
  Account,
  scValToNative,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import { rpc } from "@stellar/stellar-sdk";

export async function requestContextRules(walletContractId: string): Promise<{
  success: boolean;
  error: string | null;
  rules: ContextRuleInfo[];
}> {
  try {
    const server = new rpc.Server(TESTNET_RPC_URL);
    const contract = new Contract(walletContractId);

    async function simulateCall(funcName: string, args: any[] = []) {
      const account = new Account(Keypair.random().publicKey(), "0");
      const tx = new TransactionBuilder(account, {
        fee: "100",
        networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
      })
        .addOperation(contract.call(funcName, ...args))
        .setTimeout(30)
        .build();

      const sim = await server.simulateTransaction(tx);
      if ("error" in sim) throw new Error(`Simulation failed: ${(sim as any).error}`);
      const success = sim as any;
      return success.result?.retval ? scValToNative(success.result.retval) : null;
    }

    const count = await simulateCall("get_context_rules_count");
    const ruleCount = typeof count === "number" ? count : Number(count ?? 0);

    if (ruleCount === 0) {
      return { success: true, error: null, rules: [] };
    }

    const rules: ContextRuleInfo[] = [];

    // Rule IDs are monotonically incrementing and never reused after deletion,
    // so there can be gaps. Scan until we've found all `ruleCount` active rules.
    const maxScan = ruleCount * 5; // generous upper bound to handle sparse IDs
    for (let id = 0; rules.length < ruleCount && id < maxScan; id++) {
      try {
        const rule = await simulateCall("get_context_rule", [nativeToScVal(id, { type: "u32" })]);
        if (!rule) continue;

        let contextType: ContextRuleInfo["contextType"] = "Default";
        let targetContract: string | undefined;

        if (Array.isArray(rule.context_type)) {
          const [tag, value] = rule.context_type;
          if (tag === "CallContract") {
            contextType = "CallContract";
            targetContract = typeof value === "string" ? value : undefined;
          } else if (tag === "CreateContract") {
            contextType = "CreateContract";
          }
        }

        const signers = (rule.signers ?? []).map((s: any) => {
          if (Array.isArray(s)) {
            const [tag, addr, keyData] = s;
            return {
              type: tag as "Delegated" | "External",
              address: typeof addr === "string" ? addr : "",
              keyData: keyData instanceof Uint8Array ? keyData
                : (keyData?.type === "Buffer" && Array.isArray(keyData.data))
                  ? new Uint8Array(keyData.data)
                  : undefined,
            };
          }
          return { type: "Delegated" as const, address: "" };
        });

        const policies = (rule.policies ?? []).map((p: any) =>
          typeof p === "string" ? p : ""
        ).filter(Boolean);

        const signerIds = (rule.signer_ids ?? []).map((id: any) => Number(id));
        const policyIds = (rule.policy_ids ?? []).map((id: any) => Number(id));

        rules.push({
          id: typeof rule.id === "number" ? rule.id : Number(rule.id ?? id),
          name: rule.name ?? `Rule ${id}`,
          contextType,
          targetContract,
          signers,
          signerIds,
          policies,
          policyIds,
          validUntil: rule.valid_until != null ? Number(rule.valid_until) : undefined,
        });
      } catch {
        // Skip rules that fail to fetch (may have been removed)
      }
    }

    return { success: true, error: null, rules };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to fetch context rules", rules: [] };
  }
}
