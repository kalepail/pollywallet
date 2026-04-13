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
import { signAndSubmitDeploy } from "../lib/relayer";
import { requestSubmitToRelayer } from "../lib/policy-deploy";
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
  TESTNET_ED25519_VERIFIER,
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

      const relayerResult = await requestSubmitToRelayer({
        func: hostFunc.toXDR("base64"),
        auth: signedAuth.map((e) => e.toXDR("base64")),
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

      // Determine the selected context rule
      const selectedRule = contextRules.find(r => r.id === selectedRuleId);
      const usingPolicyRule = selectedRule && selectedRule.policies.length > 0;

      // Build the host function based on context rule type:
      // - Default rule: wallet.execute(target, fn, args) — passkey signs the execute call
      // - CallContract rule: SAC.transfer(wallet, dest, amount) — direct call triggers
      //   wallet's __check_auth with Context::Contract(SAC, "transfer", ...) which
      //   matches the CallContract(SAC) context rule and runs the policy's enforce()
      let hostFunc: xdr.HostFunction;
      if (usingPolicyRule && selectedRule?.contextType === "CallContract") {
        // Direct SAC transfer — the wallet's __check_auth is triggered by
        // SAC calling require_auth(wallet) inside transfer()
        hostFunc = xdr.HostFunction.hostFunctionTypeInvokeContract(
          new xdr.InvokeContractArgs({
            contractAddress: Address.fromString(TESTNET_NATIVE_TOKEN_CONTRACT).toScAddress(),
            functionName: "transfer",
            args: [
              xdr.ScVal.scvAddress(Address.fromString(wallet.contractId).toScAddress()),
              xdr.ScVal.scvAddress(Address.fromString(destination).toScAddress()),
              toI128(amountStroops),
            ],
          })
        );
      } else {
        // Default: wallet.execute() wrapper
        hostFunc = xdr.HostFunction.hostFunctionTypeInvokeContract(
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
      }

      // Find the ephemeral signer — supports both External (ed25519 verifier) and legacy Delegated signers.
      const ephemeralSigner = selectedRule?.signers.find(s => s.type === "External" || s.type === "Delegated");
      let ephemeralSecret: string | null = null;
      if (ephemeralSigner) {
        if (ephemeralSigner.type === "External" && ephemeralSigner.keyData) {
          // External signer: derive G-address from raw public key to look up the stored secret
          const gAddr = Keypair.fromRawEd25519PublicKey(Buffer.from(ephemeralSigner.keyData)).publicKey();
          ephemeralSecret = loadEphemeralSigners()[gAddr] ?? null;
        } else {
          ephemeralSecret = loadEphemeralSigners()[ephemeralSigner.address] ?? null;
        }
      }

      if (usingPolicyRule && !ephemeralSecret) {
        throw new Error("No stored secret for ephemeral signer — reinstall the policy to generate a new key.");
      }

      // --- Pass 1: Simulate to get auth entries ---
      setStatus("Simulating transfer...");

      // Use the deployer account (always funded) as simulation source.
      // Policy transfers need a real account with a valid sequence number.
      const simAccount = usingPolicyRule
        ? await server.getAccount(DEPLOYER_PUBLIC_KEY)
        : new Account(Keypair.random().publicKey(), "0");
      const simTx = new TransactionBuilder(simAccount, {
        fee: BASE_FEE,
        networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
      })
        .addOperation(Operation.invokeHostFunction({ func: hostFunc, auth: [] }))
        .setTimeout(30)
        .build();

      const simResult = await server.simulateTransaction(simTx);
      if ("error" in simResult) throw new Error(`Simulation failed: ${(simResult as any).error}`);
      const simSuccess = simResult as rpc.Api.SimulateTransactionSuccessResponse;
      const authEntries = simSuccess.result?.auth ?? [];
      const expiration = simSuccess.latestLedger + LEDGERS_PER_HOUR;

      let signedAuthEntries: xdr.SorobanAuthorizationEntry[];

      if (usingPolicyRule && ephemeralSecret) {
        // --- Policy-enforced: External signer with ed25519 verifier ---
        // Signs the auth_digest directly with the ephemeral ed25519 key.
        // The signature goes inline in the wallet's AuthPayload — no separate
        // auth entry needed (unlike Delegated signers which require the account
        // to exist on the ledger for require_auth_for_args).
        setStatus("Signing with ephemeral key...");
        const ephemeralKeypair = Keypair.fromSecret(ephemeralSecret);

        const walletEntry = authEntries.find(e => {
          if (e.credentials().switch().name !== "sorobanCredentialsAddress") return false;
          return Address.fromScAddress(e.credentials().address().address()).toString() === wallet.contractId;
        });
        if (!walletEntry) throw new Error("No auth entry found for wallet");

        walletEntry.credentials().address().signatureExpirationLedger(expiration);

        const sigPayload = buildSignaturePayload(TESTNET_NETWORK_PASSPHRASE, walletEntry, expiration);
        const authDigest = buildAuthDigest(sigPayload, [selectedRuleId]);

        // ed25519 sign the auth_digest directly — the verifier contract
        // calls e.crypto().ed25519_verify(pubkey, auth_digest, signature)
        const ed25519Sig = ephemeralKeypair.sign(Buffer.from(authDigest));

        // Build AuthPayload with External signer, same pattern as the passkey
        const rawPubkey = ephemeralKeypair.rawPublicKey();
        const signer = {
          tag: "External" as const,
          values: [TESTNET_ED25519_VERIFIER, Buffer.from(rawPubkey)] as const,
        };
        walletEntry.credentials().address().signature(
          writeAuthPayload([selectedRuleId], signer, Buffer.from(ed25519Sig))
        );

        signedAuthEntries = [walletEntry];
      } else {
        // --- Default: passkey signing ---
        setStatus("Sign with your passkey...");
        signedAuthEntries = [];
        for (const entry of authEntries) {
          const credType = entry.credentials().switch().name;
          if (credType === "sorobanCredentialsAddress") {
            const credentials = entry.credentials().address();
            credentials.signatureExpirationLedger(expiration);
            if (Address.fromScAddress(credentials.address()).toString() === wallet.contractId) {
              const sigPayload = buildSignaturePayload(TESTNET_NETWORK_PASSPHRASE, entry, expiration);
              const authDigest = buildAuthDigest(sigPayload, [selectedRuleId]);
              const webAuthnResult = await signWithPasskey(wallet.credentialId, authDigest);
              credentials.signature(
                writeAuthPayload([selectedRuleId], signer, buildWebAuthnSigBytes(webAuthnResult))
              );
            }
          }
          signedAuthEntries.push(entry);
        }
      }

      setStatus("Submitting via relayer...");

      // Serialize for relayer — catch serialization errors separately
      let funcXdr: string;
      let authXdr: string[];
      try {
        funcXdr = hostFunc.toXDR("base64");
        authXdr = signedAuthEntries.map((e) => e.toXDR("base64"));
      } catch (serErr: any) {
        throw new Error(`Failed to serialize auth entries: ${serErr.message}`);
      }

      const relayerResult = await requestSubmitToRelayer({ func: funcXdr, auth: authXdr });
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
