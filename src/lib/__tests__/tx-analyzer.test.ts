import { describe, it, expect } from "vitest";
import {
  Account,
  Address,
  Operation,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { extractPatterns, summarizePattern } from "../tx-analyzer";
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
      contractAddress: "CABCDEFGHIJKLMNOPQRSTUVWXYZ234567890ABCDEFGHIJKLMNOPQRSTU",
      functionName: "execute",
      args: [{ type: "Address", value: "CTARGET" }],
      signers: [{ type: "External", identity: "GABCDEF" }],
      innerCall: {
        targetContract: "CTARGETCONTRACTADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
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
      contractAddress: "CABCDEFGHIJKLMNOPQRSTUVWXYZ234567890ABCDEFGHIJKLMNOPQRSTU",
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
