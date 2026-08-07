import { afterEach, describe, expect, it, vi } from "vitest";
import { Address, xdr } from "@stellar/stellar-sdk";
import { requestContractSpec } from "../contract-spec";

const CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const WASM_HASH = Buffer.alloc(32, 7);

function leb128(value: number): Buffer {
  const bytes = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value) byte |= 0x80;
    bytes.push(byte);
  } while (value);
  return Buffer.from(bytes);
}

function wasmWithSpec(entries: xdr.ScSpecEntry[]): Buffer {
  const name = Buffer.from("contractspecv0");
  const spec = Buffer.concat(entries.map((entry) => entry.toXDR()));
  const payload = Buffer.concat([leb128(name.length), name, spec]);
  return Buffer.concat([
    Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x00]),
    leb128(payload.length),
    payload,
  ]);
}

function instanceXdr(executable: xdr.ContractExecutable): string {
  const instance = new xdr.ScContractInstance({ executable, storage: null });
  const entry = new xdr.ContractDataEntry({
    ext: new xdr.ExtensionPoint(0),
    contract: Address.fromString(CONTRACT).toScAddress(),
    key: xdr.ScVal.scvLedgerKeyContractInstance(),
    durability: xdr.ContractDataDurability.persistent(),
    val: xdr.ScVal.scvContractInstance(instance),
  });
  return xdr.LedgerEntryData.contractData(entry).toXDR("base64");
}

function codeXdr(wasm: Buffer): string {
  const entry = new xdr.ContractCodeEntry({
    ext: new xdr.ContractCodeEntryExt(0),
    hash: WASM_HASH,
    code: wasm,
  });
  return xdr.LedgerEntryData.contractCode(entry).toXDR("base64");
}

function mockRpc(wasm: Buffer) {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({
      json: async () => ({ result: { entries: [{ xdr: instanceXdr(
        xdr.ContractExecutable.contractExecutableWasm(WASM_HASH),
      ) }] } }),
    })
    .mockResolvedValueOnce({
      json: async () => ({ result: { entries: [{ xdr: codeXdr(wasm) }] } }),
    });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function functionEntry(
  name: string,
  inputs: Array<{ name: string; type: xdr.ScSpecTypeDef }> = [],
  outputs: xdr.ScSpecTypeDef[] = [],
  doc = "",
): xdr.ScSpecEntry {
  return xdr.ScSpecEntry.scSpecEntryFunctionV0(new xdr.ScSpecFunctionV0({
    doc,
    name,
    inputs: inputs.map((input) => new xdr.ScSpecFunctionInputV0({
      doc: "",
      name: input.name,
      type: input.type,
    })),
    outputs,
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe("requestContractSpec", () => {
  it("rejects invalid input without making a network request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestContractSpec("")).resolves.toMatchObject({
      success: false,
      error: "contractAddress is required",
    });
    await expect(requestContractSpec("not-an-address")).resolves.toMatchObject({
      success: false,
      error: "contractAddress must start with C or G",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the standardized SAC spec from a real instance XDR", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ result: { entries: [{ xdr: instanceXdr(
        xdr.ContractExecutable.contractExecutableStellarAsset(),
      ) }] } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await requestContractSpec(CONTRACT);

    expect(result.success).toBe(true);
    expect(result.spec?.functions.find(({ name }) => name === "transfer")).toEqual({
      name: "transfer",
      inputs: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "amount", type: "i128" },
      ],
      outputs: [],
    });
    expect(result.spec?.functions.find(({ name }) => name === "decimals")?.inputs).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("parses real function and custom-type XDR, including nested and unicode entries", async () => {
    const profile = xdr.ScSpecTypeDef.scSpecTypeUdt(
      new xdr.ScSpecTypeUdt({ name: "Profile" }),
    );
    const tuple = xdr.ScSpecTypeDef.scSpecTypeTuple(
      new xdr.ScSpecTypeTuple({
        valueTypes: [xdr.ScSpecTypeDef.scSpecTypeU32(), profile],
      }),
    );
    const resultType = xdr.ScSpecTypeDef.scSpecTypeResult(
      new xdr.ScSpecTypeResult({
        okType: tuple,
        errorType: xdr.ScSpecTypeDef.scSpecTypeError(),
      }),
    );
    const nested = xdr.ScSpecTypeDef.scSpecTypeOption(
      new xdr.ScSpecTypeOption({
        valueType: xdr.ScSpecTypeDef.scSpecTypeVec(new xdr.ScSpecTypeVec({
          elementType: xdr.ScSpecTypeDef.scSpecTypeMap(new xdr.ScSpecTypeMap({
            keyType: xdr.ScSpecTypeDef.scSpecTypeString(),
            valueType: resultType,
          })),
        })),
      }),
    );
    const struct = xdr.ScSpecEntry.scSpecEntryUdtStructV0(new xdr.ScSpecUdtStructV0({
      doc: "A user profile",
      lib: "",
      name: "Profile",
      fields: [new xdr.ScSpecUdtStructFieldV0({
        doc: "",
        name: "age",
        type: xdr.ScSpecTypeDef.scSpecTypeU32(),
      })],
    }));
    const status = xdr.ScSpecEntry.scSpecEntryUdtEnumV0(new xdr.ScSpecUdtEnumV0({
      doc: "",
      lib: "",
      name: "Status",
      cases: [
        new xdr.ScSpecUdtEnumCaseV0({ doc: "", name: "Active", value: 1 }),
        new xdr.ScSpecUdtEnumCaseV0({ doc: "", name: "Paused", value: 2 }),
      ],
    }));
    mockRpc(wasmWithSpec([
      functionEntry("读取", [
        { name: "查询", type: nested },
        { name: "hash", type: xdr.ScSpecTypeDef.scSpecTypeBytesN(new xdr.ScSpecTypeBytesN({ n: 32 })) },
        { name: "muxed", type: xdr.ScSpecTypeDef.scSpecTypeMuxedAddress() },
      ], [profile], "Unicode lookup"),
      functionEntry("ping"),
      struct,
      status,
    ]));

    const result = await requestContractSpec(CONTRACT);

    expect(result).toMatchObject({
      success: true,
      spec: {
        address: CONTRACT,
        functions: [
          {
            name: "读取",
            doc: "Unicode lookup",
            inputs: [
              { name: "查询", type: "Option<Vec<Map<string, Result<(u32, Profile), error>>>>" },
              { name: "hash", type: "bytes<32>" },
              { name: "muxed", type: "scSpecTypeMuxedAddress" },
            ],
            outputs: ["Profile"],
          },
          { name: "ping", inputs: [], outputs: [] },
        ],
      },
    });
    expect(result.spec?.customTypes).toEqual(expect.arrayContaining([
      { name: "Profile", kind: "struct", fields: [{ name: "age", type: "U32" }] },
      {
        name: "Status",
        kind: "enum",
        variants: [{ name: "Active" }, { name: "Paused" }],
      },
    ]));
  });

  it("handles an empty contractspec section", async () => {
    mockRpc(wasmWithSpec([]));

    await expect(requestContractSpec(CONTRACT)).resolves.toEqual({
      success: true,
      spec: { address: CONTRACT, functions: [], customTypes: [] },
      error: null,
    });
  });

  it("returns a failure for malformed spec XDR", async () => {
    const name = Buffer.from("contractspecv0");
    const payload = Buffer.concat([leb128(name.length), name, Buffer.from([0xff])]);
    const malformed = Buffer.concat([
      Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x00]),
      leb128(payload.length),
      payload,
    ]);
    mockRpc(malformed);

    const result = await requestContractSpec(CONTRACT);

    expect(result.success).toBe(false);
    expect(result.spec).toBeNull();
    expect(result.error).toMatch(/xdr|read|switch/i);
  });

  it("reports a missing contract without attempting a WASM lookup", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ result: { entries: [] } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestContractSpec(CONTRACT)).resolves.toMatchObject({
      success: false,
      error: `Contract not found: ${CONTRACT}`,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
