import { beforeEach, describe, expect, it, vi } from "vitest";
import { Buffer } from "buffer";
import base64url from "base64url";

const webauthn = vi.hoisted(() => ({
  register: vi.fn(),
  authenticate: vi.fn(),
}));

vi.mock("@simplewebauthn/browser", () => ({
  startRegistration: webauthn.register,
  startAuthentication: webauthn.authenticate,
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

import {
  DEPLOYER_PUBLIC_KEY,
  LEDGERS_PER_HOUR,
  clearWallet,
  createPasskey,
  loadWallet,
  parseXlmToStroops,
  saveWallet,
  signWithPasskey,
  toI128,
  type StoredWallet,
} from "../passkey";

beforeEach(() => {
  webauthn.register.mockReset();
  webauthn.authenticate.mockReset();
  localStorage.clear();
});

describe("XLM and ledger conversion", () => {
  it.each([
    ["0", 0n],
    [" 1 ", 10_000_000n],
    ["0.0000001", 1n],
    ["1.2345678", 12_345_678n],
    ["9007199254740993.0000001", 90_071_992_547_409_930_000_001n],
  ])("parses %j without floating-point loss", (input, expected) => {
    expect(parseXlmToStroops(input)).toBe(expected);
  });

  it.each(["", " ", "-1", ".1", "1.", "1e3", "1,0", "１２", "NaN"])(
    "rejects malformed amount %j",
    (input) => expect(() => parseXlmToStroops(input)).toThrow("Invalid XLM amount"),
  );

  it("rejects fractions smaller than one stroop", () => {
    expect(() => parseXlmToStroops("0.00000001")).toThrow("max 7 decimal places");
  });

  it("keeps the five-second-ledger source-of-truth conversion", () => {
    expect(LEDGERS_PER_HOUR).toBe(720);
    expect(LEDGERS_PER_HOUR * 5).toBe(60 * 60);
  });
});

describe("i128 encoding", () => {
  it.each([
    [0n, "0", "0"],
    [-1n, "-1", "18446744073709551615"],
    [(1n << 127n) - 1n, "9223372036854775807", "18446744073709551615"],
    [-(1n << 127n), "-9223372036854775808", "0"],
  ])("encodes %s into signed high and unsigned low limbs", (value, hi, lo) => {
    const parts = toI128(value).i128();
    expect(parts.hi().toString()).toBe(hi);
    expect(parts.lo().toString()).toBe(lo);
  });

  it("rejects values outside the signed i128 range", () => {
    expect(() => toI128(1n << 127n)).toThrow();
    expect(() => toI128(-(1n << 127n) - 1n)).toThrow();
  });
});

describe("key and digest byte construction", () => {
  it("pins the deterministic deployer seed to its public key", () => {
    expect(DEPLOYER_PUBLIC_KEY).toBe("GDWAZVMP6766SAM2HRO6W2QIANU64KUTINIDC5ZQWRS5NAX25CZOHIQV");
  });
});

describe("WebAuthn boundaries", () => {
  it("requests ES256 registration and returns an uncompressed P-256 key", async () => {
    const publicKey = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]);
    webauthn.register.mockResolvedValue({
      id: "credential-id",
      response: { publicKey: base64url(publicKey) },
    });
    const random = vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(((array: Uint8Array) => {
      array.fill(9);
      return array;
    }) as typeof crypto.getRandomValues);

    const result = await createPasskey("Polly 🐦", "José");

    expect(result).toEqual({ credentialId: "credential-id", publicKey: new Uint8Array(publicKey) });
    expect(webauthn.register).toHaveBeenCalledWith({
      optionsJSON: expect.objectContaining({
        rp: { name: "Polly 🐦" },
        user: expect.objectContaining({ name: "José", displayName: "José" }),
        pubKeyCredParams: [{ alg: -7, type: "public-key" }],
        timeout: 60_000,
      }),
    });
    random.mockRestore();
  });

  it("rejects registration responses without extractable key material", async () => {
    webauthn.register.mockResolvedValue({ id: "credential-id", response: {} });
    await expect(createPasskey("Polly", "user")).rejects.toThrow(
      "Could not extract public key from attestation",
    );
  });

  it("compacts DER signatures and normalizes high-S values", async () => {
    const order = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
    const highS = Buffer.from((order - 1n).toString(16).padStart(64, "0"), "hex");
    const der = Buffer.concat([
      Buffer.from([0x30, 0x26, 0x02, 0x01, 0x01, 0x02, 0x21, 0x00]),
      highS,
    ]);
    webauthn.authenticate.mockResolvedValue({
      response: {
        signature: base64url(der),
        authenticatorData: base64url(Buffer.from([1, 2])),
        clientDataJSON: base64url(Buffer.from("{}")),
      },
    });

    const result = await signWithPasskey("credential-id", Buffer.from([8, 9]));

    expect(Buffer.from(result.signature).toString("hex")).toBe(
      `${"0".repeat(63)}1${"0".repeat(63)}1`,
    );
    expect(Array.from(result.authenticatorData)).toEqual([1, 2]);
    expect(webauthn.authenticate).toHaveBeenCalledWith({
      optionsJSON: expect.objectContaining({
        challenge: base64url(Buffer.from([8, 9])),
        allowCredentials: [{ id: "credential-id", type: "public-key" }],
      }),
    });
  });
});

describe("wallet storage", () => {
  const wallet: StoredWallet = {
    credentialId: "cred-🔑",
    contractId: "C123",
    publicKey: "04ff",
  };

  it("round-trips and clears the single wallet storage key", () => {
    saveWallet(wallet);
    expect(localStorage.getItem("pollywallet:wallet")).toBe(JSON.stringify(wallet));
    expect(loadWallet()).toEqual(wallet);

    clearWallet();
    expect(loadWallet()).toBeNull();
  });

  it("returns null for malformed stored JSON", () => {
    localStorage.setItem("pollywallet:wallet", "{not-json");
    expect(loadWallet()).toBeNull();
  });
});
