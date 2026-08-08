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
  Asset,
  scValToNative,
} from "@stellar/stellar-sdk";
import { rpc } from "@stellar/stellar-sdk";
import { signAndSubmitDeploy } from "../lib/relayer";
import { requestSubmitToRelayer } from "../lib/policy-deploy";
import {
  createPasskey,
  authenticatePasskey,
  findSignerPublicKey,
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
  TESTNET_USDC_TOKEN_CONTRACT,
  TESTNET_USDC_ISSUER,
  FRIENDBOT_URL,
  DEPLOYER_PUBLIC_KEY,
  LEDGERS_PER_HOUR,
  STROOPS_PER_XLM,
  TESTNET_TOKENS,
  tokenContractFor,
} from "../lib/passkey";
import type { StoredWallet, TokenCode } from "../lib/passkey";
import { requestContextRules, type ContextRuleInfo } from "../lib/context-rules";
import { TESTNET_HORIZON_URL } from "../lib/constants";

const BASE_FEE = "1000000";
const server = new rpc.Server(TESTNET_RPC_URL);

/** Friendbot gives 10,000 XLM. Reserve 5 XLM in the temp account for the transfer fee + base reserve. */
const FRIENDBOT_TRANSFER_XLM = 9_995n;

/** XLM converted per USDC top-up. At testnet rates ~100 XLM buys ~180 USDC. */
const USDC_SWAP_XLM = "100";
/** Floor on the swap output, as a fraction of the quote, so a moving orderbook doesn't fail the tx. */
const SWAP_SLIPPAGE = 0.98;

/** Key for persisting ephemeral signer secrets in localStorage. */
const EPHEMERAL_SIGNERS_KEY = "pollywallet:ephemeral-signers";

function loadEphemeralSigners(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(EPHEMERAL_SIGNERS_KEY) || "{}");
  } catch { return {}; }
}

export function useWallet() {
  const [wallet, setWallet] = useState<StoredWallet | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  /** Lets the UI distinguish in-progress from success from failure, instead of
   *  rendering every message as the same grey line. */
  const [statusKind, setStatusKind] = useState<"idle" | "busy" | "done" | "error">("idle");
  /** Hash of the last successful transaction, for the explorer link. */
  const [lastTxHash, setLastTxHash] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [destination, setDestination] = useState("");
  const [amount, setAmount] = useState("");
  const [tokenCode, setTokenCode] = useState<TokenCode>("XLM");
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

  const fetchBalance = useCallback(async (contractId: string, token: string) => {
    try {
      const balanceKey = xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol("Balance"),
        xdr.ScVal.scvAddress(Address.fromString(contractId).toScAddress()),
      ]);
      const data = await server.getContractData(token, balanceKey);
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
    if (wallet) fetchBalance(wallet.contractId, tokenContractFor(tokenCode));
  }, [wallet, tokenCode, fetchBalance]);

  const handleCreate = async () => {
    setLoading(true);
    setStatus("Creating passkey...");
    setStatusKind("busy");
    setLastTxHash(null);

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

      // Simulate here in the browser. The server function only signs and submits: local
      // workerd cannot reach soroban-testnet.stellar.org, so keeping simulation server-side
      // broke wallet creation under `pnpm dev`.
      //
      // Simulate against a THROWAWAY account, never the deployer. The deployer authorizes the
      // deployment (its address is in the contract-id preimage) but must not source the
      // transaction: it is a shared, publicly-derivable account, so any balance it holds is
      // drainable by anyone and any third-party sequence bump breaks in-flight deploys. The
      // relayer's channel account pays — see signAndSubmitDeploy. Simulation spends nothing,
      // and this account is never submitted, so it does not need to exist or be funded.
      const simAccount = new Account(Keypair.random().publicKey(), "0");
      const unsignedTx = new TransactionBuilder(simAccount, {
        fee: "1000000",
        networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
      })
        .addOperation(deployFunc)
        .setTimeout(30)
        .build();

      const deploySim = await server.simulateTransaction(unsignedTx);
      if ("error" in deploySim) {
        throw new Error(`Simulation failed: ${(deploySim as any).error}`);
      }
      const simSuccess = deploySim as rpc.Api.SimulateTransactionSuccessResponse;

      setStatus("Deploying via relayer...");
      const deployResult = await signAndSubmitDeploy({
        data: {
          func: deployFunc.body().invokeHostFunctionOp().hostFunction().toXDR("base64"),
          auth: (simSuccess.result?.auth ?? []).map((e) => e.toXDR("base64")),
          validUntilLedger: simSuccess.latestLedger + LEDGERS_PER_HOUR,
        },
      });
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
      setStatusKind("done");
    } catch (err: any) {
      console.error("Create wallet error:", err);
      setStatus(err.message || "Something went wrong");
      setStatusKind("error");
    } finally {
      setLoading(false);
    }
  };

  /**
   * Sign in to an existing wallet on a device that has the passkey but not the localStorage
   * entry — a second browser, a cleared cache, or after Disconnect.
   *
   * Nothing has to be deployed or looked up to find the wallet: the contract id is a pure
   * function of the credential id (it is the salt), so deriving it is offline. The lookup is
   * only to recover the public key, which WebAuthn does not return on authentication.
   */
  const handleSignIn = async () => {
    setLoading(true);
    setStatus("Sign in with your passkey...");
    setStatusKind("busy");
    setLastTxHash(null);

    try {
      const credentialId = await authenticatePasskey();
      const credIdBuf = base64url.toBuffer(credentialId);
      const contractId = deriveContractAddress(
        credIdBuf, DEPLOYER_PUBLIC_KEY, TESTNET_NETWORK_PASSPHRASE
      );

      setStatus("Looking up your wallet...");
      const rulesResult = await requestContextRules(contractId);
      if (!rulesResult.success) {
        // requestContextRules collapses every failure into success:false, so a flaky RPC looks
        // identical to a wallet that was never deployed. Only the latter should suggest
        // creating one — telling a user with a temporary network fault to "create instead"
        // mints a second wallet and strands the funds in the first.
        throw new Error(
          rulesResult.error?.includes("MissingValue")
            ? "No wallet found for that passkey — create one instead."
            : "Couldn't reach the network to load your wallet — try again."
        );
      }

      // Sign-in trusts whatever the contract at this address reports as its signers, so
      // confirm it IS a wallet before believing any of it. The deployer key is publicly
      // derivable (see relayer.ts), so anyone can deploy arbitrary WASM at a derived address —
      // after a testnet reset, someone holding an old credential id could squat the address
      // with an ABI-compatible impostor reporting plausible signers, and quietly receive
      // anything sent to it. Runs after the lookup so a missing contract still gets the
      // clearer error above; nothing from the rules is used until this passes.
      const executable = (await server.getContractInstance(contractId)).executable();
      if (
        executable.switch().name !== "contractExecutableWasm" ||
        Buffer.from(executable.wasmHash()).toString("hex") !== TESTNET_ACCOUNT_WASM_HASH
      ) {
        throw new Error("The contract at that address is not a PollyWallet smart account.");
      }

      // Find the RULE the passkey signs under, not just the key. Signing sends
      // context_rule_ids alongside the signature, so a passkey that lives on rule 7 (rule 0
      // deleted, signer moved) would sign in fine and then have every transfer rejected for
      // presenting rule 0 — which selectedRuleId otherwise defaults to.
      const match = rulesResult.rules
        .map((rule) => ({ rule, publicKey: findSignerPublicKey(rule.signers, credIdBuf) }))
        .find((m) => m.publicKey !== null);
      if (!match?.publicKey) {
        throw new Error("That passkey is no longer a signer on its wallet.");
      }
      const publicKey = match.publicKey;

      const walletData: StoredWallet = {
        credentialId,
        contractId,
        publicKey: Buffer.from(publicKey).toString("hex"),
      };
      saveWallet(walletData);
      setWallet(walletData);
      setContextRules(rulesResult.rules);
      setSelectedRuleId(match.rule.id);
      setStatus("Signed in!");
      setStatusKind("done");
    } catch (err: any) {
      setStatus(err.message || "Something went wrong");
      setStatusKind("error");
    } finally {
      setLoading(false);
    }
  };

  const handleFund = async () => {
    if (!wallet) return;
    setLoading(true);
    setStatus("Requesting testnet XLM...");
    setStatusKind("busy");
    setLastTxHash(null);

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

      await fetchBalance(wallet.contractId, tokenContractFor(tokenCode));
      if (relayerResult.hash) setLastTxHash(relayerResult.hash);
      setStatus("Funded!");
      setStatusKind("done");
    } catch (err: any) {
      setStatus(err.message || "Something went wrong");
      setStatusKind("error");
    } finally {
      setLoading(false);
    }
  };

  /**
   * Get USDC into the wallet without Circle's Captcha-gated faucet: friendbot a
   * throwaway classic account, swap XLM for USDC on the SDEX with a path
   * payment, then SAC-transfer the proceeds in. The wallet is a contract
   * address, so it holds the SAC balance directly and needs no trustline —
   * only the throwaway account does.
   */
  const handleFundUsdc = async () => {
    if (!wallet) return;
    setLoading(true);
    setStatus("Requesting testnet XLM...");
    setStatusKind("busy");
    setLastTxHash(null);

    try {
      const tempKeypair = Keypair.random();
      const friendbotRes = await fetch(`${FRIENDBOT_URL}?addr=${tempKeypair.publicKey()}`);
      if (!friendbotRes.ok) throw new Error("Friendbot failed");

      setStatus("Quoting XLM → USDC...");
      const usdc = new Asset("USDC", TESTNET_USDC_ISSUER);
      const quoteRes = await fetch(
        `${TESTNET_HORIZON_URL}/paths/strict-send?source_asset_type=native` +
        `&source_amount=${USDC_SWAP_XLM}&destination_assets=USDC%3A${TESTNET_USDC_ISSUER}`
      );
      const quote = await quoteRes.json() as any;
      const best = quote?._embedded?.records?.[0];
      if (!best) throw new Error("No XLM → USDC path on testnet right now — try again shortly");
      const destMin = (Number(best.destination_amount) * SWAP_SLIPPAGE).toFixed(7);

      setStatus(`Swapping ${USDC_SWAP_XLM} XLM for ~${Number(best.destination_amount).toFixed(2)} USDC...`);
      const tempAccount = await server.getAccount(tempKeypair.publicKey());
      const swapTx = new TransactionBuilder(tempAccount, {
        fee: BASE_FEE,
        networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
      })
        .addOperation(Operation.changeTrust({ asset: usdc }))
        .addOperation(Operation.pathPaymentStrictSend({
          sendAsset: Asset.native(),
          sendAmount: USDC_SWAP_XLM,
          destination: tempKeypair.publicKey(),
          destAsset: usdc,
          destMin,
          path: (best.path ?? []).map((a: any) =>
            a.asset_type === "native" ? Asset.native() : new Asset(a.asset_code, a.asset_issuer)
          ),
        }))
        .setTimeout(60)
        .build();
      swapTx.sign(tempKeypair);

      const swapSent = await server.sendTransaction(swapTx);
      if (swapSent.status === "ERROR") {
        throw new Error(`Swap rejected: ${JSON.stringify(swapSent.errorResult)}`);
      }
      const swapFinal = await server.pollTransaction(swapSent.hash, { attempts: 20 });
      if (swapFinal.status !== "SUCCESS") throw new Error(`Swap failed: ${swapFinal.status}`);

      // Move everything the swap actually produced, not the quote — the fill can beat destMin.
      const accountRes = await fetch(`${TESTNET_HORIZON_URL}/accounts/${tempKeypair.publicKey()}`);
      const accountJson = await accountRes.json() as any;
      const usdcBalance = accountJson.balances?.find(
        (b: any) => b.asset_code === "USDC" && b.asset_issuer === TESTNET_USDC_ISSUER
      );
      const usdcStroops = BigInt(Math.floor(Number(usdcBalance?.balance ?? 0) * STROOPS_PER_XLM));
      if (usdcStroops === 0n) throw new Error("Swap settled but produced no USDC");

      setStatus("Transferring USDC to smart wallet...");
      const hostFunc = buildSacTransferFunc(
        tempKeypair.publicKey(), wallet.contractId, usdcStroops, TESTNET_USDC_TOKEN_CONTRACT
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
      if (!relayerResult.success) throw new Error(relayerResult.error || "USDC transfer via relayer failed");
      if (relayerResult.hash) {
        await server.pollTransaction(relayerResult.hash, { attempts: 15 });
        setLastTxHash(relayerResult.hash);
      }

      setTokenCode("USDC");
      await fetchBalance(wallet.contractId, TESTNET_USDC_TOKEN_CONTRACT);
      setStatus(`Received ${Number(usdcBalance.balance).toFixed(2)} USDC!`);
      setStatusKind("done");
    } catch (err: any) {
      setStatus(err.message || "Something went wrong");
      setStatusKind("error");
    } finally {
      setLoading(false);
    }
  };

  const handleTransfer = async () => {
    if (!wallet || !destination || !amount) return;
    setLoading(true);
    setStatus("Building transfer...");
    setStatusKind("busy");
    setLastTxHash(null);

    try {
      if (!StrKey.isValidEd25519PublicKey(destination) && !StrKey.isValidContract(destination)) {
        throw new Error("Invalid destination address");
      }

      const amountStroops = parseXlmToStroops(amount);
      // Both listed tokens are 7-decimal SACs, so the XLM stroop math applies to both.
      const tokenContract = tokenContractFor(tokenCode);

      if (balance !== null) {
        const balanceStroops = parseXlmToStroops(balance);
        if (amountStroops > balanceStroops) {
          throw new Error(`Insufficient balance: you have ${balance} ${tokenCode}`);
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
            contractAddress: Address.fromString(tokenContract).toScAddress(),
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
              xdr.ScVal.scvAddress(Address.fromString(tokenContract).toScAddress()),
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
          const gAddr = StrKey.encodeEd25519PublicKey(Buffer.from(ephemeralSigner.keyData));
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

      // SIMULATION SOURCE ONLY — this transaction is never submitted. The real submission
      // goes through the relayer's channel account (requestSubmitToRelayer), so nothing here
      // charges the deployer a fee. It is used because a policy transfer needs a source that
      // actually exists with a valid sequence number to simulate against.
      //
      // It does still require the account to EXIST. Wallet deployment used to guarantee that
      // as a side effect of funding it; it no longer touches the deployer's balance at all,
      // so re-fund here on demand rather than depending on that. Matters after a testnet
      // reset, when the account is gone.
      let simAccount;
      if (usingPolicyRule) {
        try {
          simAccount = await server.getAccount(DEPLOYER_PUBLIC_KEY);
        } catch {
          await fetch(`${FRIENDBOT_URL}?addr=${DEPLOYER_PUBLIC_KEY}`);
          simAccount = await server.getAccount(DEPLOYER_PUBLIC_KEY);
        }
      } else {
        simAccount = new Account(Keypair.random().publicKey(), "0");
      }
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

      await fetchBalance(wallet.contractId, tokenContractFor(tokenCode));
      if (relayerResult.hash) setLastTxHash(relayerResult.hash);
      setAmount("");
      setDestination("");
      setStatus("Transfer sent!");
      setStatusKind("done");
    } catch (err: any) {
      setStatus(err.message || "Something went wrong");
      setStatusKind("error");
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnect = () => {
    clearWallet();
    setWallet(null);
    setBalance(null);
    setStatus("");
    setStatusKind("idle");
    setLastTxHash(null);
    // Rule ids are per-wallet, and this is the only way to reach a different wallet. Left
    // stale, a rule id picked on the previous wallet is signed into the next wallet's auth
    // digest as context_rule_ids — the rule selector only renders for wallets that HAVE
    // policy rules, so on one that doesn't the plain Send button silently fails __check_auth.
    setContextRules([]);
    setSelectedRuleId(0);
  };

  const handleCopy = () => {
    if (wallet) {
      navigator.clipboard.writeText(wallet.contractId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return {
    wallet, balance, status, statusKind, lastTxHash, loading, copied, destination, amount,
    tokenCode, tokens: TESTNET_TOKENS,
    contextRules, selectedRuleId, rulesLoading,
    setDestination, setAmount, setTokenCode, setSelectedRuleId,
    handleCreate, handleSignIn, handleFund, handleFundUsdc, handleTransfer, handleDisconnect, handleCopy,
    fetchRules,
  };
}

function buildSacTransferFunc(
  from: string,
  to: string,
  amount: bigint,
  tokenContract: string = TESTNET_NATIVE_TOKEN_CONTRACT,
): xdr.HostFunction {
  return xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: Address.fromString(tokenContract).toScAddress(),
      functionName: "transfer",
      args: [
        xdr.ScVal.scvAddress(Address.fromString(from).toScAddress()),
        xdr.ScVal.scvAddress(Address.fromString(to).toScAddress()),
        toI128(amount),
      ],
    })
  );
}
