/**
 * E2E Policy Enforcement Test
 *
 * Proves that a deployed spending-limit policy contract actually enforces
 * on Stellar Testnet — not just install/uninstall, but real enforcement logic.
 *
 * Usage:
 *   node e2e-policy-test/verify-policy.mjs [policy_address]
 *
 * Defaults to the known deployed spending-limit policy if no address is given.
 *
 * Steps:
 *   1. Generate an ephemeral keypair (acts as the "smart account")
 *   2. Fund it via Friendbot
 *   3. Install the policy with a max transfer amount
 *   4. Enforce with a transfer WITHIN the limit  -> expect SUCCESS
 *   5. Enforce with a transfer EXCEEDING the limit -> expect FAILURE (simulation revert)
 *   6. Verify stored data via get_policy_data
 *   7. Uninstall the policy
 *   8. Enforce after uninstall -> expect FAILURE
 *
 * Exit code 0 = all tests pass, 1 = any test fails.
 */

import {
  Keypair,
  TransactionBuilder,
  Networks,
  xdr,
  Address,
  nativeToScVal,
  scValToNative,
  Contract,
  Operation,
  hash,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import { Server, assembleTransaction } from "@stellar/stellar-sdk/rpc";
import { ChannelsClient } from "@openzeppelin/relayer-plugin-channels";
import { readFileSync } from "fs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_POLICY = "CDTV55VTCRIPH3BCX5ZVNOWRB4NPFNS44U6X46ZP7K4GAKNNZQDCB6JI";
const RPC_URL = "https://soroban-testnet.stellar.org";
const FRIENDBOT_URL = "https://friendbot.stellar.org";
const NETWORK_PASSPHRASE = Networks.TESTNET;
const XLM_SAC_ADDRESS = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

// Max transfer amount: 10 XLM = 100_000_000 stroops
const MAX_AMOUNT = 100_000_000n;
const SIGNER_THRESHOLD = 1;

// Test amounts
const AMOUNT_WITHIN_LIMIT = 50_000_000n;  // 5 XLM — should pass
const AMOUNT_OVER_LIMIT = 200_000_000n;   // 20 XLM — should fail

const POLICY_CONTRACT_ID = process.argv[2] || DEFAULT_POLICY;

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

const server = new Server(RPC_URL);
const keypair = Keypair.random();
const publicKey = keypair.publicKey();
const results = { passed: 0, failed: 0, txHashes: {} };

// Relayer setup
const devVars = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8");
const apiKey = devVars.match(/CHANNELS_API_KEY=(.+)/)?.[1]?.trim();
if (!apiKey) {
  console.error("ERROR: CHANNELS_API_KEY not found in .dev.vars");
  process.exit(1);
}
const relayer = new ChannelsClient({
  baseUrl: "https://channels.openzeppelin.com/testnet",
  apiKey,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg) {
  console.log(`  ${msg}`);
}

function header(title) {
  console.log("");
  console.log(`${"=".repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${"=".repeat(60)}`);
}

function pass(testName, extra = "") {
  results.passed++;
  console.log(`  [PASS] ${testName}${extra ? " — " + extra : ""}`);
}

function fail(testName, reason = "") {
  results.failed++;
  console.log(`  [FAIL] ${testName}${reason ? " — " + reason : ""}`);
}

/**
 * Build the ContextRule struct as an ScVal.
 * Mirrors the Rust ContextRule struct with alphabetically-sorted symbol keys.
 */
function buildContextRule() {
  const contextType = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("CallContract"),
    new Address(XLM_SAC_ADDRESS).toScVal(),
  ]);

  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("context_type"),
      val: contextType,
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("id"),
      val: nativeToScVal(1, { type: "u32" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("name"),
      val: nativeToScVal("e2e-test-rule", { type: "string" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("policies"),
      val: xdr.ScVal.scvVec([]),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("policy_ids"),
      val: xdr.ScVal.scvVec([]),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("signer_ids"),
      val: xdr.ScVal.scvVec([]),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("signers"),
      val: xdr.ScVal.scvVec([]),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("valid_until"),
      val: xdr.ScVal.scvVoid(),
    }),
  ]);
}

/**
 * Build install params for the Kimi-generated spending-limit policy.
 * The deployed contract expects: { max_arg2: i128, threshold: u32 }
 */
function buildInstallParams() {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("max_arg2"),
      val: nativeToScVal(MAX_AMOUNT, { type: "i128" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("threshold"),
      val: nativeToScVal(SIGNER_THRESHOLD, { type: "u32" }),
    }),
  ]);
}

/**
 * Build a Context::Contract(ContractContext) ScVal for a transfer call.
 * Context is a native Soroban enum:
 *   scvVec([ scvSymbol("Contract"), contractContext_struct ])
 * ContractContext struct keys are alphabetically sorted.
 */
function buildTransferContext(amount) {
  const dummyFrom = Keypair.random().publicKey();
  const dummyTo = Keypair.random().publicKey();

  const transferArgs = xdr.ScVal.scvVec([
    new Address(dummyFrom).toScVal(),
    new Address(dummyTo).toScVal(),
    nativeToScVal(amount, { type: "i128" }),
  ]);

  const contractContext = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("args"),
      val: transferArgs,
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("contract"),
      val: new Address(XLM_SAC_ADDRESS).toScVal(),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("fn_name"),
      val: xdr.ScVal.scvSymbol("transfer"),
    }),
  ]);

  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Contract"),
    contractContext,
  ]);
}

/**
 * Build authenticated_signers: Vec<Signer>.
 * Signer::Delegated(Address) serializes as Vec([Symbol("Delegated"), Address]).
 */
function buildSigners() {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol("Delegated"),
      new Address(publicKey).toScVal(),
    ]),
  ]);
}

/**
 * Submit a contract invocation via the relayer and wait for the result.
 * When expectSimFailure is true, a simulation error is treated as the expected outcome.
 */
async function callContract(functionName, args, { expectSimFailure = false } = {}) {
  const contract = new Contract(POLICY_CONTRACT_ID);

  // Build the host function
  const hostFunc = xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: Address.fromString(POLICY_CONTRACT_ID).toScAddress(),
      functionName,
      args,
    })
  );

  // Simulate to get auth entries
  const account = await server.getAccount(publicKey);
  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.invokeHostFunction({ func: hostFunc, auth: [] }))
    .setTimeout(60)
    .build();

  let simResult;
  try {
    simResult = await server.simulateTransaction(tx);
  } catch (simErr) {
    if (expectSimFailure) {
      return { hash: null, success: false, simulationError: simErr.message || String(simErr) };
    }
    throw simErr;
  }

  if ("error" in simResult) {
    if (expectSimFailure) {
      return { hash: null, success: false, simulationError: simResult.error };
    }
    throw new Error(`Simulation failed: ${simResult.error}`);
  }

  if (expectSimFailure) {
    return { hash: null, success: true, simulationError: null };
  }

  // If no auth entries needed (read-only call), submit directly
  if ((simResult.result?.auth ?? []).length === 0) {
    const assembled = assembleTransaction(tx, simResult).build();
    assembled.sign(keypair);
    const directResult = await server.sendTransaction(assembled);
    if (directResult.status === "ERROR") throw new Error(`Send failed: ${JSON.stringify(directResult)}`);
    let getResult;
    for (let i = 0; i < 30; i++) {
      getResult = await server.getTransaction(directResult.hash);
      if (getResult.status !== "NOT_FOUND") break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (getResult.status === "SUCCESS") {
      let returnValue = null;
      if (getResult.returnValue) { try { returnValue = scValToNative(getResult.returnValue); } catch {} }
      return { hash: directResult.hash, success: true, result: getResult, returnValue };
    }
    throw new Error(`${functionName} failed: ${getResult.status}`);
  }

  // Sign auth entries with the test keypair
  const LEDGERS_PER_HOUR = 720;
  const expiration = simResult.latestLedger + LEDGERS_PER_HOUR;
  const networkId = hash(Buffer.from(NETWORK_PASSPHRASE));
  const authEntries = simResult.result?.auth ?? [];

  const signedAuth = authEntries.map((entry) => {
    const credType = entry.credentials().switch().name;
    if (credType === "sorobanCredentialsSourceAccount") {
      const nonce = xdr.Int64.fromString(Date.now().toString());
      const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
        new xdr.HashIdPreimageSorobanAuthorization({
          networkId, nonce, signatureExpirationLedger: expiration,
          invocation: entry.rootInvocation(),
        })
      );
      const sig = keypair.sign(hash(preimage.toXDR()));
      return new xdr.SorobanAuthorizationEntry({
        credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
          new xdr.SorobanAddressCredentials({
            address: Address.fromString(publicKey).toScAddress(),
            nonce, signatureExpirationLedger: expiration,
            signature: xdr.ScVal.scvVec([xdr.ScVal.scvMap([
              new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("public_key"), val: xdr.ScVal.scvBytes(keypair.rawPublicKey()) }),
              new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("signature"), val: xdr.ScVal.scvBytes(sig) }),
            ])]),
          })
        ),
        rootInvocation: entry.rootInvocation(),
      });
    }
    if (credType === "sorobanCredentialsAddress") {
      const creds = entry.credentials().address();
      creds.signatureExpirationLedger(expiration);
      const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
        new xdr.HashIdPreimageSorobanAuthorization({
          networkId, nonce: creds.nonce(), signatureExpirationLedger: expiration,
          invocation: entry.rootInvocation(),
        })
      );
      const sig = keypair.sign(hash(preimage.toXDR()));
      creds.signature(xdr.ScVal.scvVec([xdr.ScVal.scvMap([
        new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("public_key"), val: xdr.ScVal.scvBytes(keypair.rawPublicKey()) }),
        new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("signature"), val: xdr.ScVal.scvBytes(sig) }),
      ])]));
    }
    return entry;
  });

  // Submit via relayer
  let sendResult;
  try {
    sendResult = await relayer.submitSorobanTransaction({
      func: hostFunc.toXDR("base64"),
      auth: signedAuth.map((e) => e.toXDR("base64")),
    });
  } catch (relayerErr) {
    throw new Error(`Relayer failed: ${relayerErr.message}`);
  }

  // Poll for confirmation
  let getResult;
  for (let i = 0; i < 30; i++) {
    getResult = await server.getTransaction(sendResult.hash);
    if (getResult.status !== "NOT_FOUND") break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (getResult.status === "SUCCESS") {
    let returnValue = null;
    if (getResult.returnValue) {
      try { returnValue = scValToNative(getResult.returnValue); } catch {}
    }
    return { hash: sendResult.hash, success: true, result: getResult, returnValue };
  } else {
    throw new Error(`${functionName} tx failed on-chain: ${getResult.status}`);
  }
}

// ---------------------------------------------------------------------------
// Test Steps
// ---------------------------------------------------------------------------

async function fundAccount() {
  header("Phase 0: Setup — Fund Ephemeral Account");
  log(`Keypair: ${publicKey}`);
  log(`Policy:  ${POLICY_CONTRACT_ID}`);
  log(`XLM SAC: ${XLM_SAC_ADDRESS}`);
  log("");

  const res = await fetch(`${FRIENDBOT_URL}?addr=${publicKey}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Friendbot failed (${res.status}): ${body}`);
  }
  log("Funded via Friendbot");
}

async function testInstall() {
  header("Phase 1: Install Policy");
  log(`Params: max_arg2=${MAX_AMOUNT} stroops (${Number(MAX_AMOUNT) / 10_000_000} XLM), threshold=${SIGNER_THRESHOLD}`);

  const smartAccountAddr = new Address(publicKey).toScVal();
  const installParams = buildInstallParams();
  const contextRule = buildContextRule();

  const result = await callContract("install", [installParams, contextRule, smartAccountAddr]);
  results.txHashes.install = result.hash;
  log(`TX hash: ${result.hash}`);
  pass("install", "policy installed on ephemeral account");
}

async function testEnforceWithinLimit() {
  header("Phase 2: Enforce — Transfer WITHIN Limit (should SUCCEED)");
  log(`Amount: ${AMOUNT_WITHIN_LIMIT} stroops (${Number(AMOUNT_WITHIN_LIMIT) / 10_000_000} XLM) <= limit ${MAX_AMOUNT}`);

  const smartAccountAddr = new Address(publicKey).toScVal();
  const contextRule = buildContextRule();
  const context = buildTransferContext(AMOUNT_WITHIN_LIMIT);
  const signers = buildSigners();

  const result = await callContract("enforce", [context, signers, contextRule, smartAccountAddr]);
  results.txHashes.enforcePass = result.hash;
  log(`TX hash: ${result.hash}`);
  pass("enforce (within limit)", "policy allowed the transfer");
}

async function testEnforceOverLimit() {
  header("Phase 3: Enforce — Transfer EXCEEDING Limit (should FAIL)");
  log(`Amount: ${AMOUNT_OVER_LIMIT} stroops (${Number(AMOUNT_OVER_LIMIT) / 10_000_000} XLM) > limit ${MAX_AMOUNT}`);

  const smartAccountAddr = new Address(publicKey).toScVal();
  const contextRule = buildContextRule();
  const context = buildTransferContext(AMOUNT_OVER_LIMIT);
  const signers = buildSigners();

  const result = await callContract(
    "enforce",
    [context, signers, contextRule, smartAccountAddr],
    { expectSimFailure: true },
  );

  if (!result.success && result.simulationError) {
    log(`Simulation correctly rejected: ${result.simulationError.slice(0, 200)}`);
    pass("enforce (over limit)", "policy rejected the over-limit transfer");
  } else {
    fail("enforce (over limit)", "expected simulation failure but it succeeded");
  }
}

async function testGetData() {
  header("Phase 4: Verify — Read Policy Data");

  const smartAccountAddr = new Address(publicKey).toScVal();

  const result = await callContract("get_policy_data", [
    nativeToScVal(1, { type: "u32" }),
    smartAccountAddr,
  ]);
  results.txHashes.getData = result.hash;
  log(`TX hash: ${result.hash}`);

  if (result.returnValue) {
    const data = result.returnValue;
    const json = JSON.stringify(data, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
    log(`Data: ${json}`);

    // Verify max_arg2 matches what was installed
    const maxArg2 = data?.max_arg2 ?? data?.["max_arg2"];
    if (maxArg2 !== undefined && BigInt(maxArg2) === MAX_AMOUNT) {
      log(`max_arg2 matches installed value: ${maxArg2}`);
      pass("get_policy_data", "stored data matches install params");
    } else if (maxArg2 !== undefined) {
      log(`max_arg2 = ${maxArg2} (expected ${MAX_AMOUNT})`);
      fail("get_policy_data", "max_arg2 does not match installed value");
    } else {
      pass("get_policy_data", "data returned successfully");
    }
  } else {
    pass("get_policy_data", "call succeeded");
  }
}

async function testUninstall() {
  header("Phase 5: Uninstall Policy");

  const smartAccountAddr = new Address(publicKey).toScVal();
  const contextRule = buildContextRule();

  const result = await callContract("uninstall", [contextRule, smartAccountAddr]);
  results.txHashes.uninstall = result.hash;
  log(`TX hash: ${result.hash}`);
  pass("uninstall", "policy removed from account");
}

async function testEnforceAfterUninstall() {
  header("Phase 6: Enforce After Uninstall (should FAIL)");

  const smartAccountAddr = new Address(publicKey).toScVal();
  const contextRule = buildContextRule();
  const context = buildTransferContext(AMOUNT_WITHIN_LIMIT);
  const signers = buildSigners();

  const result = await callContract(
    "enforce",
    [context, signers, contextRule, smartAccountAddr],
    { expectSimFailure: true },
  );

  if (!result.success && result.simulationError) {
    log(`Simulation correctly rejected: ${result.simulationError.slice(0, 200)}`);
    pass("enforce (after uninstall)", "policy correctly rejects — no longer installed");
  } else {
    fail("enforce (after uninstall)", "expected failure but simulation succeeded");
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("PollyWallet E2E Policy Enforcement Test");
  console.log(`Policy contract: ${POLICY_CONTRACT_ID}`);
  console.log(`Testnet RPC:     ${RPC_URL}`);

  try {
    await fundAccount();
    await testInstall();
    await testEnforceWithinLimit();
    await testEnforceOverLimit();
    await testGetData();
    await testUninstall();
    await testEnforceAfterUninstall();
  } catch (err) {
    fail("UNEXPECTED ERROR", err.message);
    if (err.stack) console.error(err.stack);
  }

  // Summary
  header("RESULTS");
  console.log("");
  log(`Passed: ${results.passed}`);
  log(`Failed: ${results.failed}`);
  console.log("");
  log("Transaction hashes:");
  for (const [name, hash] of Object.entries(results.txHashes)) {
    log(`  ${name}: ${hash}`);
  }
  console.log("");

  if (results.failed > 0) {
    log("SOME TESTS FAILED");
    process.exit(1);
  } else {
    log("ALL TESTS PASSED — policy enforcement verified on Stellar Testnet");
    process.exit(0);
  }
}

main();
