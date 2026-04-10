import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";

// --- Types ---

export interface DeployResult {
  success: boolean;
  error: string | null;
  wasmHash: string | null;
  contractAddress: string | null;
}

export interface InstallOnWalletResult {
  success: boolean;
  error: string | null;
  hash: string | null;
}

// --- Server Functions ---

interface DeployInput {
  wasmBase64: string;
}

function validateDeployInput(data: unknown): DeployInput {
  if (typeof data !== "object" || data === null) {
    throw new Error("Invalid payload");
  }
  const { wasmBase64 } = data as { wasmBase64?: unknown };
  if (typeof wasmBase64 !== "string" || wasmBase64.length === 0) {
    throw new Error("wasmBase64 is required");
  }
  // WASM files can be large but cap at 2MB base64 (~1.5MB binary)
  if (wasmBase64.length > 2_000_000) {
    throw new Error("WASM exceeds maximum size (2MB base64)");
  }
  return { wasmBase64 };
}

/**
 * Deploy a compiled policy WASM to Stellar Testnet.
 * 1. Upload WASM to get the hash
 * 2. Deploy a contract instance from the hash
 * Returns the contract address and WASM hash.
 */
export const deployPolicyWasm = createServerFn({ method: "POST" })
  .inputValidator(validateDeployInput)
  .handler(async ({ data }): Promise<DeployResult> => {
    const { wasmBase64 } = data;

    const sandbox = env.SANDBOX;

    if (!sandbox) {
      return {
        success: false,
        error: "Sandbox service not configured. Add SANDBOX service binding.",
        wasmHash: null,
        contractAddress: null,
      };
    }

    try {
      const response = await sandbox.fetch("https://sandbox/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wasmBase64 }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          success: false,
          error: `Deploy failed (${response.status}): ${errorText}`,
          wasmHash: null,
          contractAddress: null,
        };
      }

      const result = await response.json() as any;
      return {
        success: result.success ?? false,
        error: result.error ?? null,
        wasmHash: result.wasmHash ?? null,
        contractAddress: result.contractAddress ?? null,
      };
    } catch (err: any) {
      return {
        success: false,
        error: err.message || "Failed to reach sandbox service for deploy",
        wasmHash: null,
        contractAddress: null,
      };
    }
  });

// --- Install Policy on Smart Wallet ---

interface InstallInput {
  walletContractId: string;
  policyAddress: string;
  contextRuleId: number;
  installParamsXdr: string;
}

function validateInstallInput(data: unknown): InstallInput {
  if (typeof data !== "object" || data === null) {
    throw new Error("Invalid payload");
  }
  const d = data as Record<string, unknown>;
  if (typeof d.walletContractId !== "string" || !d.walletContractId) {
    throw new Error("walletContractId is required");
  }
  if (typeof d.policyAddress !== "string" || !d.policyAddress) {
    throw new Error("policyAddress is required");
  }
  if (typeof d.contextRuleId !== "number" || d.contextRuleId < 0) {
    throw new Error("contextRuleId must be a non-negative number");
  }
  if (typeof d.installParamsXdr !== "string") {
    throw new Error("installParamsXdr is required");
  }
  return {
    walletContractId: d.walletContractId as string,
    policyAddress: d.policyAddress as string,
    contextRuleId: d.contextRuleId as number,
    installParamsXdr: d.installParamsXdr as string,
  };
}

/**
 * Install a deployed policy contract on a user's smart wallet.
 * Calls add_policy on the smart account via the relayer.
 *
 * This builds the invocation but does NOT sign it — the caller must
 * handle passkey signing of the auth entries before submitting.
 * Returns the host function XDR for the caller to sign and submit.
 */
export const buildInstallPolicyTx = createServerFn({ method: "POST" })
  .inputValidator(validateInstallInput)
  .handler(async ({ data }): Promise<{
    success: boolean;
    error: string | null;
    hostFuncXdr: string | null;
  }> => {
    const { walletContractId, policyAddress, contextRuleId, installParamsXdr } = data;

    try {
      // Lazy-import heavy Stellar SDK deps to avoid `require` errors in Workers
      const { Address, xdr } = await import("@stellar/stellar-sdk");

      // Build the add_policy invocation on the smart wallet
      const hostFunc = xdr.HostFunction.hostFunctionTypeInvokeContract(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(walletContractId).toScAddress(),
          functionName: "add_policy",
          args: [
            // context_rule_id
            xdr.ScVal.scvU32(contextRuleId),
            // policy address
            xdr.ScVal.scvAddress(Address.fromString(policyAddress).toScAddress()),
            // install_params (encoded as ScVal by the caller)
            installParamsXdr
              ? xdr.ScVal.fromXDR(installParamsXdr, "base64")
              : xdr.ScVal.scvVoid(),
          ],
        })
      );

      return {
        success: true,
        error: null,
        hostFuncXdr: hostFunc.toXDR("base64"),
      };
    } catch (err: any) {
      return {
        success: false,
        error: err.message || "Failed to build install transaction",
        hostFuncXdr: null,
      };
    }
  });

// --- Create Context Rule with Policy ---

interface AddContextRuleInput {
  walletContractId: string;
  targetContractAddress: string;
  policyAddress: string;
  installParamsXdr: string;
  ephemeralSignerPublicKey: string;
  ruleName: string;
}

function validateAddContextRuleInput(data: unknown): AddContextRuleInput {
  if (typeof data !== "object" || data === null) throw new Error("Invalid payload");
  const d = data as Record<string, unknown>;
  if (typeof d.walletContractId !== "string" || !d.walletContractId) throw new Error("walletContractId required");
  if (typeof d.targetContractAddress !== "string" || !d.targetContractAddress) throw new Error("targetContractAddress required");
  if (typeof d.policyAddress !== "string" || !d.policyAddress) throw new Error("policyAddress required");
  if (typeof d.installParamsXdr !== "string") throw new Error("installParamsXdr required");
  if (typeof d.ephemeralSignerPublicKey !== "string" || !d.ephemeralSignerPublicKey) throw new Error("ephemeralSignerPublicKey required");
  if (typeof d.ruleName !== "string" || !d.ruleName) throw new Error("ruleName required");
  return d as unknown as AddContextRuleInput;
}

/**
 * Build an add_context_rule invocation that creates a new context rule
 * scoped to a target contract, with an ephemeral Delegated signer and a policy.
 * Returns the host function XDR for passkey signing and relayer submission.
 */
export const buildAddContextRuleTx = createServerFn({ method: "POST" })
  .inputValidator(validateAddContextRuleInput)
  .handler(async ({ data }): Promise<{
    success: boolean;
    error: string | null;
    hostFuncXdr: string | null;
  }> => {
    const { walletContractId, targetContractAddress, policyAddress, installParamsXdr, ephemeralSignerPublicKey, ruleName } = data;

    try {
      const { Address, xdr, nativeToScVal } = await import("@stellar/stellar-sdk");

      // context_type: CallContract(targetContractAddress)
      const contextType = xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol("CallContract"),
        xdr.ScVal.scvAddress(Address.fromString(targetContractAddress).toScAddress()),
      ]);

      // signers: [Delegated(ephemeralSignerPublicKey)]
      const signers = xdr.ScVal.scvVec([
        xdr.ScVal.scvVec([
          xdr.ScVal.scvSymbol("Delegated"),
          xdr.ScVal.scvAddress(Address.fromString(ephemeralSignerPublicKey).toScAddress()),
        ]),
      ]);

      // policies: Map<Address, Val> { policyAddress => installParams }
      const policyInstallParams = installParamsXdr
        ? xdr.ScVal.fromXDR(installParamsXdr, "base64")
        : xdr.ScVal.scvVoid();
      const policies = xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvAddress(Address.fromString(policyAddress).toScAddress()),
          val: policyInstallParams,
        }),
      ]);

      const hostFunc = xdr.HostFunction.hostFunctionTypeInvokeContract(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(walletContractId).toScAddress(),
          functionName: "add_context_rule",
          args: [
            contextType,
            nativeToScVal(ruleName, { type: "string" }),
            xdr.ScVal.scvVoid(), // valid_until: None
            signers,
            policies,
          ],
        })
      );

      return { success: true, error: null, hostFuncXdr: hostFunc.toXDR("base64") };
    } catch (err: any) {
      return { success: false, error: err.message || "Failed to build add_context_rule tx", hostFuncXdr: null };
    }
  });

// --- Build Policy-scoped Execute Transaction ---

interface PolicyExecuteInput {
  walletContractId: string;
  targetContractAddress: string;
  functionName: string;
  argsXdr: string; // base64 XDR of ScVal (Vec<Val>)
}

function validatePolicyExecuteInput(data: unknown): PolicyExecuteInput {
  if (typeof data !== "object" || data === null) throw new Error("Invalid payload");
  const d = data as Record<string, unknown>;
  if (typeof d.walletContractId !== "string" || !d.walletContractId) throw new Error("walletContractId required");
  if (typeof d.targetContractAddress !== "string" || !d.targetContractAddress) throw new Error("targetContractAddress required");
  if (typeof d.functionName !== "string" || !d.functionName) throw new Error("functionName required");
  if (typeof d.argsXdr !== "string") throw new Error("argsXdr required");
  return d as unknown as PolicyExecuteInput;
}

/**
 * Build an execute() invocation on the smart wallet for a specific target
 * contract + function. This is the same pattern used by handleTransfer in
 * useWallet, but generic for any contract call that a policy might scope.
 */
export const buildPolicyExecuteTx = createServerFn({ method: "POST" })
  .inputValidator(validatePolicyExecuteInput)
  .handler(async ({ data }): Promise<{
    success: boolean;
    error: string | null;
    hostFuncXdr: string | null;
  }> => {
    const { walletContractId, targetContractAddress, functionName, argsXdr } = data;

    try {
      const { Address, xdr } = await import("@stellar/stellar-sdk");

      const hostFunc = xdr.HostFunction.hostFunctionTypeInvokeContract(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(walletContractId).toScAddress(),
          functionName: "execute",
          args: [
            xdr.ScVal.scvAddress(Address.fromString(targetContractAddress).toScAddress()),
            xdr.ScVal.scvSymbol(functionName),
            argsXdr
              ? xdr.ScVal.fromXDR(argsXdr, "base64")
              : xdr.ScVal.scvVec([]),
          ],
        })
      );

      return { success: true, error: null, hostFuncXdr: hostFunc.toXDR("base64") };
    } catch (err: any) {
      return { success: false, error: err.message || "Failed to build execute tx", hostFuncXdr: null };
    }
  });

// --- Client-side convenience ---

export async function requestDeploy(wasmBase64: string): Promise<DeployResult> {
  return deployPolicyWasm({ data: { wasmBase64 } });
}

export async function requestBuildInstallTx(params: {
  walletContractId: string;
  policyAddress: string;
  contextRuleId: number;
  installParamsXdr: string;
}): Promise<{ success: boolean; error: string | null; hostFuncXdr: string | null }> {
  return buildInstallPolicyTx({ data: params });
}

export async function requestAddContextRule(params: {
  walletContractId: string;
  targetContractAddress: string;
  policyAddress: string;
  installParamsXdr: string;
  ephemeralSignerPublicKey: string;
  ruleName: string;
}): Promise<{ success: boolean; error: string | null; hostFuncXdr: string | null }> {
  return buildAddContextRuleTx({ data: params });
}

export async function requestBuildExecuteTx(params: {
  walletContractId: string;
  targetContractAddress: string;
  functionName: string;
  argsXdr: string;
}): Promise<{ success: boolean; error: string | null; hostFuncXdr: string | null }> {
  return buildPolicyExecuteTx({ data: params });
}
