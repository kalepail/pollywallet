import { useState, useEffect, useCallback } from "react";
import { Buffer } from "buffer";
import base64url from "base64url";
import {
  Account,
  Keypair,
  hash,
  xdr,
  Address,
  TransactionBuilder,
  Operation,
  StrKey,
  scValToNative,
} from "@stellar/stellar-sdk";
import { rpc } from "@stellar/stellar-sdk";
import { submitToRelayer, signAndSubmitDeploy } from "../lib/relayer";
import {
  createPasskey,
  signWithPasskey,
  buildKeyData,
  buildSignaturePayload,
  buildAuthDigest,
  buildWebAuthnSigBytes,
  writeAuthPayload,
  signKeypairAuthEntries,
  deriveContractAddress,
  toI128,
  parseXlmToStroops,
  saveWallet,
  loadWallet,
  clearWallet,
  TESTNET_RPC_URL,
  TESTNET_NETWORK_PASSPHRASE,
  TESTNET_ACCOUNT_WASM_HASH,
  TESTNET_WEBAUTHN_VERIFIER,
  TESTNET_NATIVE_TOKEN_CONTRACT,
  FRIENDBOT_URL,
  DEPLOYER_PUBLIC_KEY,
  LEDGERS_PER_HOUR,
  STROOPS_PER_XLM,
} from "../lib/passkey";
import type { StoredWallet } from "../lib/passkey";
import { requestContextRules, type ContextRuleInfo } from "../lib/context-rules";

const BASE_FEE = "1000000";
const server = new rpc.Server(TESTNET_RPC_URL);

/** Friendbot gives 10,000 XLM. Reserve 5 XLM in the temp account for the transfer fee + base reserve. */
const FRIENDBOT_TRANSFER_XLM = 9_995n;

/** Key for persisting ephemeral signer secrets in localStorage. */
const EPHEMERAL_SIGNERS_KEY = "pollywallet:ephemeral-signers";

function loadEphemeralSigners(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(EPHEMERAL_SIGNERS_KEY) || "{}");
  } catch { return {}; }
}

function saveEphemeralSigner(publicKey: string, secret: string) {
  const signers = loadEphemeralSigners();
  signers[publicKey] = secret;
  localStorage.setItem(EPHEMERAL_SIGNERS_KEY, JSON.stringify(signers));
}

export function useWallet() {
  const [wallet, setWallet] = useState<StoredWallet | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [destination, setDestination] = useState("");
  const [amount, setAmount] = useState("");
  const [contextRules, setContextRules] = useState<ContextRuleInfo[]>([]);
  const [selectedRuleId, setSelectedRuleId] = useState<number>(0);
  const [rulesLoading, setRulesLoading] = useState(false);

  useEffect(() => {
    const stored = loadWallet();
    if (stored) setWallet(stored);
  }, []);

  // Fetch context rules when wallet is available
  const fetchRules = useCallback(async (contractId: string) => {
    setRulesLoading(true);
    try {
      const result = await requestContextRules(contractId);
      if (result.success) {
        setContextRules(result.rules);
      }
    } catch { /* best effort */ }
    finally { setRulesLoading(false); }
  }, []);

  useEffect(() => {
    if (wallet) fetchRules(wallet.contractId);
  }, [wallet, fetchRules]);

  const fetchBalance = useCallback(async (contractId: string) => {
    try {
      const balanceKey = xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol("Balance"),
        xdr.ScVal.scvAddress(Address.fromString(contractId).toScAddress()),
      ]);
      const data = await server.getContractData(TESTNET_NATIVE_TOKEN_CONTRACT, balanceKey);
      const parsed = scValToNative(data.val.contractData().val());
      const amount = typeof parsed === "object" && parsed.amount != null
        ? BigInt(parsed.amount)
        : (typeof parsed === "bigint" ? parsed : 0n);
      setBalance((Number(amount) / STROOPS_PER_XLM).toFixed(2));
    } catch {
      setBalance("0.00");
    }
  }, []);

  // TODO: Add periodic polling or subscription so balance updates on external receives.
  useEffect(() => {
    if (wallet) fetchBalance(wallet.contractId);
  }, [wallet, fetchBalance]);

  const handleCreate = async () => {
    setLoading(true);
    setStatus("Creating passkey...");

    try {
      const { credentialId, publicKey } = await createPasskey("PollyWallet", "user");

      setStatus("Building deploy...");

      const keyData = buildKeyData(publicKey, credentialId);
      const signerXdr = xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol("External"),
        xdr.ScVal.scvAddress(Address.fromString(TESTNET_WEBAUTHN_VERIFIER).toScAddress()),
        xdr.ScVal.scvBytes(keyData),
      ]);

      const credIdBuf = base64url.toBuffer(credentialId);
      const saltHash = hash(credIdBuf);
      const finalContractId = deriveContractAddress(
        credIdBuf, DEPLOYER_PUBLIC_KEY, TESTNET_NETWORK_PASSPHRASE
      );

      const deployFunc = Operation.createCustomContract({
        address: Address.fromString(DEPLOYER_PUBLIC_KEY),
        wasmHash: Buffer.from(TESTNET_ACCOUNT_WASM_HASH, "hex"),
        salt: saltHash,
        constructorArgs: [
          xdr.ScVal.scvVec([signerXdr]),
          xdr.ScVal.scvMap([]),
        ],
      });

      setStatus("Preparing deploy...");

      // Build unsigned transaction — signing happens server-side
      const sourceAccount = await server.getAccount(DEPLOYER_PUBLIC_KEY);
      const unsignedTx = new TransactionBuilder(sourceAccount, {
        fee: "100",
        networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
      })
        .addOperation(deployFunc)
        .setTimeout(30)
        .build();

      setStatus("Deploying via relayer...");
      const deployResult = await signAndSubmitDeploy({ data: { unsignedXdr: unsignedTx.toXDR() } });
      if (!deployResult.success) throw new Error(deployResult.error || "Deploy failed");

      if (deployResult.hash) {
        await server.pollTransaction(deployResult.hash, { attempts: 15 });
      }

      const walletData: StoredWallet = {
        credentialId,
        contractId: finalContractId,
        publicKey: Buffer.from(publicKey).toString("hex"),
      };
      saveWallet(walletData);
      setWallet(walletData);
      setStatus("Wallet created!");
    } catch (err: any) {
      console.error("Create wallet error:", err);
      setStatus(`Error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleFund = async () => {
    if (!wallet) return;
    setLoading(true);
    setStatus("Requesting testnet XLM...");

    try {
      const tempKeypair = Keypair.random();
      const res = await fetch(`${FRIENDBOT_URL}?addr=${tempKeypair.publicKey()}`);
      if (!res.ok) throw new Error("Friendbot failed");

      setStatus("Transferring to smart wallet via relayer...");

      const transferAmount = FRIENDBOT_TRANSFER_XLM * BigInt(STROOPS_PER_XLM);
      const hostFunc = buildSacTransferFunc(
        tempKeypair.publicKey(), wallet.contractId, transferAmount
      );

      const sourceAccount = await server.getAccount(tempKeypair.publicKey());
      const simTx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
      })
        .addOperation(Operation.invokeHostFunction({ func: hostFunc, auth: [] }))
        .setTimeout(30)
        .build();

      const simResult = await server.simulateTransaction(simTx);
      if ("error" in simResult) throw new Error(`Simulation failed: ${(simResult as any).error}`);
      const simSuccess = simResult as rpc.Api.SimulateTransactionSuccessResponse;

      const signedAuth = signKeypairAuthEntries(
        simSuccess.result?.auth ?? [], tempKeypair,
        simSuccess.latestLedger + LEDGERS_PER_HOUR, TESTNET_NETWORK_PASSPHRASE
      );

      const relayerResult = await submitToRelayer({
        data: {
          func: hostFunc.toXDR("base64"),
          auth: signedAuth.map((e) => e.toXDR("base64")),
        },
      });
      if (!relayerResult.success) throw new Error(relayerResult.error || "Fund via relayer failed");

      if (relayerResult.hash) {
        await server.pollTransaction(relayerResult.hash, { attempts: 15 });
      }

      await fetchBalance(wallet.contractId);
      setStatus("Funded!");
    } catch (err: any) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleTransfer = async () => {
    if (!wallet || !destination || !amount) return;
    setLoading(true);
    setStatus("Building transfer...");

    try {
      if (!StrKey.isValidEd25519PublicKey(destination) && !StrKey.isValidContract(destination)) {
        throw new Error("Invalid destination address");
      }

      const amountStroops = parseXlmToStroops(amount);

      if (balance !== null) {
        const balanceStroops = parseXlmToStroops(balance);
        if (amountStroops > balanceStroops) {
          throw new Error(`Insufficient balance: you have ${balance} XLM`);
        }
      }

      const keyData = buildKeyData(Buffer.from(wallet.publicKey, "hex"), wallet.credentialId);
      const signer = { tag: "External" as const, values: [TESTNET_WEBAUTHN_VERIFIER, keyData] as const };

      // Smart account calls SAC.transfer via execute()
      const executeHostFunc = xdr.HostFunction.hostFunctionTypeInvokeContract(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(wallet.contractId).toScAddress(),
          functionName: "execute",
          args: [
            xdr.ScVal.scvAddress(Address.fromString(TESTNET_NATIVE_TOKEN_CONTRACT).toScAddress()),
            xdr.ScVal.scvSymbol("transfer"),
            xdr.ScVal.scvVec([
              xdr.ScVal.scvAddress(Address.fromString(wallet.contractId).toScAddress()),
              xdr.ScVal.scvAddress(Address.fromString(destination).toScAddress()),
              toI128(amountStroops),
            ]),
          ],
        })
      );

      setStatus("Simulating transfer...");
      const simAccount = new Account(Keypair.random().publicKey(), "0");
      const simTx = new TransactionBuilder(simAccount, {
        fee: BASE_FEE,
        networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
      })
        .addOperation(Operation.invokeHostFunction({ func: executeHostFunc, auth: [] }))
        .setTimeout(30)
        .build();

      const simResult = await server.simulateTransaction(simTx);
      if ("error" in simResult) throw new Error(`Simulation failed: ${(simResult as any).error}`);
      const simSuccess = simResult as rpc.Api.SimulateTransactionSuccessResponse;

      const authEntries = simSuccess.result?.auth ?? [];
      const expiration = simSuccess.latestLedger + LEDGERS_PER_HOUR;

      // Sign auth entries — method depends on which context rule is selected
      const selectedRule = contextRules.find(r => r.id === selectedRuleId);
      const usingDelegatedSigner = selectedRule && selectedRule.signers.some(s => s.type === "Delegated");
      const delegatedSignerAddr = selectedRule?.signers.find(s => s.type === "Delegated")?.address;
      const ephemeralSecret = delegatedSignerAddr ? loadEphemeralSigners()[delegatedSignerAddr] : null;

      if (usingDelegatedSigner && !ephemeralSecret) {
        throw new Error(`No stored secret for Delegated signer ${delegatedSignerAddr}. The ephemeral key from policy install may have been lost.`);
      }

      if (usingDelegatedSigner && ephemeralSecret) {
        setStatus("Signing with ephemeral key...");
      } else {
        setStatus("Sign with your passkey...");
      }

      const signedAuthEntries: xdr.SorobanAuthorizationEntry[] = [];
      for (const entry of authEntries) {
        const credType = entry.credentials().switch().name;

        if (credType === "sorobanCredentialsAddress") {
          const credentials = entry.credentials().address();
          credentials.signatureExpirationLedger(expiration);

          if (Address.fromScAddress(credentials.address()).toString() === wallet.contractId) {
            if (usingDelegatedSigner && ephemeralSecret) {
              // Policy-enforced rule: sign with ephemeral Delegated keypair
              const ephemeralKeypair = Keypair.fromSecret(ephemeralSecret);
              const sigPayload = buildSignaturePayload(TESTNET_NETWORK_PASSPHRASE, entry, expiration);
              const authDigest = buildAuthDigest(sigPayload, [selectedRuleId]);

              // Build Delegated signer ScVal
              const delegatedSignerScVal = xdr.ScVal.scvVec([
                xdr.ScVal.scvSymbol("Delegated"),
                xdr.ScVal.scvAddress(Address.fromString(ephemeralKeypair.publicKey()).toScAddress()),
              ]);

              const signature = ephemeralKeypair.sign(authDigest);

              credentials.signature(xdr.ScVal.scvMap([
                new xdr.ScMapEntry({
                  key: xdr.ScVal.scvSymbol("context_rule_ids"),
                  val: xdr.ScVal.scvVec([xdr.ScVal.scvU32(selectedRuleId)]),
                }),
                new xdr.ScMapEntry({
                  key: xdr.ScVal.scvSymbol("signers"),
                  val: xdr.ScVal.scvMap([
                    new xdr.ScMapEntry({
                      key: delegatedSignerScVal,
                      val: xdr.ScVal.scvBytes(signature),
                    }),
                  ]),
                }),
              ]));
            } else {
              // Default rule: sign with passkey
              const sigPayload = buildSignaturePayload(TESTNET_NETWORK_PASSPHRASE, entry, expiration);
              const authDigest = buildAuthDigest(sigPayload, [selectedRuleId]);
              const webAuthnResult = await signWithPasskey(wallet.credentialId, authDigest);
              credentials.signature(
                writeAuthPayload([selectedRuleId], signer, buildWebAuthnSigBytes(webAuthnResult))
              );
            }
          }
          signedAuthEntries.push(entry);
        } else {
          signedAuthEntries.push(entry);
        }
      }

      setStatus("Submitting via relayer...");

      // Serialize for relayer — catch serialization errors separately
      let funcXdr: string;
      let authXdr: string[];
      try {
        funcXdr = executeHostFunc.toXDR("base64");
        authXdr = signedAuthEntries.map((e) => e.toXDR("base64"));
      } catch (serErr: any) {
        throw new Error(`Failed to serialize auth entries: ${serErr.message}`);
      }

      const relayerResult = await submitToRelayer({ data: { func: funcXdr, auth: authXdr } });
      if (!relayerResult) {
        throw new Error("Relayer returned undefined — check server function configuration");
      }
      if (!relayerResult.success) throw new Error(relayerResult.error || "Relayer failed");

      if (relayerResult.hash) {
        await server.pollTransaction(relayerResult.hash, { attempts: 15 });
      }

      await fetchBalance(wallet.contractId);
      setAmount("");
      setDestination("");
      setStatus("Transfer sent!");
    } catch (err: any) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnect = () => {
    clearWallet();
    setWallet(null);
    setBalance(null);
    setStatus("");
  };

  const handleCopy = () => {
    if (wallet) {
      navigator.clipboard.writeText(wallet.contractId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return {
    wallet, balance, status, loading, copied, destination, amount,
    contextRules, selectedRuleId, rulesLoading,
    setDestination, setAmount, setSelectedRuleId,
    handleCreate, handleFund, handleTransfer, handleDisconnect, handleCopy,
    fetchRules, saveEphemeralSigner,
  };
}

function buildSacTransferFunc(from: string, to: string, amount: bigint): xdr.HostFunction {
  return xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: Address.fromString(TESTNET_NATIVE_TOKEN_CONTRACT).toScAddress(),
      functionName: "transfer",
      args: [
        xdr.ScVal.scvAddress(Address.fromString(from).toScAddress()),
        xdr.ScVal.scvAddress(Address.fromString(to).toScAddress()),
        toI128(amount),
      ],
    })
  );
}
