/**
 * Rubric check for the policy builder's example transactions.
 * Run: pnpm check:examples   (network — hits testnet RPC, then Horizon)
 *
 * A hash is a good example when it:
 *   1. resolves through analyzeTransaction() (succeeded on-chain, still fetchable)
 *   2. decodes to at least one invoke-contract pattern
 *   3. carries a named auth signer for a policy to bind to
 *   4. has concretely-typed args (nothing decoding to "[complex]")
 *   5. covers a contract+function shape no other example covers
 */
import assert from "node:assert/strict";
import { EXAMPLE_TXS } from "../src/lib/example-txs.ts";
import { analyzeTransaction, summarizePattern } from "../src/lib/tx-analyzer.ts";

const shapes = new Set<string>();
let failed = 0;

for (const ex of EXAMPLE_TXS) {
  try {
    const analysis = await analyzeTransaction(ex.hash);
    const [pattern] = analysis.patterns;
    assert.ok(pattern, "no invoke-contract pattern");
    assert.ok(pattern.contractAddress && pattern.functionName, "missing contract or function");
    assert.ok(pattern.signers.length > 0, "no auth signer");
    assert.ok(
      pattern.args.every((a) => a.value !== "[complex]"),
      "an arg failed to decode"
    );
    const shape = `${pattern.contractAddress}:${pattern.functionName}`;
    assert.ok(!shapes.has(shape), `duplicate shape ${shape}`);
    shapes.add(shape);

    console.log(`PASS  ${ex.label}\n      ${summarizePattern(pattern)}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  ${ex.label} (${ex.hash})\n      ${(err as Error).message}`);
  }
}

if (failed) {
  console.error(`\n${failed}/${EXAMPLE_TXS.length} examples failed — repopulate src/lib/example-txs.ts.`);
  process.exit(1);
}
console.log(`\n${EXAMPLE_TXS.length}/${EXAMPLE_TXS.length} examples pass the rubric.`);
