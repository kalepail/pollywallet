import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import type { PolicySchema } from "./policy-schema";
import { schemaToJSON, schemaFromJSON } from "./policy-schema";

// --- Types ---

export interface SavedPolicy {
  /** Contract address on Stellar (C...) */
  contractAddress: string;
  /** WASM hash used for deployment */
  wasmHash: string;
  /** The schema that generated this policy */
  schema: PolicySchema;
  /** The generated Rust source code */
  rustCode: string;
  /** Network the policy was deployed to */
  network: "testnet" | "mainnet";
  /** ISO timestamp of deployment */
  deployedAt: string;
  /** Human-readable name from the schema */
  name: string;
}

interface SavedPolicyJSON {
  contractAddress: string;
  wasmHash: string;
  schemaJson: string;
  rustCode: string;
  network: "testnet" | "mainnet";
  deployedAt: string;
  name: string;
}

// --- Server Functions ---

function validateSaveInput(data: unknown): SavedPolicyJSON {
  if (typeof data !== "object" || data === null) throw new Error("Invalid payload");
  const d = data as Record<string, unknown>;
  if (typeof d.contractAddress !== "string" || !d.contractAddress.startsWith("C"))
    throw new Error("contractAddress must be a Stellar contract address (C...)");
  if (typeof d.wasmHash !== "string") throw new Error("wasmHash required");
  if (typeof d.schemaJson !== "string") throw new Error("schemaJson required");
  if (typeof d.rustCode !== "string") throw new Error("rustCode required");
  if (d.network !== "testnet" && d.network !== "mainnet") throw new Error("network must be testnet or mainnet");
  return d as unknown as SavedPolicyJSON;
}

/** Save a deployed policy to KV, keyed by contract address. */
export const savePolicy = createServerFn({ method: "POST" })
  .inputValidator(validateSaveInput)
  .handler(async ({ data }) => {
    const kv = env.POLICIES_KV;
    if (!kv) return { success: false, error: "KV binding not available" };

    // Store by contract address (primary key)
    await kv.put(`policy:${data.contractAddress}`, JSON.stringify(data), {
      metadata: { name: data.name, network: data.network, deployedAt: data.deployedAt },
    });

    // Also maintain an index list of all policy addresses
    const indexRaw = await kv.get("policy:index");
    const index: string[] = indexRaw ? JSON.parse(indexRaw) : [];
    if (!index.includes(data.contractAddress)) {
      index.push(data.contractAddress);
      await kv.put("policy:index", JSON.stringify(index));
    }

    return { success: true, error: null };
  });

/** Load a saved policy by contract address. */
export const loadPolicy = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => {
    if (typeof data !== "object" || data === null) throw new Error("Invalid");
    const { contractAddress } = data as { contractAddress?: unknown };
    if (typeof contractAddress !== "string") throw new Error("contractAddress required");
    return { contractAddress };
  })
  .handler(async ({ data }): Promise<SavedPolicy | null> => {
    const kv = env.POLICIES_KV;
    if (!kv) return null;

    const raw = await kv.get(`policy:${data.contractAddress}`);
    if (!raw) return null;

    const stored: SavedPolicyJSON = JSON.parse(raw);
    return {
      contractAddress: stored.contractAddress,
      wasmHash: stored.wasmHash,
      schema: schemaFromJSON(stored.schemaJson),
      rustCode: stored.rustCode,
      network: stored.network,
      deployedAt: stored.deployedAt,
      name: stored.name,
    };
  });

/** List all saved policies (metadata only for the list view). */
export const listPolicies = createServerFn({ method: "GET" })
  .handler(async (): Promise<Array<{
    contractAddress: string;
    name: string;
    network: string;
    deployedAt: string;
  }>> => {
    const kv = env.POLICIES_KV;
    if (!kv) return [];

    const indexRaw = await kv.get("policy:index");
    if (!indexRaw) return [];

    const addresses: string[] = JSON.parse(indexRaw);
    const policies = [];

    for (const addr of addresses) {
      const { metadata } = await kv.getWithMetadata(`policy:${addr}`);
      if (metadata) {
        const meta = metadata as { name: string; network: string; deployedAt: string };
        policies.push({
          contractAddress: addr,
          name: meta.name,
          network: meta.network,
          deployedAt: meta.deployedAt,
        });
      }
    }

    return policies;
  });

// --- Client-side convenience ---

/** Save a policy after successful deployment. Call from the UI after deploy succeeds. */
export async function savePolicyAfterDeploy(
  contractAddress: string,
  wasmHash: string,
  schema: PolicySchema,
  rustCode: string,
  network: "testnet" | "mainnet" = "testnet",
): Promise<{ success: boolean; error: string | null }> {
  return savePolicy({
    data: {
      contractAddress,
      wasmHash,
      schemaJson: schemaToJSON(schema),
      rustCode,
      network,
      deployedAt: new Date().toISOString(),
      name: schema.name,
    },
  });
}
