import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock = vi.hoisted(() => ({} as Record<string, any>));

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    inputValidator: (validate: (data: unknown) => unknown) => ({
      handler: (handler: (args: any) => unknown) => async ({ data }: any) =>
        handler({ data: validate(data) }),
    }),
  }),
}));

vi.mock("cloudflare:workers", () => ({ env: envMock }));

import { loadPolicy, savePolicy, savePolicyAfterDeploy } from "../policy-store";
import { SCHEMA_VERSION, schemaToJSON, type PolicySchema } from "../policy-schema";

const CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const SECOND_CONTRACT = "CCMR63YE5T7MPWREF3PC5XNTTGXFSB4GYUGUIT5POHP2UGCS65TBIUUU";
const schema: PolicySchema = {
  $schema: SCHEMA_VERSION,
  name: "unicode-policy",
  description: "Allows José 🔑",
  contracts: [{ address: CONTRACT, functions: [{ name: "transfer", args: [] }] }],
  globalRules: [],
};

function savedData(contractAddress = CONTRACT) {
  return {
    contractAddress,
    wasmHash: "ab12",
    schemaJson: schemaToJSON(schema),
    rustCode: "#![no_std]\n// 🔒",
    network: "testnet" as const,
    deployedAt: "2026-08-06T12:00:00.000Z",
    name: schema.name,
  };
}

function kv(index: string | null = null) {
  return {
    get: vi.fn(async (key: string) => key === "policy:index" ? index : null),
    put: vi.fn(async (_key: string, _value: string, _options?: unknown) => undefined),
  };
}

beforeEach(() => {
  for (const key of Object.keys(envMock)) delete envMock[key];
});

describe("savePolicy", () => {
  it.each([
    [null, "Invalid payload"],
    [{ ...savedData(), contractAddress: "G-account" }, "contractAddress"],
    [{ ...savedData(), wasmHash: 1 }, "wasmHash"],
    [{ ...savedData(), schemaJson: 1 }, "schemaJson"],
    [{ ...savedData(), rustCode: 1 }, "rustCode"],
    [{ ...savedData(), network: "futurenet" }, "network"],
  ])("rejects malformed persisted data", async (data, message) => {
    await expect(savePolicy({ data: data as any })).rejects.toThrow(message);
  });

  it("rejects a C-prefixed string that is not a Stellar contract address", async () => {
    envMock.POLICIES_KV = kv();
    await expect(savePolicy({ data: savedData("C-not-a-contract") })).rejects.toThrow("contractAddress");
  });

  it("rejects malformed or invalid schema JSON before it can poison KV", async () => {
    const binding = kv();
    envMock.POLICIES_KV = binding;
    await expect(savePolicy({ data: { ...savedData(), schemaJson: "{bad-json" } }))
      .rejects.toThrow("schemaJson");
    await expect(savePolicy({ data: { ...savedData(), schemaJson: "{}" } }))
      .rejects.toThrow("schemaJson");
    expect(binding.put).not.toHaveBeenCalled();
  });

  it("stores the policy under its derived key with searchable metadata and creates the index", async () => {
    const binding = kv();
    envMock.POLICIES_KV = binding;
    const data = savedData();

    await expect(savePolicy({ data })).resolves.toEqual({ success: true, error: null });
    expect(binding.put).toHaveBeenNthCalledWith(1, `policy:${CONTRACT}`, JSON.stringify(data), {
      metadata: {
        name: schema.name,
        network: "testnet",
        deployedAt: data.deployedAt,
      },
    });
    expect(binding.get).toHaveBeenCalledWith("policy:index");
    expect(binding.put).toHaveBeenNthCalledWith(2, "policy:index", JSON.stringify([CONTRACT]));
  });

  it("appends a new address but does not rewrite an existing index entry", async () => {
    const append = kv(JSON.stringify([CONTRACT]));
    envMock.POLICIES_KV = append;
    await savePolicy({ data: savedData(SECOND_CONTRACT) });
    expect(append.put).toHaveBeenLastCalledWith(
      "policy:index",
      JSON.stringify([CONTRACT, SECOND_CONTRACT]),
    );

    const duplicate = kv(JSON.stringify([CONTRACT]));
    envMock.POLICIES_KV = duplicate;
    await savePolicy({ data: savedData() });
    expect(duplicate.put).toHaveBeenCalledOnce();
  });

  it("returns a stable error when the KV binding is absent", async () => {
    await expect(savePolicy({ data: savedData() })).resolves.toEqual({
      success: false,
      error: "KV binding not available",
    });
  });
});

describe("loadPolicy", () => {
  it.each([null, undefined, {}, { contractAddress: 1 }])("rejects invalid lookup %j", async (data) => {
    await expect(loadPolicy({ data: data as any })).rejects.toThrow();
  });

  it("uses the policy key and reconstructs the typed schema", async () => {
    const data = savedData();
    const binding = {
      get: vi.fn().mockResolvedValue(JSON.stringify(data)),
      put: vi.fn(),
    };
    envMock.POLICIES_KV = binding;

    await expect(loadPolicy({ data: { contractAddress: CONTRACT } })).resolves.toEqual({
      contractAddress: CONTRACT,
      wasmHash: data.wasmHash,
      schema,
      rustCode: data.rustCode,
      network: "testnet",
      deployedAt: data.deployedAt,
      name: schema.name,
    });
    expect(binding.get).toHaveBeenCalledWith(`policy:${CONTRACT}`);
  });

  it("returns null for an absent binding or missing key", async () => {
    await expect(loadPolicy({ data: { contractAddress: CONTRACT } })).resolves.toBeNull();
    envMock.POLICIES_KV = { get: vi.fn().mockResolvedValue(null) };
    await expect(loadPolicy({ data: { contractAddress: CONTRACT } })).resolves.toBeNull();
  });

  it("surfaces corrupted stored JSON instead of returning a partial policy", async () => {
    envMock.POLICIES_KV = { get: vi.fn().mockResolvedValue("{bad-json") };
    await expect(loadPolicy({ data: { contractAddress: CONTRACT } })).rejects.toThrow(SyntaxError);
  });
});

describe("savePolicyAfterDeploy", () => {
  it("serializes the schema and supplies an ISO deployment timestamp", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T15:30:00.000Z"));
    const binding = kv();
    envMock.POLICIES_KV = binding;

    try {
      await expect(savePolicyAfterDeploy(CONTRACT, "hash", schema, "rust", "mainnet"))
        .resolves.toEqual({ success: true, error: null });
      const stored = JSON.parse(binding.put.mock.calls[0][1]);
      expect(stored).toEqual({
        contractAddress: CONTRACT,
        wasmHash: "hash",
        schemaJson: schemaToJSON(schema),
        rustCode: "rust",
        network: "mainnet",
        deployedAt: "2026-08-06T15:30:00.000Z",
        name: schema.name,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
