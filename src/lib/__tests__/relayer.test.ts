import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionBuilder } from "@stellar/stellar-sdk";
import { TESTNET_NETWORK_PASSPHRASE } from "../constants";

const channels = vi.hoisted(() => ({
  constructor: vi.fn(),
  submitTransaction: vi.fn(),
}));

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    inputValidator: (validate: (data: unknown) => unknown) => ({
      handler: (handler: (args: any) => unknown) => async ({ data }: any) =>
        handler({ data: validate(data) }),
    }),
  }),
}));

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  const keypair = new Proxy(actual.Keypair, {
    get(target, property, receiver) {
      if (property !== "fromRawEd25519Seed") return Reflect.get(target, property, receiver);
      return (seed: ArrayLike<number>) => {
        const hex = Array.from(seed, (byte) => byte.toString(16).padStart(2, "0")).join("");
        if (hex !== "4c695154d0f77de86c53757e98025877433ee07e77c8f60922546b31b8f1f76c") {
          throw new Error("unexpected deployer seed");
        }
        return { publicKey: () => "GDWAZVMP6766SAM2HRO6W2QIANU64KUTINIDC5ZQWRS5NAX25CZOHIQV" };
      };
    },
  });
  return {
    ...actual,
    Keypair: keypair,
  };
});

vi.mock("@openzeppelin/relayer-plugin-channels", () => ({
  ChannelsClient: class {
    constructor(config: unknown) { channels.constructor(config); }
    submitTransaction = channels.submitTransaction;
  },
}));

import { MAX_AUTH_ENTRIES, MAX_XDR_LENGTH, signAndSubmitDeploy } from "../relayer";

const oldApiKey = process.env.CHANNELS_API_KEY;
const oldBaseUrl = process.env.CHANNELS_BASE_URL;

beforeEach(() => {
  channels.constructor.mockReset();
  channels.submitTransaction.mockReset();
  delete (globalThis as any).CHANNELS_API_KEY;
  delete (globalThis as any).CHANNELS_BASE_URL;
  Reflect.deleteProperty(process.env, "CHANNELS_API_KEY");
  Reflect.deleteProperty(process.env, "CHANNELS_BASE_URL");
});

afterEach(() => {
  vi.restoreAllMocks();
  if (oldApiKey === undefined) Reflect.deleteProperty(process.env, "CHANNELS_API_KEY");
  else process.env.CHANNELS_API_KEY = oldApiKey;
  if (oldBaseUrl === undefined) Reflect.deleteProperty(process.env, "CHANNELS_BASE_URL");
  else process.env.CHANNELS_BASE_URL = oldBaseUrl;
});

describe("input limits", () => {
  it("exports the shared relayer limits", () => {
    expect(MAX_XDR_LENGTH).toBe(100_000);
    expect(MAX_AUTH_ENTRIES).toBe(10);
  });

  it.each([undefined, null, 3, ""])("rejects invalid preparedXdr %j", async (preparedXdr) => {
    await expect(signAndSubmitDeploy({ data: { preparedXdr } as any })).rejects.toThrow(
      "Invalid preparedXdr",
    );
  });

  it("accepts the exact limit and rejects one byte over", async () => {
    await expect(signAndSubmitDeploy({ data: { preparedXdr: "x".repeat(MAX_XDR_LENGTH) } }))
      .resolves.toMatchObject({ error: "Relayer not configured" });
    await expect(signAndSubmitDeploy({ data: { preparedXdr: "x".repeat(MAX_XDR_LENGTH + 1) } }))
      .rejects.toThrow("Invalid preparedXdr");
  });
});

describe("deploy submission", () => {
  it("does not parse or sign when the relayer is unconfigured", async () => {
    const parse = vi.spyOn(TransactionBuilder, "fromXDR");
    await expect(signAndSubmitDeploy({ data: { preparedXdr: "prepared" } })).resolves.toEqual({
      success: false,
      error: "Relayer not configured",
      hash: null,
    });
    expect(parse).not.toHaveBeenCalled();
    expect(channels.constructor).not.toHaveBeenCalled();
  });

  it("signs the parsed testnet transaction and submits its resulting XDR", async () => {
    (globalThis as any).CHANNELS_API_KEY = "global-key";
    (globalThis as any).CHANNELS_BASE_URL = "https://channels.example/testnet";
    const tx = { sign: vi.fn(), toXDR: vi.fn(() => "signed-xdr") };
    const parse = vi.spyOn(TransactionBuilder, "fromXDR").mockReturnValue(tx as any);
    channels.submitTransaction.mockResolvedValue({ hash: "tx-hash" });

    await expect(signAndSubmitDeploy({ data: { preparedXdr: "prepared-xdr" } })).resolves.toEqual({
      success: true,
      error: null,
      hash: "tx-hash",
    });
    expect(parse).toHaveBeenCalledWith("prepared-xdr", TESTNET_NETWORK_PASSPHRASE);
    expect(tx.sign).toHaveBeenCalledOnce();
    expect(tx.toXDR).toHaveBeenCalledOnce();
    expect(channels.constructor).toHaveBeenCalledWith({
      baseUrl: "https://channels.example/testnet",
      apiKey: "global-key",
    });
    expect(channels.submitTransaction).toHaveBeenCalledWith({ xdr: "signed-xdr" });
  });

  it("uses process configuration and preserves a null response hash", async () => {
    process.env.CHANNELS_API_KEY = "process-key";
    const tx = { sign: vi.fn(), toXDR: vi.fn(() => "signed-xdr") };
    vi.spyOn(TransactionBuilder, "fromXDR").mockReturnValue(tx as any);
    channels.submitTransaction.mockResolvedValue({});

    await expect(signAndSubmitDeploy({ data: { preparedXdr: "prepared" } })).resolves.toEqual({
      success: true,
      error: null,
      hash: null,
    });
    expect(channels.constructor).toHaveBeenCalledWith({
      baseUrl: "https://channels.openzeppelin.com/testnet",
      apiKey: "process-key",
    });
  });

  it("maps SDK and relayer errors without leaking a success result", async () => {
    process.env.CHANNELS_API_KEY = "key";
    vi.spyOn(TransactionBuilder, "fromXDR").mockImplementation(() => {
      throw new Error("malformed XDR");
    });

    await expect(signAndSubmitDeploy({ data: { preparedXdr: "bad" } })).resolves.toEqual({
      success: false,
      error: "malformed XDR",
      hash: null,
    });
  });
});
