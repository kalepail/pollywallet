import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Address, StrKey, scValToNative, xdr } from "@stellar/stellar-sdk";

const envMock = vi.hoisted(() => ({} as Record<string, any>));
const channels = vi.hoisted(() => ({
  constructor: vi.fn(),
  submitSorobanTransaction: vi.fn(),
}));
const ED25519_VERIFIER = "CCINZKKTMDWH2RNUVQOIZP2S2TIQR73VZYU7G6M5ZW64UTJCPYMDHKO4";
const NATIVE_TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const WEBAUTHN_VERIFIER = "CCMR63YE5T7MPWREF3PC5XNTTGXFSB4GYUGUIT5POHP2UGCS65TBIUUU";

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    inputValidator: (validate: (data: unknown) => unknown) => ({
      handler: (handler: (args: any) => unknown) => async ({ data }: any) =>
        handler({ data: validate(data) }),
    }),
  }),
}));

vi.mock("cloudflare:workers", () => ({ env: envMock }));
vi.mock("../passkey", () => ({ TESTNET_ED25519_VERIFIER: ED25519_VERIFIER }));
vi.mock("@openzeppelin/relayer-plugin-channels", () => ({
  ChannelsClient: class {
    constructor(config: unknown) { channels.constructor(config); }
    submitSorobanTransaction = channels.submitSorobanTransaction;
  },
}));

import {
  buildAddContextRuleTx,
  deployPolicyWasm,
  requestAddContextRule,
  requestDeploy,
  requestSubmitToRelayer,
  submitPolicyTransaction,
} from "../policy-deploy";
import { MAX_AUTH_ENTRIES, MAX_XDR_LENGTH } from "../relayer";

const oldApiKey = process.env.CHANNELS_API_KEY;
const oldBaseUrl = process.env.CHANNELS_BASE_URL;

beforeEach(() => {
  for (const key of Object.keys(envMock)) delete envMock[key];
  channels.constructor.mockReset();
  channels.submitSorobanTransaction.mockReset();
  delete (globalThis as any).CHANNELS_API_KEY;
  delete (globalThis as any).CHANNELS_BASE_URL;
  Reflect.deleteProperty(process.env, "CHANNELS_API_KEY");
  Reflect.deleteProperty(process.env, "CHANNELS_BASE_URL");
});

afterEach(() => {
  if (oldApiKey === undefined) Reflect.deleteProperty(process.env, "CHANNELS_API_KEY");
  else process.env.CHANNELS_API_KEY = oldApiKey;
  if (oldBaseUrl === undefined) Reflect.deleteProperty(process.env, "CHANNELS_BASE_URL");
  else process.env.CHANNELS_BASE_URL = oldBaseUrl;
});

describe("policy WASM deployment", () => {
  it.each([null, undefined, {}, { wasmBase64: "" }, { wasmBase64: 1 }])(
    "rejects invalid input %j",
    async (data) => expect(deployPolicyWasm({ data: data as any })).rejects.toThrow(),
  );

  it("enforces the two-million-character boundary", async () => {
    const maxSizeWasm = "AGFzbQEAAAA" + "A".repeat(1_999_989);
    await expect(deployPolicyWasm({ data: { wasmBase64: maxSizeWasm } }))
      .resolves.toMatchObject({ error: expect.stringContaining("Sandbox service not configured") });
    await expect(deployPolicyWasm({ data: { wasmBase64: `${maxSizeWasm}A` } }))
      .rejects.toThrow("WASM exceeds maximum size");
  });

  it("rejects malformed base64 and non-WASM payloads before contacting the sandbox", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}"));
    envMock.SANDBOX = { fetch };
    await expect(deployPolicyWasm({ data: { wasmBase64: "***not-base64***" } }))
      .rejects.toThrow("wasmBase64");
    await expect(deployPolicyWasm({ data: { wasmBase64: "bm90IHdhc20=" } }))
      .rejects.toThrow("wasmBase64");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts only the encoded WASM to the sandbox and returns its result", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      wasmHash: "ab12",
      contractAddress: WEBAUTHN_VERIFIER,
    }), { status: 200 }));
    envMock.SANDBOX = { fetch };

    await expect(requestDeploy("AGFzbQEAAAA=")).resolves.toEqual({
      success: true,
      error: null,
      wasmHash: "ab12",
      contractAddress: WEBAUTHN_VERIFIER,
    });
    expect(fetch).toHaveBeenCalledWith("https://sandbox/deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wasmBase64: "AGFzbQEAAAA=" }),
    });
  });

  it("maps non-2xx response details and thrown transport errors", async () => {
    envMock.SANDBOX = {
      fetch: vi.fn().mockResolvedValueOnce(new Response("compiler exploded", { status: 422 }))
        .mockRejectedValueOnce(new Error("service unavailable")),
    };

    await expect(requestDeploy("AGFzbQEAAAA=")).resolves.toEqual({
      success: false,
      error: "Deploy failed (422): compiler exploded",
      wasmHash: null,
      contractAddress: null,
    });
    await expect(requestDeploy("AGFzbQEAAAA=")).resolves.toEqual({
      success: false,
      error: "service unavailable",
      wasmHash: null,
      contractAddress: null,
    });
  });
});

describe("add_context_rule XDR", () => {
  const input = {
    walletContractId: NATIVE_TOKEN,
    targetContractAddress: WEBAUTHN_VERIFIER,
    policyAddress: ED25519_VERIFIER,
    installParamsXdr: "",
    ephemeralSignerPublicKey: "GAAH4OT36RRCCAGKARGPN2HLHT2NOBVFHO4GUHA6CF7UKQ4MMV24WQ4N",
    ruleName: "policy-rule",
  };

  it.each([
    ["walletContractId", ""],
    ["targetContractAddress", ""],
    ["policyAddress", ""],
    ["installParamsXdr", 1],
    ["ephemeralSignerPublicKey", ""],
    ["ruleName", ""],
    ["ruleName", "x".repeat(21)],
  ])("rejects invalid %s", async (field, value) => {
    await expect(buildAddContextRuleTx({ data: { ...input, [field]: value } as any })).rejects.toThrow();
  });

  it("encodes the target, signer, policy, void params, and 20-character name", async () => {
    const result = await requestAddContextRule({ ...input, ruleName: "x".repeat(20) });
    expect(result.success).toBe(true);

    const hostFunc = xdr.HostFunction.fromXDR(result.hostFuncXdr!, "base64");
    const invocation = hostFunc.invokeContract();
    const args = invocation.args();

    expect(Address.fromScAddress(invocation.contractAddress()).toString()).toBe(input.walletContractId);
    expect(invocation.functionName().toString()).toBe("add_context_rule");
    expect(scValToNative(args[0])).toEqual(["CallContract", input.targetContractAddress]);
    expect(scValToNative(args[1])).toBe("x".repeat(20));
    expect(args[2].switch().name).toBe("scvVoid");
    expect(scValToNative(args[3])).toEqual([[
      "External",
      ED25519_VERIFIER,
      StrKey.decodeEd25519PublicKey(input.ephemeralSignerPublicKey),
    ]]);
    expect(scValToNative(args[4])).toEqual({ [input.policyAddress]: null });
  });

  it("returns a structured failure for malformed Stellar addresses and XDR", async () => {
    await expect(requestAddContextRule({ ...input, targetContractAddress: "C-not-valid" }))
      .resolves.toMatchObject({ success: false, hostFuncXdr: null });
    await expect(requestAddContextRule({ ...input, installParamsXdr: "not-xdr" }))
      .resolves.toMatchObject({ success: false, hostFuncXdr: null });
  });
});

describe("policy relayer submission", () => {
  it.each([
    [{ func: "", auth: [] }, "func required"],
    [{ func: "x".repeat(MAX_XDR_LENGTH + 1), auth: [] }, "Invalid func"],
    [{ func: "func", auth: "bad" }, "Invalid auth"],
    [{ func: "func", auth: Array(MAX_AUTH_ENTRIES + 1).fill("a") }, "Invalid auth"],
    [{ func: "func", auth: ["x".repeat(MAX_XDR_LENGTH + 1)] }, "Invalid auth"],
    [{ func: "func", auth: [1] }, "Invalid auth"],
  ])("rejects invalid func/auth input", async (data, message) => {
    await expect(submitPolicyTransaction({ data: data as any })).rejects.toThrow(message);
  });

  it("accepts exact size/count limits without constructing an unconfigured client", async () => {
    await expect(submitPolicyTransaction({ data: {
      func: "x".repeat(MAX_XDR_LENGTH),
      auth: Array(MAX_AUTH_ENTRIES).fill("x".repeat(MAX_XDR_LENGTH)),
    } })).resolves.toEqual({
      success: false,
      error: "Relayer not configured (no API key)",
      hash: null,
    });
    expect(channels.constructor).not.toHaveBeenCalled();
  });

  it("submits func/auth unchanged using configured Channels", async () => {
    (globalThis as any).CHANNELS_API_KEY = "key";
    (globalThis as any).CHANNELS_BASE_URL = "https://channels.example";
    channels.submitSorobanTransaction.mockResolvedValue({ hash: "hash-1" });

    await expect(requestSubmitToRelayer({ func: "func-xdr", auth: ["auth-xdr"] })).resolves.toEqual({
      success: true,
      error: null,
      hash: "hash-1",
    });
    expect(channels.constructor).toHaveBeenCalledWith({
      baseUrl: "https://channels.example",
      apiKey: "key",
    });
    expect(channels.submitSorobanTransaction).toHaveBeenCalledWith({
      func: "func-xdr",
      auth: ["auth-xdr"],
    });
  });

  it("maps a Channels rejection to the public error shape", async () => {
    process.env.CHANNELS_API_KEY = "key";
    channels.submitSorobanTransaction.mockRejectedValue(new Error("POOL_CAPACITY"));
    await expect(requestSubmitToRelayer({ func: "func", auth: [] })).resolves.toEqual({
      success: false,
      error: "POOL_CAPACITY",
      hash: null,
    });
  });
});
