import { createServerFn } from "@tanstack/react-start";
import { xdr, Address, contract } from "@stellar/stellar-sdk";
import { TESTNET_RPC_URL } from "./constants";

// --- Types ---

export interface ContractSpec {
  address: string;
  functions: SpecFunction[];
  customTypes: SpecCustomType[];
}

export interface SpecFunction {
  name: string;
  doc?: string;
  inputs: { name: string; type: string }[];
  outputs: string[];
}

export interface SpecCustomType {
  name: string;
  kind: "struct" | "enum";
  fields?: { name: string; type: string }[];
  variants?: { name: string; values?: string[] }[];
}

// --- RPC Helper ---

async function rpcRequest(method: string, params: Record<string, unknown>): Promise<any> {
  const response = await fetch(TESTNET_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await response.json() as any;
  if (json.error) {
    throw new Error(`RPC error: ${json.error.message ?? JSON.stringify(json.error)}`);
  }
  return json.result;
}

async function getLedgerEntries(keys: xdr.LedgerKey[]): Promise<any[]> {
  const result = await rpcRequest("getLedgerEntries", {
    keys: keys.map((k) => k.toXDR("base64")),
  });
  return result?.entries ?? [];
}

// --- WASM Custom Section Extraction ---

/**
 * Extract all custom sections with the given name from a WASM binary.
 * Ported from stellar-error-mcp/src/contracts.ts
 */
function extractWasmCustomSections(wasm: Uint8Array, sectionName: string): Uint8Array[] {
  const matches: Uint8Array[] = [];
  if (wasm.length < 8) return matches;
  // Verify WASM magic: \0asm
  if (wasm[0] !== 0 || wasm[1] !== 0x61 || wasm[2] !== 0x73 || wasm[3] !== 0x6d) {
    return matches;
  }

  let offset = 8; // Skip magic + version

  while (offset < wasm.length) {
    const sectionId = wasm[offset++];
    const { value: size, bytesRead } = readLEB128(wasm, offset);
    offset += bytesRead;
    const sectionEnd = offset + size;

    if (sectionId === 0) {
      // Custom section — read name
      const { value: nameLen, bytesRead: nb } = readLEB128(wasm, offset);
      const nameStart = offset + nb;
      const name = new TextDecoder().decode(wasm.slice(nameStart, nameStart + nameLen));
      if (name === sectionName) {
        matches.push(wasm.slice(nameStart + nameLen, sectionEnd));
      }
    }

    offset = sectionEnd;
  }

  return matches;
}

function readLEB128(bytes: Uint8Array, offset: number): { value: number; bytesRead: number } {
  let result = 0;
  let shift = 0;
  let bytesRead = 0;

  while (offset < bytes.length) {
    const byte = bytes[offset++];
    bytesRead++;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }

  return { value: result, bytesRead };
}

// --- Recursive Type Descriptor ---

/**
 * Convert a spec type XDR object to a human-readable type string.
 * Ported from stellar-error-mcp/src/contracts.ts
 */
function describeSpecType(t: any): string {
  try {
    const name = t.switch().name;

    const simpleTypes: Record<string, string> = {
      scSpecTypeVal: "val",
      scSpecTypeBool: "bool",
      scSpecTypeVoid: "void",
      scSpecTypeError: "error",
      scSpecTypeU32: "u32",
      scSpecTypeI32: "i32",
      scSpecTypeU64: "u64",
      scSpecTypeI64: "i64",
      scSpecTypeTimepoint: "timepoint",
      scSpecTypeDuration: "duration",
      scSpecTypeU128: "u128",
      scSpecTypeI128: "i128",
      scSpecTypeU256: "u256",
      scSpecTypeI256: "i256",
      scSpecTypeBytes: "bytes",
      scSpecTypeString: "string",
      scSpecTypeSymbol: "symbol",
      scSpecTypeAddress: "address",
    };
    if (name in simpleTypes) return simpleTypes[name];

    switch (name) {
      case "scSpecTypeBytesN": {
        const n = t.value?.()?.n?.();
        return `bytes<${typeof n === "number" ? n : "N"}>`;
      }
      case "scSpecTypeOption": {
        const inner = t.value?.()?.valueType?.() ?? t.value?.();
        return `Option<${inner ? describeSpecType(inner) : "?"}>`;
      }
      case "scSpecTypeVec": {
        const elem = t.value?.()?.elementType?.() ?? t.value?.();
        return `Vec<${elem ? describeSpecType(elem) : "?"}>`;
      }
      case "scSpecTypeResult": {
        const ok = t.value?.()?.okType?.();
        const err = t.value?.()?.errorType?.();
        return `Result<${ok ? describeSpecType(ok) : "?"}, ${err ? describeSpecType(err) : "?"}>`;
      }
      case "scSpecTypeMap": {
        const kType = t.value?.()?.keyType?.();
        const vType = t.value?.()?.valueType?.();
        return `Map<${kType ? describeSpecType(kType) : "?"}, ${vType ? describeSpecType(vType) : "?"}>`;
      }
      case "scSpecTypeTuple": {
        const types = t.value?.()?.valueTypes?.() ?? [];
        return `(${types.map((tt: any) => describeSpecType(tt)).join(", ")})`;
      }
      case "scSpecTypeUdt": {
        const udtName = t.value?.()?.name?.();
        if (udtName && typeof udtName.toString === "function") return udtName.toString();
        return "UDT";
      }
      default:
        return name;
    }
  } catch {
    return "unknown";
  }
}

// --- Core Spec Extraction ---

/**
 * Fetch a contract's WASM from Stellar RPC and extract its spec.
 * Returns function signatures, custom types, and documentation.
 */
async function extractContractSpec(contractAddress: string): Promise<ContractSpec> {
  // Step 1: Fetch contract instance to get WASM hash
  const instanceKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(contractAddress).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );

  const instanceEntries = await getLedgerEntries([instanceKey]);
  if (instanceEntries.length === 0) {
    throw new Error(`Contract not found: ${contractAddress}`);
  }

  const ledgerEntry = xdr.LedgerEntryData.fromXDR(instanceEntries[0].xdr, "base64");
  const instance = ledgerEntry.contractData().val().instance();
  const executable = instance.executable();
  const execSwitch = executable.switch().name;

  if (execSwitch === "contractExecutableStellarAsset") {
    // Stellar Asset Contract — return well-known SAC functions
    return buildSACSpec(contractAddress);
  }

  if (execSwitch !== "contractExecutableWasm") {
    throw new Error(`Unsupported executable type: ${execSwitch}`);
  }

  // Step 2: Fetch WASM bytes
  const wasmHash = executable.wasmHash();
  const codeKey = xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: wasmHash }),
  );

  const codeEntries = await getLedgerEntries([codeKey]);
  if (codeEntries.length === 0) {
    throw new Error(`WASM code not found for contract: ${contractAddress}`);
  }

  const codeLedgerEntry = xdr.LedgerEntryData.fromXDR(codeEntries[0].xdr, "base64");
  const wasmBytes = codeLedgerEntry.contractCode().code();

  // Step 3: Extract contractspecv0 custom section
  const specSections = extractWasmCustomSections(wasmBytes, "contractspecv0");
  const specSection = specSections[0];
  if (!specSection) {
    throw new Error(`No contract spec found in WASM for: ${contractAddress}`);
  }

  // Step 4: Parse with Spec
  const spec = new contract.Spec(specSection as any);

  // Extract functions
  const functions: SpecFunction[] = [];
  for (const fn of spec.funcs()) {
    try {
      const entry: SpecFunction = {
        name: fn.name().toString(),
        inputs: fn.inputs().map((inp: any) => ({
          name: inp.name().toString(),
          type: describeSpecType(inp.type()),
        })),
        outputs: fn.outputs().map((out: any) => describeSpecType(out)),
      };
      try {
        const doc = (fn as any).doc?.()?.toString?.();
        if (doc) entry.doc = doc;
      } catch {
        // doc() may not exist
      }
      functions.push(entry);
    } catch {
      // Skip unparseable functions
    }
  }

  // Extract custom types via jsonSchema
  const customTypes: SpecCustomType[] = [];
  try {
    const schema = spec.jsonSchema("") as any;
    const defs = schema?.definitions ?? {};
    for (const [name, def] of Object.entries(defs) as [string, any][]) {
      if (def.properties && def.type === "object") {
        customTypes.push({
          name,
          kind: "struct",
          fields: Object.entries(def.properties).map(([fname, fdef]: [string, any]) => ({
            name: fname,
            type: fdef.type ?? fdef.$ref?.split("/").pop() ?? "unknown",
          })),
        });
      } else if (def.oneOf || def.enum) {
        customTypes.push({
          name,
          kind: "enum",
          variants: def.oneOf
            ? def.oneOf.map((v: any) => ({
                name: v.title ?? v.const ?? "unknown",
                values: v.properties
                  ? Object.entries(v.properties).map(([, p]: [string, any]) => p.type ?? "unknown")
                  : undefined,
              }))
            : def.enum?.map((v: string) => ({ name: v })),
        });
      }
    }
  } catch {
    // jsonSchema may fail for some contracts
  }

  return { address: contractAddress, functions, customTypes };
}

/**
 * Well-known Stellar Asset Contract (SAC) spec.
 * SAC functions are standardized, so we don't need to fetch WASM.
 */
function buildSACSpec(address: string): ContractSpec {
  return {
    address,
    functions: [
      {
        name: "transfer",
        inputs: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "amount", type: "i128" },
        ],
        outputs: [],
      },
      {
        name: "approve",
        inputs: [
          { name: "from", type: "address" },
          { name: "spender", type: "address" },
          { name: "amount", type: "i128" },
          { name: "expiration_ledger", type: "u32" },
        ],
        outputs: [],
      },
      {
        name: "transfer_from",
        inputs: [
          { name: "spender", type: "address" },
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "amount", type: "i128" },
        ],
        outputs: [],
      },
      {
        name: "burn",
        inputs: [
          { name: "from", type: "address" },
          { name: "amount", type: "i128" },
        ],
        outputs: [],
      },
      {
        name: "burn_from",
        inputs: [
          { name: "spender", type: "address" },
          { name: "from", type: "address" },
          { name: "amount", type: "i128" },
        ],
        outputs: [],
      },
      {
        name: "mint",
        inputs: [
          { name: "to", type: "address" },
          { name: "amount", type: "i128" },
        ],
        outputs: [],
      },
      {
        name: "balance",
        inputs: [{ name: "id", type: "address" }],
        outputs: ["i128"],
      },
      {
        name: "allowance",
        inputs: [
          { name: "from", type: "address" },
          { name: "spender", type: "address" },
        ],
        outputs: ["i128"],
      },
      {
        name: "decimals",
        inputs: [],
        outputs: ["u32"],
      },
      {
        name: "name",
        inputs: [],
        outputs: ["string"],
      },
      {
        name: "symbol",
        inputs: [],
        outputs: ["string"],
      },
    ],
    customTypes: [],
  };
}

// --- Server Function ---

interface SpecInput {
  contractAddress: string;
}

function validateSpecInput(data: unknown): SpecInput {
  if (typeof data !== "object" || data === null) {
    throw new Error("Invalid payload");
  }
  const { contractAddress } = data as { contractAddress?: unknown };
  if (typeof contractAddress !== "string" || contractAddress.length === 0) {
    throw new Error("contractAddress is required");
  }
  if (!contractAddress.startsWith("C") && !contractAddress.startsWith("G")) {
    throw new Error("contractAddress must start with C or G");
  }
  return { contractAddress };
}

export const getContractSpec = createServerFn({ method: "POST" })
  .inputValidator(validateSpecInput)
  .handler(async ({ data }) => {
    try {
      const spec = await extractContractSpec(data.contractAddress);
      return { success: true as const, spec, error: null };
    } catch (err: any) {
      return {
        success: false as const,
        spec: null,
        error: err.message || "Failed to fetch contract spec",
      };
    }
  });

// --- Client-side convenience ---

export async function requestContractSpec(
  contractAddress: string
): Promise<{ success: boolean; spec: ContractSpec | null; error: string | null }> {
  return getContractSpec({ data: { contractAddress } });
}
