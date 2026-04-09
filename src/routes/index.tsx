import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useCallback } from "react";
import { Buffer } from "buffer";
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
import type { Signer } from "multisig-account";
import { submitToRelayer } from "../lib/relayer";
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
  saveWallet,
  loadWallet,
  clearWallet,
  TESTNET_RPC_URL,
  TESTNET_NETWORK_PASSPHRASE,
  TESTNET_ACCOUNT_WASM_HASH,
  TESTNET_WEBAUTHN_VERIFIER,
  TESTNET_NATIVE_TOKEN_CONTRACT,
  FRIENDBOT_URL,
  DEPLOYER_KEYPAIR,
  LEDGERS_PER_HOUR,
  STROOPS_PER_XLM,
} from "../lib/passkey";
import type { StoredWallet } from "../lib/passkey";
import { Wallet, Plus, Send, Coins, LogOut, Copy, Check, Loader2 } from "lucide-react";

export const Route = createFileRoute("/")({ component: App });

const BASE_FEE = "1000000";
const server = new rpc.Server(TESTNET_RPC_URL);

function App() {
  const [wallet, setWallet] = useState<StoredWallet | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [destination, setDestination] = useState("");
  const [amount, setAmount] = useState("");

  useEffect(() => {
    const stored = loadWallet();
    if (stored) setWallet(stored);
  }, []);

  useEffect(() => {
    if (wallet) fetchBalance(wallet.contractId);
  }, [wallet]);

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

  // --- Create Wallet ---
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

      const credIdBuf = Buffer.from(base64urlToBuffer(credentialId));
      const saltHash = hash(credIdBuf);
      const finalContractId = deriveContractAddress(
        credIdBuf, DEPLOYER_KEYPAIR.publicKey(), TESTNET_NETWORK_PASSPHRASE
      );

      const deployFunc = Operation.createCustomContract({
        address: Address.fromString(DEPLOYER_KEYPAIR.publicKey()),
        wasmHash: Buffer.from(TESTNET_ACCOUNT_WASM_HASH, "hex"),
        salt: saltHash,
        constructorArgs: [
          xdr.ScVal.scvVec([signerXdr]),
          xdr.ScVal.scvMap([]),
        ],
      });

      setStatus("Preparing deploy...");

      // Ensure deployer exists (idempotent — friendbot is a no-op if already funded)
      await fetch(`${FRIENDBOT_URL}?addr=${DEPLOYER_KEYPAIR.publicKey()}`).catch(() => {});

      const sourceAccount = await server.getAccount(DEPLOYER_KEYPAIR.publicKey());
      const simTx = new TransactionBuilder(sourceAccount, {
        fee: "100",
        networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
      })
        .addOperation(deployFunc)
        .setTimeout(30)
        .build();

      setStatus("Simulating deploy...");
      const simResult = await server.simulateTransaction(simTx);
      if ("error" in simResult) throw new Error(`Simulation failed: ${(simResult as any).error}`);

      const preparedTx = rpc
        .assembleTransaction(simTx, simResult as rpc.Api.SimulateTransactionSuccessResponse)
        .build();
      preparedTx.sign(DEPLOYER_KEYPAIR);

      setStatus("Deploying via relayer...");
      const deployResult = await submitToRelayer({ data: { xdr: preparedTx.toXDR() } });
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

  // --- Fund Wallet ---
  const handleFund = async () => {
    if (!wallet) return;
    setLoading(true);
    setStatus("Requesting testnet XLM...");

    try {
      const tempKeypair = Keypair.random();
      const res = await fetch(`${FRIENDBOT_URL}?addr=${tempKeypair.publicKey()}`);
      if (!res.ok) throw new Error("Friendbot failed");

      setStatus("Transferring to smart wallet via relayer...");

      const transferAmount = 9_995n * BigInt(STROOPS_PER_XLM);
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

  // --- Transfer XLM ---
  const handleTransfer = async () => {
    if (!wallet || !destination || !amount) return;
    setLoading(true);
    setStatus("Building transfer...");

    try {
      if (!StrKey.isValidEd25519PublicKey(destination) && !StrKey.isValidContract(destination)) {
        throw new Error("Invalid destination address");
      }

      const amountStroops = BigInt(Math.round(parseFloat(amount) * STROOPS_PER_XLM));

      const keyData = buildKeyData(Buffer.from(wallet.publicKey, "hex"), wallet.credentialId);
      const signer: Signer = { tag: "External", values: [TESTNET_WEBAUTHN_VERIFIER, keyData] };

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

      setStatus("Sign with your passkey...");

      const signedAuthEntries: xdr.SorobanAuthorizationEntry[] = [];
      for (const entry of authEntries) {
        const credType = entry.credentials().switch().name;

        if (credType === "sorobanCredentialsAddress") {
          const credentials = entry.credentials().address();
          credentials.signatureExpirationLedger(expiration);

          if (Address.fromScAddress(credentials.address()).toString() === wallet.contractId) {
            const sigPayload = buildSignaturePayload(TESTNET_NETWORK_PASSPHRASE, entry, expiration);
            const authDigest = buildAuthDigest(sigPayload, [0]);
            const webAuthnResult = await signWithPasskey(wallet.credentialId, authDigest);
            credentials.signature(
              writeAuthPayload([0], signer as any, buildWebAuthnSigBytes(webAuthnResult))
            );
          }
          signedAuthEntries.push(entry);
        } else {
          signedAuthEntries.push(entry);
        }
      }

      setStatus("Submitting via relayer...");

      const relayerResult = await submitToRelayer({
        data: {
          func: executeHostFunc.toXDR("base64"),
          auth: signedAuthEntries.map((e) => e.toXDR("base64")),
        },
      });
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

  if (!wallet) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center px-4">
        <div className="max-w-md w-full">
          <div className="text-center mb-8">
            <Wallet className="w-16 h-16 text-cyan-400 mx-auto mb-4" />
            <h1 className="text-4xl font-bold text-white mb-2">PollyWallet</h1>
            <p className="text-gray-400">Passkey-secured smart wallet on Stellar Testnet</p>
          </div>
          <button
            onClick={handleCreate}
            disabled={loading}
            className="w-full flex items-center justify-center gap-3 px-6 py-4 bg-cyan-500 hover:bg-cyan-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-colors shadow-lg shadow-cyan-500/25"
          >
            {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Plus className="w-5 h-5" />}
            Create Smart Wallet
          </button>
          {status && <p className="mt-4 text-sm text-center text-gray-400">{status}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-slate-800 to-slate-900 px-4 py-8">
      <div className="max-w-lg mx-auto space-y-6">
        <div className="bg-slate-800/50 border border-slate-700 rounded-2xl p-6">
          <p className="text-sm text-gray-400 mb-1">Balance</p>
          <p className="text-4xl font-bold text-white">
            {balance ?? "..."} <span className="text-lg text-gray-400">XLM</span>
          </p>
          <div className="mt-3 flex items-center gap-2">
            <code className="text-xs text-gray-500 truncate flex-1">{wallet.contractId}</code>
            <button onClick={handleCopy} className="text-gray-400 hover:text-white transition-colors" title="Copy address">
              {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
            </button>
          </div>
        </div>

        <button
          onClick={handleFund}
          disabled={loading}
          className="w-full flex items-center justify-center gap-3 px-6 py-3 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-colors"
        >
          {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Coins className="w-5 h-5" />}
          Fund with Friendbot
        </button>

        <div className="bg-slate-800/50 border border-slate-700 rounded-2xl p-6">
          <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
            <Send className="w-5 h-5 text-cyan-400" />
            Send XLM
          </h2>
          <div className="space-y-3">
            <input type="text" placeholder="Destination (G... or C...)" value={destination}
              onChange={(e) => setDestination(e.target.value)}
              className="w-full px-4 py-3 bg-slate-700/50 border border-slate-600 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:border-cyan-500 transition-colors" />
            <input type="number" placeholder="Amount (XLM)" value={amount}
              onChange={(e) => setAmount(e.target.value)} step="any" min="0"
              className="w-full px-4 py-3 bg-slate-700/50 border border-slate-600 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:border-cyan-500 transition-colors" />
            <button onClick={handleTransfer} disabled={loading || !destination || !amount}
              className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-cyan-500 hover:bg-cyan-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-colors"
            >
              {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-4 h-4" />}
              Send
            </button>
          </div>
        </div>

        {status && <p className="text-sm text-center text-gray-400">{status}</p>}

        <button onClick={handleDisconnect}
          className="w-full flex items-center justify-center gap-2 px-6 py-3 text-gray-400 hover:text-red-400 transition-colors"
        >
          <LogOut className="w-4 h-4" />
          Disconnect
        </button>
      </div>
    </div>
  );
}

// --- Helpers ---

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

function base64urlToBuffer(str: string): Uint8Array {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = base64.length % 4;
  const padded = pad ? base64 + "=".repeat(4 - pad) : base64;
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}
