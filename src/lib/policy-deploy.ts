import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { MAX_XDR_LENGTH, MAX_AUTH_ENTRIES } from "./relayer";

// --- Types ---

export interface DeployResult {
  success: boolean;
  error: string | null;
  wasmHash: string | null;
  contractAddress: string | null;
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
  let wasm: string;
  try {
    wasm = atob(wasmBase64);
  } catch {
    throw new Error("wasmBase64 must be valid base64");
  }
  if (!wasm.startsWith("\0asm\x01\0\0\0")) {
    throw new Error("wasmBase64 must encode a WebAssembly module");
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
  if ((d.ruleName as string).length > 20) throw new Error("ruleName must be 20 characters or fewer (MAX_NAME_SIZE)");
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
      const { Address, StrKey, xdr, nativeToScVal } = await import("@stellar/stellar-sdk");
      const { TESTNET_ED25519_VERIFIER } = await import("./passkey");

      // context_type: CallContract(targetContractAddress)
      const contextType = xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol("CallContract"),
        xdr.ScVal.scvAddress(Address.fromString(targetContractAddress).toScAddress()),
      ]);

      // signers: [External(ed25519_verifier, raw_public_key)]
      // Uses External signer with an ed25519 verifier contract instead of Delegated,
      // so the ephemeral keypair doesn't need to exist as a funded Stellar account.
      const rawPubkey = StrKey.decodeEd25519PublicKey(ephemeralSignerPublicKey);
      const signers = xdr.ScVal.scvVec([
        xdr.ScVal.scvVec([
          xdr.ScVal.scvSymbol("External"),
          xdr.ScVal.scvAddress(Address.fromString(TESTNET_ED25519_VERIFIER).toScAddress()),
          xdr.ScVal.scvBytes(Buffer.from(rawPubkey)),
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

// --- Submit to Relayer (server function wrapper) ---
// This wraps the relayer call so route files don't need to import
// relayer.ts directly (which has heavy server-only dependencies that
// cause issues when imported in TanStack Start route files).

interface RelayerSubmitInput {
  func: string;
  auth: string[];
}

function validateRelayerSubmitInput(data: unknown): RelayerSubmitInput {
  if (typeof data !== "object" || data === null) throw new Error("Invalid payload");
  const d = data as Record<string, unknown>;
  if (typeof d.func !== "string" || !d.func) throw new Error("func required");
  if (d.func.length > MAX_XDR_LENGTH) {
    throw new Error("Invalid func: must be under 100KB");
  }
  if (
    !Array.isArray(d.auth) ||
    d.auth.length > MAX_AUTH_ENTRIES ||
    !d.auth.every((a) => typeof a === "string" && a.length <= MAX_XDR_LENGTH)
  ) {
    throw new Error(`Invalid auth: must be an array of up to ${MAX_AUTH_ENTRIES} strings under 100KB each`);
  }
  return { func: d.func as string, auth: d.auth as string[] };
}

export const submitPolicyTransaction = createServerFn({ method: "POST" })
  .inputValidator(validateRelayerSubmitInput)
  .handler(async ({ data }): Promise<{
    success: boolean;
    error: string | null;
    hash: string | null;
  }> => {
    try {
      // Lazy import to keep relayer deps server-only
      const { ChannelsClient } = await import("@openzeppelin/relayer-plugin-channels");

      const baseUrl = (globalThis as any).CHANNELS_BASE_URL
        || (typeof process !== "undefined" ? process.env?.CHANNELS_BASE_URL : undefined)
        || "https://channels.openzeppelin.com/testnet";
      const apiKey = (globalThis as any).CHANNELS_API_KEY
        || (typeof process !== "undefined" ? process.env?.CHANNELS_API_KEY : undefined);

      if (!apiKey) {
        return { success: false, error: "Relayer not configured (no API key)", hash: null };
      }

      const client = new ChannelsClient({ baseUrl, apiKey });
      const result = await client.submitSorobanTransaction({ func: data.func, auth: data.auth });

      return { success: true, error: null, hash: result.hash ?? null };
    } catch (err: any) {
      return { success: false, error: err.message || "Relayer request failed", hash: null };
    }
  });

// --- Client-side convenience ---

export async function requestSubmitToRelayer(params: {
  func: string;
  auth: string[];
}): Promise<{ success: boolean; error: string | null; hash: string | null }> {
  return submitPolicyTransaction({ data: params });
}

export async function requestDeploy(wasmBase64: string): Promise<DeployResult> {
  return deployPolicyWasm({ data: { wasmBase64 } });
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
