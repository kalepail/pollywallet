import { createServerFn } from "@tanstack/react-start";
import { TESTNET_RPC_URL, TESTNET_NETWORK_PASSPHRASE } from "./constants";

// --- Types ---

export interface ContextRuleInfo {
  id: number;
  name: string;
  contextType: "Default" | "CallContract" | "CreateContract";
  targetContract?: string;
  signers: Array<{ type: "Delegated" | "External"; address: string }>;
  policies: string[];
  validUntil?: number;
}

// --- Server Function: Fetch Context Rules ---

interface FetchRulesInput {
  walletContractId: string;
}

function validateFetchRulesInput(data: unknown): FetchRulesInput {
  if (typeof data !== "object" || data === null) throw new Error("Invalid payload");
  const d = data as Record<string, unknown>;
  if (typeof d.walletContractId !== "string" || !d.walletContractId) throw new Error("walletContractId required");
  return { walletContractId: d.walletContractId as string };
}

/**
 * Fetch all context rules from a smart wallet contract.
 * Calls get_context_rules_count() then get_context_rule(id) for each.
 */
export const fetchContextRules = createServerFn({ method: "POST" })
  .inputValidator(validateFetchRulesInput)
  .handler(async ({ data }): Promise<{
    success: boolean;
    error: string | null;
    rules: ContextRuleInfo[];
  }> => {
    const { walletContractId } = data;

    try {
      const { Contract, TransactionBuilder, Keypair, Account, scValToNative, Address } = await import("@stellar/stellar-sdk");
      const { Server } = await import("@stellar/stellar-sdk/rpc");

      const server = new Server(TESTNET_RPC_URL);
      const contract = new Contract(walletContractId);

      // Helper: simulate a read-only call
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

      // Get count
      const count = await simulateCall("get_context_rules_count");
      const ruleCount = typeof count === "number" ? count : Number(count ?? 0);

      if (ruleCount === 0) {
        return { success: true, error: null, rules: [] };
      }

      // Fetch each rule (IDs start at 0)
      const { nativeToScVal } = await import("@stellar/stellar-sdk");
      const rules: ContextRuleInfo[] = [];

      for (let id = 0; id < ruleCount; id++) {
        try {
          const rule = await simulateCall("get_context_rule", [nativeToScVal(id, { type: "u32" })]);
          if (!rule) continue;

          // Parse the context type
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

          // Parse signers
          const signers = (rule.signers ?? []).map((s: any) => {
            if (Array.isArray(s)) {
              const [tag, addr] = s;
              return {
                type: tag as "Delegated" | "External",
                address: typeof addr === "string" ? addr : "",
              };
            }
            return { type: "Delegated" as const, address: "" };
          });

          // Parse policies
          const policies = (rule.policies ?? []).map((p: any) =>
            typeof p === "string" ? p : ""
          ).filter(Boolean);

          rules.push({
            id: typeof rule.id === "number" ? rule.id : Number(rule.id ?? id),
            name: rule.name ?? `Rule ${id}`,
            contextType,
            targetContract,
            signers,
            policies,
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
  });

// --- Client-side convenience ---

export async function requestContextRules(walletContractId: string): Promise<{
  success: boolean;
  error: string | null;
  rules: ContextRuleInfo[];
}> {
  return fetchContextRules({ data: { walletContractId } });
}
