import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TESTNET_NETWORK_PASSPHRASE } from "../constants";

const channels = vi.hoisted(() => ({
  constructor: vi.fn(),
  submitTransaction: vi.fn(),
  submitSorobanTransaction: vi.fn(),
}));

const authz = vi.hoisted(() => ({ authorizeEntry: vi.fn() }));

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
    authorizeEntry: authz.authorizeEntry,
    xdr: {
      ...actual.xdr,
      SorobanAuthorizationEntry: {
        ...actual.xdr.SorobanAuthorizationEntry,
        fromXDR: (v: string) => ({ __entry: v }),
      },
    },
  };
});

vi.mock("@openzeppelin/relayer-plugin-channels", () => ({
  ChannelsClient: class {
    constructor(config: unknown) { channels.constructor(config); }
    submitTransaction = channels.submitTransaction;
    submitSorobanTransaction = channels.submitSorobanTransaction;
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

  it.each([undefined, null, 3, ""])("rejects invalid func %j", async (func) => {
    await expect(
      signAndSubmitDeploy({ data: { func, auth: [], validUntilLedger: 1 } as any }),
    ).rejects.toThrow("Invalid func");
  });

  it("rejects malformed auth and out-of-range ledgers", async () => {
    const base = { func: "f", validUntilLedger: 1 };
    await expect(signAndSubmitDeploy({ data: { ...base, auth: "nope" } as any }))
      .rejects.toThrow("Invalid auth");
    await expect(
      signAndSubmitDeploy({
        data: { ...base, auth: new Array(MAX_AUTH_ENTRIES + 1).fill("a") } as any,
      }),
    ).rejects.toThrow("Invalid auth");
    await expect(signAndSubmitDeploy({ data: { func: "f", auth: [], validUntilLedger: 0 } as any }))
      .rejects.toThrow("Invalid validUntilLedger");
  });

  it("accepts the exact func limit and rejects one byte over", async () => {
    await expect(
      signAndSubmitDeploy({
        data: { func: "x".repeat(MAX_XDR_LENGTH), auth: [], validUntilLedger: 1 },
      }),
    ).resolves.toMatchObject({ error: "Relayer not configured" });
    await expect(
      signAndSubmitDeploy({
        data: { func: "x".repeat(MAX_XDR_LENGTH + 1), auth: [], validUntilLedger: 1 },
      }),
    ).rejects.toThrow("Invalid func");
  });
});

describe("deploy submission", () => {
  it("does not sign when the relayer is unconfigured", async () => {
    await expect(
      signAndSubmitDeploy({ data: { func: "f", auth: ["a"], validUntilLedger: 9 } }),
    ).resolves.toEqual({ success: false, error: "Relayer not configured", hash: null });
    expect(authz.authorizeEntry).not.toHaveBeenCalled();
    expect(channels.constructor).not.toHaveBeenCalled();
  });

  // The deployer AUTHORIZES the deployment but must never SOURCE it. submitSorobanTransaction
  // is the channel-account path, so the relayer pays; submitTransaction would submit our own
  // envelope and charge whatever account sourced it — which is how the shared, publicly
  // derivable deployer ended up spending real XLM on fees.
  it("signs each auth entry and submits via the channel-account path", async () => {
    (globalThis as any).CHANNELS_API_KEY = "global-key";
    (globalThis as any).CHANNELS_BASE_URL = "https://channels.example/testnet";
    authz.authorizeEntry.mockImplementation(async (entry: any) => ({
      toXDR: () => `signed:${entry.__entry}`,
    }));
    channels.submitSorobanTransaction.mockResolvedValue({ hash: "tx-hash" });

    await expect(
      signAndSubmitDeploy({ data: { func: "func-xdr", auth: ["e1", "e2"], validUntilLedger: 42 } }),
    ).resolves.toEqual({ success: true, error: null, hash: "tx-hash" });

    expect(authz.authorizeEntry).toHaveBeenCalledTimes(2);
    expect(authz.authorizeEntry.mock.calls[0][2]).toBe(42);
    expect(authz.authorizeEntry.mock.calls[0][3]).toBe(TESTNET_NETWORK_PASSPHRASE);
    expect(channels.submitSorobanTransaction).toHaveBeenCalledWith({
      func: "func-xdr",
      auth: ["signed:e1", "signed:e2"],
    });
    // The fee-charging path must not be used.
    expect(channels.submitTransaction).not.toHaveBeenCalled();
  });
});
