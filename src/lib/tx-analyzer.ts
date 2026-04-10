import { xdr, Address, scValToNative } from "@stellar/stellar-sdk";
import { rpc } from "@stellar/stellar-sdk";
import { TESTNET_RPC_URL } from "./constants";

// --- Types ---

export interface InvocationNode {
  contractAddress: string;
  functionName: string;
  args: { type: string; value: string }[];
  /** Nested calls that require authorization from this address */
  subInvocations: InvocationNode[];
}

export interface TxPattern {
  contractAddress: string;
  functionName: string;
  args: { type: string; value: string }[];
  signers: { type: "Delegated" | "External"; identity: string }[];
  /** The full authorization invocation tree from the auth entry */
  invocationTree?: InvocationNode;
  /** If this is an execute() call, decomposed inner call details */
  innerCall?: {
    targetContract: string;
    functionName: string;
    args: { type: string; value: string }[];
  };
}

export interface TxAnalysis {
  hash: string;
  ledger: number;
  timestamp: number;
  patterns: TxPattern[];
}

// --- Public API ---

const server = new rpc.Server(TESTNET_RPC_URL);

/**
 * Fetch a transaction by hash from Stellar testnet RPC and extract policy-relevant patterns.
 */
export async function analyzeTransaction(hash: string): Promise<TxAnalysis> {
  const response = await server.getTransaction(hash);

  if (response.status === "NOT_FOUND") {
    throw new Error(`Transaction not found: ${hash}`);
  }

  if (response.status === "FAILED") {
    throw new Error(`Transaction failed: ${hash}`);
  }

  const envelope = response.envelopeXdr;
  const patterns = extractPatterns(envelope);

  return {
    hash,
    ledger: response.ledger,
    timestamp: response.createdAt,
    patterns,
  };
}

// --- Internal extraction ---

function extractPatterns(envelope: xdr.TransactionEnvelope): TxPattern[] {
  const patterns: TxPattern[] = [];

  // Handle both regular and fee-bump envelopes
  let tx: xdr.Transaction;
  const envelopeType = envelope.switch().name;
  if (envelopeType === "envelopeTypeTx") {
    tx = envelope.v1().tx();
  } else if (envelopeType === "envelopeTypeTxFeeBump") {
    tx = envelope.feeBump().tx().innerTx().v1().tx();
  } else {
    throw new Error(`Unsupported envelope type: ${envelopeType}`);
  }

  const operations = tx.operations();

  for (const op of operations) {
    const body = op.body();
    if (body.switch().name !== "invokeHostFunction") continue;

    const invokeOp = body.value() as xdr.InvokeHostFunctionOp;
    const hostFn = invokeOp.hostFunction();
    if (hostFn.switch().name !== "hostFunctionTypeInvokeContract") continue;

    const invokeArgs = hostFn.invokeContract();
    const contractAddress = Address.fromScAddress(invokeArgs.contractAddress()).toString();
    const functionName = invokeArgs.functionName().toString();
    const args = invokeArgs.args().map(scValToArg);

    // Extract signers from auth entries
    const authEntries = invokeOp.auth();
    const signers = extractSigners(authEntries);

    // Extract invocation tree from auth entries
    let invocationTree: InvocationNode | undefined;
    for (const entry of authEntries) {
      const credSwitch = entry.credentials().switch().name;
      if (credSwitch === "sorobanCredentialsAddress") {
        const rootInvocation = entry.rootInvocation();
        invocationTree = extractInvocationTree(rootInvocation);
        break; // Use the first address-credentialed auth entry's tree
      }
    }

    // Decompose execute() args if applicable
    let innerCall: TxPattern["innerCall"];
    if (functionName === "execute" && args.length >= 3) {
      const rawArgs = invokeArgs.args();
      if (
        rawArgs[0].switch().name === "scvAddress" &&
        (rawArgs[1].switch().name === "scvSymbol" || rawArgs[1].switch().name === "scvString")
      ) {
        const targetContract = Address.fromScAddress(rawArgs[0].address()).toString();
        const innerFnName = rawArgs[1].switch().name === "scvSymbol"
          ? rawArgs[1].sym().toString()
          : rawArgs[1].str().toString();

        let innerArgs: { type: string; value: string }[] = [];
        if (rawArgs[2].switch().name === "scvVec") {
          const vec = rawArgs[2].vec();
          if (vec) {
            innerArgs = vec.map(scValToArg);
          }
        }

        innerCall = {
          targetContract,
          functionName: innerFnName,
          args: innerArgs,
        };
      }
    }

    patterns.push({
      contractAddress,
      functionName,
      args,
      signers,
      invocationTree,
      innerCall,
    });
  }

  return patterns;
}

function scValToArg(val: xdr.ScVal): { type: string; value: string } {
  const typeName = val.switch().name;

  switch (typeName) {
    case "scvAddress": {
      const addr = Address.fromScAddress(val.address());
      return { type: "Address", value: addr.toString() };
    }
    case "scvI128": {
      const parts = val.i128();
      const lo = BigInt(parts.lo().toString());
      const hi = BigInt(parts.hi().toString());
      const value = (hi << 64n) | lo;
      return { type: "i128", value: value.toString() };
    }
    case "scvU64":
      return { type: "u64", value: val.u64().toString() };
    case "scvI64":
      return { type: "i64", value: val.i64().toString() };
    case "scvU32":
      return { type: "u32", value: val.u32().toString() };
    case "scvI32":
      return { type: "i32", value: val.i32().toString() };
    case "scvBool":
      return { type: "bool", value: val.b().toString() };
    case "scvString":
      return { type: "string", value: val.str().toString() };
    case "scvSymbol":
      return { type: "symbol", value: val.sym().toString() };
    case "scvBytes":
      return { type: "bytes", value: Buffer.from(val.bytes()).toString("hex") };
    case "scvVec": {
      // For nested vecs (e.g. execute() args), try to extract native
      try {
        const native = scValToNative(val);
        return { type: "vec", value: JSON.stringify(native, (_k, v) => typeof v === "bigint" ? v.toString() : v) };
      } catch {
        return { type: "vec", value: `[${val.vec()?.length ?? 0} elements]` };
      }
    }
    case "scvMap": {
      try {
        const native = scValToNative(val);
        return { type: "map", value: JSON.stringify(native, (_k, v) => typeof v === "bigint" ? v.toString() : v) };
      } catch {
        return { type: "map", value: `{${val.map()?.length ?? 0} entries}` };
      }
    }
    default:
      return { type: typeName.replace("scv", "").toLowerCase(), value: "[complex]" };
  }
}

/**
 * Recursively extract the invocation tree from a SorobanAuthorizedInvocation.
 */
function extractInvocationTree(
  invocation: xdr.SorobanAuthorizedInvocation
): InvocationNode {
  const authorizedFn = invocation.function();
  let contractAddress = "";
  let functionName = "";
  let args: { type: string; value: string }[] = [];

  if (authorizedFn.switch().name === "sorobanAuthorizedFunctionTypeContractFn") {
    const contractFn = authorizedFn.contractFn();
    contractAddress = Address.fromScAddress(contractFn.contractAddress()).toString();
    functionName = contractFn.functionName().toString();
    args = contractFn.args().map(scValToArg);
  }
  // sorobanAuthorizedFunctionTypeCreateContractHostFn — leave fields as defaults

  const subInvocations = invocation
    .subInvocations()
    .map((sub) => extractInvocationTree(sub));

  return {
    contractAddress,
    functionName,
    args,
    subInvocations,
  };
}

/**
 * Extract signer information from Soroban auth entries.
 */
function extractSigners(
  authEntries: xdr.SorobanAuthorizationEntry[]
): { type: "Delegated" | "External"; identity: string }[] {
  const signers: { type: "Delegated" | "External"; identity: string }[] = [];

  for (const entry of authEntries) {
    const credSwitch = entry.credentials().switch().name;

    if (credSwitch === "sorobanCredentialsAddress") {
      const cred = entry.credentials().address();
      const address = Address.fromScAddress(cred.address()).toString();

      // Check if the signature contains our AuthPayload structure (External signer)
      const sig = cred.signature();
      if (sig.switch().name === "scvMap") {
        const map = sig.map();
        if (map) {
          // Look for "signers" key in the map — indicates smart account auth payload
          const hasSignersKey = map.some(
            (e) => e.key().switch().name === "scvSymbol" && e.key().sym().toString() === "signers"
          );
          if (hasSignersKey) {
            signers.push({ type: "External", identity: address });
            continue;
          }
        }
      }

      // Standard Stellar account address credential
      signers.push({ type: "Delegated", identity: address });
    }
  }

  return signers;
}

/**
 * Summarize a TxPattern for display in the UI.
 */
export function summarizePattern(pattern: TxPattern): string {
  const fnLabel = pattern.innerCall
    ? `execute() → ${pattern.innerCall.functionName}() on ${pattern.innerCall.targetContract.slice(0, 8)}...${pattern.innerCall.targetContract.slice(-4)}`
    : `${pattern.functionName}()`;

  const parts = [
    fnLabel,
    `on ${pattern.contractAddress.slice(0, 8)}...${pattern.contractAddress.slice(-4)}`,
  ];

  if (pattern.args.length > 0) {
    const argsSummary = pattern.args.map((a, i) => `arg${i}:${a.type}`).join(", ");
    parts.push(`args: [${argsSummary}]`);
  }

  if (pattern.signers.length > 0) {
    parts.push(`${pattern.signers.length} signer(s)`);
  }

  return parts.join(" | ");
}
