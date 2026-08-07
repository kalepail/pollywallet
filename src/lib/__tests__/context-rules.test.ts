import { beforeEach, describe, expect, it, vi } from "vitest";
import { Address, Keypair, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";

import { requestContextRules } from "../context-rules";

const simulateTransaction = vi.spyOn(rpc.Server.prototype, "simulateTransaction");
const getContractInstance = vi.spyOn(rpc.Server.prototype, "getContractInstance");

const WALLET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const TARGET = "CCMR63YE5T7MPWREF3PC5XNTTGXFSB4GYUGUIT5POHP2UGCS65TBIUUU";
const SIGNER = "GAAH4OT36RRCCAGKARGPN2HLHT2NOBVFHO4GUHA6CF7UKQ4MMV24WQ4N";
type SimulationResponse = Awaited<ReturnType<typeof rpc.Server.prototype.simulateTransaction>>;

vi.spyOn(Keypair, "random").mockReturnValue({
  publicKey: () => SIGNER,
} as unknown as Keypair);

function success(retval: xdr.ScVal) {
  return { result: { retval } } as SimulationResponse;
}

function map(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  return xdr.ScVal.scvMap(Object.entries(fields).map(([key, val]) => new xdr.ScMapEntry({
    key: xdr.ScVal.scvSymbol(key),
    val,
  })));
}

function address(value: string): xdr.ScVal {
  return xdr.ScVal.scvAddress(Address.fromString(value).toScAddress());
}

function contractInstance(nextId: number): xdr.ScContractInstance {
  return new xdr.ScContractInstance({
    executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.alloc(32)),
    storage: [new xdr.ScMapEntry({
      key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("NextId")]),
      val: xdr.ScVal.scvU32(nextId),
    })],
  });
}

function rule(id: number, contextType: xdr.ScVal): xdr.ScVal {
  return map({
    id: xdr.ScVal.scvU32(id),
    name: xdr.ScVal.scvString(`Rule ${id}`),
    context_type: contextType,
    signers: xdr.ScVal.scvVec([
      xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol("External"),
        address(SIGNER),
      ]),
    ]),
    signer_ids: xdr.ScVal.scvVec([xdr.ScVal.scvU32(9)]),
    policies: xdr.ScVal.scvVec([address(TARGET)]),
    policy_ids: xdr.ScVal.scvVec([xdr.ScVal.scvU32(4)]),
    valid_until: xdr.ScVal.scvU32(500),
  });
}

beforeEach(() => {
  simulateTransaction.mockReset().mockRejectedValue(new Error("unexpected simulation"));
  getContractInstance.mockReset().mockRejectedValue(new Error("unexpected instance lookup"));
});

describe("requestContextRules", () => {
  it("returns immediately for a zero count", async () => {
    simulateTransaction.mockResolvedValueOnce(success(xdr.ScVal.scvU32(0)));

    await expect(requestContextRules(WALLET)).resolves.toEqual({
      success: true,
      error: null,
      rules: [],
    });
    expect(simulateTransaction).toHaveBeenCalledTimes(1);
  });

  it("rejects an unsupported count ScVal instead of reporting an empty wallet", async () => {
    simulateTransaction.mockResolvedValueOnce(success(
      xdr.ScVal.scvLedgerKeyContractInstance(),
    ));

    const result = await requestContextRules(WALLET);
    expect(result.success).toBe(false);
  });

  it("decodes real ScVal rules and skips gaps in monotonically increasing IDs", async () => {
    getContractInstance.mockResolvedValueOnce(contractInstance(4));
    simulateTransaction
      .mockResolvedValueOnce(success(xdr.ScVal.scvU32(2)))
      .mockRejectedValueOnce(new Error("removed"))
      .mockResolvedValueOnce(success(rule(1, xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol("CallContract"),
        address(TARGET),
      ]))))
      .mockResolvedValueOnce(success(xdr.ScVal.scvVoid()))
      .mockResolvedValueOnce(success(rule(3, xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol("CreateContract"),
      ]))));

    const result = await requestContextRules(WALLET);

    expect(result).toEqual({
      success: true,
      error: null,
      rules: [
        {
          id: 1,
          name: "Rule 1",
          contextType: "CallContract",
          targetContract: TARGET,
          signers: [{ type: "External", address: SIGNER, keyData: undefined }],
          signerIds: [9],
          policies: [TARGET],
          policyIds: [4],
          validUntil: 500,
        },
        {
          id: 3,
          name: "Rule 3",
          contextType: "CreateContract",
          targetContract: undefined,
          signers: [{ type: "External", address: SIGNER, keyData: undefined }],
          signerIds: [9],
          policies: [TARGET],
          policyIds: [4],
          validUntil: 500,
        },
      ],
    });
    expect(simulateTransaction).toHaveBeenCalledTimes(5);
  });

  it("converts bigint counts and defaults missing optional fields", async () => {
    getContractInstance.mockResolvedValueOnce(contractInstance(1));
    simulateTransaction
      .mockResolvedValueOnce(success(nativeToScVal(1n, { type: "u64" })))
      .mockResolvedValueOnce(success(map({
        id: xdr.ScVal.scvU32(0),
        name: xdr.ScVal.scvString("Default"),
        context_type: xdr.ScVal.scvSymbol("unexpected"),
      })));

    await expect(requestContextRules(WALLET)).resolves.toEqual({
      success: true,
      error: null,
      rules: [{
        id: 0,
        name: "Default",
        contextType: "Default",
        targetContract: undefined,
        signers: [],
        signerIds: [],
        policies: [],
        policyIds: [],
        validUntil: undefined,
      }],
    });
  });

  it("finds an active rule beyond the old fixed sparse-ID scan window", async () => {
    getContractInstance.mockResolvedValueOnce(contractInstance(6));
    simulateTransaction.mockResolvedValueOnce(success(xdr.ScVal.scvU32(1)));
    for (let id = 0; id < 5; id++) {
      simulateTransaction.mockResolvedValueOnce(success(xdr.ScVal.scvVoid()));
    }
    simulateTransaction.mockResolvedValueOnce(success(rule(5, xdr.ScVal.scvVec([]))));

    const result = await requestContextRules(WALLET);
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].id).toBe(5);
  });

  it("returns a stable failure shape when count simulation fails", async () => {
    simulateTransaction.mockResolvedValueOnce({ error: "rpc unavailable" } as SimulationResponse);

    await expect(requestContextRules(WALLET)).resolves.toEqual({
      success: false,
      error: "Simulation failed: rpc unavailable",
      rules: [],
    });
  });
});
