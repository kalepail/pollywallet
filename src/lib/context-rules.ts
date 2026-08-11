import { MAX_U32, TESTNET_RPC_URL, TESTNET_NETWORK_PASSPHRASE } from "./constants";

// --- Types ---

export interface ContextRuleInfo {
  id: number;
  name: string;
  contextType: "Default" | "CallContract" | "CreateContract";
  targetContract?: string;
  wasmHash?: string;
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
  contract,
  scValToNative,
} from "@stellar/stellar-sdk";
import { rpc } from "@stellar/stellar-sdk";

interface WalletReadClient {
  get_context_rules_count: () => Promise<contract.AssembledTransaction<number | bigint>>;
  get_context_rule: (args: {
    context_rule_id: number;
  }) => Promise<contract.AssembledTransaction<any>>;
}

export async function requestContextRules(walletContractId: string): Promise<{
  success: boolean;
  error: string | null;
  rules: ContextRuleInfo[];
}> {
  try {
    const server = new rpc.Server(TESTNET_RPC_URL);
    const client = await contract.Client.from<WalletReadClient>({
      contractId: walletContractId,
      rpcUrl: TESTNET_RPC_URL,
      networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
      server,
    });

    const count = (await client.get_context_rules_count()).result;
    const ruleCount = Number(count);

    if (
      (typeof count !== "number" && typeof count !== "bigint") ||
      !Number.isSafeInteger(ruleCount) ||
      ruleCount < 0 ||
      ruleCount > MAX_U32
    ) {
      throw new Error("Contract returned an invalid context rule count");
    }

    if (ruleCount === 0) {
      return { success: true, error: null, rules: [] };
    }

    const nextIdEntry = (await server.getContractInstance(walletContractId))
      .storage()
      ?.find((entry) => {
        const key = scValToNative(entry.key());
        return Array.isArray(key) && key.length === 1 && key[0] === "NextId";
      });
    const nextIdValue = nextIdEntry && scValToNative(nextIdEntry.val());
    const nextId = Number(nextIdValue);

    if (
      (typeof nextIdValue !== "number" && typeof nextIdValue !== "bigint") ||
      !Number.isSafeInteger(nextId) ||
      nextId < ruleCount ||
      nextId > MAX_U32
    ) {
      throw new Error("Contract returned an invalid next context rule ID");
    }

    const rules: ContextRuleInfo[] = [];

    // Rule IDs are monotonically incrementing and never reused after deletion,
    // so scan the contract's actual NextId range rather than guessing from count.
    for (let id = 0; rules.length < ruleCount && id < nextId; id++) {
      try {
        const rule = (await client.get_context_rule({ context_rule_id: id })).result;
        if (!rule) continue;

        let contextType: ContextRuleInfo["contextType"] = "Default";
        let targetContract: string | undefined;
        let wasmHash: string | undefined;

        if (Array.isArray(rule.context_type)) {
          const [tag, value] = rule.context_type;
          if (tag === "CallContract") {
            contextType = "CallContract";
            targetContract = typeof value === "string" ? value : undefined;
          } else if (tag === "CreateContract") {
            contextType = "CreateContract";
            const bytes: ArrayLike<number> | undefined = ArrayBuffer.isView(value) ? value
              : (value?.type === "Buffer" && Array.isArray(value.data)) ? value.data
                : undefined;
            wasmHash = bytes
              ? Array.from(bytes, (byte: number) => byte.toString(16).padStart(2, "0")).join("")
              : undefined;
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
          wasmHash,
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

    if (rules.length !== ruleCount) {
      throw new Error(`Expected ${ruleCount} context rules but found ${rules.length}`);
    }

    return { success: true, error: null, rules };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to fetch context rules", rules: [] };
  }
}
