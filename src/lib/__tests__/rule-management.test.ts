import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { MAX_CONTEXT_RULE_NAME, MAX_U32 } from "../constants";
import RuleCard from "../../components/rules/RuleCard";

const routeMocks = vi.hoisted(() => ({
  loadWallet: vi.fn(),
  requestContextRules: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({}),
}));

vi.mock("@/lib/context-rules", () => ({
  requestContextRules: routeMocks.requestContextRules,
}));

vi.mock("@/lib/passkey", () => ({
  loadWallet: routeMocks.loadWallet,
  signWalletAuthEntries: vi.fn(),
  TESTNET_RPC_URL: "https://rpc.example",
  TESTNET_NETWORK_PASSPHRASE: "test network",
  LEDGERS_PER_HOUR: 720,
}));

vi.mock("@/lib/policy-deploy", () => ({ requestSubmitToRelayer: vi.fn() }));
vi.mock("@/lib/policy-store", () => ({ loadPolicy: vi.fn() }));

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    inputValidator: (validate: (data: unknown) => unknown) => ({
      handler: (handle: (input: any) => unknown) => async (input: any) =>
        handle({ ...input, data: validate(input.data) }),
    }),
  }),
}));

import {
  requestRemoveContextRule,
  requestRenameContextRule,
  requestUpdateExpiration,
  assertTransactionSuccess,
} from "../rule-management";
import { RulesManager } from "../../routes/rules";

const WALLET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

afterEach(() => {
  cleanup();
  routeMocks.loadWallet.mockReset();
  routeMocks.requestContextRules.mockReset();
});

function invocation(hostFuncXdr: string | null) {
  expect(hostFuncXdr).not.toBeNull();
  return xdr.HostFunction.fromXDR(hostFuncXdr!, "base64").invokeContract();
}

describe("rule-management transaction builders", () => {
  it("builds remove_context_rule with a real u32 argument", async () => {
    const result = await requestRemoveContextRule({ walletContractId: WALLET, contextRuleId: 0 });
    const call = invocation(result.hostFuncXdr);

    expect(result).toMatchObject({ success: true, error: null });
    expect(call.functionName().toString()).toBe("remove_context_rule");
    expect(call.args().map(scValToNative)).toEqual([0]);
  });

  it("accepts a name at 20 characters and rejects one at 21", async () => {
    const atLimit = "x".repeat(MAX_CONTEXT_RULE_NAME);
    const result = await requestRenameContextRule({
      walletContractId: WALLET,
      contextRuleId: 7,
      name: atLimit,
    });
    const call = invocation(result.hostFuncXdr);

    expect(call.functionName().toString()).toBe("update_context_rule_name");
    expect(call.args().map(scValToNative)).toEqual([7, atLimit]);
    await expect(requestRenameContextRule({
      walletContractId: WALLET,
      contextRuleId: 7,
      name: "x".repeat(MAX_CONTEXT_RULE_NAME + 1),
    })).rejects.toThrow("name must be 20 UTF-8 bytes or fewer");
  });

  it("rejects unicode rule names larger than 20 UTF-8 bytes", async () => {
    await expect(requestRenameContextRule({
      walletContractId: WALLET,
      contextRuleId: 1,
      name: "é".repeat(11),
    })).rejects.toThrow(/20/);
  });

  it("encodes expiration Some(u32) and None(void)", async () => {
    const some = invocation((await requestUpdateExpiration({
      walletContractId: WALLET,
      contextRuleId: 3,
      validUntil: 123_456,
    })).hostFuncXdr);
    const none = invocation((await requestUpdateExpiration({
      walletContractId: WALLET,
      contextRuleId: 3,
      validUntil: null,
    })).hostFuncXdr);

    expect(some.functionName().toString()).toBe("update_context_rule_valid_until");
    expect(some.args().map(scValToNative)).toEqual([3, 123_456]);
    expect(none.args()[1].switch().name).toBe("scvVoid");
  });

  it("does not report an expiration clear as saved without chain confirmation", () => {
    expect(() => assertTransactionSuccess("SUCCESS")).not.toThrow();
    expect(() => assertTransactionSuccess("FAILED")).toThrow(
      "Transaction failed on-chain; no changes were saved.",
    );
    expect(() => assertTransactionSuccess("NOT_FOUND")).toThrow(
      "Transaction was not confirmed; no changes are shown as saved.",
    );
  });

  it("submits the blank expiration visible in the DOM even if React state is stale", () => {
    const onUpdateExpiration = vi.fn();
    render(createElement(RuleCard, {
      rule: {
        id: 3,
        name: "Rule 3",
        contextType: "Default",
        signers: [],
        signerIds: [],
        policies: [],
        policyIds: [],
        validUntil: 123_456,
      },
      latestLedger: 100,
      policyMeta: new Map(),
      actionInProgress: null,
      onRename: vi.fn(),
      onDelete: vi.fn(),
      onUpdateExpiration,
    }));

    fireEvent.click(screen.getByRole("heading", { name: "Rule 3" }));
    fireEvent.click(screen.getByRole("button", { name: "Expiration" }));
    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "");
    expect(input.value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onUpdateExpiration).toHaveBeenCalledWith(3, null);
  });

  it("validates the blank name visible in the DOM even if React state is stale", () => {
    const onRename = vi.fn();
    render(createElement(RuleCard, {
      rule: {
        id: 3,
        name: "Rule 3",
        contextType: "Default",
        signers: [],
        signerIds: [],
        policies: [],
        policyIds: [],
      },
      latestLedger: 100,
      policyMeta: new Map(),
      actionInProgress: null,
      onRename,
      onDelete: vi.fn(),
      onUpdateExpiration: vi.fn(),
    }));

    fireEvent.click(screen.getByRole("heading", { name: "Rule 3" }));
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByRole("textbox") as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByText("Name is required.")).toBeTruthy();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(onRename).not.toHaveBeenCalled();
  });

  it("does not render the empty-wallet state when rule loading failed", async () => {
    routeMocks.loadWallet.mockReturnValue({
      contractId: WALLET,
      credentialId: "credential",
      publicKey: "00",
    });
    routeMocks.requestContextRules.mockResolvedValue({
      success: false,
      error: "Contract returned an invalid context rule count",
      rules: [],
    });
    const latestLedger = vi.spyOn(rpc.Server.prototype, "getLatestLedger")
      .mockResolvedValue({ sequence: 100 } as any);

    render(createElement(RulesManager));

    expect(await screen.findByText("Contract returned an invalid context rule count")).toBeTruthy();
    expect(screen.queryByText("No context rules found on this wallet.")).toBeNull();
    latestLedger.mockRestore();
  });

  it("rejects expiration values above u32", async () => {
    await expect(requestUpdateExpiration({
      walletContractId: WALLET,
      contextRuleId: 1,
      validUntil: MAX_U32 + 1,
    })).rejects.toThrow(`whole number from 0 to ${MAX_U32}`);
  });

  it("rejects fractional expiration values instead of truncating them", async () => {
    await expect(requestUpdateExpiration({
      walletContractId: WALLET,
      contextRuleId: 1,
      validUntil: 1.9,
    })).rejects.toThrow(`whole number from 0 to ${MAX_U32}`);
  });

  it.each([
    ["remove", () => requestRemoveContextRule({ walletContractId: "", contextRuleId: 1 }), "walletContractId required"],
    ["rename", () => requestRenameContextRule({ walletContractId: WALLET, contextRuleId: -1, name: "ok" }), "contextRuleId must be a non-negative number"],
    ["expiration", () => requestUpdateExpiration({ walletContractId: WALLET, contextRuleId: 1, validUntil: -1 }), `validUntil must be a whole number from 0 to ${MAX_U32}, or null`],
  ])("validates invalid %s input before building XDR", async (_name, request, error) => {
    await expect(request()).rejects.toThrow(error);
  });
});
