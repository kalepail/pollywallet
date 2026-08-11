import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Address, contract, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";

import { requestContextRules } from "../context-rules";
import RuleCard from "../../components/rules/RuleCard";

const clientFrom = vi.spyOn(contract.Client, "from");
const getContractInstance = vi.spyOn(rpc.Server.prototype, "getContractInstance");
const getCount = vi.fn();
const getRule = vi.fn();

const WALLET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const TARGET = "CCMR63YE5T7MPWREF3PC5XNTTGXFSB4GYUGUIT5POHP2UGCS65TBIUUU";
const SIGNER = "GAAH4OT36RRCCAGKARGPN2HLHT2NOBVFHO4GUHA6CF7UKQ4MMV24WQ4N";
const WASM_HASH = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const WASM_HASH_HEX = WASM_HASH.toString("hex");
function assembledResult(retval: xdr.ScVal) {
  return { result: scValToNative(retval) };
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
  getCount.mockReset().mockRejectedValue(new Error("unexpected count lookup"));
  getRule.mockReset().mockRejectedValue(new Error("unexpected rule lookup"));
  clientFrom.mockReset().mockResolvedValue({
    get_context_rules_count: getCount,
    get_context_rule: getRule,
  } as any);
  getContractInstance.mockReset().mockRejectedValue(new Error("unexpected instance lookup"));
});

describe("requestContextRules", () => {
  it("returns immediately for a zero count", async () => {
    getCount.mockResolvedValueOnce(assembledResult(xdr.ScVal.scvU32(0)));

    await expect(requestContextRules(WALLET)).resolves.toEqual({
      success: true,
      error: null,
      rules: [],
    });
    expect(getCount).toHaveBeenCalledTimes(1);
  });

  it("rejects an unsupported count ScVal instead of reporting an empty wallet", async () => {
    getCount.mockResolvedValueOnce({ result: xdr.ScVal.scvLedgerKeyContractInstance() });

    const result = await requestContextRules(WALLET);
    expect(result.success).toBe(false);
  });

  it("decodes real ScVal rules and skips gaps in monotonically increasing IDs", async () => {
    getContractInstance.mockResolvedValueOnce(contractInstance(4));
    getCount.mockResolvedValueOnce(assembledResult(xdr.ScVal.scvU32(2)));
    getRule
      .mockRejectedValueOnce(new Error("removed"))
      .mockResolvedValueOnce(assembledResult(rule(1, xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol("CallContract"),
        address(TARGET),
      ]))))
      .mockResolvedValueOnce(assembledResult(xdr.ScVal.scvVoid()))
      .mockResolvedValueOnce(assembledResult(rule(3, xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol("CreateContract"),
        xdr.ScVal.scvBytes(WASM_HASH),
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
          wasmHash: undefined,
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
          wasmHash: WASM_HASH_HEX,
          signers: [{ type: "External", address: SIGNER, keyData: undefined }],
          signerIds: [9],
          policies: [TARGET],
          policyIds: [4],
          validUntil: 500,
        },
      ],
    });
    expect(getCount).toHaveBeenCalledTimes(1);
    expect(getRule).toHaveBeenCalledTimes(4);
  });

  it("converts bigint counts and defaults missing optional fields", async () => {
    getContractInstance.mockResolvedValueOnce(contractInstance(1));
    getCount.mockResolvedValueOnce({ result: 1n });
    getRule.mockResolvedValueOnce(assembledResult(map({
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
        wasmHash: undefined,
        signers: [],
        signerIds: [],
        policies: [],
        policyIds: [],
        validUntil: undefined,
      }],
    });
  });

  it("renders a CreateContract WASM hash truncated and copyable", () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(createElement(RuleCard, {
      rule: {
        id: 3,
        name: "Create rule",
        contextType: "CreateContract",
        wasmHash: WASM_HASH_HEX,
        signers: [],
        signerIds: [],
        policies: [],
        policyIds: [],
      },
      latestLedger: 100,
      policyMeta: new Map(),
      actionInProgress: null,
      onRename: vi.fn(),
      onDelete: vi.fn(),
      onUpdateExpiration: vi.fn(),
    }));

    expect(screen.getByText("WASM: 00010203...1c1d1e1f")).toBeTruthy();
    fireEvent.click(screen.getByRole("heading", { name: "Create rule" }));
    expect(screen.getByText("WASM Hash")).toBeTruthy();
    expect(screen.getByText(WASM_HASH_HEX)).toBeTruthy();
    fireEvent.click(screen.getByTitle("Copy"));
    expect(writeText).toHaveBeenCalledWith(WASM_HASH_HEX);
    cleanup();
  });

  it("finds an active rule beyond the old fixed sparse-ID scan window", async () => {
    getContractInstance.mockResolvedValueOnce(contractInstance(6));
    getCount.mockResolvedValueOnce(assembledResult(xdr.ScVal.scvU32(1)));
    for (let id = 0; id < 5; id++) {
      getRule.mockResolvedValueOnce(assembledResult(xdr.ScVal.scvVoid()));
    }
    getRule.mockResolvedValueOnce(assembledResult(rule(5, xdr.ScVal.scvVec([]))));

    const result = await requestContextRules(WALLET);
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].id).toBe(5);
  });

  it("returns a stable failure shape when count simulation fails", async () => {
    getCount.mockRejectedValueOnce(new Error("Simulation failed: rpc unavailable"));

    await expect(requestContextRules(WALLET)).resolves.toEqual({
      success: false,
      error: "Simulation failed: rpc unavailable",
      rules: [],
    });
  });
});
