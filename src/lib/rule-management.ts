import { createServerFn } from "@tanstack/react-start";
import { MAX_CONTEXT_RULE_NAME } from "./constants";

// --- Types ---

interface RemoveRuleInput {
  walletContractId: string;
  contextRuleId: number;
}

interface RenameRuleInput {
  walletContractId: string;
  contextRuleId: number;
  name: string;
}

interface UpdateExpirationInput {
  walletContractId: string;
  contextRuleId: number;
  /** Ledger sequence number, or null to remove expiration */
  validUntil: number | null;
}

type BuildTxResult = {
  success: boolean;
  error: string | null;
  hostFuncXdr: string | null;
};

// --- Validators ---

function validateRemoveInput(data: unknown): RemoveRuleInput {
  if (typeof data !== "object" || data === null) throw new Error("Invalid payload");
  const d = data as Record<string, unknown>;
  if (typeof d.walletContractId !== "string" || !d.walletContractId)
    throw new Error("walletContractId required");
  if (typeof d.contextRuleId !== "number" || d.contextRuleId < 0)
    throw new Error("contextRuleId must be a non-negative number");
  return { walletContractId: d.walletContractId, contextRuleId: d.contextRuleId };
}

function validateRenameInput(data: unknown): RenameRuleInput {
  if (typeof data !== "object" || data === null) throw new Error("Invalid payload");
  const d = data as Record<string, unknown>;
  if (typeof d.walletContractId !== "string" || !d.walletContractId)
    throw new Error("walletContractId required");
  if (typeof d.contextRuleId !== "number" || d.contextRuleId < 0)
    throw new Error("contextRuleId must be a non-negative number");
  if (typeof d.name !== "string" || !d.name)
    throw new Error("name required");
  if (d.name.length > MAX_CONTEXT_RULE_NAME)
    throw new Error(`name must be ${MAX_CONTEXT_RULE_NAME} characters or fewer`);
  return {
    walletContractId: d.walletContractId,
    contextRuleId: d.contextRuleId,
    name: d.name,
  };
}

function validateExpirationInput(data: unknown): UpdateExpirationInput {
  if (typeof data !== "object" || data === null) throw new Error("Invalid payload");
  const d = data as Record<string, unknown>;
  if (typeof d.walletContractId !== "string" || !d.walletContractId)
    throw new Error("walletContractId required");
  if (typeof d.contextRuleId !== "number" || d.contextRuleId < 0)
    throw new Error("contextRuleId must be a non-negative number");
  if (d.validUntil !== null && (typeof d.validUntil !== "number" || d.validUntil < 0))
    throw new Error("validUntil must be a non-negative number or null");
  return {
    walletContractId: d.walletContractId,
    contextRuleId: d.contextRuleId,
    validUntil: d.validUntil as number | null,
  };
}

// --- Server Functions ---

/**
 * Build a remove_context_rule invocation on the smart wallet.
 * Deletes the rule and uninstalls all its policies.
 */
export const buildRemoveContextRuleTx = createServerFn({ method: "POST" })
  .inputValidator(validateRemoveInput)
  .handler(async ({ data }): Promise<BuildTxResult> => {
    try {
      const { Address, xdr, nativeToScVal } = await import("@stellar/stellar-sdk");

      const hostFunc = xdr.HostFunction.hostFunctionTypeInvokeContract(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(data.walletContractId).toScAddress(),
          functionName: "remove_context_rule",
          args: [nativeToScVal(data.contextRuleId, { type: "u32" })],
        })
      );

      return { success: true, error: null, hostFuncXdr: hostFunc.toXDR("base64") };
    } catch (err: any) {
      return { success: false, error: err.message || "Failed to build remove tx", hostFuncXdr: null };
    }
  });

/**
 * Build an update_context_rule_name invocation on the smart wallet.
 */
export const buildRenameContextRuleTx = createServerFn({ method: "POST" })
  .inputValidator(validateRenameInput)
  .handler(async ({ data }): Promise<BuildTxResult> => {
    try {
      const { Address, xdr, nativeToScVal } = await import("@stellar/stellar-sdk");

      const hostFunc = xdr.HostFunction.hostFunctionTypeInvokeContract(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(data.walletContractId).toScAddress(),
          functionName: "update_context_rule_name",
          args: [
            nativeToScVal(data.contextRuleId, { type: "u32" }),
            nativeToScVal(data.name, { type: "string" }),
          ],
        })
      );

      return { success: true, error: null, hostFuncXdr: hostFunc.toXDR("base64") };
    } catch (err: any) {
      return { success: false, error: err.message || "Failed to build rename tx", hostFuncXdr: null };
    }
  });

/**
 * Build an update_context_rule_valid_until invocation on the smart wallet.
 * Pass validUntil: null to remove expiration (Option::None).
 */
export const buildUpdateExpirationTx = createServerFn({ method: "POST" })
  .inputValidator(validateExpirationInput)
  .handler(async ({ data }): Promise<BuildTxResult> => {
    try {
      const { Address, xdr, nativeToScVal } = await import("@stellar/stellar-sdk");

      // Encode Option<u32>: Some(ledger) or None (void)
      const validUntilScVal = data.validUntil !== null
        ? nativeToScVal(data.validUntil, { type: "u32" })
        : xdr.ScVal.scvVoid();

      const hostFunc = xdr.HostFunction.hostFunctionTypeInvokeContract(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(data.walletContractId).toScAddress(),
          functionName: "update_context_rule_valid_until",
          args: [
            nativeToScVal(data.contextRuleId, { type: "u32" }),
            validUntilScVal,
          ],
        })
      );

      return { success: true, error: null, hostFuncXdr: hostFunc.toXDR("base64") };
    } catch (err: any) {
      return { success: false, error: err.message || "Failed to build update expiration tx", hostFuncXdr: null };
    }
  });

// --- Client-side convenience wrappers ---

export async function requestRemoveContextRule(params: {
  walletContractId: string;
  contextRuleId: number;
}): Promise<BuildTxResult> {
  return buildRemoveContextRuleTx({ data: params });
}

export async function requestRenameContextRule(params: {
  walletContractId: string;
  contextRuleId: number;
  name: string;
}): Promise<BuildTxResult> {
  return buildRenameContextRuleTx({ data: params });
}

export async function requestUpdateExpiration(params: {
  walletContractId: string;
  contextRuleId: number;
  validUntil: number | null;
}): Promise<BuildTxResult> {
  return buildUpdateExpirationTx({ data: params });
}
