import { describe, it, expect } from "vitest";
import {
  Account,
  Address,
  Operation,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { extractPatterns, summarizePattern, scValToArg } from "../tx-analyzer";
import type { TxPattern } from "../tx-analyzer";
import { TESTNET_NETWORK_PASSPHRASE } from "../constants";

const WALLET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const TOKEN = "CCMR63YE5T7MPWREF3PC5XNTTGXFSB4GYUGUIT5POHP2UGCS65TBIUUU";
const SOURCE = "GAAH4OT36RRCCAGKARGPN2HLHT2NOBVFHO4GUHA6CF7UKQ4MMV24WQ4N";
const DEST = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

function addr(a: string) {
  return xdr.ScVal.scvAddress(Address.fromString(a).toScAddress());
}

function i128(n: bigint) {
  return xdr.ScVal.scvI128(
    new xdr.Int128Parts({
      lo: xdr.Uint64.fromString((n & 0xffffffffffffffffn).toString()),
      hi: xdr.Int64.fromString((n >> 64n).toString()),
    })
  );
}

/** wallet.execute(TOKEN, "transfer", [wallet, dest, amount]) — the app's default send path. */
function executeTransferFunc(): xdr.HostFunction {
  return xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: Address.fromString(WALLET).toScAddress(),
      functionName: "execute",
      args: [
        addr(TOKEN),
        xdr.ScVal.scvSymbol("transfer"),
        xdr.ScVal.scvVec([addr(WALLET), addr(DEST), i128(10_000_000n)]),
      ],
    })
  );
}

/**
 * An address-credentialed auth entry whose signature is the smart account's
 * AuthPayload map. The "signers" key is what marks it as an External signer.
 */
function smartAccountAuthEntry(): xdr.SorobanAuthorizationEntry {
  const authPayload = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("context_rule_ids"),
      val: xdr.ScVal.scvVec([xdr.ScVal.scvU32(0)]),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("signers"),
      val: xdr.ScVal.scvMap([]),
    }),
  ]);

  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(WALLET).toScAddress(),
        nonce: xdr.Int64.fromString("12345"),
        signatureExpirationLedger: 1000,
        signature: authPayload,
      })
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(WALLET).toScAddress(),
          functionName: "execute",
          args: [addr(TOKEN), xdr.ScVal.scvSymbol("transfer")],
        })
      ),
      subInvocations: [
        new xdr.SorobanAuthorizedInvocation({
          function:
            xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
              new xdr.InvokeContractArgs({
                contractAddress: Address.fromString(TOKEN).toScAddress(),
                functionName: "transfer",
                args: [addr(WALLET), addr(DEST), i128(10_000_000n)],
              })
            ),
          subInvocations: [],
        }),
      ],
    }),
  });
}

function buildEnvelope(
  func: xdr.HostFunction,
  auth: xdr.SorobanAuthorizationEntry[]
): xdr.TransactionEnvelope {
  return new TransactionBuilder(new Account(SOURCE, "0"), {
    fee: "1000000",
    networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.invokeHostFunction({ func, auth }))
    .setTimeout(30)
    .build()
    .toEnvelope();
}

describe("extractPatterns", () => {
  it("decomposes an execute->transfer transaction", () => {
    const patterns = extractPatterns(
      buildEnvelope(executeTransferFunc(), [smartAccountAuthEntry()])
    );

    expect(patterns).toHaveLength(1);
    const p = patterns[0];

    expect(p.contractAddress).toBe(WALLET);
    expect(p.functionName).toBe("execute");
    expect(p.args.length).toBe(3);

    expect(p.innerCall).toBeDefined();
    expect(p.innerCall!.functionName).toBe("transfer");
    expect(p.innerCall!.targetContract).toBe(TOKEN);
    expect(p.innerCall!.args.map((a) => a.type)).toEqual([
      "Address",
      "Address",
      "i128",
    ]);
    expect(p.innerCall!.args[2].value).toBe("10000000");
  });

  it("marks smart-account auth payloads as External signers", () => {
    const [p] = extractPatterns(
      buildEnvelope(executeTransferFunc(), [smartAccountAuthEntry()])
    );

    expect(p.signers).toEqual([{ type: "External", identity: WALLET }]);
  });

  it("walks the full authorization invocation tree", () => {
    const [p] = extractPatterns(
      buildEnvelope(executeTransferFunc(), [smartAccountAuthEntry()])
    );

    expect(p.invocationTree).toBeDefined();
    expect(p.invocationTree!.functionName).toBe("execute");
    expect(p.invocationTree!.subInvocations).toHaveLength(1);
    expect(p.invocationTree!.subInvocations[0].functionName).toBe("transfer");
    expect(p.invocationTree!.subInvocations[0].contractAddress).toBe(TOKEN);
  });

  it("treats a plain address credential as a Delegated signer", () => {
    const entry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: Address.fromString(SOURCE).toScAddress(),
          nonce: xdr.Int64.fromString("1"),
          signatureExpirationLedger: 10,
          // A classic keypair signature is a vec, not the AuthPayload map.
          signature: xdr.ScVal.scvVec([]),
        })
      ),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function:
          xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
            new xdr.InvokeContractArgs({
              contractAddress: Address.fromString(TOKEN).toScAddress(),
              functionName: "transfer",
              args: [],
            })
          ),
        subInvocations: [],
      }),
    });

    const [p] = extractPatterns(buildEnvelope(executeTransferFunc(), [entry]));
    expect(p.signers).toEqual([{ type: "Delegated", identity: SOURCE }]);
  });

  it("has no innerCall for a direct (non-execute) contract call", () => {
    const direct = xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(TOKEN).toScAddress(),
        functionName: "transfer",
        args: [addr(WALLET), addr(DEST), i128(5n)],
      })
    );

    const [p] = extractPatterns(buildEnvelope(direct, []));
    expect(p.functionName).toBe("transfer");
    expect(p.innerCall).toBeUndefined();
    expect(p.signers).toEqual([]);
  });
});

describe("summarizePattern", () => {
  it("should include arrow notation for execute patterns", () => {
    const pattern: TxPattern = {
      contractAddress: "CACQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQLC2U",
      functionName: "execute",
      args: [{ type: "Address", value: "CACQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQLC2U" }],
      signers: [{ type: "External", identity: "GABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQHGPC" }],
      innerCall: {
        targetContract: "CACQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQLC2U",
        functionName: "transfer",
        args: [],
      },
    };

    const summary = summarizePattern(pattern);
    expect(summary).toContain("execute()");
    expect(summary).toContain("→");
    expect(summary).toContain("transfer()");
  });

  it("should show args summary without arrow when no innerCall", () => {
    const pattern: TxPattern = {
      contractAddress: "CACQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQLC2U",
      functionName: "transfer",
      args: [
        { type: "Address", value: "GFROM" },
        { type: "Address", value: "GTO" },
        { type: "i128", value: "1000" },
      ],
      signers: [],
    };

    const summary = summarizePattern(pattern);
    expect(summary).toContain("transfer()");
    expect(summary).not.toContain("→");
    expect(summary).toContain("args:");
    expect(summary).toContain("arg0:Address");
  });
});

// These scalars all fell through to "[complex]" — a value the analyzer could read perfectly well
// shown to the user as an opaque token. Display only, but a value the UI cannot name is a value
// the user cannot check a bound against when they turn it into a constraint.
describe("wide and time-typed scalars decode instead of reading [complex]", () => {
  const arg = (v: xdr.ScVal) => scValToArg(v);

  it("decodes u128, u256, i256, timepoint and duration", () => {
    expect(arg(xdr.ScVal.scvU128(new xdr.UInt128Parts({
      hi: xdr.Uint64.fromString("1"), lo: xdr.Uint64.fromString("0"),
    })))).toEqual({ type: "u128", value: (1n << 64n).toString() });

    expect(arg(xdr.ScVal.scvU256(new xdr.UInt256Parts({
      hiHi: xdr.Uint64.fromString("0"), hiLo: xdr.Uint64.fromString("0"),
      loHi: xdr.Uint64.fromString("0"), loLo: xdr.Uint64.fromString("7"),
    })))).toEqual({ type: "u256", value: "7" });

    expect(arg(xdr.ScVal.scvI256(new xdr.Int256Parts({
      hiHi: xdr.Int64.fromString("0"), hiLo: xdr.Uint64.fromString("0"),
      loHi: xdr.Uint64.fromString("0"), loLo: xdr.Uint64.fromString("9"),
    })))).toEqual({ type: "i256", value: "9" });

    expect(arg(xdr.ScVal.scvTimepoint(xdr.Uint64.fromString("1790000000"))))
      .toEqual({ type: "timepoint", value: "1790000000" });
    expect(arg(xdr.ScVal.scvDuration(xdr.Uint64.fromString("3600"))))
      .toEqual({ type: "duration", value: "3600" });
  });

  it("still reports something for a type it genuinely cannot render", () => {
    expect(arg(xdr.ScVal.scvLedgerKeyContractInstance()).value).toBe("[complex]");
  });
});
