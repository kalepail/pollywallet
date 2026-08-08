/**
 * Print a wallet's live context rules and the install params of every policy on them.
 *
 * Run from the repo root:
 *   npx tsx .claude/skills/soroban-policy-authoring/scripts/inspect-wallet-policies.mts C...
 *
 * Written because the same throwaway script got rewritten three times while tracing a policy
 * that installed cleanly and then rejected everything. The install params are the answer to
 * most "the policy doesn't work" reports, and they are invisible from the UI: a cap reading
 * `max_amount: "100"` is 100 BASE UNITS (0.00001 XLM at 7 decimals), not 100 tokens.
 *
 * Reads only — no keys, no signing, safe against any wallet.
 */
import {
  xdr, Address, Contract, TransactionBuilder, Keypair, Account, StrKey,
  nativeToScVal, scValToNative, rpc,
} from "@stellar/stellar-sdk";
import { requestContextRules } from "../../../../src/lib/context-rules";
import { TESTNET_RPC_URL, TESTNET_NETWORK_PASSPHRASE } from "../../../../src/lib/constants";

const wallet = process.argv[2];
if (!wallet || !StrKey.isValidContract(wallet)) {
  console.error("usage: inspect-wallet-policies.mts <wallet C-address>");
  process.exit(1);
}
const server = new rpc.Server(TESTNET_RPC_URL);

/** Policies key per-account state as AccountContext(smart_account, context_rule_id). */
const installKey = (account: string, ruleId: number) =>
  xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("AccountContext"),
    xdr.ScVal.scvAddress(Address.fromString(account).toScAddress()),
    nativeToScVal(ruleId, { type: "u32" }),
  ]);

async function simulate(contractId: string, fn: string) {
  const tx = new TransactionBuilder(new Account(Keypair.random().publicKey(), "0"), {
    fee: "100", networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
  }).addOperation(new Contract(contractId).call(fn)).setTimeout(30).build();
  const sim: any = await server.simulateTransaction(tx);
  if ("error" in sim) return null;
  return sim.result?.retval ? scValToNative(sim.result.retval) : null;
}

const json = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

const result = await requestContextRules(wallet);
if (!result.success) {
  console.error("could not read context rules:", result.error);
  process.exit(1);
}

for (const rule of result.rules) {
  const target = rule.targetContract;
  // Decimals turn an opaque bound into a number a human can check against intent.
  const decimals = target ? await simulate(target, "decimals") : null;
  console.log(`\n--- rule #${rule.id} "${rule.name}" ---`);
  console.log(`  context   : ${rule.contextType}${target ? ` -> ${target}` : ""}`);
  if (decimals != null) console.log(`  decimals  : ${decimals} (1 token = ${10 ** Number(decimals)} base units)`);
  if (rule.validUntil != null) console.log(`  validUntil: ledger ${rule.validUntil}`);

  for (const s of rule.signers) {
    let g = "";
    try {
      if (s.keyData?.length === 32) g = ` ${StrKey.encodeEd25519PublicKey(Buffer.from(s.keyData))}`;
    } catch { /* not an ed25519 key */ }
    console.log(`  signer    : ${s.type} via ${s.address} keyData=${s.keyData?.length ?? 0}B${g}`);
  }

  for (const policy of rule.policies) {
    try {
      const entry = await server.getContractData(policy, installKey(wallet, rule.id), rpc.Durability.Persistent);
      const params: any = scValToNative(entry.val.contractData().val());
      console.log(`  policy    : ${policy}`);
      console.log(`    params  : ${json(params)}`);
      for (const [k, v] of Object.entries(params ?? {})) {
        if (!/^(max|min)_/.test(k) || decimals == null) continue;
        const human = Number(v as any) / 10 ** Number(decimals);
        console.log(`    ${k} = ${v} base units = ${human} tokens`);
      }
    } catch {
      // No entry means install() never ran for this account, and enforce() will fail closed.
      console.log(`  policy    : ${policy}\n    params  : NOT INSTALLED for this account`);
    }
  }
}
