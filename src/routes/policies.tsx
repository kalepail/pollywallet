import { createFileRoute } from "@tanstack/react-router";
import {
  ShieldCheck,
  ArrowRight,
  ArrowLeft,
  FileCode,
  Plus,
  CheckCircle,
  Sparkle,
  PencilSimple,
} from "@phosphor-icons/react";
import { Loader } from "@cloudflare/kumo/components/loader";
import { Badge } from "@cloudflare/kumo/components/badge";
import { useState, useCallback } from "react";
import TxHashInput, { type TxSummary } from "@/components/policy/TxHashInput";
import PatternSummary from "@/components/policy/PatternSummary";
import ContractCard, {
  getDefaultContract,
  GlobalRuleCard,
  getDefaultGlobalRule,
} from "@/components/policy/RuleCard";
import SchemaPreview from "@/components/policy/SchemaPreview";
import CodeEditor from "@/components/policy/CodeEditor";
import TestResults, { type TestResult, type BuildAttempt } from "@/components/policy/TestResults";
import DeployPanel, { type DeployResult } from "@/components/policy/DeployPanel";
import InstallPanel, { type InstallResult } from "@/components/policy/InstallPanel";
import { analyzeTransaction, type TxAnalysis } from "@/lib/tx-analyzer";
import {
  schemaFromPatterns,
  mergeSpecIntoSchema,
  emptySchema,
  schemaToJSON,
  type PolicySchema,
  type ContractPermission,
  type GlobalRule,
} from "@/lib/policy-schema";
import type { TxPattern } from "@/lib/tx-analyzer";
import { requestContractSpec } from "@/lib/contract-spec";
import { requestPolicyGeneration, requestStreamingGeneration, requestFixCode, type GenerateChunk } from "@/lib/policy-codegen";
import type { StreamStats } from "@/components/policy/CodeEditor";
import { requestTest, requestCompile } from "@/lib/policy-sandbox";
import { requestDeploy, requestAddContextRule, requestSubmitToRelayer } from "@/lib/policy-deploy";
import { savePolicyAfterDeploy } from "@/lib/policy-store";
import {
  loadWallet,
  buildSignaturePayload,
  buildAuthDigest,
  signWithPasskey,
  buildWebAuthnSigBytes,
  writeAuthPayload,
  buildKeyData,
  toI128,
  TESTNET_RPC_URL,
  TESTNET_NETWORK_PASSPHRASE,
  TESTNET_WEBAUTHN_VERIFIER,
  LEDGERS_PER_HOUR,
  type StoredWallet,
} from "@/lib/passkey";
// Note: do NOT import submitToRelayer from relayer.ts directly in route files.
// It has heavy server-only deps that break the client bundle.
// Use requestSubmitToRelayer from policy-deploy.ts instead.

export const Route = createFileRoute("/policies")({ component: PolicyBuilder });

const STEPS = [
  { label: "Analyze", icon: "search" },
  { label: "Schema", icon: "settings" },
  { label: "Generate", icon: "code" },
  { label: "Test", icon: "flask" },
  { label: "Deploy", icon: "rocket" },
  { label: "Done", icon: "check" },
] as const;

function PolicyBuilder() {
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 1: TX Analysis
  const [txSummaries, setTxSummaries] = useState<TxSummary[]>([]);
  const [txAnalyses, setTxAnalyses] = useState<TxAnalysis[]>([]);
  const [patterns, setPatterns] = useState<TxPattern[]>([]);
  const [selectedPatterns, setSelectedPatterns] = useState<Set<number>>(new Set());

  // Step 2: Schema Editor
  const [schema, setSchema] = useState<PolicySchema>(emptySchema());

  // Step 3: Code Generation
  const [generatedCode, setGeneratedCode] = useState("");
  const [streamingCode, setStreamingCode] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamStats, setStreamStats] = useState<StreamStats>({
    tokenCount: 0,
    linesOfCode: 0,
    tokensPerSecond: 0,
    startTime: 0,
    status: "idle",
  });

  // Step 4: Test Results
  const [testResults, setTestResults] = useState<TestResult[]>([]);
  const [buildTimeline, setBuildTimeline] = useState<BuildAttempt[]>([]);

  // Step 5: Deploy
  const [wasmBase64, setWasmBase64] = useState<string | null>(null);
  const [deployResult, setDeployResult] = useState<DeployResult>();

  // Step 6: Install on Wallet
  const [installResult, setInstallResult] = useState<InstallResult>();
  const [installStatus, setInstallStatus] = useState("");
  const [installError, setInstallError] = useState<string | null>(null);

  // Wallet state
  const [wallet] = useState<StoredWallet | null>(() => {
    try { return loadWallet(); } catch { return null; }
  });

  // Contract spec loading
  const [specLoading, setSpecLoading] = useState(false);

  // --- Step 1 Handlers ---

  const handleAddHash = useCallback(async (hash: string) => {
    setTxSummaries((prev) => [...prev, { hash }]);
    setLoading(true);
    setError(null);
    try {
      const analysis = await analyzeTransaction(hash);
      setTxAnalyses((prev) => [...prev, analysis]);

      // Update summary with decoded data
      const firstPattern = analysis.patterns[0];
      setTxSummaries((prev) =>
        prev.map((s) =>
          s.hash === hash
            ? {
                ...s,
                contractAddress: firstPattern?.contractAddress,
                functionName: firstPattern?.innerCall
                  ? `${firstPattern.functionName} → ${firstPattern.innerCall.functionName}`
                  : firstPattern?.functionName,
                argCount: firstPattern?.args.length,
              }
            : s
        )
      );

      // Merge new patterns
      const newPatterns = analysis.patterns;
      setPatterns((prev) => {
        const updated = [...prev, ...newPatterns];
        // Auto-select all new patterns
        setSelectedPatterns(new Set(updated.map((_, i) => i)));
        return updated;
      });
    } catch (err) {
      setTxSummaries((prev) =>
        prev.map((s) =>
          s.hash === hash
            ? { ...s, error: err instanceof Error ? err.message : "Failed to analyze" }
            : s
        )
      );
    } finally {
      setLoading(false);
    }
  }, []);

  const handleRemoveHash = useCallback((hash: string) => {
    setTxSummaries((prev) => prev.filter((s) => s.hash !== hash));
    setTxAnalyses((prev) => prev.filter((a) => a.hash !== hash));
    // Recalculate patterns from remaining analyses
    setTxAnalyses((prev) => {
      const remaining = prev.filter((a) => a.hash !== hash);
      const allPatterns = remaining.flatMap((a) => a.patterns);
      setPatterns(allPatterns);
      setSelectedPatterns(new Set(allPatterns.map((_, i) => i)));
      return remaining;
    });
  }, []);

  const handleTogglePattern = useCallback((index: number) => {
    setSelectedPatterns((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  const handleAnalyzeNext = useCallback(async () => {
    const selected = patterns.filter((_, i) => selectedPatterns.has(i));
    let generated = schemaFromPatterns(selected);
    setSchema(generated);
    setStep(1);

    // Auto-fetch specs for all contracts in the schema
    const addresses = [...new Set(generated.contracts.map((c) => c.address))].filter(Boolean);
    if (addresses.length > 0) {
      setSpecLoading(true);
      try {
        const results = await Promise.allSettled(
          addresses.map((addr) => requestContractSpec(addr))
        );
        for (const [i, result] of results.entries()) {
          if (result.status === "fulfilled" && result.value.success && result.value.spec) {
            generated = mergeSpecIntoSchema(
              generated,
              addresses[i],
              result.value.spec.functions
            );
          }
        }
        setSchema(generated);
      } finally {
        setSpecLoading(false);
      }
    }
  }, [patterns, selectedPatterns]);

  // --- Step 2 Handlers ---

  const handleFetchSpec = useCallback(async (address: string) => {
    if (!address) return;
    setSpecLoading(true);
    try {
      const result = await requestContractSpec(address);
      if (result.success && result.spec) {
        setSchema((prev) => mergeSpecIntoSchema(prev, address, result.spec!.functions));
      }
    } finally {
      setSpecLoading(false);
    }
  }, []);

  const handleAddContract = useCallback(() => {
    setSchema((prev) => ({
      ...prev,
      contracts: [...prev.contracts, getDefaultContract()],
    }));
  }, []);

  const handleUpdateContract = useCallback(
    (index: number, updated: ContractPermission) => {
      setSchema((prev) => ({
        ...prev,
        contracts: prev.contracts.map((c, i) => (i === index ? updated : c)),
      }));
    },
    []
  );

  const handleRemoveContract = useCallback((index: number) => {
    setSchema((prev) => ({
      ...prev,
      contracts: prev.contracts.filter((_, i) => i !== index),
    }));
  }, []);

  const handleAddGlobalRule = useCallback(() => {
    setSchema((prev) => ({
      ...prev,
      globalRules: [...prev.globalRules, getDefaultGlobalRule("threshold")],
    }));
  }, []);

  const handleUpdateGlobalRule = useCallback(
    (index: number, updated: GlobalRule) => {
      setSchema((prev) => ({
        ...prev,
        globalRules: prev.globalRules.map((r, i) =>
          i === index ? updated : r
        ),
      }));
    },
    []
  );

  const handleRemoveGlobalRule = useCallback((index: number) => {
    setSchema((prev) => ({
      ...prev,
      globalRules: prev.globalRules.filter((_, i) => i !== index),
    }));
  }, []);

  const handleGenerate = useCallback(async () => {
    setStep(2);
    setError(null);
    setGeneratedCode("");
    setStreamingCode("");
    setStreaming(true);

    const startTime = Date.now();
    setStreamStats({
      tokenCount: 0,
      linesOfCode: 0,
      tokensPerSecond: 0,
      startTime,
      status: "streaming",
    });

    try {
      const result = await requestStreamingGeneration(schema);

      if ("error" in result) {
        setError(result.error);
        setStreaming(false);
        setStreamStats((s) => ({ ...s, status: "error" }));
        return;
      }

      let code = "";
      let tokens = 0;

      for await (const chunk of result) {
        if (chunk.type === "token" && chunk.text) {
          code += chunk.text;
          tokens = chunk.tokenCount ?? tokens + 1;
          const elapsed = (Date.now() - startTime) / 1000;
          const lines = code.split("\n").length;

          setStreamingCode(code);
          setStreamStats({
            tokenCount: tokens,
            linesOfCode: lines,
            tokensPerSecond: elapsed > 0 ? tokens / elapsed : 0,
            startTime,
            status: "streaming",
          });
        } else if (chunk.type === "done") {
          const finalCode = chunk.text ?? code;
          const elapsed = (Date.now() - startTime) / 1000;
          const lines = finalCode.split("\n").length;
          tokens = chunk.tokenCount ?? tokens;

          setGeneratedCode(finalCode);
          setStreamingCode("");
          setStreaming(false);
          setStreamStats({
            tokenCount: tokens,
            linesOfCode: lines,
            tokensPerSecond: elapsed > 0 ? tokens / elapsed : 0,
            startTime,
            status: "done",
          });
        } else if (chunk.type === "error") {
          setError(chunk.text ?? "Generation failed");
          setStreaming(false);
          setStreamStats((s) => ({ ...s, status: "error" }));
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Code generation failed");
      setStreaming(false);
      setStreamStats((s) => ({ ...s, status: "error" }));
    }
  }, [schema]);

  // --- Step 3 Handlers ---

  const MAX_FIX_ATTEMPTS = 3;

  const handleTest = useCallback(async () => {
    setStep(3);
    setLoading(true);
    setError(null);
    setTestResults([]);
    setBuildTimeline([]);

    let codeToTest = generatedCode;
    const timeline: BuildAttempt[] = [];

    try {
      for (let attempt = 0; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
        // Run test first (includes compilation), then compile for WASM separately.
        // These MUST be sequential — both use the same sandbox project directory.
        const testResult = await requestTest(codeToTest, schema);

        // Compilation succeeded — show results
        if (testResult.compiled) {
          timeline.push({
            attempt: attempt + 1,
            compiled: true,
            errors: "",
            fixed: attempt > 0,
          });
          setBuildTimeline([...timeline]);

          setTestResults(
            testResult.testCases.map((tc) => ({
              name: tc.name,
              passed: tc.passed,
              output: tc.output,
            }))
          );
          if (!testResult.success) {
            const failed = testResult.testCases.filter((tc) => !tc.passed).length;
            setError(`${failed} test(s) failed`);
          } else {
            setError(null);
          }
          // Now compile separately to get the optimized WASM binary
          const compileResult = await requestCompile(codeToTest);
          if (compileResult.success && compileResult.wasmBase64) {
            setWasmBase64(compileResult.wasmBase64);
          }
          break;
        }

        // Compilation failed — record in timeline
        // Extract just the error lines (skip "Compiling...", "Downloading..." noise)
        const cleanErrors = testResult.compileOutput
          .split("\n")
          .filter(line => {
            const t = line.trim();
            return t && !t.startsWith("Compiling ") && !t.startsWith("Downloading ") &&
              !t.startsWith("Downloaded ") && !t.startsWith("Blocking ");
          })
          .join("\n")
          .slice(0, 3000);

        timeline.push({
          attempt: attempt + 1,
          compiled: false,
          errors: cleanErrors,
          fixed: false,
        });
        setBuildTimeline([...timeline]);

        // Try auto-fix if we have attempts left
        if (attempt < MAX_FIX_ATTEMPTS) {
          setError(`Compilation failed — auto-fixing with AI (attempt ${attempt + 1}/${MAX_FIX_ATTEMPTS})...`);
          const fixResult = await requestFixCode(codeToTest, testResult.compileOutput, (stats) => {
            setError(`Auto-fixing (attempt ${attempt + 1}/${MAX_FIX_ATTEMPTS}) — ${stats.tokenCount} tokens, ${stats.tokensPerSecond.toFixed(0)} tok/s`);
          });
          if (fixResult.success && fixResult.code) {
            timeline[timeline.length - 1].fixed = true;
            setBuildTimeline([...timeline]);
            codeToTest = fixResult.code;
            setGeneratedCode(codeToTest);
            setError(`Re-testing fixed code (attempt ${attempt + 1}/${MAX_FIX_ATTEMPTS})...`);
            continue;
          }
          // Fix itself failed — fall through to show compile error
        }

        // All fix attempts exhausted or fix call failed
        setError(
          `Compilation failed${attempt > 0 ? ` after ${attempt} fix attempt(s)` : ""}: ${testResult.compileOutput}`
        );
        setTestResults([]);
        break;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Testing failed");
    } finally {
      setLoading(false);
    }
  }, [generatedCode, schema]);

  // --- Step 4 Handlers ---

  const handleDeploy = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (!wasmBase64) {
        setError("No compiled WASM available. Please run tests first.");
        return;
      }
      const result = await requestDeploy(wasmBase64);
      if (!result.success || !result.contractAddress) {
        setError(result.error || "Deployment failed");
      } else {
        setDeployResult({
          contractAddress: result.contractAddress,
          wasmHash: result.wasmHash ?? undefined,
        });
        // Auto-save the policy (schema + Rust code + deploy info) to KV
        savePolicyAfterDeploy(
          result.contractAddress,
          result.wasmHash ?? "",
          schema,
          generatedCode,
        ).catch(() => {}); // Best-effort save, don't block the UI
        setStep(4);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Deployment failed");
    } finally {
      setLoading(false);
    }
  }, [wasmBase64]);

  // --- Step 5 Handlers ---

  const handleInstall = useCallback(async () => {
    if (!deployResult?.contractAddress || !wallet) return;
    setLoading(true);
    setInstallError(null);
    setInstallStatus("Generating ephemeral signer...");

    try {
      const { Keypair, xdr, Account, TransactionBuilder, Operation, Address, scValToNative } = await import("@stellar/stellar-sdk");
      const { rpc } = await import("@stellar/stellar-sdk");
      const { Buffer } = await import("buffer");

      // Generate ephemeral keypair and save secret to localStorage immediately.
      // Must persist before the relayer call — if the install crashes after
      // signing but before completion, the key is still recoverable.
      const ephemeralKeypair = Keypair.random();
      const ephemeralPublicKey = ephemeralKeypair.publicKey();
      try {
        const existing = JSON.parse(localStorage.getItem("pollywallet:ephemeral-signers") || "{}");
        existing[ephemeralPublicKey] = ephemeralKeypair.secret();
        localStorage.setItem("pollywallet:ephemeral-signers", JSON.stringify(existing));
        console.log("[PollyWallet] Saved ephemeral signer:", ephemeralPublicKey);
      } catch (storageErr) {
        console.error("[PollyWallet] Failed to save ephemeral signer to localStorage:", storageErr);
        // Don't block the install — worst case the user has to reinstall
      }

      // Determine the target contract from the schema
      const targetContract = schema.contracts[0]?.address;
      if (!targetContract) throw new Error("No target contract in schema");

      // Build install params as Map<Val, Val> matching the schema constraints
      const entries: InstanceType<typeof xdr.ScMapEntry>[] = [];
      for (const contract of schema.contracts) {
        for (const func of contract.functions) {
          for (const arg of func.args) {
            if (!arg.constraint || arg.constraint.kind === "unconstrained") continue;
            if (arg.constraint.kind === "range" && arg.constraint.max) {
              entries.push(new xdr.ScMapEntry({
                key: xdr.ScVal.scvSymbol(`max_${arg.name}`),
                val: toI128(BigInt(arg.constraint.max)),
              }));
            }
            if (arg.constraint.kind === "range" && arg.constraint.min) {
              entries.push(new xdr.ScMapEntry({
                key: xdr.ScVal.scvSymbol(`min_${arg.name}`),
                val: toI128(BigInt(arg.constraint.min)),
              }));
            }
          }
        }
      }
      for (const rule of schema.globalRules) {
        if (rule.type === "threshold") {
          entries.push(new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol("threshold"),
            val: xdr.ScVal.scvU32(rule.params.threshold),
          }));
        }
      }

      // Build installParams ScVal
      let installParamsXdr = "";
      if (entries.length > 0) {
        installParamsXdr = xdr.ScVal.scvMap(entries).toXDR("base64");
      }

      setInstallStatus("Building context rule transaction...");

      // Build the add_context_rule host function
      let result;
      try {
        result = await requestAddContextRule({
          walletContractId: wallet.contractId,
          targetContractAddress: targetContract,
          policyAddress: deployResult.contractAddress,
          installParamsXdr,
          ephemeralSignerPublicKey: ephemeralPublicKey,
          ruleName: (schema.name || "policy-rule").slice(0, 20),
        });
      } catch (e: any) {
        throw new Error(`Failed to call requestAddContextRule: ${e.message}`);
      }

      if (!result || !result.success || !result.hostFuncXdr) {
        throw new Error(result?.error || "Failed to build context rule transaction");
      }

      // Simulate
      setInstallStatus("Simulating transaction...");
      const server = new rpc.Server(TESTNET_RPC_URL);
      const hostFunc = xdr.HostFunction.fromXDR(result.hostFuncXdr, "base64");
      const simAccount = new Account(Keypair.random().publicKey(), "0");
      const simTx = new TransactionBuilder(simAccount, {
        fee: "1000000",
        networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
      })
        .addOperation(Operation.invokeHostFunction({ func: hostFunc, auth: [] }))
        .setTimeout(30)
        .build();

      let simResult;
      try {
        simResult = await server.simulateTransaction(simTx);
      } catch (e: any) {
        throw new Error(`Simulation request failed: ${e.message}`);
      }
      if ("error" in simResult) throw new Error(`Simulation failed: ${(simResult as any).error}`);
      const simSuccess = simResult as rpc.Api.SimulateTransactionSuccessResponse;

      const authEntries = simSuccess.result?.auth ?? [];
      const expiration = simSuccess.latestLedger + LEDGERS_PER_HOUR;

      // Sign with passkey
      setInstallStatus("Sign with your passkey...");
      const keyData = buildKeyData(Buffer.from(wallet.publicKey, "hex"), wallet.credentialId);
      const signer = { tag: "External" as const, values: [TESTNET_WEBAUTHN_VERIFIER, keyData] as const };

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
              writeAuthPayload([0], signer, buildWebAuthnSigBytes(webAuthnResult))
            );
          }
          signedAuthEntries.push(entry);
        } else {
          signedAuthEntries.push(entry);
        }
      }

      setInstallStatus("Submitting via relayer...");
      const relayerResult = await requestSubmitToRelayer({
        func: hostFunc.toXDR("base64"),
        auth: signedAuthEntries.map((e) => e.toXDR("base64")),
      });
      if (!relayerResult.success) throw new Error(relayerResult.error || "Relayer failed");

      if (relayerResult.hash) {
        setInstallStatus("Waiting for confirmation...");
        await server.pollTransaction(relayerResult.hash, { attempts: 15 });
      }

      // Extract context rule ID from the return value
      // add_context_rule returns a ContextRule struct which includes the id
      let contextRuleId = 0;
      if (relayerResult.hash) {
        try {
          const txResult = await server.getTransaction(relayerResult.hash);
          if (txResult.status === "SUCCESS" && txResult.returnValue) {
            const native = scValToNative(txResult.returnValue);
            contextRuleId = typeof native === "object" && native.id != null ? Number(native.id) : 0;
          }
        } catch { /* best effort */ }
      }

      setInstallResult({
        contextRuleId,
        ephemeralPublicKey,
        txHash: relayerResult.hash || "",
      });
      setInstallStatus("");
      setStep(5);
    } catch (err) {
      let msg = err instanceof Error ? err.message : "Install failed";
      // Make WebAuthn errors more user-friendly
      if (msg.includes("timed out or was not allowed")) {
        msg = "Passkey signing was cancelled or timed out. Please try again and approve the passkey prompt.";
      }
      setInstallError(msg);
      setInstallStatus("");
    } finally {
      setLoading(false);
    }
  }, [deployResult, wallet, schema]);

  // --- Navigation ---

  const canGoBack = step > 0 && step < 5;

  const handleBack = () => {
    if (canGoBack) setStep(step - 1);
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-slate-800 to-slate-900 px-4 py-8">
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Header */}
        <div className="text-center mb-8">
          <ShieldCheck size={48} weight="duotone" className="text-violet-400 mx-auto mb-3" />
          <h1 className="text-3xl font-bold text-white mb-2">Policy Builder</h1>
          <p className="text-gray-400">
            Craft signing policies from transaction patterns
          </p>
        </div>

        {/* Step Indicator */}
        <StepIndicator currentStep={step} />

        {/* Error Banner */}
        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}

        {/* Step Content */}
        {step === 0 && (
          <>
            <TxHashInput
              txSummaries={txSummaries}
              onAdd={handleAddHash}
              onRemove={handleRemoveHash}
              loading={loading}
            />
            <PatternSummary
              patterns={patterns}
              selected={selectedPatterns}
              onToggle={handleTogglePattern}
            />
            {patterns.length > 0 && selectedPatterns.size > 0 && (
              <button
                onClick={handleAnalyzeNext}
                disabled={loading}
                className="w-full flex items-center justify-center gap-3 px-6 py-4 bg-violet-500 hover:bg-violet-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-colors shadow-lg shadow-violet-500/25"
              >
                <FileCode size={20} />
                Continue with {selectedPatterns.size} Pattern{selectedPatterns.size !== 1 ? "s" : ""}
                <ArrowRight size={16} />
              </button>
            )}
          </>
        )}

        {step === 1 && (
          <>
            <div className="space-y-4">
              {/* Schema metadata */}
              <div className="bg-slate-800/50 border border-slate-700 rounded-2xl p-6 space-y-3">
                <h2 className="text-lg font-semibold text-white mb-2">Policy Details</h2>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Policy Name</label>
                  <input
                    type="text"
                    value={schema.name}
                    onChange={(e) => {
                      const val = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "");
                      setSchema((prev) => ({ ...prev, name: val.slice(0, 20) }));
                    }}
                    maxLength={20}
                    placeholder="e.g. transfer-limit"
                    className={`w-full px-4 py-3 bg-slate-700/50 border rounded-xl text-white placeholder-gray-500 focus:outline-none transition-colors text-sm ${
                      schema.name.length > 20 ? "border-red-500" : "border-slate-600 focus:border-violet-500"
                    }`}
                  />
                  <p className={`text-xs mt-1 ${schema.name.length >= 18 ? "text-amber-400" : "text-gray-500"}`}>
                    {schema.name.length}/20
                  </p>
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Description</label>
                  <input
                    type="text"
                    value={schema.description}
                    onChange={(e) =>
                      setSchema((prev) => ({ ...prev, description: e.target.value }))
                    }
                    placeholder="What does this policy enforce?"
                    className="w-full px-4 py-3 bg-slate-700/50 border border-slate-600 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:border-violet-500 transition-colors text-sm"
                  />
                </div>
              </div>

              {/* Contracts */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-semibold text-white">Contracts</h2>
                  <button
                    onClick={handleAddContract}
                    className="flex items-center gap-1.5 text-sm text-violet-400 hover:text-violet-300 transition-colors"
                  >
                    <Plus size={16} />
                    Add Contract
                  </button>
                </div>
                {schema.contracts.length === 0 ? (
                  <div className="bg-slate-800/30 border border-dashed border-slate-700 rounded-2xl p-6 text-center">
                    <p className="text-gray-500 text-sm">
                      No contracts yet. Add at least one contract to define allowed operations.
                    </p>
                  </div>
                ) : (
                  schema.contracts.map((contract, index) => (
                    <ContractCard
                      key={index}
                      contract={contract}
                      onChange={(updated) => handleUpdateContract(index, updated)}
                      onRemove={() => handleRemoveContract(index)}
                      onFetchSpec={handleFetchSpec}
                      specLoading={specLoading}
                    />
                  ))
                )}
              </div>

              {/* Global Rules */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-semibold text-white">Global Rules</h2>
                  <button
                    onClick={handleAddGlobalRule}
                    className="flex items-center gap-1.5 text-sm text-violet-400 hover:text-violet-300 transition-colors"
                  >
                    <Plus size={16} />
                    Add Global Rule
                  </button>
                </div>
                {schema.globalRules.length === 0 ? (
                  <div className="bg-slate-800/30 border border-dashed border-slate-700 rounded-2xl p-6 text-center">
                    <p className="text-gray-500 text-sm">
                      No global rules. Add threshold or time lock rules that apply across all contracts.
                    </p>
                  </div>
                ) : (
                  schema.globalRules.map((rule, index) => (
                    <GlobalRuleCard
                      key={index}
                      rule={rule}
                      onChange={(updated) => handleUpdateGlobalRule(index, updated)}
                      onRemove={() => handleRemoveGlobalRule(index)}
                    />
                  ))
                )}
              </div>

              <SchemaPreview schema={schema} />
            </div>

            <div className="flex gap-3">
              <button
                onClick={handleBack}
                className="flex items-center justify-center gap-2 px-6 py-4 bg-slate-700 hover:bg-slate-600 text-white font-semibold rounded-xl transition-colors"
              >
                <ArrowLeft size={16} />
                Back
              </button>
              <button
                onClick={handleGenerate}
                disabled={loading || schema.contracts.length === 0 || !schema.name}
                className="flex-1 flex items-center justify-center gap-3 px-6 py-4 bg-violet-500 hover:bg-violet-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-colors shadow-lg shadow-violet-500/25"
              >
                {loading ? (
                  <Loader size={20} />
                ) : (
                  <Sparkle size={20} weight="fill" />
                )}
                Generate Policy Code
                <ArrowRight size={16} />
              </button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <CodeEditor
              code={generatedCode}
              loading={loading}
              streaming={streaming}
              streamingCode={streamingCode}
              stats={streamStats}
              onEdit={setGeneratedCode}
            />
            <div className="flex gap-3">
              <button
                onClick={handleBack}
                className="flex items-center justify-center gap-2 px-6 py-4 bg-slate-700 hover:bg-slate-600 text-white font-semibold rounded-xl transition-colors"
              >
                <ArrowLeft size={16} />
                Back
              </button>
              <button
                onClick={handleGenerate}
                disabled={loading}
                className="flex items-center justify-center gap-2 px-6 py-4 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-white font-semibold rounded-xl transition-colors"
              >
                <Sparkle size={16} weight="fill" />
                Regenerate
              </button>
              <button
                onClick={handleTest}
                disabled={loading || !generatedCode}
                className="flex-1 flex items-center justify-center gap-3 px-6 py-4 bg-violet-500 hover:bg-violet-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-colors shadow-lg shadow-violet-500/25"
              >
                Test in Sandbox
                <ArrowRight size={16} />
              </button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <TestResults results={testResults} loading={loading} buildTimeline={buildTimeline} />
            <div className="flex gap-3">
              <button
                onClick={handleBack}
                className="flex items-center justify-center gap-2 px-6 py-4 bg-slate-700 hover:bg-slate-600 text-white font-semibold rounded-xl transition-colors"
              >
                <PencilSimple size={16} />
                Edit Code
              </button>
              <button
                onClick={handleTest}
                disabled={loading || !generatedCode}
                className="flex items-center justify-center gap-2 px-6 py-4 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-white font-semibold rounded-xl transition-colors"
              >
                <Sparkle size={16} weight="fill" />
                Re-test
              </button>
              {wasmBase64 && !loading && (
                <button
                  onClick={handleDeploy}
                  disabled={loading}
                  className={`flex-1 flex items-center justify-center gap-3 px-6 py-4 ${
                    testResults.length > 0 && testResults.every((r) => r.passed)
                      ? "bg-violet-500 hover:bg-violet-600 shadow-lg shadow-violet-500/25"
                      : "bg-amber-600 hover:bg-amber-700 shadow-lg shadow-amber-600/25"
                  } disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-colors`}
                >
                  {loading ? <Loader size={20} /> : null}
                  {testResults.length > 0 && testResults.every((r) => r.passed)
                    ? "Deploy to Testnet"
                    : "Deploy Anyway (tests incomplete)"}
                  <ArrowRight size={16} />
                </button>
              )}
            </div>
          </>
        )}

        {step === 4 && (
          <>
            <DeployPanel
              onDeploy={handleDeploy}
              deployResult={deployResult}
              loading={loading && !installStatus}
            />
            {deployResult && (
              <InstallPanel
                policyAddress={deployResult.contractAddress}
                walletConnected={!!wallet}
                onInstall={handleInstall}
                installResult={installResult}
                loading={loading && !!installStatus}
                error={installError}
                status={installStatus}
              />
            )}
          </>
        )}

        {step === 5 && (
          <div className="bg-slate-800/50 border border-slate-700 rounded-2xl p-8 text-center space-y-4">
            <CheckCircle size={64} weight="fill" className="text-emerald-400 mx-auto" />
            <h2 className="text-2xl font-bold text-white">Policy Installed</h2>
            <p className="text-gray-400">
              Your policy has been deployed and installed on your smart wallet.
            </p>
            {installResult && (
              <div className="bg-slate-900/70 border border-slate-700 rounded-xl p-4 text-left space-y-2">
                <div>
                  <p className="text-xs text-gray-500 mb-1">Context Rule ID</p>
                  <code className="text-sm text-white font-mono">{installResult.contextRuleId}</code>
                </div>
                <div>
                  <p className="text-xs text-gray-500 mb-1">Ephemeral Signer</p>
                  <code className="text-xs text-white font-mono break-all">{installResult.ephemeralPublicKey}</code>
                </div>
                <div>
                  <p className="text-xs text-gray-500 mb-1">Install TX</p>
                  <code className="text-xs text-gray-400 font-mono break-all">{installResult.txHash}</code>
                </div>
                {deployResult && (
                  <div>
                    <p className="text-xs text-gray-500 mb-1">Policy Contract</p>
                    <code className="text-xs text-gray-400 font-mono break-all">{deployResult.contractAddress}</code>
                  </div>
                )}
              </div>
            )}
            {!installResult && deployResult && (
              <div className="bg-slate-900/70 border border-slate-700 rounded-xl p-4 text-left">
                <p className="text-xs text-gray-500 mb-1">Contract Address</p>
                <code className="text-sm text-white font-mono break-all">{deployResult.contractAddress}</code>
              </div>
            )}
            <button
              onClick={() => {
                setStep(0);
                setTxSummaries([]);
                setTxAnalyses([]);
                setPatterns([]);
                setSelectedPatterns(new Set());
                setSchema(emptySchema());
                setGeneratedCode("");
                setStreamingCode("");
                setStreaming(false);
                setStreamStats({ tokenCount: 0, linesOfCode: 0, tokensPerSecond: 0, startTime: 0, status: "idle" });
                setTestResults([]);
                setBuildTimeline([]);
                setWasmBase64(null);
                setDeployResult(undefined);
                setInstallResult(undefined);
                setInstallError(null);
                setInstallStatus("");
                setError(null);
              }}
              className="inline-flex items-center gap-2 px-6 py-3 bg-violet-500 hover:bg-violet-600 text-white font-semibold rounded-xl transition-colors"
            >
              <Plus size={16} />
              Create Another Policy
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function StepIndicator({ currentStep }: { currentStep: number }) {
  return (
    <div className="flex items-center justify-between mb-2">
      {STEPS.map((s, i) => {
        const isActive = i === currentStep;
        const isCompleted = i < currentStep;
        return (
          <div key={i} className="flex items-center flex-1 last:flex-none">
            <div className="flex flex-col items-center">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
                  isCompleted
                    ? "bg-violet-500 text-white"
                    : isActive
                      ? "bg-violet-500/20 text-violet-400 border-2 border-violet-500"
                      : "bg-slate-700 text-gray-500"
                }`}
              >
                {isCompleted ? (
                  <CheckCircle size={16} weight="fill" />
                ) : (
                  i + 1
                )}
              </div>
              <span
                className={`text-xs mt-1 ${
                  isActive ? "text-violet-400 font-medium" : "text-gray-500"
                }`}
              >
                {s.label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div
                className={`flex-1 h-px mx-2 mt-[-1rem] ${
                  isCompleted ? "bg-violet-500" : "bg-slate-700"
                }`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
